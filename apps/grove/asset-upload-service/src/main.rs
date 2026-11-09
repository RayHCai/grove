//! The worker that inspects every asset a creator uploads, in one process, the composition root only.
//! An asset arrives on a stream and leaves as a copy beside the bundles, or not at all.

mod config;
mod consumer;
mod inspect;
mod routes;
mod tasks;

use std::future::Future;
use std::net::SocketAddr;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use axum::Router;
use tokio::net::TcpListener;
use tokio::sync::{oneshot, watch};

use crate::config::Config;
use crate::consumer::Worker;
use crate::inspect::HttpBucket;
use crate::tasks::HttpTasks;

/// How long a drain may run before whatever is still open is dropped, which is the ceiling
/// `libs/go-grove/httpx` gives the Go half of the fleet so a rolling deploy is one deadline.
const DRAIN_TIMEOUT: Duration = Duration::from_secs(30);

#[tokio::main]
async fn main() -> Result<()> {
    request_id::init_tracing();

    let config = Config::from_env()?;
    // Down until the consumer has joined its group, so a deploy with no stream fails its probe.
    let consuming = Arc::new(AtomicBool::new(false));
    let router = routes::router(consuming.clone());

    let bind: SocketAddr = config
        .bind
        .parse()
        .context("ASSET_UPLOAD_SERVICE_BIND is not an address")?;
    let socket = TcpListener::bind(bind)
        .await
        .with_context(|| format!("binding {bind}"))?;
    tracing::info!(addr = %bind, "listening");

    let worker = Arc::new(Worker {
        tasks: Arc::new(HttpTasks::new(config.api_url, config.service_secret)?),
        bucket: Arc::new(HttpBucket::new()?),
    });
    let client =
        redis::Client::open(config.redis_url).context("REDIS_URL is not a Redis address")?;
    tracing::info!(worker = %config.worker_name, "claiming asset uploads");
    let (stopping, stop) = watch::channel(false);
    let consumer = tokio::spawn(consumer::supervise(
        client,
        worker,
        config.worker_name,
        stop,
        consuming,
    ));

    let served = serve(socket, router, request_id::stop_signal(), DRAIN_TIMEOUT).await;

    // After the drain, so an asset claimed on the way out is settled rather than left pending for
    // the reclaim window to hand back.
    let _ = stopping.send(true);
    let _ = consumer.await;
    served
}

/// Serves until `shutdown` resolves, then until what is in flight finishes or `drain` elapses.
async fn serve(
    socket: TcpListener,
    router: Router,
    shutdown: impl Future<Output = ()> + Send + 'static,
    drain: Duration,
) -> Result<()> {
    let (began, draining) = oneshot::channel();
    let serving = axum::serve(socket, router).with_graceful_shutdown(async move {
        shutdown.await;
        tracing::info!(?drain, "draining");
        let _ = began.send(());
    });

    tokio::select! {
        result = serving => result.context("serving"),
        // A peer that never finishes its request holds its connection open, and nothing else ends it.
        () = drain_deadline(draining, drain) => bail!("a connection outlasted the {drain:?} drain"),
    }
}

/// Resolves `drain` after the drain begins, and never at all where one never does.
async fn drain_deadline(began: oneshot::Receiver<()>, drain: Duration) {
    match began.await {
        Ok(()) => tokio::time::sleep(drain).await,
        Err(_) => std::future::pending().await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;
    use tokio::io::AsyncWriteExt;
    use tokio::net::TcpStream;

    /// Short enough to assert against, and the only thing this test changes about the real drain.
    const TEST_DRAIN: Duration = Duration::from_millis(250);

    #[tokio::test]
    async fn a_peer_that_never_finishes_its_request_does_not_hold_the_drain_open() {
        let router = routes::router(Arc::new(AtomicBool::new(true)));
        let socket = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = socket.local_addr().unwrap();
        let (signal, on_signal) = oneshot::channel();
        let serving = tokio::spawn(serve(
            socket,
            router,
            async move {
                let _ = on_signal.await;
            },
            TEST_DRAIN,
        ));

        // Half a head on a fresh connection, which hyper keeps waiting on through a graceful stop.
        let mut peer = TcpStream::connect(addr).await.unwrap();
        peer.write_all(b"GET /health HTTP/1.1\r\nHost: up")
            .await
            .unwrap();
        tokio::time::sleep(TEST_DRAIN).await;
        signal.send(()).unwrap();

        let outcome = tokio::time::timeout(TEST_DRAIN * 40, serving)
            .await
            .expect("the drain never ended")
            .unwrap();
        assert!(outcome
            .unwrap_err()
            .to_string()
            .contains("outlasted the 250ms drain"));
    }
}

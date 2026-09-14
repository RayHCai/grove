//! Content-addressed object storage for the fleet, in one process.
//!
//! The composition root and nothing else: read the environment, open the object root, build the
//! router the store sits behind, and drain on a signal. An object is multi-megabyte and arrives and
//! leaves as a stream, so the only state this process holds between a request and its answer is a
//! chunk and a hasher.

mod auth;
mod config;
mod routes;
mod store;

use std::future::Future;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use axum::Router;
use tokio::net::TcpListener;
use tokio::sync::oneshot;

use crate::config::Config;
use crate::routes::AppState;
use crate::store::FileStore;

/// How long a drain may run before whatever is still open is dropped, which is the ceiling
/// `libs/go-grove/httpx` gives the Go half of the fleet so a rolling deploy is one deadline.
const DRAIN_TIMEOUT: Duration = Duration::from_secs(30);

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let config = Config::from_env()?;
    let store = FileStore::open(config.root.clone())
        .await
        .with_context(|| format!("opening the object root at {}", config.root.display()))?;

    let router = routes::router(
        AppState {
            store: Arc::new(store),
            max_bytes: config.max_bytes,
        },
        Arc::new(config.fleet_secret),
    );

    let bind: SocketAddr = config
        .bind
        .parse()
        .context("UPLOAD_SERVICE_BIND is not an address")?;
    let socket = TcpListener::bind(bind)
        .await
        .with_context(|| format!("binding {bind}"))?;
    tracing::info!(addr = %bind, root = %config.root.display(), "listening");

    let signal = async {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            () = terminate() => {}
        }
    };
    serve(socket, router, signal, DRAIN_TIMEOUT).await
}

/// Serves until `shutdown` resolves, then until what is still in flight finishes or `drain` elapses.
///
/// A deploy is a drain rather than a kill: an upload in flight holds a temp file that only its own
/// rename publishes, so a kill mid-stream is an object the caller was never told it lost.
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
        // A peer that has stopped reading is never polled again and the body deadline maps only the
        // request body, so without this the drain has nothing under it that ever ends.
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

/// Resolves on SIGTERM, which is what a supervisor sends where a keyboard sends SIGINT.
#[cfg(unix)]
async fn terminate() {
    use tokio::signal::unix::{signal, SignalKind};

    match signal(SignalKind::terminate()) {
        Ok(mut sigterm) => {
            let _ = sigterm.recv().await;
        }
        // A handler this process could not register is not a drain it can ever start.
        Err(err) => {
            tracing::error!(error = ?err, "cannot listen for SIGTERM");
            std::future::pending().await
        }
    }
}

/// Windows has no SIGTERM, so the drain there is the console signal alone.
#[cfg(not(unix))]
async fn terminate() {
    std::future::pending().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{ObjectHash, ObjectStore, PutRequest};
    use bytes::Bytes;
    use sha2::{Digest, Sha256};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;

    const SECRET: &str = "a-fleet-secret-at-least-thirty-two-characters";

    /// Past any socket buffer the two ends can rest the response in, so a peer that stops reading
    /// really does leave the write stuck rather than merely slow.
    const STUCK_OBJECT_BYTES: usize = 16 * 1024 * 1024;

    /// Short enough to assert against, and the only thing this test changes about the real drain.
    const TEST_DRAIN: Duration = Duration::from_millis(250);

    #[tokio::test]
    async fn a_peer_that_stops_reading_does_not_hold_the_drain_open() {
        let root = tempfile::tempdir().unwrap();
        let store = Arc::new(FileStore::open(root.path().to_path_buf()).await.unwrap());

        let bytes = vec![7u8; STUCK_OBJECT_BYTES];
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        let hash: String = hasher
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        store
            .put(
                PutRequest {
                    hash: ObjectHash::parse(&hash).unwrap(),
                    content_type: "application/wasm".to_owned(),
                    max_bytes: STUCK_OBJECT_BYTES as u64,
                },
                Box::pin(futures_util::stream::once(
                    async move { Ok(Bytes::from(bytes)) },
                )),
            )
            .await
            .unwrap();

        let router = routes::router(
            AppState {
                store: store.clone(),
                max_bytes: STUCK_OBJECT_BYTES as u64,
            },
            Arc::new(SECRET.to_owned()),
        );
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

        let mut peer = TcpStream::connect(addr).await.unwrap();
        peer.write_all(
            format!(
                "GET /v1/objects/{hash} HTTP/1.1\r\nHost: upload\r\nAuthorization: Bearer {SECRET}\r\n\r\n"
            )
            .as_bytes(),
        )
        .await
        .unwrap();

        // One byte proves the answer started; everything after it backs up, because this is the last
        // read this peer ever does.
        assert_eq!(peer.read(&mut [0u8; 1]).await.unwrap(), 1);
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

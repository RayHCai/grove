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

use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::{Context, Result};

use crate::config::Config;
use crate::routes::AppState;
use crate::store::FileStore;

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
    let socket = tokio::net::TcpListener::bind(bind)
        .await
        .with_context(|| format!("binding {bind}"))?;
    tracing::info!(addr = %bind, root = %config.root.display(), "listening");

    // A deploy is a drain rather than a kill: an upload in flight holds a temp file that only its
    // own rename publishes, so a kill mid-stream is an object the caller was never told it lost.
    axum::serve(socket, router)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
            tracing::info!("draining");
        })
        .await
        .context("serving")
}

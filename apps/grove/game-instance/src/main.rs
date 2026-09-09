//! One game session, in one process.
//!
//! Two halves that never share a thread: `tokio` owns the sockets and the store, and one dedicated
//! thread owns the V8 isolate the world runs in. They meet at a single channel of `HostEvent`, which
//! is what gives the tick one order over everything that happened to it.
//!
//! The process boundary is the isolation, and the isolate is the second one inside it: this process
//! holds no database credential and no platform secret — a session-scoped bearer for
//! `@grove/game-manager` and the shared secret it verifies tickets with, and nothing else.

mod clock;
mod config;
mod isolate;
mod net;
mod protocol;
mod session;
mod store;
mod ticket;

use std::net::SocketAddr;
use std::time::Duration;

use anyhow::{Context, Result};
use tokio::sync::mpsc;

use crate::config::Config;
use crate::session::{HostEvent, SessionOptions};

/// What the bundle's own config file must name, beside whatever `SimConfig` it carries.
#[derive(serde::Deserialize)]
struct Rates {
    #[serde(default = "default_sim_rate")]
    sim_rate: f64,
    #[serde(default = "default_send_rate")]
    send_rate: f64,
}

fn default_sim_rate() -> f64 {
    60.0
}

fn default_send_rate() -> f64 {
    20.0
}

fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let config = Config::from_env()?;
    let bundle = std::fs::read_to_string(&config.bundle_path)
        .with_context(|| format!("reading the sim bundle at {}", config.bundle_path.display()))?;
    let sim_config = std::fs::read_to_string(&config.sim_config_path)
        .with_context(|| format!("reading {}", config.sim_config_path.display()))?;
    let rates: Rates = serde_json::from_str(&sim_config).context("reading the world's rates")?;

    // Multi-threaded for the sockets and the store; the isolate is on a thread of its own and never
    // enters this pool, because a `JsRuntime` is not `Send` and a tick must not be moved mid-step.
    let io = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .context("starting the async runtime")?;

    let (events, receiver) = mpsc::unbounded_channel::<HostEvent>();
    let store = store::Store::new(config.manager_url.clone(), config.manager_token.clone());

    let listener = net::Listener::new(
        events.clone(),
        config.token_secret.clone(),
        config.game_id.clone(),
    );
    let bind: SocketAddr = config
        .bind
        .parse()
        .context("GROVE_BIND is not an address")?;
    let router = listener.router();

    let serving = io.spawn(async move {
        let socket = tokio::net::TcpListener::bind(bind).await?;
        // Reported rather than assumed: `server-manager` binds port 0 and learns the port from here.
        tracing::info!(addr = %socket.local_addr()?, "listening");
        axum::serve(
            socket,
            router.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await?;
        Ok::<(), anyhow::Error>(())
    });

    // A deploy is a drain, not a kill: stop taking connections, let the session end, and only then
    // exit — so the saves the last batch carries are actually written.
    let drain = events.clone();
    io.spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            tracing::info!("draining");
            let _ = drain.send(HostEvent::Drain);
        }
    });

    let outcome = session::run(
        SessionOptions {
            bundle,
            sim_config,
            sim_rate: rates.sim_rate,
            send_rate: rates.send_rate,
            heap_limit_bytes: config.heap_limit_bytes,
            tick_budget: Duration::from_millis(config.tick_budget_ms),
            store,
        },
        receiver,
        events,
        io.handle().clone(),
    );

    serving.abort();
    outcome
}

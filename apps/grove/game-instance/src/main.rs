//! One game session, in one process. Two halves that never share a thread: `tokio` owns the
//! sockets and the store, one dedicated thread owns the V8 isolate. They meet at a single channel
//! of `HostEvent`, which gives the tick one order over everything that happened to it.
//! This process holds no database credential and no platform secret.

mod clock;
mod config;
mod isolate;
mod net;
mod protocol;
mod request_id;
mod session;
mod store;
mod ticket;

use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use tokio::sync::mpsc;

use crate::config::Config;
use crate::session::{HostEvent, SessionOptions};

/// What the bundle's own config file must name, beside whatever `SimConfig` it carries.
/// camelCase because the file IS that `SimConfig`, and serde discards an unknown field without a
/// word: read under the wrong spelling these fall back to defaults the world never declared.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
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

    // One counter, written by the session thread and read by `/healthz`: the agent on this box
    // polls that route for the roster, and a bare 200 reports every full session as empty.
    let players = Arc::new(AtomicUsize::new(0));
    let draining = Arc::new(AtomicBool::new(false));

    let listener = net::Listener::new(
        events.clone(),
        config.token_secret.clone(),
        config.game_id.clone(),
        config.session_id.clone(),
        players.clone(),
        draining.clone(),
    );
    let bind: SocketAddr = config
        .bind
        .parse()
        .context("GROVE_BIND is not an address")?;
    let router = listener.router();

    let faults = events.clone();
    let serving = io.spawn(async move {
        let listening = async {
            let socket = tokio::net::TcpListener::bind(bind).await?;
            // Reported rather than assumed: a hand-run process is given port zero, and this line is
            // the only place the port the kernel picked appears.
            tracing::info!(addr = %socket.local_addr()?, "listening");
            axum::serve(
                socket,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await?;
            Ok::<(), anyhow::Error>(())
        };
        // A socket nobody bound is a slot only an operator can reclaim: the session would otherwise
        // tick an unreachable world until the agent's probe gave up on it.
        if let Err(error) = listening.await {
            let _ = faults.send(HostEvent::Fatal {
                error: format!("serving {bind}: {error}"),
            });
        }
    });

    // A deploy is a drain, not a kill: stop taking connections, let the session end, and only then
    // exit — so the saves the last batch carries are actually written.
    let drain = events.clone();
    io.spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            tracing::info!("draining");
            draining.store(true, Ordering::Relaxed);
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
            players,
        },
        receiver,
        events,
        io.handle().clone(),
    );

    serving.abort();
    outcome
}

#[cfg(test)]
mod tests {
    use super::Rates;

    /// The file parsed here is the very same string handed to the isolate as its `SimConfig`, and
    /// that type spells both of these in camelCase.
    #[test]
    fn reads_the_rates_a_sim_config_actually_declares() {
        let rates: Rates =
            serde_json::from_str(r#"{"simRate":30,"sendRate":15,"maxPlayers":8}"#).unwrap();

        assert_eq!(rates.sim_rate, 30.0);
        assert_eq!(rates.send_rate, 15.0);
    }

    #[test]
    fn falls_back_only_where_the_world_declared_nothing() {
        let rates: Rates = serde_json::from_str("{}").unwrap();

        assert_eq!(rates.sim_rate, 60.0);
        assert_eq!(rates.send_rate, 20.0);
    }
}

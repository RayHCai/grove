//! What one game process is told about itself, all of it from the environment. Nothing is
//! discovered: the agent already decided every value, so a missing one is a wiring fault.
//! Three are defaulted to the numbers the agent floors them at, so a hand-run process agrees.

use std::path::PathBuf;

use anyhow::Result;
use request_id::env::{number, required, secret};

pub struct Config {
    /// Which game this process serves. A ticket naming another is refused outright.
    pub game_id: String,
    /// Which session this process IS. A ticket minted for another world is refused outright.
    pub session_id: String,
    /// The address to bind. `instance-manager` picks the port and reports it upward.
    pub bind: String,
    /// The compiled sim bundle: `@platform/sim`, the engine it needs, and this game's own scripts.
    pub bundle_path: PathBuf,
    /// The `SimConfig` this world boots with, already JSON, written by whoever built the bundle.
    pub sim_config_path: PathBuf,
    /// Shared with `@grove/api`, which mints the tickets this process verifies.
    pub token_secret: Vec<u8>,
    /// The session-scoped bearer for `@grove/game-manager`, which is the only store this reaches.
    pub manager_url: String,
    pub manager_token: String,
    /// Bytes this session's V8 heap may reach before the session is torn down.
    pub heap_limit_bytes: usize,
    /// Wall-clock one tick may spend inside the isolate before it is terminated as a runaway.
    pub tick_budget_ms: u64,
}

impl Config {
    pub fn from_env() -> Result<Self> {
        Ok(Self {
            game_id: required("GROVE_GAME_ID")?,
            session_id: required("GROVE_SESSION_ID")?,
            bind: std::env::var("GROVE_BIND").unwrap_or_else(|_| "0.0.0.0:0".to_owned()),
            bundle_path: PathBuf::from(required("GROVE_BUNDLE")?),
            sim_config_path: PathBuf::from(required("GROVE_SIM_CONFIG")?),
            token_secret: secret("GAME_TOKEN_SECRET")?.into_bytes(),
            manager_url: required("GROVE_MANAGER_URL")?,
            manager_token: required("GROVE_MANAGER_TOKEN")?,
            heap_limit_bytes: number("GROVE_HEAP_LIMIT_BYTES", 256 * 1024 * 1024)?,
            tick_budget_ms: number("GROVE_TICK_BUDGET_MS", 250)?,
        })
    }
}

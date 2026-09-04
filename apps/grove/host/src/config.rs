//! What one game process is told about itself, all of it from the environment.
//!
//! Nothing here is discovered and nothing is defaulted quietly: `@grove/server-manager` spawns this
//! process and every value below is a decision it already made, so a missing one is a wiring fault
//! to fail on rather than a gap to paper over.

use std::path::PathBuf;

use anyhow::{bail, Context, Result};

/// The shortest secret this process will accept, matching `@grove/api`'s own floor.
const MIN_SECRET_LEN: usize = 32;

pub struct Config {
    /// Which game this process serves. A ticket naming another is refused outright.
    pub game_id: String,
    /// The address to bind. `server-manager` picks the port and tells the API about it.
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
        let token_secret = required("GAME_TOKEN_SECRET")?;
        if token_secret.len() < MIN_SECRET_LEN {
            bail!("GAME_TOKEN_SECRET must be at least {MIN_SECRET_LEN} characters");
        }
        Ok(Self {
            game_id: required("GROVE_GAME_ID")?,
            bind: std::env::var("GROVE_BIND").unwrap_or_else(|_| "0.0.0.0:0".to_owned()),
            bundle_path: PathBuf::from(required("GROVE_BUNDLE")?),
            sim_config_path: PathBuf::from(required("GROVE_SIM_CONFIG")?),
            token_secret: token_secret.into_bytes(),
            manager_url: required("GROVE_MANAGER_URL")?,
            manager_token: required("GROVE_MANAGER_TOKEN")?,
            heap_limit_bytes: number("GROVE_HEAP_LIMIT_BYTES", 256 * 1024 * 1024)?,
            tick_budget_ms: number("GROVE_TICK_BUDGET_MS", 250)? as u64,
        })
    }
}

fn required(name: &str) -> Result<String> {
    std::env::var(name).with_context(|| format!("{name} is not set"))
}

fn number(name: &str, fallback: usize) -> Result<usize> {
    match std::env::var(name) {
        Err(_) => Ok(fallback),
        Ok(raw) => raw.parse().with_context(|| format!("{name} must be a whole number")),
    }
}

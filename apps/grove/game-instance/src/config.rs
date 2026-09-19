//! What one game process is told about itself, all of it from the environment. Nothing is
//! discovered: the agent already decided every value, so a missing one is a wiring fault.
//! Three are defaulted to the numbers the agent floors them at, so a hand-run process agrees.

use std::path::PathBuf;

use anyhow::{bail, Context, Result};

/// The shortest secret this process will accept, matching `@grove/api`'s own floor.
const MIN_SECRET_LEN: usize = 32;

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
        let token_secret = required("GAME_TOKEN_SECRET")?;
        if token_secret.len() < MIN_SECRET_LEN {
            bail!("GAME_TOKEN_SECRET must be at least {MIN_SECRET_LEN} characters");
        }
        Ok(Self {
            game_id: required("GROVE_GAME_ID")?,
            session_id: required("GROVE_SESSION_ID")?,
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
    let value = match std::env::var(name) {
        Err(_) => return Ok(fallback),
        Ok(raw) => raw
            .parse()
            .with_context(|| format!("{name} must be a whole number"))?,
    };
    // Both of these are budgets: zero is not a smaller one but none at all, and the watchdog it
    // disarms is what a session with no other way out depends on.
    if value == 0 {
        bail!("{name} must be greater than zero");
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::number;

    #[test]
    fn refuses_a_budget_of_zero() {
        std::env::set_var("GROVE_TEST_ZERO_BUDGET", "0");
        assert!(number("GROVE_TEST_ZERO_BUDGET", 250).is_err());
    }

    #[test]
    fn takes_the_fallback_only_where_nothing_is_set() {
        assert_eq!(number("GROVE_TEST_UNSET_BUDGET", 250).unwrap(), 250);
    }
}

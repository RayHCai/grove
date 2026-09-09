//! What this service is told about itself, all of it from the environment.
//!
//! The root and the secret are decisions a deploy already made, so a missing one is a wiring fault
//! to fail on rather than a gap to paper over. The bind address and the ceiling carry a default
//! because every deploy would write the same one, and both are stated here rather than discovered.

use std::path::PathBuf;

use anyhow::{bail, Context, Result};

/// The shortest secret this process will accept, matching `@grove/api`'s own floor.
const MIN_SECRET_LEN: usize = 32;

/// 64 MiB. A bundle set is tens of megabytes and an uncompressed texture atlas is the worst case, so
/// the ceiling is generous — it exists to bound one hostile upload, not to size a legitimate one.
const DEFAULT_MAX_BYTES: u64 = 64 * 1024 * 1024;

pub struct Config {
    pub bind: String,
    /// The directory objects live under. One filesystem, because a rename is only atomic inside one.
    pub root: PathBuf,
    /// Shared across the fleet. Every caller of this service presents it; nothing else may.
    pub fleet_secret: String,
    /// Bytes one upload may reach before it is abandoned.
    pub max_bytes: u64,
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let fleet_secret = required("FLEET_SECRET")?;
        if fleet_secret.len() < MIN_SECRET_LEN {
            bail!("FLEET_SECRET must be at least {MIN_SECRET_LEN} characters");
        }
        Ok(Self {
            bind: std::env::var("UPLOAD_SERVICE_BIND")
                .unwrap_or_else(|_| "0.0.0.0:4005".to_owned()),
            root: PathBuf::from(required("UPLOAD_ROOT")?),
            fleet_secret,
            max_bytes: number("UPLOAD_MAX_BYTES", DEFAULT_MAX_BYTES)?,
        })
    }
}

fn required(name: &str) -> Result<String> {
    std::env::var(name).with_context(|| format!("{name} is not set"))
}

fn number(name: &str, fallback: u64) -> Result<u64> {
    match std::env::var(name) {
        Err(_) => Ok(fallback),
        Ok(raw) => raw
            .parse()
            .with_context(|| format!("{name} must be a whole number")),
    }
}

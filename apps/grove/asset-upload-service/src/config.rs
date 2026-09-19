//! What this service is told about itself, all of it from the environment. The root and the secret
//! are decisions a deploy already made, so a missing one is a wiring fault to fail on.

use std::path::PathBuf;

use anyhow::{bail, Context, Result};

/// The shortest secret this process will accept, matching `@grove/api`'s own floor.
const MIN_SECRET_LEN: usize = 32;

/// 64 MiB. Generous, because an uncompressed atlas is the worst case: it exists to bound one
/// hostile upload rather than to size a legitimate one.
const DEFAULT_MAX_BYTES: u64 = 64 * 1024 * 1024;

pub struct Config {
    pub bind: String,
    /// The directory objects live under. One filesystem, since a rename is atomic only inside one.
    pub root: PathBuf,
    /// Shared across the fleet. Every caller of this service presents it; nothing else may.
    pub fleet_secret: String,
    /// Bytes one upload may reach before it is abandoned.
    pub max_bytes: u64,
    /// The stream asset uploads are claimed from. Absent, and this process serves objects only.
    pub redis_url: Option<String>,
    /// Where a claimed asset upload is settled, which is the only call this service makes out.
    pub api_url: String,
    /// What this process is called in the consumer group; two sharing a name share their claims.
    pub worker_name: String,
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let fleet_secret = required("FLEET_SECRET")?;
        if fleet_secret.len() < MIN_SECRET_LEN {
            bail!("FLEET_SECRET must be at least {MIN_SECRET_LEN} characters");
        }
        Ok(Self {
            // Binds loopback by default. This service is reachable from the fleet's own network and
            // from nowhere else, and a default of 0.0.0.0 is how that stops being true by accident.
            bind: std::env::var("ASSET_UPLOAD_SERVICE_BIND")
                .unwrap_or_else(|_| "127.0.0.1:4005".to_owned()),
            root: PathBuf::from(required("UPLOAD_ROOT")?),
            fleet_secret,
            max_bytes: number("UPLOAD_MAX_BYTES", DEFAULT_MAX_BYTES)?,
            redis_url: std::env::var("REDIS_URL").ok(),
            api_url: required("API_URL")?,
            worker_name: std::env::var("UPLOAD_WORKER_NAME")
                .ok()
                .filter(|name| !name.is_empty())
                .or_else(hostname)
                .unwrap_or_else(|| "asset-upload-service".to_owned()),
        })
    }
}

/// What this box is called, which keeps two workers' claims apart without a deploy saying so.
fn hostname() -> Option<String> {
    std::env::var("HOSTNAME")
        .ok()
        .or_else(|| std::env::var("COMPUTERNAME").ok())
        .filter(|name| !name.is_empty())
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

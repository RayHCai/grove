//! What this service is told about itself, all of it from the environment. The root and the secret
//! are decisions a deploy already made, so a missing one is a wiring fault to fail on.

use std::path::PathBuf;

use anyhow::Result;
use request_id::env::{number, required, secret};

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
        let fleet_secret = secret("FLEET_SECRET")?;
        Ok(Self {
            bind: bind(),
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

/// Loopback by default: this service is reachable from the fleet's own network and from nowhere
/// else, and a default of 0.0.0.0 is how that stops being true by accident. A platform that assigns
/// `PORT` routes to the process from off the box, so that one binds every interface.
fn bind() -> String {
    if let Ok(bind) = std::env::var("ASSET_UPLOAD_SERVICE_BIND") {
        return bind;
    }
    match std::env::var("PORT") {
        Ok(port) if !port.is_empty() => format!("0.0.0.0:{port}"),
        _ => "127.0.0.1:4005".to_owned(),
    }
}

/// What this box is called, which keeps two workers' claims apart without a deploy saying so.
fn hostname() -> Option<String> {
    std::env::var("HOSTNAME")
        .ok()
        .or_else(|| std::env::var("COMPUTERNAME").ok())
        .filter(|name| !name.is_empty())
}

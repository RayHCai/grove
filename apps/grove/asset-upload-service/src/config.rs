//! What this service is told about itself, all of it from the environment. The stream and the
//! credential are decisions a deploy already made, so a missing one is a wiring fault to fail on.

use anyhow::Result;
use request_id::env::{required, secret};

pub struct Config {
    pub bind: String,
    /// What this process presents to `@grove/api`, which takes it for asset uploads and nothing else.
    pub service_secret: String,
    /// The stream asset uploads are claimed from, which is the whole of this process's work.
    pub redis_url: String,
    /// Where a claimed asset upload is settled.
    pub api_url: String,
    /// What this process is called in the consumer group; two sharing a name share their claims.
    pub worker_name: String,
}

impl Config {
    pub fn from_env() -> Result<Self> {
        Ok(Self {
            bind: bind(),
            service_secret: secret("ASSET_SERVICE_SECRET")?,
            redis_url: required("REDIS_URL")?,
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

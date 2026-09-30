//! The id that joins one request across the services it passes through, the same token the Go
//! half puts on every hop, restated for the Rust crates that sit between them: a chain is only as
//! long as its quietest link. With `service`, also the rest of what both Rust services start the
//! same way: the middleware that carries the id, the log setup, and the environment readers.

use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(feature = "service")]
pub mod env;

/// Where a caller's id arrives and where this process echoes the one it chose.
pub const HEADER: &str = "x-request-id";

/// Wide enough for a uuid, a 32-hex trace id or a w3c traceparent, and narrow enough that a caller
/// cannot spend a megabyte of every log line on a header nobody bounded.
pub const MAX_LEN: usize = 64;

/// Reports whether a presented id is one token a log, an echo header and an outbound call can all
/// carry unchanged.
pub fn valid(candidate: &str) -> bool {
    !candidate.is_empty()
        && candidate.len() <= MAX_LEN
        && candidate
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

/// Mints one from the clock and a counter rather than a uuid crate, because what this needs is a
/// token two logs can be joined on and not a name unique across the world, and a fourth crate
/// inside the process that hosts an untrusted isolate is a cost with nothing behind it.
pub fn mint() -> String {
    static COUNTER: AtomicU32 = AtomicU32::new(0);

    // A clock set before 1970 reads as zero rather than failing the request the id is for.
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_nanos() as u64)
        .unwrap_or(0);
    format!(
        "{nanos:016x}{:08x}",
        COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

/// Joins one request to the caller that made it: the id it presented when that is one token this
/// process can log unchanged, and a fresh one when it is not. Put back on the request too, so a
/// handler reads the id the caller will quote.
#[cfg(feature = "service")]
pub async fn correlate(
    mut request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let id = request
        .headers()
        .get(HEADER)
        .and_then(|presented| presented.to_str().ok())
        .filter(|presented| valid(presented))
        .map_or_else(mint, str::to_owned);

    let value =
        axum::http::HeaderValue::from_str(&id).expect("a checked request id is a header value");
    request.headers_mut().insert(HEADER, value.clone());

    let mut response = next.run(request).await;
    response.headers_mut().insert(HEADER, value);
    response
}

/// Logs at `info` unless `RUST_LOG` says otherwise.
#[cfg(feature = "service")]
pub fn init_tracing() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_an_id_the_rest_of_the_fleet_mints() {
        assert!(valid("9f8c2b1a-0000-4000-8000-00000000abcd"));
        assert!(valid("4bf92f3577b34da6a3ce929d0e0e4736"));
    }

    #[test]
    fn refuses_an_id_a_log_line_could_not_carry_whole() {
        assert!(!valid(""));
        assert!(!valid("has a space"));
        assert!(!valid("good-id\r\nx-injected: yes"));
        assert!(!valid("a:b"));
    }

    #[test]
    fn refuses_one_character_past_the_bound_the_go_half_holds() {
        assert!(valid(&"a".repeat(MAX_LEN)));
        assert!(!valid(&"a".repeat(MAX_LEN + 1)));
    }

    #[test]
    fn mints_an_id_it_would_accept_from_a_caller() {
        assert!(valid(&mint()));
    }

    /// Two calls inside one clock tick still have to name two different requests.
    #[test]
    fn mints_a_new_one_every_time() {
        assert_ne!(mint(), mint());
    }
}

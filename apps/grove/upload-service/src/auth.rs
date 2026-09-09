//! The fleet bearer every `/v1` route sits behind.
//!
//! One shared secret rather than a credential per caller: this service is not publicly routable and
//! its callers are three services rather than a population, so a per-caller identity would be a key
//! rotation problem bought with nothing. Compared in constant time, exactly as `grove-game-instance`
//! compares a signature — the length is compared first and is not secret, being a deploy-wide fact
//! rather than a per-request one.

use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::header::AUTHORIZATION;
use axum::middleware::Next;
use axum::response::Response;
use subtle::ConstantTimeEq;

use crate::routes::ApiError;

const BEARER: &str = "Bearer ";

/// Runs the rest of the stack only for a request carrying the fleet secret.
pub async fn require_fleet_bearer(
    State(secret): State<Arc<String>>,
    request: Request,
    next: Next,
) -> Result<Response, ApiError> {
    let presented = request
        .headers()
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix(BEARER))
        .is_some_and(|token| token.as_bytes().ct_eq(secret.as_bytes()).unwrap_u8() == 1);

    if !presented {
        // The path and nothing else: a peer without the bearer has no business being told which of
        // the two it got wrong, and the detail an operator needs is on this side of the socket.
        tracing::warn!(path = %request.uri().path(), "refused: no fleet bearer");
        return Err(ApiError::unauthorized());
    }
    Ok(next.run(request).await)
}

//! The fleet bearer every `/v1` route sits behind. One shared secret rather than a credential per
//! caller: the callers are three services, not a population, so per-caller identity would buy only
//! a rotation problem. Compared in constant time; the length is a deploy-wide fact, not a secret.

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

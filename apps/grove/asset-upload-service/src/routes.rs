//! The health probe and the shape of a refusal: the whole HTTP surface, since the work itself
//! arrives on the asset stream.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{middleware, Json, Router};
use serde::Serialize;

/// `/health` carries no bearer: the load balancer probing it holds no credential, and it answers
/// nothing a peer could not already infer from the socket being open.
pub fn router(consuming: Arc<AtomicBool>) -> Router {
    Router::new()
        .route("/health", get(health).with_state(consuming))
        .method_not_allowed_fallback(method_not_allowed)
        .fallback(no_such_route)
        // Outermost, so a refusal written by a fallback is answered under the id its caller traces.
        .layer(middleware::from_fn(request_id::correlate))
}

/// A wrong path answers in the shape a wrong body does, which is the whole point of a code a caller
/// can match on.
async fn no_such_route() -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, "not_found", "no such route")
}

async fn method_not_allowed() -> ApiError {
    ApiError::new(
        StatusCode::METHOD_NOT_ALLOWED,
        "invalid_request",
        "that is not a method this address answers",
    )
}

#[derive(Serialize)]
struct Health {
    ok: bool,
}

/// 503 while the consumer is down: a process that claims no asset is one a supervisor should see,
/// since the asset's creator is left watching a task nothing moves.
async fn health(State(consuming): State<Arc<AtomicBool>>) -> (StatusCode, Json<Health>) {
    let ok = consuming.load(Ordering::Relaxed);
    let status = if ok {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    (status, Json(Health { ok }))
}

/// A refusal on the wire, mirroring `ErrorBody` in `libs/api-contract`: a code a caller matches on
/// and a message a human reads.
#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: &'static str,
}

#[derive(Serialize)]
struct ErrorBody<'a> {
    code: &'a str,
    message: &'a str,
}

impl ApiError {
    fn new(status: StatusCode, code: &'static str, message: &'static str) -> Self {
        Self {
            status,
            code,
            message,
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(ErrorBody {
                code: self.code,
                message: self.message,
            }),
        )
            .into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    fn app(consuming: bool) -> Router {
        router(Arc::new(AtomicBool::new(consuming)))
    }

    async fn body_of(response: Response) -> String {
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        String::from_utf8(bytes.to_vec()).unwrap()
    }

    fn echoed(response: &Response) -> &str {
        response
            .headers()
            .get(request_id::HEADER)
            .expect("every answer carries the id it was served under")
            .to_str()
            .unwrap()
    }

    async fn answer(app: Router, request: Request<Body>) -> Response {
        app.oneshot(request).await.unwrap()
    }

    #[tokio::test]
    async fn answers_the_probe_under_the_id_the_balancer_sent() {
        let response = answer(
            app(true),
            Request::get("/health")
                .header(request_id::HEADER, "known-id")
                .body(Body::empty())
                .unwrap(),
        )
        .await;

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(echoed(&response), "known-id");
        assert_eq!(body_of(response).await, r#"{"ok":true}"#);
    }

    #[tokio::test]
    async fn replaces_an_id_too_long_for_a_log_line_rather_than_writing_it_down() {
        let presented = "a".repeat(request_id::MAX_LEN + 1);
        let response = answer(
            app(true),
            Request::get("/health")
                .header(request_id::HEADER, &presented)
                .body(Body::empty())
                .unwrap(),
        )
        .await;

        assert_ne!(echoed(&response), presented);
        assert!(request_id::valid(echoed(&response)));
    }

    #[tokio::test]
    async fn mints_one_for_a_caller_that_presented_none() {
        let response = answer(
            app(true),
            Request::get("/health").body(Body::empty()).unwrap(),
        )
        .await;

        assert!(request_id::valid(echoed(&response)));
    }

    #[tokio::test]
    async fn health_is_unavailable_while_the_consumer_is_down() {
        let response = answer(
            app(false),
            Request::get("/health").body(Body::empty()).unwrap(),
        )
        .await;

        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(body_of(response).await, r#"{"ok":false}"#);
    }

    /// The layer is on the outer router: a refusal written by a fallback is exactly the answer an
    /// operator is tracing, and an inner mount would miss it.
    #[tokio::test]
    async fn carries_the_id_onto_a_route_that_does_not_exist() {
        let response = answer(
            app(true),
            Request::get("/v1/objects/anything")
                .header(request_id::HEADER, "known-id")
                .body(Body::empty())
                .unwrap(),
        )
        .await;

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(echoed(&response), "known-id");
        assert!(body_of(response).await.contains(r#""code":"not_found""#));
    }

    #[tokio::test]
    async fn a_wrong_method_on_the_health_probe_carries_an_error_body() {
        let response = answer(
            app(true),
            Request::post("/health").body(Body::empty()).unwrap(),
        )
        .await;

        assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
        assert!(body_of(response)
            .await
            .contains(r#""code":"invalid_request""#));
    }
}

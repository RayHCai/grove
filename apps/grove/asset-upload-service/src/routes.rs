//! The four object routes, the health probe, and the shape of a refusal. Nothing here holds an
//! object: the handler owns only the checks a stream cannot make for itself — the name is a
//! SHA-256, the declared length is under the ceiling, the type is bounded.

use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::extract::{Path, Request, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_LENGTH, CONTENT_TYPE};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, put};
use axum::{middleware, Json, Router};
use futures_util::stream::StreamExt;
use serde::Serialize;
use tower::limit::GlobalConcurrencyLimitLayer;
use tower_http::timeout::TimeoutBody;

use crate::auth;
use crate::store::{ObjectHash, ObjectStore, PutError, PutRequest, Stored, DEFAULT_CONTENT_TYPE};

/// A content address can never name different bytes, so a reader may keep it until it runs out of
/// disk. This is the whole reason a bundle URL is a hash rather than a path plus a version.
const IMMUTABLE: &str = "public, max-age=31536000, immutable";

/// Stored and echoed back on every read, so its length is bounded where it arrives rather than
/// wherever it is written out.
const MAX_CONTENT_TYPE_LEN: usize = 255;

/// How long an arriving body may go between chunks. Idle time rather than total time, because a
/// 64 MiB object over a slow link is a long request and not a stalled one.
const BODY_IDLE_TIMEOUT: Duration = Duration::from_secs(30);

/// Object requests running at once. A permit is held until the handler returns, which for a put is
/// the whole body — the descriptor and the file in `incoming/` this is here to bound.
const MAX_OBJECTS_IN_FLIGHT: usize = 64;

#[derive(Clone)]
pub struct AppState {
    pub store: Arc<dyn ObjectStore>,
    pub max_bytes: u64,
}

/// `/health` sits outside the bearer layer: the load balancer probing it holds no fleet secret, and
/// it answers nothing a peer could not already infer from the socket being open.
pub fn router(state: AppState, fleet_secret: Arc<String>) -> Router {
    let objects = Router::new()
        .route(
            "/v1/objects/{hash}",
            put(put_object)
                .head(head_object)
                .get(get_object)
                .delete(delete_object),
        )
        // Declared before the bearer layer so the bearer wraps it too: a peer without the secret
        // has no business learning that this address answers some other verb.
        .method_not_allowed_fallback(method_not_allowed)
        // One semaphore rather than `ConcurrencyLimitLayer`'s: `Router::layer` clones the layer
        // into each method and the fallback, so a per-service limit would be this cap five times.
        .layer(GlobalConcurrencyLimitLayer::new(MAX_OBJECTS_IN_FLIGHT))
        .layer(middleware::from_fn(deadline_between_chunks))
        .layer(middleware::from_fn_with_state(
            fleet_secret,
            auth::require_fleet_bearer,
        ))
        .with_state(state);

    Router::new()
        .route("/health", get(health))
        // Reaches `/health` alone: the object routes were given theirs inside the bearer layer.
        .method_not_allowed_fallback(method_not_allowed)
        .merge(objects)
        .fallback(no_such_route)
        // On the OUTER router, which is what reaches the two fallbacks and the health probe as well
        // as the object routes: a refusal is the answer an operator is tracing.
        .layer(middleware::from_fn(correlate))
}

/// A peer that stops sending holds a task, a descriptor and a file in `incoming/`, and the gap
/// between one chunk and the next is the only place that shows.
async fn deadline_between_chunks(request: Request, next: middleware::Next) -> Response {
    next.run(request.map(|body| Body::new(TimeoutBody::new(BODY_IDLE_TIMEOUT, body))))
        .await
}

/// Joins one request to the caller that made it: the id it presented when that is one token this
/// service can log unchanged, and a fresh one when it is not. Put back on the request as well as
/// the answer, so a handler reads the id the caller will quote.
async fn correlate(mut request: Request, next: middleware::Next) -> Response {
    let id = request
        .headers()
        .get(request_id::HEADER)
        .and_then(|presented| presented.to_str().ok())
        .filter(|presented| request_id::valid(presented))
        .map_or_else(request_id::mint, str::to_owned);

    let value = HeaderValue::from_str(&id).expect("a checked request id is a header value");
    request
        .headers_mut()
        .insert(request_id::HEADER, value.clone());

    let mut response = next.run(request).await;
    response.headers_mut().insert(request_id::HEADER, value);
    response
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

async fn health() -> Json<Health> {
    Json(Health { ok: true })
}

async fn put_object(
    State(state): State<AppState>,
    Path(hash): Path<String>,
    headers: HeaderMap,
    body: Body,
) -> Result<Response, ApiError> {
    let hash = parse_hash(&hash)?;
    if declared_length(&headers).is_some_and(|length| length > state.max_bytes) {
        // Refused before a byte is read. The ceiling bounds what this process will spend, and
        // reading the body to discover it was too long is already spending it.
        return Err(ApiError::too_large(state.max_bytes));
    }

    let request = PutRequest {
        hash,
        content_type: content_type(&headers)?,
        max_bytes: state.max_bytes,
    };
    let stream = body
        .into_data_stream()
        .map(|chunk| chunk.map_err(std::io::Error::other));

    match state.store.put(request, Box::pin(stream)).await? {
        Stored::Created => Ok(StatusCode::CREATED.into_response()),
        Stored::AlreadyPresent => Ok(StatusCode::OK.into_response()),
    }
}

async fn head_object(
    State(state): State<AppState>,
    Path(hash): Path<String>,
) -> Result<Response, ApiError> {
    let head = state
        .store
        .head(&parse_hash(&hash)?)
        .await
        .map_err(ApiError::internal)?
        .ok_or_else(ApiError::not_found)?;
    Ok(object_headers(head.byte_length, head.content_type).into_response())
}

async fn get_object(
    State(state): State<AppState>,
    Path(hash): Path<String>,
) -> Result<Response, ApiError> {
    let (head, body) = state
        .store
        .get(&parse_hash(&hash)?)
        .await
        .map_err(ApiError::internal)?
        .ok_or_else(ApiError::not_found)?;
    Ok((
        object_headers(head.byte_length, head.content_type),
        Body::from_stream(body),
    )
        .into_response())
}

async fn delete_object(
    State(state): State<AppState>,
    Path(hash): Path<String>,
) -> Result<Response, ApiError> {
    let removed = state
        .store
        .delete(&parse_hash(&hash)?)
        .await
        .map_err(ApiError::internal)?;
    if removed {
        Ok(StatusCode::NO_CONTENT.into_response())
    } else {
        Err(ApiError::not_found())
    }
}

fn object_headers(byte_length: u64, content_type: String) -> [(HeaderName, String); 3] {
    [
        (CONTENT_TYPE, content_type),
        (CONTENT_LENGTH, byte_length.to_string()),
        (CACHE_CONTROL, IMMUTABLE.to_owned()),
    ]
}

fn parse_hash(raw: &str) -> Result<ObjectHash, ApiError> {
    ObjectHash::parse(raw).ok_or_else(|| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "an object is named by 64 lowercase hex characters",
        )
    })
}

fn declared_length(headers: &HeaderMap) -> Option<u64> {
    headers.get(CONTENT_LENGTH)?.to_str().ok()?.parse().ok()
}

fn content_type(headers: &HeaderMap) -> Result<String, ApiError> {
    let Some(value) = headers.get(CONTENT_TYPE) else {
        return Ok(DEFAULT_CONTENT_TYPE.to_owned());
    };
    let value = value.to_str().unwrap_or_default();
    if value.is_empty() || value.len() > MAX_CONTENT_TYPE_LEN {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            format!("Content-Type must be text of at most {MAX_CONTENT_TYPE_LEN} characters"),
        ));
    }
    Ok(value.to_owned())
}

/// A refusal on the wire, mirroring `ErrorBody` in `libs/api-contract`: a code a caller matches on
/// and a message a human reads.
#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

#[derive(Serialize)]
struct ErrorBody<'a> {
    code: &'a str,
    message: &'a str,
}

impl ApiError {
    fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }

    pub fn unauthorized() -> Self {
        Self::new(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "this service is reachable only from inside the fleet",
        )
    }

    fn not_found() -> Self {
        Self::new(
            StatusCode::NOT_FOUND,
            "not_found",
            "nothing is stored under that address",
        )
    }

    /// A 413 answers `invalid_request`: the contract's code set is closed, and a body over the
    /// ceiling is a request this service will not take rather than a failure on this side.
    fn too_large(max_bytes: u64) -> Self {
        Self::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "invalid_request",
            format!("an object may not exceed {max_bytes} bytes"),
        )
    }

    /// The cause goes to the log and never to the caller — a path, a permission or a disk is this
    /// side's to know.
    fn internal(err: anyhow::Error) -> Self {
        tracing::error!(error = ?err, "object store failed");
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            "the object store failed",
        )
    }
}

impl From<PutError> for ApiError {
    fn from(err: PutError) -> Self {
        match err {
            PutError::HashMismatch { computed } => Self::new(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                format!("the body hashes to {computed}, not to the name it was given"),
            ),
            PutError::TooLarge => Self::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "invalid_request",
                "the body ran past the ceiling this service stores under",
            ),
            PutError::Lost => Self::new(
                StatusCode::CONFLICT,
                "conflict",
                "the copy this upload was answered from is no longer whole; send it again",
            ),
            PutError::Source(err) => Self::new(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                format!("the upload ended before its body did: {err}"),
            ),
            PutError::Storage(err) => Self::internal(err),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(ErrorBody {
                code: self.code,
                message: &self.message,
            }),
        )
            .into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::FileStore;
    use axum::http::header::AUTHORIZATION;
    use axum::http::Request;
    use sha2::{Digest, Sha256};
    use tower::ServiceExt;

    const SECRET: &str = "a-fleet-secret-at-least-thirty-two-characters";
    const BODY: &[u8] = b"the bytes a session loads";

    fn name_of(bytes: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        let mut out = String::new();
        for byte in hasher.finalize() {
            out.push_str(&format!("{byte:02x}"));
        }
        out
    }

    async fn app(root: &std::path::Path) -> Router {
        let store = FileStore::open(root.to_path_buf()).await.unwrap();
        router(
            AppState {
                store: Arc::new(store),
                max_bytes: 1024,
            },
            Arc::new(SECRET.to_owned()),
        )
    }

    async fn body_of(response: Response) -> String {
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        String::from_utf8(bytes.to_vec()).unwrap()
    }

    fn upload(hash: &str, bytes: &'static [u8]) -> Request<Body> {
        Request::put(format!("/v1/objects/{hash}"))
            .header(AUTHORIZATION, format!("Bearer {SECRET}"))
            .header(CONTENT_TYPE, "application/wasm")
            .body(Body::from(bytes))
            .unwrap()
    }

    fn echoed(response: &Response) -> &str {
        response
            .headers()
            .get(request_id::HEADER)
            .expect("every answer carries the id it was served under")
            .to_str()
            .unwrap()
    }

    async fn answer(root: &std::path::Path, request: Request<Body>) -> Response {
        app(root).await.oneshot(request).await.unwrap()
    }

    #[tokio::test]
    async fn answers_the_probe_under_the_id_the_balancer_sent() {
        let root = tempfile::tempdir().unwrap();
        let response = answer(
            root.path(),
            Request::get("/health")
                .header(request_id::HEADER, "known-id")
                .body(Body::empty())
                .unwrap(),
        )
        .await;

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(echoed(&response), "known-id");
    }

    #[tokio::test]
    async fn replaces_an_id_too_long_for_a_log_line_rather_than_writing_it_down() {
        let root = tempfile::tempdir().unwrap();
        let presented = "a".repeat(request_id::MAX_LEN + 1);
        let response = answer(
            root.path(),
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
        let root = tempfile::tempdir().unwrap();
        let response = answer(
            root.path(),
            Request::get("/health").body(Body::empty()).unwrap(),
        )
        .await;

        assert!(request_id::valid(echoed(&response)));
    }

    /// The layer is on the outer router for these two: a refusal written by a fallback or by the
    /// bearer layer is exactly the answer an operator is tracing, and an inner mount would miss it.
    #[tokio::test]
    async fn carries_the_id_onto_a_route_that_does_not_exist() {
        let root = tempfile::tempdir().unwrap();
        let response = answer(
            root.path(),
            Request::get("/v1/nothing")
                .header(request_id::HEADER, "known-id")
                .body(Body::empty())
                .unwrap(),
        )
        .await;

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(echoed(&response), "known-id");
    }

    #[tokio::test]
    async fn carries_the_id_onto_an_object_call_the_bearer_layer_refused() {
        let root = tempfile::tempdir().unwrap();
        let response = answer(
            root.path(),
            Request::get(format!("/v1/objects/{}", name_of(BODY)))
                .header(request_id::HEADER, "known-id")
                .body(Body::empty())
                .unwrap(),
        )
        .await;

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(echoed(&response), "known-id");
    }

    #[tokio::test]
    async fn health_answers_outside_the_bearer_layer() {
        let root = tempfile::tempdir().unwrap();
        let response = app(root.path())
            .await
            .oneshot(Request::get("/health").body(Body::empty()).unwrap())
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(body_of(response).await, r#"{"ok":true}"#);
    }

    #[tokio::test]
    async fn an_object_route_without_a_bearer_is_unauthorized() {
        let root = tempfile::tempdir().unwrap();
        let response = app(root.path())
            .await
            .oneshot(
                Request::get(format!("/v1/objects/{}", name_of(BODY)))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert!(body_of(response).await.contains(r#""code":"unauthorized""#));
    }

    #[tokio::test]
    async fn another_secret_is_unauthorized() {
        let root = tempfile::tempdir().unwrap();
        let response = app(root.path())
            .await
            .oneshot(
                Request::get(format!("/v1/objects/{}", name_of(BODY)))
                    .header(AUTHORIZATION, "Bearer a-fleet-secret-from-somewhere-else")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn a_first_put_is_created_and_a_second_is_ok() {
        let root = tempfile::tempdir().unwrap();
        let app = app(root.path()).await;
        let hash = name_of(BODY);

        let created = app.clone().oneshot(upload(&hash, BODY)).await.unwrap();
        assert_eq!(created.status(), StatusCode::CREATED);

        let again = app.clone().oneshot(upload(&hash, BODY)).await.unwrap();
        assert_eq!(again.status(), StatusCode::OK);

        let read = app
            .oneshot(
                Request::get(format!("/v1/objects/{hash}"))
                    .header(AUTHORIZATION, format!("Bearer {SECRET}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(read.status(), StatusCode::OK);
        assert_eq!(read.headers()[CONTENT_TYPE], "application/wasm");
        assert_eq!(read.headers()[CACHE_CONTROL], IMMUTABLE);
        assert_eq!(body_of(read).await, String::from_utf8_lossy(BODY));
    }

    #[tokio::test]
    async fn bytes_that_are_not_their_name_are_refused() {
        let root = tempfile::tempdir().unwrap();
        let response = app(root.path())
            .await
            .oneshot(upload(&name_of(b"something else"), BODY))
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert!(body_of(response)
            .await
            .contains(r#""code":"invalid_request""#));
    }

    #[tokio::test]
    async fn a_declared_length_over_the_ceiling_is_refused_before_the_body() {
        let root = tempfile::tempdir().unwrap();
        let response = app(root.path())
            .await
            .oneshot(
                Request::put(format!("/v1/objects/{}", name_of(BODY)))
                    .header(AUTHORIZATION, format!("Bearer {SECRET}"))
                    .header(CONTENT_LENGTH, "1048576")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[tokio::test(start_paused = true)]
    async fn a_body_that_stops_arriving_is_abandoned_rather_than_held() {
        let root = tempfile::tempdir().unwrap();
        let stalled = Request::put(format!("/v1/objects/{}", name_of(BODY)))
            .header(AUTHORIZATION, format!("Bearer {SECRET}"))
            .body(Body::from_stream(futures_util::stream::pending::<
                std::io::Result<bytes::Bytes>,
            >()))
            .unwrap();

        // Well past the deadline, so a run that reaches it is one where no deadline fired at all.
        let response = tokio::time::timeout(
            BODY_IDLE_TIMEOUT * 120,
            app(root.path()).await.oneshot(stalled),
        )
        .await
        .expect("the body deadline never fired")
        .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test(start_paused = true)]
    async fn the_cap_counts_object_requests_rather_than_requests_per_method() {
        let root = tempfile::tempdir().unwrap();
        let app = app(root.path()).await;
        let hash = name_of(BODY);

        let stalled = || {
            Request::put(format!("/v1/objects/{hash}"))
                .header(AUTHORIZATION, format!("Bearer {SECRET}"))
                .body(Body::from_stream(futures_util::stream::pending::<
                    std::io::Result<bytes::Bytes>,
                >()))
                .unwrap()
        };
        let _holding: Vec<_> = (0..MAX_OBJECTS_IN_FLIGHT)
            .map(|_| tokio::spawn(app.clone().oneshot(stalled())))
            .collect();

        // Paused time advances only once every task is parked, so by here each put holds a permit.
        tokio::time::sleep(Duration::from_secs(1)).await;

        let head = Request::head(format!("/v1/objects/{hash}"))
            .header(AUTHORIZATION, format!("Bearer {SECRET}"))
            .body(Body::empty())
            .unwrap();
        assert!(
            tokio::time::timeout(Duration::from_secs(1), app.clone().oneshot(head))
                .await
                .is_err(),
            "a head answered while every permit was held by a put"
        );

        // `/health` is outside the cap, and a probe queued behind a publish burst is a load balancer
        // being told this process is gone.
        let probe = tokio::time::timeout(
            Duration::from_secs(1),
            app.oneshot(Request::get("/health").body(Body::empty()).unwrap()),
        )
        .await
        .expect("the health probe waited on an object permit")
        .unwrap();
        assert_eq!(probe.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn a_put_answered_from_a_copy_that_goes_away_is_a_conflict() {
        let root = tempfile::tempdir().unwrap();
        let app = app(root.path()).await;
        let hash = name_of(BODY);
        app.clone().oneshot(upload(&hash, BODY)).await.unwrap();

        // The delete lands inside the body, which is the window the check taken before it opens.
        let stored = root.path().join("objects").join(&hash[..2]).join(&hash);
        let vanishing = Body::from_stream(futures_util::stream::once(async move {
            std::fs::remove_file(stored)?;
            Ok::<_, std::io::Error>(bytes::Bytes::from_static(BODY))
        }));

        let response = app
            .oneshot(
                Request::put(format!("/v1/objects/{hash}"))
                    .header(AUTHORIZATION, format!("Bearer {SECRET}"))
                    .body(vanishing)
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::CONFLICT);
        assert!(body_of(response).await.contains(r#""code":"conflict""#));
    }

    #[tokio::test]
    async fn a_wrong_method_on_the_health_probe_carries_an_error_body() {
        let root = tempfile::tempdir().unwrap();
        let response = app(root.path())
            .await
            .oneshot(Request::post("/health").body(Body::empty()).unwrap())
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
        assert!(body_of(response)
            .await
            .contains(r#""code":"invalid_request""#));
    }

    #[tokio::test]
    async fn a_path_this_service_does_not_answer_carries_an_error_body() {
        let root = tempfile::tempdir().unwrap();
        let response = app(root.path())
            .await
            .oneshot(Request::get("/nope").body(Body::empty()).unwrap())
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert!(body_of(response).await.contains(r#""code":"not_found""#));
    }

    #[tokio::test]
    async fn a_wrong_method_carries_an_error_body_and_only_behind_the_bearer() {
        let root = tempfile::tempdir().unwrap();
        let app = app(root.path()).await;
        let path = format!("/v1/objects/{}", name_of(BODY));

        let anonymous = app
            .clone()
            .oneshot(Request::post(&path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(anonymous.status(), StatusCode::UNAUTHORIZED);

        let refused = app
            .oneshot(
                Request::post(&path)
                    .header(AUTHORIZATION, format!("Bearer {SECRET}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(refused.status(), StatusCode::METHOD_NOT_ALLOWED);
        assert!(body_of(refused)
            .await
            .contains(r#""code":"invalid_request""#));
    }

    #[tokio::test]
    async fn a_name_that_is_not_a_sha256_is_refused() {
        let root = tempfile::tempdir().unwrap();
        let response = app(root.path())
            .await
            .oneshot(
                Request::get("/v1/objects/not-a-hash")
                    .header(AUTHORIZATION, format!("Bearer {SECRET}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn head_and_delete_answer_for_a_stored_object_and_then_stop() {
        let root = tempfile::tempdir().unwrap();
        let app = app(root.path()).await;
        let hash = name_of(BODY);
        app.clone().oneshot(upload(&hash, BODY)).await.unwrap();

        let probe = |method: &'static str| {
            let app = app.clone();
            let hash = hash.clone();
            async move {
                app.oneshot(
                    Request::builder()
                        .method(method)
                        .uri(format!("/v1/objects/{hash}"))
                        .header(AUTHORIZATION, format!("Bearer {SECRET}"))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap()
            }
        };

        let head = probe("HEAD").await;
        assert_eq!(head.status(), StatusCode::OK);
        assert_eq!(head.headers()[CONTENT_LENGTH], BODY.len().to_string());
        assert_eq!(head.headers()[CONTENT_TYPE], "application/wasm");

        assert_eq!(probe("DELETE").await.status(), StatusCode::NO_CONTENT);
        assert_eq!(probe("DELETE").await.status(), StatusCode::NOT_FOUND);
        assert_eq!(probe("HEAD").await.status(), StatusCode::NOT_FOUND);
    }
}

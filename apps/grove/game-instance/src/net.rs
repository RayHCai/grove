//! The sockets: one listener, one task per peer, and the ticket check before either.
//! Nothing here knows what an entity is. The narrowing, and every bound on what one frame may
//! contain, is the sim's — this half refuses only what it can judge: the bytes, and the bearer.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{middleware, Json, Router};
use futures_util::{SinkExt, StreamExt};
use serde_json::value::RawValue;
use tokio::sync::mpsc;

use crate::protocol::{ConnectionId, SendClass};
use crate::session::HostEvent;
use crate::ticket;

/// 4 MiB, the same ceiling `@platform/transport`'s codec refuses a frame at. Restated rather than
/// derived, because the cap has to hold on this side BEFORE a parse: `serde_json` allocates a
/// graph several times the wire bytes, which no downstream check can undo.
pub const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;

/// Frames one peer may fall behind by before its droppable ones start being discarded.
const WRITE_QUEUE_DEPTH: usize = 64;

/// How long a joined peer may send nothing before its socket is closed. The client refreshes
/// `time-sync` every two seconds, so silence this long is a peer that stopped running —
/// including a tab the browser throttled to a stop, which is the point.
const IDLE_TIMEOUT: Duration = Duration::from_secs(15);

/// Frames one peer may send inside `INBOUND_WINDOW` before it is closed as a flood.
/// The sim refuses extra input a tick later, so this is the only bound on how fast one socket
/// can feed the event queue — an order of magnitude above what a 60 Hz client sends.
const INBOUND_BUDGET_FRAMES: usize = 600;
const INBOUND_WINDOW: Duration = Duration::from_secs(1);

/// How long the writer gets to drain its queue once the session has hung the peer up.
const FLUSH_GRACE: Duration = Duration::from_millis(250);

/// 2026-01-01, which is before this process was built and so before any ticket it can be shown.
///
/// A floor rather than a fallible read: `SystemTime` only errors for a clock set before 1970, so an
/// unset RTC arrives as a small positive number that every `exp` in existence outlives.
const EARLIEST_PLAUSIBLE_SECONDS: i64 = 1_767_225_600;

/// One thing on its way out: an envelope the writer may discard under pressure, or the close that
/// ends the socket.
pub enum Outgoing {
    Frame {
        text: Arc<String>,
        class: SendClass,
    },
    /// What the session died of, written as a close frame: the alternative the peer sees is a bare
    /// 1006, indistinguishable from a link that dropped.
    Death(&'static str),
}

impl Outgoing {
    fn into_message(self) -> Message {
        match self {
            Self::Frame { text, .. } => Message::Text(text.as_str().into()),
            // 1011: the server hit a condition it could not continue past, which is exactly what a
            // terminated or throwing tick is.
            Self::Death(reason) => Message::Close(Some(CloseFrame {
                code: 1011,
                reason: reason.into(),
            })),
        }
    }
}

/// The session thread's end of one peer's life: dropping it closes that socket.
///
/// A sender rather than a flag because the reader is parked in `.next()` and cannot poll anything —
/// only a cancellation it is selecting on can wake it, and a dropped sender is that cancellation.
pub struct HangUp(#[allow(dead_code)] mpsc::Sender<()>);

/// What `/healthz` answers with, mirroring the `Vitals` the agent on this box decodes.
#[derive(serde::Serialize)]
struct Vitals {
    players: usize,
}

#[derive(Clone)]
pub struct Listener {
    events: mpsc::UnboundedSender<HostEvent>,
    secret: Arc<Vec<u8>>,
    game_id: Arc<String>,
    session_id: Arc<String>,
    /// Written by the session thread after every tick and read by the health route: the agent on
    /// this box takes the roster from there, and a bare 200 reports a full box as empty.
    players: Arc<AtomicUsize>,
    /// Set when the process is draining, which is what stops a new peer joining a world that is
    /// about to end — and what lets the drain reach an empty roster at all.
    draining: Arc<AtomicBool>,
    next_id: Arc<AtomicU64>,
}

impl Listener {
    pub fn new(
        events: mpsc::UnboundedSender<HostEvent>,
        secret: Vec<u8>,
        game_id: String,
        session_id: String,
        players: Arc<AtomicUsize>,
        draining: Arc<AtomicBool>,
    ) -> Self {
        Self {
            events,
            secret: Arc::new(secret),
            game_id: Arc::new(game_id),
            session_id: Arc::new(session_id),
            players,
            draining,
            next_id: Arc::new(AtomicU64::new(1)),
        }
    }

    pub fn router(self) -> Router {
        Router::new()
            .route("/play", get(upgrade))
            .route("/healthz", get(healthz))
            .with_state(self)
            // Outermost, so the agent's probe and an upgrade refused before any handler ran are
            // both answered under the id their caller is tracing.
            .layer(middleware::from_fn(correlate))
    }
}

/// Joins one request to the caller that made it: the id it presented when that is one token this
/// process can log unchanged, and a fresh one when it is not. Put back on the request too, so a
/// handler reads the id the caller will quote.
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

/// The ticket rides the WebSocket SUBPROTOCOL, not the query string: a browser cannot set a
/// header on `new WebSocket(url)` but can name a subprotocol, and a URL ends up in access logs.
/// The value is `grove.ticket.<token>`, whose alphabet is legal in a subprotocol name.
const TICKET_PREFIX: &str = "grove.ticket.";

async fn upgrade(
    State(listener): State<Listener>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    if listener.draining.load(Ordering::Relaxed) {
        tracing::warn!(%peer, "accept-refused reason=draining");
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    let Some(offered) = subprotocol(&headers, TICKET_PREFIX) else {
        tracing::warn!(%peer, "accept-refused reason=no-ticket");
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let raw = &offered[TICKET_PREFIX.len()..];

    let now = unix_seconds();
    if now < EARLIEST_PLAUSIBLE_SECONDS {
        // A clock this process cannot trust is a check it cannot make, and `exp` is the only bound
        // a stolen ticket has — so the box refuses rather than admits.
        tracing::error!(%peer, "accept-refused reason=no-clock");
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }

    let claims = match ticket::verify(
        raw,
        &listener.secret,
        &listener.game_id,
        &listener.session_id,
        now,
    ) {
        Ok(claims) => claims,
        Err(failure) => {
            // Logged here and answered with nothing but a status: a peer that cannot present a
            // ticket has no session to be told about, and the reason is the operator's — carrying
            // both readings, since a box a minute fast refuses every honest ticket as `expired` and
            // no token names which of the two clocks moved.
            tracing::warn!(
                %peer,
                reason = failure.token(),
                exp = failure.expiry(),
                now,
                "accept-refused"
            );
            return StatusCode::UNAUTHORIZED.into_response();
        }
    };

    let connection_id = format!("c{}", listener.next_id.fetch_add(1, Ordering::Relaxed));
    // The session id is logged and never used again: it correlates this process's lines with the
    // allocator's that minted the ticket and the manager's that answers its reads.
    tracing::info!(
        conn = %connection_id,
        session = %claims.session_id,
        player = %claims.player_id,
        "accept conn"
    );
    let identity = claims.player_id;
    // Held on the codec as well, because its own defaults are 16 MiB a frame and 64 MiB a message —
    // against which the check in `serve` only ever sees bytes this process has already buffered.
    let ws = ws
        .max_message_size(MAX_FRAME_BYTES)
        .max_frame_size(MAX_FRAME_BYTES);
    // Echoed back, because a peer that named a subprotocol expects one and closes if it gets none.
    ws.protocols([offered.clone()])
        .on_upgrade(move |socket| serve(socket, listener, connection_id, identity))
}

async fn healthz(State(listener): State<Listener>) -> Json<Vitals> {
    Json(Vitals {
        players: listener.players.load(Ordering::Relaxed),
    })
}

fn subprotocol(headers: &HeaderMap, prefix: &str) -> Option<String> {
    headers
        .get("sec-websocket-protocol")?
        .to_str()
        .ok()?
        .split(',')
        .map(str::trim)
        .find(|value| value.starts_with(prefix) && value.len() > prefix.len())
        .map(str::to_owned)
}

async fn serve(
    socket: WebSocket,
    listener: Listener,
    connection_id: ConnectionId,
    identity: String,
) {
    let (writes, mut queue) = mpsc::channel::<Outgoing>(WRITE_QUEUE_DEPTH);
    let (hangup, mut hung_up) = mpsc::channel::<()>(1);
    if listener
        .events
        .send(HostEvent::Opened {
            connection_id: connection_id.clone(),
            identity,
            writes,
            hangup: HangUp(hangup),
        })
        .is_err()
    {
        return;
    }

    let (mut sink, mut stream) = socket.split();

    let mut writer = tokio::spawn(async move {
        while let Some(outgoing) = queue.recv().await {
            // Nothing follows a close, and the frame after one would be written to a socket the
            // peer has already been told is going.
            let last = matches!(outgoing, Outgoing::Death(_));
            if sink.send(outgoing.into_message()).await.is_err() || last {
                break;
            }
        }
    });

    let mut hung_up_by_session = false;
    let mut inbound = Inbound::new(Instant::now());
    loop {
        let frame = tokio::select! {
            // The session thread hung this peer up: its `HangUp` was dropped, so this arm completes
            _ = hung_up.recv() => {
                hung_up_by_session = true;
                break;
            },
            frame = tokio::time::timeout(IDLE_TIMEOUT, stream.next()) => match frame {
                Ok(Some(Ok(frame))) => frame,
                // Nothing on this wire is a ping, so silence is the only evidence there is: a peer
                // whose TCP stack still answers while its application has stopped holds a slot and
                // holds the drain open behind it.
                Err(_) => {
                    tracing::warn!(conn = %connection_id, "close conn reason=idle");
                    break;
                }
                _ => break,
            },
        };
        if !inbound.admit(Instant::now()) {
            tracing::warn!(conn = %connection_id, "close conn reason=inbound-flood");
            break;
        }
        let text = match frame {
            Message::Text(text) => text,
            Message::Close(_) => break,
            // Binary is not on this wire: the codec is JSON on both ends, and a peer sending bytes
            // is a peer running something else.
            _ => continue,
        };
        if text.len() > MAX_FRAME_BYTES {
            tracing::warn!(conn = %connection_id, "close conn reason=frame-too-large");
            break;
        }
        // Validated as JSON and never parsed into a tree: what a frame is allowed to CONTAIN is the
        // sim's to bound, a second opinion here would be a second copy of every cap that package
        // already states, and the bytes reach it exactly as the peer sent them.
        let Ok(message) = RawValue::from_string(text.to_string()) else {
            continue;
        };
        if listener
            .events
            .send(HostEvent::Frame {
                connection_id: connection_id.clone(),
                message,
            })
            .is_err()
        {
            break;
        }
    }

    // Only when the session hung up, where it dropped `writes` with `hangup` so the queue ends on
    // its own: the grace is what puts a `Reject` or a death token on the wire ahead of the close,
    // and awaiting a writer whose sender is still held would never return.
    if hung_up_by_session {
        let _ = tokio::time::timeout(FLUSH_GRACE, &mut writer).await;
    }
    writer.abort();
    let _ = listener.events.send(HostEvent::Closed { connection_id });
}

/// One peer's inbound allowance, refilled a window at a time.
///
/// `now` is passed in rather than read here for the same reason the ticket's clock is: a test can
/// put it where it needs it.
struct Inbound {
    window_opened: Instant,
    frames: usize,
}

impl Inbound {
    fn new(now: Instant) -> Self {
        Self {
            window_opened: now,
            frames: 0,
        }
    }

    /// Counts one frame and answers whether the peer is still inside its budget.
    fn admit(&mut self, now: Instant) -> bool {
        if now.duration_since(self.window_opened) >= INBOUND_WINDOW {
            self.window_opened = now;
            self.frames = 0;
        }
        self.frames += 1;
        self.frames <= INBOUND_BUDGET_FRAMES
    }
}

fn unix_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request as HttpRequest;
    use tower::ServiceExt;

    /// A listener holding nothing: every route under test answers without a world behind it.
    fn listening() -> Listener {
        let (events, _receiver) = mpsc::unbounded_channel();
        Listener::new(
            events,
            b"a-token-secret-at-least-thirty-two-ch".to_vec(),
            "9f1c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f".to_owned(),
            "5d9a0c3b-7e21-4f44-9b0d-3c5e7a9f1b24".to_owned(),
            Arc::new(AtomicUsize::new(0)),
            Arc::new(AtomicBool::new(false)),
        )
    }

    async fn probe(presented: Option<&str>) -> Response {
        let mut request = HttpRequest::get("/healthz");
        if let Some(id) = presented {
            request = request.header(request_id::HEADER, id);
        }
        listening()
            .router()
            .oneshot(request.body(Body::empty()).unwrap())
            .await
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

    #[tokio::test]
    async fn answers_the_agents_probe_under_the_id_the_agent_sent() {
        let response = probe(Some("known-id")).await;

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(echoed(&response), "known-id");
    }

    #[tokio::test]
    async fn replaces_an_id_too_long_for_a_log_line_rather_than_writing_it_down() {
        let presented = "a".repeat(65);
        let response = probe(Some(&presented)).await;

        assert_ne!(echoed(&response), presented);
        assert!(request_id::valid(echoed(&response)));
    }

    #[tokio::test]
    async fn mints_one_for_a_caller_that_presented_none() {
        let response = probe(None).await;

        assert!(request_id::valid(echoed(&response)));
    }

    /// A refusal is what an operator traces, and this one is written by the extractors rather than
    /// by any handler — which is exactly the answer a layer mounted inside the router would miss.
    #[tokio::test]
    async fn carries_the_id_onto_an_upgrade_refused_before_a_handler_ran() {
        let response = listening()
            .router()
            .oneshot(
                HttpRequest::get("/play")
                    .header(request_id::HEADER, "known-id")
                    .extension(ConnectInfo(
                        "127.0.0.1:4000"
                            .parse::<SocketAddr>()
                            .expect("a loopback peer"),
                    ))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(echoed(&response), "known-id");
    }

    #[test]
    fn closes_a_peer_that_outruns_its_window() {
        let opened = Instant::now();
        let mut inbound = Inbound::new(opened);

        for _ in 0..INBOUND_BUDGET_FRAMES {
            assert!(inbound.admit(opened));
        }
        assert!(!inbound.admit(opened));
    }

    #[test]
    fn refills_the_allowance_a_window_later() {
        let opened = Instant::now();
        let mut inbound = Inbound::new(opened);

        for _ in 0..=INBOUND_BUDGET_FRAMES {
            inbound.admit(opened);
        }
        assert!(inbound.admit(opened + INBOUND_WINDOW));
    }
}

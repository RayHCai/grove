//! The sockets: one listener, one task per peer, and the ticket check that happens before either.
//!
//! Nothing here knows what an entity is. A frame is decoded to JSON and handed on; an envelope is
//! encoded and written. The narrowing, and every bound on what one frame may contain, is the sim's —
//! this half only refuses what it can judge without a world: the bytes, and the bearer.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;

use crate::protocol::{ConnectionId, SendClass};
use crate::session::HostEvent;
use crate::ticket;

/// 4 MiB, the same ceiling `@platform/transport`'s codec refuses a frame at.
///
/// Restated rather than derived, because the two run in different languages and the cap has to hold
/// on this side BEFORE a parse: `serde_json` allocates a graph several times the wire bytes, so an
/// unbounded frame is an unbounded allocation no check downstream can undo.
pub const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;

/// Frames one peer may fall behind by before its droppable ones start being discarded.
const WRITE_QUEUE_DEPTH: usize = 64;

/// One frame on its way out, and whether the writer may discard it under pressure.
pub struct Outgoing {
    pub text: Arc<String>,
    pub class: SendClass,
}

#[derive(Clone)]
pub struct Listener {
    events: mpsc::UnboundedSender<HostEvent>,
    secret: Arc<Vec<u8>>,
    game_id: Arc<String>,
    next_id: Arc<AtomicU64>,
}

impl Listener {
    pub fn new(events: mpsc::UnboundedSender<HostEvent>, secret: Vec<u8>, game_id: String) -> Self {
        Self {
            events,
            secret: Arc::new(secret),
            game_id: Arc::new(game_id),
            next_id: Arc::new(AtomicU64::new(1)),
        }
    }

    pub fn router(self) -> Router {
        Router::new()
            .route("/play", get(upgrade))
            .route("/healthz", get(|| async { StatusCode::OK }))
            .with_state(self)
    }
}

/// The ticket rides the WebSocket SUBPROTOCOL, not the query string.
///
/// A browser cannot set a header on `new WebSocket(url)` but it can name a subprotocol, and a URL
/// ends up in access logs, proxy traces and `Referer` while a subprotocol does not. The value is
/// `grove.ticket.<token>`; the token's own alphabet is base64url plus one dot, all of which are
/// legal in a subprotocol name.
const TICKET_PREFIX: &str = "grove.ticket.";

async fn upgrade(
    State(listener): State<Listener>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    let Some(offered) = subprotocol(&headers, TICKET_PREFIX) else {
        tracing::warn!(%peer, "accept-refused reason=no-ticket");
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let raw = &offered[TICKET_PREFIX.len()..];

    let claims = match ticket::verify(raw, &listener.secret, &listener.game_id, unix_seconds()) {
        Ok(claims) => claims,
        Err(failure) => {
            // Logged here and answered with nothing but a status: a peer that cannot present a
            // ticket has no session to be told about, and the reason is the operator's.
            tracing::warn!(%peer, reason = failure.token(), "accept-refused");
            return StatusCode::UNAUTHORIZED.into_response();
        }
    };

    let connection_id = format!("c{}", listener.next_id.fetch_add(1, Ordering::Relaxed));
    let identity = claims.player_id;
    // Echoed back, because a peer that named a subprotocol expects one and closes if it gets none.
    ws.protocols([offered.clone()])
        .on_upgrade(move |socket| serve(socket, listener, connection_id, identity))
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

async fn serve(socket: WebSocket, listener: Listener, connection_id: ConnectionId, identity: String) {
    let (writes, mut queue) = mpsc::channel::<Outgoing>(WRITE_QUEUE_DEPTH);
    if listener
        .events
        .send(HostEvent::Opened {
            connection_id: connection_id.clone(),
            identity,
            writes,
        })
        .is_err()
    {
        return;
    }

    let (mut sink, mut stream) = socket.split();

    let writer = tokio::spawn(async move {
        while let Some(outgoing) = queue.recv().await {
            if sink.send(Message::Text(outgoing.text.as_str().into())).await.is_err() {
                break;
            }
        }
    });

    while let Some(frame) = stream.next().await {
        let Ok(frame) = frame else { break };
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
        // Decoded, never narrowed: what a frame is allowed to CONTAIN is the sim's to bound, and a
        // second opinion here would be a second copy of every cap that package already states.
        let Ok(message) = serde_json::from_str(&text) else { continue };
        if listener
            .events
            .send(HostEvent::Frame { connection_id: connection_id.clone(), message })
            .is_err()
        {
            break;
        }
    }

    writer.abort();
    let _ = listener.events.send(HostEvent::Closed { connection_id });
}

fn unix_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

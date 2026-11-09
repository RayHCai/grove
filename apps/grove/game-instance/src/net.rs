//! The sockets: one listener, one task per peer, and the ticket check before either.
//! A connection is bounded before it is a peer too: a deadline on its request head, and two caps.
//! Nothing here knows what an entity is. The narrowing, and every bound on what one frame may
//! contain, is the sim's; this half refuses only what it can judge: the bytes, and the bearer.

use std::io;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{middleware, Json, Router};
use futures_util::{SinkExt, StreamExt};
use hyper::body::Incoming;
use hyper_util::rt::{TokioIo, TokioTimer};
use serde_json::value::RawValue;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio::sync::mpsc::error::TrySendError;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tower::Service as _;

use crate::protocol::{ConnectionId, SendClass};
use crate::session::HostEvent;
use crate::ticket::{Gate, TicketFailure};

/// 4 MiB, the same ceiling `@platform/transport`'s codec refuses a frame at. Restated rather than
/// derived, because the cap has to hold on this side BEFORE a parse: `serde_json` allocates a
/// graph several times the wire bytes, which no downstream check can undo.
pub const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;

/// Frames one peer may fall behind by before its droppable ones start being discarded.
const WRITE_QUEUE_DEPTH: usize = 64;

/// How long a joined peer may send nothing before its socket is closed. The client refreshes
/// `time-sync` every two seconds, so silence this long is a peer that stopped running,
/// including a tab the browser throttled to a stop, which is the point.
const IDLE_TIMEOUT: Duration = Duration::from_secs(15);

/// Frames one peer may send inside `INBOUND_WINDOW` before it is closed as a flood.
/// The sim refuses extra input a tick later, so this is the only bound on how fast one socket
/// can feed the event queue, an order of magnitude above what a 60 Hz client sends.
const INBOUND_BUDGET_FRAMES: usize = 600;
/// Bytes one peer may send inside `INBOUND_WINDOW`: two whole frames at the codec's ceiling, so a
/// legitimate large frame fits, while a peer cannot hold the frame budget at 4 MiB apiece.
const INBOUND_BUDGET_BYTES: usize = 2 * MAX_FRAME_BYTES;
const INBOUND_WINDOW: Duration = Duration::from_secs(1);

/// How long the writer gets to drain its queue once the session has hung the peer up.
const FLUSH_GRACE: Duration = Duration::from_millis(250);

/// How long a request head may take to arrive, which also bounds a connection idling between two.
const HEADER_READ_TIMEOUT: Duration = Duration::from_secs(5);

/// Connections not yet upgraded: a handshake on its way through, or the agent's probe.
const MAX_HANDSHAKES: usize = 64;

/// Every socket this process holds at once, a peer's included, each a task and a write queue.
const MAX_CONNECTIONS: usize = 1024;

/// What hyper may buffer of one request head: a ticket and a handful of headers fit many times over.
const MAX_HEAD_BYTES: usize = 16 * 1024;

/// How long the accept loop rests after a failed accept, which is a box out of descriptors.
const ACCEPT_BACKOFF: Duration = Duration::from_millis(100);

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
/// A sender rather than a flag because the reader is parked in `.next()` and cannot poll anything:
/// only a cancellation it is selecting on can wake it, and a dropped sender is that cancellation.
pub struct HangUp {
    _sender: mpsc::Sender<()>,
}

/// What `/healthz` answers with, mirroring the `Vitals` the agent on this box decodes.
#[derive(serde::Serialize)]
struct Vitals {
    players: usize,
}

#[derive(Clone)]
pub struct Listener {
    events: mpsc::Sender<HostEvent>,
    gate: Arc<Gate>,
    /// Written by the session thread after every tick and read by the health route: the agent on
    /// this box takes the roster from there, and a bare 200 reports a full box as empty.
    players: Arc<AtomicUsize>,
    /// Set when the process is draining, which is what stops a new peer joining a world that is
    /// about to end, and what lets the drain reach an empty roster at all.
    draining: Arc<AtomicBool>,
    next_id: Arc<AtomicU64>,
}

impl Listener {
    pub fn new(
        events: mpsc::Sender<HostEvent>,
        gate: Gate,
        players: Arc<AtomicUsize>,
        draining: Arc<AtomicBool>,
    ) -> Self {
        Self {
            events,
            gate: Arc::new(gate),
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
            .layer(middleware::from_fn(request_id::correlate))
    }
}

/// What a connection may cost before it is a peer; a deploy runs the defaults.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub header_read: Duration,
    pub handshakes: usize,
    pub connections: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            header_read: HEADER_READ_TIMEOUT,
            handshakes: MAX_HANDSHAKES,
            connections: MAX_CONNECTIONS,
        }
    }
}

/// Serves `router` over HTTP/1.1 with upgrades. hyper is driven directly because `axum::serve`
/// gives it no timer, and hyper without one silently drops the header deadline.
pub async fn listen(socket: TcpListener, router: Router, limits: Limits) -> io::Result<()> {
    let connections = Arc::new(Semaphore::new(limits.connections));
    let handshakes = Arc::new(Semaphore::new(limits.handshakes));
    loop {
        // Taken before the accept, so past either cap the next peer waits in the kernel's backlog.
        let (Ok(held), Ok(handshake)) = (
            connections.clone().acquire_owned().await,
            handshakes.clone().acquire_owned().await,
        ) else {
            return Err(io::Error::other("the connection caps were closed"));
        };
        let (stream, peer) = match socket.accept().await {
            Ok(accepted) => accepted,
            Err(error) => {
                tracing::warn!(%error, "accept failed");
                tokio::time::sleep(ACCEPT_BACKOFF).await;
                continue;
            }
        };
        // A tick's frames are small and late is worse than many: Nagle would hold one for an ACK.
        let _ = stream.set_nodelay(true);

        let router = router.clone();
        tokio::spawn(async move {
            let service =
                hyper::service::service_fn(move |mut request: hyper::Request<Incoming>| {
                    request.extensions_mut().insert(ConnectInfo(peer));
                    router.clone().call(request)
                });
            let mut http = hyper::server::conn::http1::Builder::new();
            http.timer(TokioTimer::new())
                .header_read_timeout(limits.header_read)
                .max_buf_size(MAX_HEAD_BYTES);
            let io = TokioIo::new(Held {
                stream,
                _held: held,
            });
            if let Err(error) = http.serve_connection(io, service).with_upgrades().await {
                tracing::debug!(%peer, %error, "connection ended");
            }
            // An upgrade ends this future at the hand-off, which is where a handshake becomes a peer.
            drop(handshake);
        });
    }
}

/// A socket holding its place under the connection cap, which it gives back only when dropped,
/// so a peer's socket keeps its place after the upgrade carried it off.
struct Held {
    stream: TcpStream,
    _held: OwnedSemaphorePermit,
}

impl AsyncRead for Held {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().stream).poll_read(cx, buf)
    }
}

impl AsyncWrite for Held {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().stream).poll_write(cx, buf)
    }

    fn poll_write_vectored(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().stream).poll_write_vectored(cx, bufs)
    }

    fn is_write_vectored(&self) -> bool {
        self.stream.is_write_vectored()
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().stream).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().stream).poll_shutdown(cx)
    }
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
        // a stolen ticket has, so the box refuses rather than admits.
        tracing::error!(%peer, "accept-refused reason=no-clock");
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }

    let claims = match listener.gate.admit(raw, now) {
        Ok(claims) => claims,
        Err(failure) => {
            // Logged here and answered with nothing but a status: a peer that cannot present a
            // ticket has no session to be told about, and the reason is the operator's, carrying
            // both readings, since a box a minute fast refuses every honest ticket as `expired` and
            // no token names which of the two clocks moved.
            tracing::warn!(
                %peer,
                reason = failure.token(),
                exp = failure.expiry(),
                now,
                "accept-refused"
            );
            // A full set of spent tickets is this process's limit, which a peer can wait out.
            if failure == TicketFailure::Crowded {
                return StatusCode::SERVICE_UNAVAILABLE.into_response();
            }
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
    // Held on the codec as well, because its own defaults are 16 MiB a frame and 64 MiB a message,
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
            hangup: HangUp { _sender: hangup },
        })
        .await
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
        if !inbound.admit(Instant::now(), frame_bytes(&frame)) {
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
        match listener.events.try_send(HostEvent::Frame {
            connection_id: connection_id.clone(),
            message,
        }) {
            Ok(()) => {}
            // The session is a whole queue behind: a peer that waited here would hold every frame it
            // has read in memory, so it goes, as a flood would.
            Err(TrySendError::Full(_)) => {
                tracing::warn!(conn = %connection_id, "close conn reason=event-queue-full");
                break;
            }
            Err(TrySendError::Closed(_)) => break,
        }
    }

    // Only when the session hung up, where it dropped `writes` with `hangup` so the queue ends on
    // its own: the grace is what puts a `Reject` or a death token on the wire ahead of the close,
    // and awaiting a writer whose sender is still held would never return.
    if hung_up_by_session {
        let _ = tokio::time::timeout(FLUSH_GRACE, &mut writer).await;
    }
    writer.abort();
    let _ = listener
        .events
        .send(HostEvent::Closed { connection_id })
        .await;
}

fn frame_bytes(frame: &Message) -> usize {
    match frame {
        Message::Text(text) => text.len(),
        Message::Binary(bytes) => bytes.len(),
        _ => 0,
    }
}

/// One peer's inbound allowance, refilled a window at a time.
///
/// `now` is passed in rather than read here for the same reason the ticket's clock is: a test can
/// put it where it needs it.
struct Inbound {
    window_opened: Instant,
    frames: usize,
    bytes: usize,
}

impl Inbound {
    fn new(now: Instant) -> Self {
        Self {
            window_opened: now,
            frames: 0,
            bytes: 0,
        }
    }

    /// Counts one frame of `bytes` and answers whether the peer is still inside both budgets.
    fn admit(&mut self, now: Instant, bytes: usize) -> bool {
        if now.duration_since(self.window_opened) >= INBOUND_WINDOW {
            self.window_opened = now;
            self.frames = 0;
            self.bytes = 0;
        }
        self.frames += 1;
        self.bytes = self.bytes.saturating_add(bytes);
        self.frames <= INBOUND_BUDGET_FRAMES && self.bytes <= INBOUND_BUDGET_BYTES
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
    use crate::ticket::tests::{claims, keys, mint, GAME, PLAYER, SEED, SESSION};
    use axum::body::Body;
    use axum::http::Request as HttpRequest;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tower::ServiceExt;

    fn listener(events: mpsc::Sender<HostEvent>) -> Listener {
        Listener::new(
            events,
            Gate::new(keys(), GAME.to_owned(), SESSION.to_owned()),
            Arc::new(AtomicUsize::new(0)),
            Arc::new(AtomicBool::new(false)),
        )
    }

    /// A listener holding nothing: every route under test answers without a world behind it.
    fn listening() -> Listener {
        listener(mpsc::channel(1).0)
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
    /// by any handler, which is exactly the answer a layer mounted inside the router would miss.
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
            assert!(inbound.admit(opened, 1));
        }
        assert!(!inbound.admit(opened, 1));
    }

    #[test]
    fn closes_a_peer_that_sends_too_many_bytes_in_few_frames() {
        let opened = Instant::now();
        let mut inbound = Inbound::new(opened);

        assert!(inbound.admit(opened, MAX_FRAME_BYTES));
        assert!(inbound.admit(opened, MAX_FRAME_BYTES));
        assert!(!inbound.admit(opened, 1));
        assert!(inbound.admit(opened + INBOUND_WINDOW, MAX_FRAME_BYTES));
    }

    #[test]
    fn refills_the_allowance_a_window_later() {
        let opened = Instant::now();
        let mut inbound = Inbound::new(opened);

        for _ in 0..=INBOUND_BUDGET_FRAMES {
            inbound.admit(opened, 1);
        }
        assert!(inbound.admit(opened + INBOUND_WINDOW, 1));
    }

    /// The listener for real, on loopback, under `limits`.
    async fn bound(limits: Limits) -> (SocketAddr, mpsc::Receiver<HostEvent>) {
        let (events, opened) = mpsc::channel(16);
        let socket = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = socket.local_addr().unwrap();
        tokio::spawn(listen(socket, listener(events).router(), limits));
        (addr, opened)
    }

    /// Writes `head` and reads back as far as the end of the answer's head.
    async fn ask(stream: &mut TcpStream, head: &str) -> String {
        stream.write_all(head.as_bytes()).await.unwrap();
        let mut answer = Vec::new();
        let mut chunk = [0u8; 1024];
        while !answer.windows(4).any(|four| four == b"\r\n\r\n") {
            match stream.read(&mut chunk).await.unwrap() {
                0 => break,
                read => answer.extend_from_slice(&chunk[..read]),
            }
        }
        String::from_utf8_lossy(&answer).to_lowercase()
    }

    fn handshake(ticket: &str) -> String {
        format!(
            "GET /play HTTP/1.1\r\nHost: world\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\
             Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\
             Sec-WebSocket-Protocol: grove.ticket.{ticket}\r\n\r\n"
        )
    }

    const PROBE: &str = "GET /healthz HTTP/1.1\r\nHost: world\r\n\r\n";

    fn ticket() -> String {
        mint(&claims(unix_seconds() + 60), SEED)
    }

    /// A ticket opens one socket: the bytes that upgraded one peer are refused for the next.
    #[tokio::test]
    async fn upgrades_a_peer_holding_a_ticket_and_spends_the_ticket() {
        let (addr, mut opened) = bound(Limits::default()).await;
        let ticket = ticket();

        let mut first = TcpStream::connect(addr).await.unwrap();
        let answer = ask(&mut first, &handshake(&ticket)).await;
        assert!(answer.starts_with("http/1.1 101"), "{answer}");
        assert!(answer
            .contains(&format!("sec-websocket-protocol: grove.ticket.{ticket}").to_lowercase()));
        match opened.recv().await {
            Some(HostEvent::Opened { identity, .. }) => assert_eq!(identity, PLAYER),
            _ => panic!("the session was not told about the peer"),
        }

        let mut second = TcpStream::connect(addr).await.unwrap();
        let answer = ask(&mut second, &handshake(&ticket)).await;
        assert!(answer.starts_with("http/1.1 401"), "{answer}");
    }

    #[tokio::test]
    async fn drops_a_connection_that_never_finishes_its_request_head() {
        let limits = Limits {
            header_read: Duration::from_millis(200),
            ..Limits::default()
        };
        let (addr, _opened) = bound(limits).await;

        let mut stalled = TcpStream::connect(addr).await.unwrap();
        stalled
            .write_all(b"GET /healthz HTTP/1.1\r\nHost: wor")
            .await
            .unwrap();
        let mut rest = Vec::new();
        let ended =
            tokio::time::timeout(Duration::from_secs(5), stalled.read_to_end(&mut rest)).await;

        assert!(ended.is_ok(), "the half-sent head held its socket open");
    }

    /// Past the cap a peer waits in the backlog rather than being served, and a freed slot serves it.
    #[tokio::test]
    async fn serves_no_more_handshakes_at_once_than_its_cap() {
        let limits = Limits {
            handshakes: 1,
            ..Limits::default()
        };
        let (addr, _opened) = bound(limits).await;

        let holding = TcpStream::connect(addr).await.unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        let mut waiting = TcpStream::connect(addr).await.unwrap();
        waiting.write_all(PROBE.as_bytes()).await.unwrap();
        let mut early = [0u8; 1];
        assert!(
            tokio::time::timeout(Duration::from_millis(300), waiting.read(&mut early))
                .await
                .is_err(),
            "a probe was served while the only handshake slot was held"
        );

        drop(holding);
        let answer = tokio::time::timeout(Duration::from_secs(5), ask(&mut waiting, ""))
            .await
            .expect("the freed slot never served the waiting probe");
        assert!(answer.starts_with("http/1.1 200"), "{answer}");
    }

    #[tokio::test]
    async fn an_upgraded_peer_gives_its_handshake_slot_back() {
        let limits = Limits {
            handshakes: 1,
            ..Limits::default()
        };
        let (addr, mut opened) = bound(limits).await;

        let mut peer = TcpStream::connect(addr).await.unwrap();
        assert!(ask(&mut peer, &handshake(&ticket()))
            .await
            .starts_with("http/1.1 101"));
        assert!(opened.recv().await.is_some());

        let mut probe = TcpStream::connect(addr).await.unwrap();
        let answer = tokio::time::timeout(Duration::from_secs(5), ask(&mut probe, PROBE))
            .await
            .expect("the upgraded peer still held the only handshake slot");
        assert!(answer.starts_with("http/1.1 200"), "{answer}");
    }

    /// The upgrade carries the socket off, and its place under the cap goes with it until it closes.
    #[tokio::test]
    async fn an_upgraded_peer_keeps_its_place_under_the_connection_cap() {
        let limits = Limits {
            connections: 1,
            ..Limits::default()
        };
        let (addr, mut opened) = bound(limits).await;

        let mut peer = TcpStream::connect(addr).await.unwrap();
        assert!(ask(&mut peer, &handshake(&ticket()))
            .await
            .starts_with("http/1.1 101"));
        // Held as the session holds it: dropping the event's hang-up is what closes a peer.
        let _session = opened
            .recv()
            .await
            .expect("the session was told about the peer");

        let mut probe = TcpStream::connect(addr).await.unwrap();
        probe.write_all(PROBE.as_bytes()).await.unwrap();
        let mut early = [0u8; 1];
        assert!(
            tokio::time::timeout(Duration::from_millis(300), probe.read(&mut early))
                .await
                .is_err(),
            "a probe was served while the peer held the only place"
        );

        drop(peer);
        let answer = tokio::time::timeout(Duration::from_secs(5), ask(&mut probe, ""))
            .await
            .expect("the closed peer never gave its place back");
        assert!(answer.starts_with("http/1.1 200"), "{answer}");
    }
}

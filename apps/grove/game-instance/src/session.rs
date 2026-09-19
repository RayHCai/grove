//! The session thread: the one place the isolate is touched, and the loop that turns arrivals
//! into batches and batches into writes. A `JsRuntime` is not `Send`, so it never crosses into a
//! `tokio` task — which is what makes the tick a single-threaded, ordered, replayable sequence.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Result};
use serde_json::value::RawValue;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::clock::Clock;
use crate::isolate::{Death, Isolate};
use crate::net::{HangUp, Outgoing};
use crate::protocol::{
    ConnectionId, InboundFrame, InputBatch, LoadedRecord, OpenedConnection, OutputBatch, Rates,
    SendClass, SimDiagnostics,
};
use crate::store::Store;

/// What the bundle and every `@onStart` in it may spend before the watchdog calls the boot a
/// runaway, sized as its own allowance because compiling megabytes of creator code once
/// legitimately outruns a tick and still has to land inside the agent's start grace.
const BOOT_BUDGET: Duration = Duration::from_secs(10);

/// What the close may spend releasing every session still on the world, which is more than a tick
/// because it dispatches a leave for all of them at once and terminating it would discard the one
/// batch their saves travel in.
const CLOSE_BUDGET: Duration = Duration::from_secs(2);

/// How long a drain waits for the last player to leave before ending the session regardless.
/// This and the three deadlines below run back to back, and together must finish inside the
/// twenty seconds `@grove/instance-manager` allows before it kills the child.
const DRAIN_DEADLINE: Duration = Duration::from_secs(6);

/// How long the runtime is held open for frames queued to the peers being hung up.
/// Longer than the writer's own grace: dropping the runtime first cancels the writer inside its
/// `send`, and the death token the socket was closed with is the frame that never lands.
const FLUSH_DEADLINE: Duration = Duration::from_secs(1);

/// How long the runtime is held open at the end for the writes already in flight.
const SETTLE_DEADLINE: Duration = Duration::from_secs(8);

/// Attempts one save gets before the sim is left holding the record.
const SAVE_ATTEMPTS: u32 = 3;

/// Wait before the second attempt, doubled for each one after it.
const SAVE_BACKOFF: Duration = Duration::from_millis(200);

/// Everything the async half tells the session thread. One channel, so the order is one order.
pub enum HostEvent {
    Opened {
        connection_id: ConnectionId,
        /// From the verified ticket. Never a frame's claim.
        identity: String,
        writes: mpsc::Sender<Outgoing>,
        /// Dropping this ends the peer's task, which is how a socket is actually closed: the writer
        /// alone going away leaves the reader parked on a socket nobody is answering.
        hangup: HangUp,
    },
    Frame {
        connection_id: ConnectionId,
        message: Box<RawValue>,
    },
    Closed {
        connection_id: ConnectionId,
    },
    /// An answer to a `LoadOrder`. `None` means the read FAILED, which the sim treats differently
    /// from a store that simply held nothing.
    Loaded {
        connection_id: ConnectionId,
        fields: Option<Box<RawValue>>,
    },
    /// A `SaveOrder` that reached the store, so the sim may release the record it was holding.
    Saved {
        host_key: String,
    },
    /// Stop taking new connections and end once the world is empty — a deploy, not a crash.
    Drain,
    /// The async half failed at something the session cannot run without, such as the bind.
    ///
    /// It ends the session where it stands rather than draining it, so it must not be raised for a
    /// fault the world could have been closed through.
    Fatal {
        error: String,
    },
}

pub struct SessionOptions {
    pub bundle: String,
    pub sim_config: String,
    pub sim_rate: f64,
    pub send_rate: f64,
    pub heap_limit_bytes: usize,
    pub tick_budget: Duration,
    pub store: Store,
    /// Where this thread publishes its roster for `/healthz` to answer from.
    pub players: Arc<AtomicUsize>,
}

/// Runs one session to its end. Blocking, and owns the thread it is called on.
///
/// `answers` is the other end of `events`: a load and a save are answered on the async side, and
/// their replies come back into this same queue, which is what keeps one order over everything.
pub fn run(
    opts: SessionOptions,
    mut events: mpsc::UnboundedReceiver<HostEvent>,
    answers: mpsc::UnboundedSender<HostEvent>,
    io: tokio::runtime::Handle,
) -> Result<()> {
    // Held for the life of this thread, before the isolate exists: V8 posts delayed tasks and
    // deno_core schedules them on the ambient runtime, so an isolate built outside one silently
    // loses every timer it asks for.
    let _entered = io.enter();

    let mut isolate = Isolate::new(opts.heap_limit_bytes);

    // Armed once and held for the session: a span of creator code that will not return is the one
    // failure this process cannot log its way out of, and the bundle is such a span itself.
    let watchdog = Watchdog::arm(isolate.terminator(), opts.tick_budget, &io);

    watchdog.enter(BOOT_BUDGET);
    let booted = isolate.boot(opts.bundle, opts.sim_config);
    watchdog.leave();
    booted?;

    let mut clock = Clock::new(opts.sim_rate, opts.send_rate);
    let mut peers: HashMap<ConnectionId, Peer> = HashMap::new();
    let mut pending = Pending::default();
    let mut drains: Vec<bool> = Vec::new();
    let mut draining: Option<Instant> = None;
    // Retained rather than detached: dropping the runtime at the end of this function cancels a
    // spawned save at its first await, which is inside the PUT the drain exists for.
    let mut spawned: Vec<JoinHandle<()>> = Vec::new();
    let mut reported = SimDiagnostics {
        dropped: 0,
        stale: 0,
    };

    let mut interval = Duration::from_secs_f64(1.0 / opts.sim_rate);
    let mut rates = Rates {
        sim_rate: opts.sim_rate,
        send_rate: opts.send_rate,
    };

    loop {
        let woke = Instant::now();
        // Non-blocking: the loop's pace is the clock's, not the channel's, and a wake that waited
        // on a message would run the game at the rate its players happened to type.
        while let Ok(event) = events.try_recv() {
            match event {
                HostEvent::Opened {
                    connection_id,
                    identity,
                    writes,
                    hangup,
                } => {
                    peers.insert(connection_id.clone(), Peer { writes, hangup });
                    pending.opened.push(OpenedConnection {
                        connection_id,
                        identity: Some(identity),
                    });
                }
                HostEvent::Frame {
                    connection_id,
                    message,
                } => {
                    pending.frames.push(InboundFrame {
                        connection_id,
                        message,
                    });
                }
                HostEvent::Closed { connection_id } => {
                    peers.remove(&connection_id);
                    pending.closed.push(connection_id);
                }
                HostEvent::Loaded {
                    connection_id,
                    fields,
                } => {
                    pending.records.push(LoadedRecord {
                        connection_id,
                        fields,
                    });
                }
                HostEvent::Saved { host_key } => pending.saved.push(host_key),
                HostEvent::Drain => {
                    draining.get_or_insert_with(Instant::now);
                }
                HostEvent::Fatal { error } => {
                    settle(&io, &mut spawned);
                    return Err(anyhow!(error));
                }
            }
        }

        // Wall-clock, as `GameInstance` feeds its own driver: the accumulator clamps a reading that
        // moved backwards, and the same reading stamps the batch — a monotonic one would put 1970
        // on every `serverSentMs`.
        let wake = clock.wake(unix_millis() / 1000.0, &mut drains);
        if wake.shed {
            tracing::warn!(
                shed = clock.shed_count(),
                "the world is behind and shed its backlog"
            );
        }

        for drain in drains.iter().copied() {
            let mut batch = InputBatch::new(clock.now_seconds() * 1000.0, drain);
            pending.take_into(&mut batch);

            watchdog.enter(opts.tick_budget);
            let out = isolate.tick(&batch);
            watchdog.leave();

            match out {
                Ok(out) => {
                    // A world that retuned itself mid-session: the sim has already told every
                    // client the new rate, and a driver left on the old one runs the world at a
                    // speed nothing agrees on.
                    if out.rates != rates {
                        tracing::info!(
                            sim_rate = out.rates.sim_rate,
                            send_rate = out.rates.send_rate,
                            "the world retuned its clock"
                        );
                        rates = out.rates;
                        clock.set_rates(rates.sim_rate, rates.send_rate);
                        interval = Duration::from_secs_f64(1.0 / rates.sim_rate);
                    }
                    // Only when they move: they are cumulative, so a line per tick would say the
                    // same thing sixty times a second and a rate is what an operator watches.
                    if out.diagnostics.dropped != reported.dropped
                        || out.diagnostics.stale != reported.stale
                    {
                        tracing::warn!(
                            tick = out.tick,
                            dropped = out.diagnostics.dropped,
                            stale = out.diagnostics.stale,
                            "unrepresentable marks"
                        );
                        reported = out.diagnostics;
                    }
                    apply(out, &mut peers, &opts.store, &io, &answers, &mut spawned);
                }
                // A tick that threw is a world that cannot be trusted to be advanced again — it
                // mutates in place and there is no transaction, so half a step is a world no later
                // delta repairs. Every peer is told why, and the process ends.
                Err(error) => {
                    let reason = isolate.death().map_or("sim-threw", Death::token);
                    tracing::error!(%error, reason, "the tick failed; ending the session");
                    for (connection_id, peer) in &peers {
                        tracing::info!(conn = %connection_id, reason, "close conn");
                        let _ = peer.writes.try_send(Outgoing::Death(reason));
                    }
                    let hung_up = peers.len();
                    // Dropped, which hangs up every socket: a peer left open against a dead world
                    // would sit waiting for a tick that is never coming.
                    peers.clear();
                    opts.players.store(0, Ordering::Relaxed);
                    flush(&io, &mut events, hung_up);
                    settle(&io, &mut spawned);
                    return Err(error);
                }
            }
        }

        // Published after the batch rather than at each mutation: the probe is seconds apart and a
        // reading per tick is one the agent could never have asked for.
        opts.players.store(peers.len(), Ordering::Relaxed);
        prune(&mut spawned);

        if let Some(started) = draining {
            if peers.is_empty() {
                break;
            }
            // A player who will not leave is not worth the SIGKILL that ends this process at twenty
            // seconds: a close batch written late still carries every save, and the kill does not.
            if started.elapsed() > DRAIN_DEADLINE {
                tracing::warn!(held = peers.len(), "the drain ran out of time");
                break;
            }
        }
        // To the deadline rather than after the work: a whole interval on top of the tick paces the
        // world slower than its own rate, and a zero sleep is what leaves shedding to the clock.
        std::thread::sleep(interval.saturating_sub(woke.elapsed()));
    }

    // The last batch, and the only one that carries every online player's save.
    watchdog.enter(CLOSE_BUDGET);
    let closed = isolate.close();
    watchdog.leave();
    let outcome = match closed {
        Ok(out) => {
            apply(out, &mut peers, &opts.store, &io, &answers, &mut spawned);
            Ok(())
        }
        Err(error) => Err(error),
    };
    let hung_up = peers.len();
    // Every socket goes with the world: the sim released each session inline, and a peer still
    // holding an open connection would wait on a tick that will never run.
    peers.clear();
    opts.players.store(0, Ordering::Relaxed);
    flush(&io, &mut events, hung_up);
    settle(&io, &mut spawned);
    outcome
}

/// One peer's two ends: the frames it is owed, and the handle that hangs it up.
struct Peer {
    writes: mpsc::Sender<Outgoing>,
    /// Held only to be dropped — dropping it is what closes the socket.
    #[allow(dead_code)]
    hangup: HangUp,
}

/// What has arrived since the last tick. Emptied into the batch, never copied out of it.
#[derive(Default)]
struct Pending {
    opened: Vec<OpenedConnection>,
    frames: Vec<InboundFrame>,
    closed: Vec<ConnectionId>,
    records: Vec<LoadedRecord>,
    saved: Vec<String>,
}

impl Pending {
    fn take_into(&mut self, batch: &mut InputBatch) {
        batch.opened = std::mem::take(&mut self.opened);
        batch.frames = std::mem::take(&mut self.frames);
        batch.closed = std::mem::take(&mut self.closed);
        batch.records = std::mem::take(&mut self.records);
        batch.saved = std::mem::take(&mut self.saved);
    }
}

/// Everything one output batch orders, in the order it must happen: write, then close, then store.
///
/// `spawned` collects the saves this batch started, because a write that has not landed when this
/// thread returns is a write the runtime's own shutdown cancels.
fn apply(
    out: OutputBatch,
    peers: &mut HashMap<ConnectionId, Peer>,
    store: &Store,
    io: &tokio::runtime::Handle,
    events: &mpsc::UnboundedSender<HostEvent>,
    spawned: &mut Vec<JoinHandle<()>>,
) {
    for line in &out.log {
        match line.level.as_str() {
            "error" => tracing::error!("{}", line.line),
            "warn" => tracing::warn!("{}", line.line),
            _ => tracing::info!("{}", line.line),
        }
    }

    for send in out.sends {
        // The sim's own bytes, written verbatim and shared across the list — the only reason `to`
        // is a list. Re-encoding would hand a peer bytes the sim never measured.
        let text = Arc::new(send.envelope);
        for connection_id in &send.to {
            let Some(peer) = peers.get(connection_id) else {
                continue;
            };
            let outgoing = Outgoing::Frame {
                text: text.clone(),
                class: send.class,
            };
            match peer.writes.try_send(outgoing) {
                Ok(()) => {}
                // A full queue is a peer that cannot keep up. A droppable frame is superseded by
                // the next of its kind, so discarding it is the backpressure policy; a reliable one
                // is not, and such a peer has to go rather than fall silently behind.
                Err(mpsc::error::TrySendError::Full(dropped)) => {
                    if matches!(
                        dropped,
                        Outgoing::Frame {
                            class: SendClass::Reliable,
                            ..
                        }
                    ) {
                        tracing::warn!(conn = %connection_id, "close conn reason=write-backpressure");
                        peers.remove(connection_id);
                    }
                }
                Err(mpsc::error::TrySendError::Closed(_)) => {
                    peers.remove(connection_id);
                }
            }
        }
    }

    // After the sends, so a `Reject` reaches the wire before the close that follows it. Removing
    // the peer drops its `HangUp`, which is what actually closes the socket — dropping only the
    // writer would leave the reader parked on a connection nothing will ever answer.
    for order in out.closes {
        tracing::info!(conn = %order.connection_id, reason = %order.reason, "close conn");
        peers.remove(&order.connection_id);
    }

    for load in out.loads {
        let store = store.clone();
        let events = events.clone();
        io.spawn(async move {
            let fields = match store.load(&load.host_key).await {
                // `{}` for a store that held nothing, so the leave still writes; `null` only for a
                // read that failed, stopping the leave overwriting a save nobody read.
                Ok(Some(fields)) => Some(fields),
                Ok(None) => RawValue::from_string("{}".to_owned()).ok(),
                Err(error) => {
                    tracing::warn!(%error, key = %load.host_key, "reading state failed");
                    None
                }
            };
            let _ = events.send(HostEvent::Loaded {
                connection_id: load.connection_id,
                fields,
            });
        });
    }

    for save in out.saves {
        let store = store.clone();
        let events = events.clone();
        spawned.push(io.spawn(async move {
            let mut wait = SAVE_BACKOFF;
            for attempt in 1..=SAVE_ATTEMPTS {
                // Safe to repeat: the write is the whole record under a compare-and-set, so an
                // attempt either lands or is refused, never applied twice.
                let error = match store.save(&save.host_key, &save.fields).await {
                    Ok(()) => {
                        let _ = events.send(HostEvent::Saved {
                            host_key: save.host_key,
                        });
                        return;
                    }
                    Err(error) => error,
                };
                if attempt == SAVE_ATTEMPTS {
                    // Not acknowledged: the sim holds the record so a rejoin inside this session
                    // still reads its own values back — the better of two wrong answers.
                    tracing::warn!(%error, key = %save.host_key, "persisting failed");
                    return;
                }
                tracing::warn!(%error, key = %save.host_key, "persisting failed; retrying");
                tokio::time::sleep(wait).await;
                wait *= 2;
            }
        }));
    }
}

/// Waits for the peers just hung up to report themselves closed — the echo that says their last
/// frame reached the socket. Returning from `run` drops the runtime, cancelling the writer inside
/// `send`, so the reason a session died reaches nobody unless this thread waits.
fn flush(
    io: &tokio::runtime::Handle,
    events: &mut mpsc::UnboundedReceiver<HostEvent>,
    hung_up: usize,
) {
    if hung_up == 0 {
        return;
    }

    io.block_on(async {
        let echoes = async {
            let mut waiting = hung_up;
            while waiting > 0 {
                match events.recv().await {
                    Some(HostEvent::Closed { .. }) => waiting -= 1,
                    Some(_) => {}
                    None => break,
                }
            }
        };
        if tokio::time::timeout(FLUSH_DEADLINE, echoes).await.is_err() {
            tracing::warn!(hung_up, "gave up on the closes still on their way out");
        }
    });
}

/// Drops the handles of the saves that have already landed. A `JoinHandle` keeps its task's cell
/// allocated after the task finished, and the sim spawns one save per departing player.
fn prune(spawned: &mut Vec<JoinHandle<()>>) {
    spawned.retain(|handle| !handle.is_finished());
}

/// Waits out the saves already in flight, under one deadline for all of them together.
///
/// Returning from `run` drops the runtime, and tokio cancels a spawned task at its first await —
/// which for a save is inside the request the drain exists to make.
fn settle(io: &tokio::runtime::Handle, spawned: &mut Vec<JoinHandle<()>>) {
    let handles = std::mem::take(spawned);
    if handles.is_empty() {
        return;
    }

    io.block_on(async move {
        let deadline = tokio::time::Instant::now() + SETTLE_DEADLINE;
        for handle in handles {
            if tokio::time::timeout_at(deadline, handle).await.is_err() {
                tracing::warn!("gave up on the writes still in flight");
                return;
            }
        }
    });
}

/// What the watchdog does to an isolate, and all it needs of one.
trait Terminator: Clone + Send + 'static {
    fn terminate(&self);
    /// Clears a termination that has been called for but not yet observed by the running script.
    fn cancel(&self);
}

impl Terminator for deno_core::v8::IsolateHandle {
    fn terminate(&self) {
        self.terminate_execution();
    }

    fn cancel(&self) {
        self.cancel_terminate_execution();
    }
}

/// Terminates a span of creator code that has outstayed its budget.
///
/// V8 will not yield to anything on this thread while a script is running, so the only thing that
/// can stop an infinite loop in creator code is another thread holding an `IsolateHandle`.
struct Watchdog<T: Terminator> {
    /// When the span in flight runs out, measured from `base`, or zero between spans.
    ///
    /// A lock rather than an atomic because deciding and killing have to be one step against
    /// `leave`: a `leave` that lands between them cancels a termination that has not been called
    /// yet, and V8 carries the latched flag into the next span, killing a healthy tick.
    deadline: Arc<Mutex<u64>>,
    /// Monotonic: an operator's clock correction is not a runaway tick, and killing one ends the
    /// session for everybody on it.
    base: Instant,
    handle: T,
}

impl<T: Terminator> Watchdog<T> {
    /// `tick_budget` sets only how finely a span is sampled: each span carries its own deadline, so
    /// a longer one is watched at tick granularity rather than at its own.
    fn arm(handle: T, tick_budget: Duration, io: &tokio::runtime::Handle) -> Self {
        let deadline = Arc::new(Mutex::new(0));
        let watched = deadline.clone();
        let base = Instant::now();
        let killer = handle.clone();
        io.spawn(async move {
            let mut ticker = tokio::time::interval(tick_budget / 4);
            loop {
                ticker.tick().await;
                let terminated = {
                    let at = held(&watched);
                    let over = *at != 0 && base.elapsed().as_millis() as u64 > *at;
                    if over {
                        killer.terminate();
                    }
                    over
                };
                // Outside the lock the kill was taken under, because `leave` is a session thread
                // waiting on it and formatting a line is long enough for a marginal tick to finish.
                if terminated {
                    tracing::error!("a span outstayed its budget; terminating the isolate");
                }
            }
        });
        Self {
            deadline,
            base,
            handle,
        }
    }

    fn enter(&self, budget: Duration) {
        // Zero is the between-spans sentinel, so a deadline that lands on it moves one out.
        let at = (self.base.elapsed().as_millis() as u64 + budget.as_millis() as u64).max(1);
        *held(&self.deadline) = at;
    }

    fn leave(&self) {
        let mut at = held(&self.deadline);
        *at = 0;
        // Under the same lock the kill is taken under, and so ordered against it: a termination
        // decided against this span but not yet observed would otherwise be served to the next one,
        // which is healthy, since the run that earned it has already read its own death.
        self.handle.cancel();
    }
}

/// Poison is ignored: a deadline is all that is under this lock, and a panicking holder leaves it
/// readable.
fn held(deadline: &Mutex<u64>) -> MutexGuard<'_, u64> {
    deadline
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Wall-clock milliseconds — the only reading this process takes, and the only one the sim stamps.
fn unix_millis() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicBool;

    use super::*;

    /// Under `io.enter()`, as the session thread holds it: the whole point is that this is legal
    /// there, since it is the last thing that runs before the runtime carrying the saves is dropped.
    #[test]
    fn holds_the_thread_until_a_write_has_landed() {
        let io = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        let _entered = io.enter();

        let landed = Arc::new(AtomicBool::new(false));
        let writing = landed.clone();
        let mut spawned = vec![io.spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            writing.store(true, Ordering::SeqCst);
        })];

        settle(io.handle(), &mut spawned);

        assert!(landed.load(Ordering::SeqCst));
        assert!(spawned.is_empty());
    }

    /// The close frame is queued on the way out and written by a task the runtime carries, so the
    /// return from `run` that drops that runtime has to come after the socket reports itself gone.
    #[test]
    fn waits_for_the_peers_it_hung_up_to_report_themselves_closed() {
        let io = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        let _entered = io.enter();

        let (answers, mut events) = mpsc::unbounded_channel::<HostEvent>();
        io.spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            let _ = answers.send(HostEvent::Closed {
                connection_id: "c1".to_owned(),
            });
        });

        let waited = Instant::now();
        flush(io.handle(), &mut events, 1);

        assert!(waited.elapsed() >= Duration::from_millis(50));
        assert!(waited.elapsed() < FLUSH_DEADLINE);
    }

    /// The in-flight set is what `settle` has to wait on, so pruning may only drop what has landed.
    #[test]
    fn drops_the_saves_that_have_landed_and_keeps_the_rest() {
        let io = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();

        let mut spawned = vec![
            io.spawn(async {}),
            io.spawn(async { tokio::time::sleep(Duration::from_secs(30)).await }),
        ];
        io.block_on(async { tokio::time::sleep(Duration::from_millis(50)).await });

        prune(&mut spawned);

        assert_eq!(spawned.len(), 1);
        assert!(!spawned[0].is_finished());
    }

    /// A killer that takes as long to terminate as V8's does to be observed, so the interleaving the
    /// lock exists for is the one this drives.
    #[derive(Clone)]
    struct FakeIsolate {
        started: Arc<AtomicBool>,
        latched: Arc<AtomicBool>,
    }

    impl Terminator for FakeIsolate {
        fn terminate(&self) {
            self.started.store(true, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(150));
            self.latched.store(true, Ordering::SeqCst);
        }

        fn cancel(&self) {
            self.latched.store(false, Ordering::SeqCst);
        }
    }

    /// A `leave` landing while the watchdog kills must not cancel a termination not yet called:
    /// the flag survives into the next span, and killing that one ends the session for every
    /// player on a world that was healthy.
    #[test]
    fn a_leave_that_races_the_kill_still_clears_it() {
        let io = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        let killer = FakeIsolate {
            started: Arc::new(AtomicBool::new(false)),
            latched: Arc::new(AtomicBool::new(false)),
        };
        let watchdog = Watchdog::arm(killer.clone(), Duration::from_millis(800), io.handle());

        watchdog.enter(Duration::from_millis(1));
        let waited = Instant::now();
        while !killer.started.load(Ordering::SeqCst) {
            assert!(waited.elapsed() < Duration::from_secs(5), "it never fired");
            std::thread::sleep(Duration::from_millis(1));
        }
        watchdog.leave();

        // Read after the kill could possibly have landed, since a cancel that merely goes FIRST is
        // the defect: the flag it did not clear is the one the next span dies of.
        std::thread::sleep(Duration::from_millis(300));
        assert!(!killer.latched.load(Ordering::SeqCst));
    }
}

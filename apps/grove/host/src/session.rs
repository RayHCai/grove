//! The session thread: the one place the isolate is touched, and the loop that turns arrivals into
//! batches and batches into writes.
//!
//! A `JsRuntime` is not `Send`, so it never crosses into a `tokio` task. Everything the async side
//! learns arrives here as a `HostEvent` on a channel, and everything this side wants done goes back
//! out the same way. That is not a workaround — it is what makes the tick a single-threaded,
//! ordered, replayable sequence, which is the whole claim `@platform/sim` is written against.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::Result;
use serde_json::value::RawValue;
use tokio::sync::mpsc;

use crate::clock::Clock;
use crate::isolate::{Death, Isolate, IsolateOptions};
use crate::net::Outgoing;
use crate::protocol::{
    ConnectionId, InboundFrame, InputBatch, LoadedRecord, OpenedConnection, OutputBatch, SendClass,
};
use crate::store::Store;

/// Everything the async half tells the session thread. One channel, so the order is one order.
pub enum HostEvent {
    Opened {
        connection_id: ConnectionId,
        /// From the verified ticket. Never a frame's claim.
        identity: String,
        writes: mpsc::Sender<Outgoing>,
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
}

pub struct SessionOptions {
    pub bundle: String,
    pub sim_config: String,
    pub sim_rate: f64,
    pub send_rate: f64,
    pub heap_limit_bytes: usize,
    pub tick_budget: Duration,
    pub store: Store,
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
    let mut isolate = Isolate::boot(IsolateOptions {
        bundle: opts.bundle,
        config: opts.sim_config,
        heap_limit_bytes: opts.heap_limit_bytes,
    })?;

    // Armed once and held for the session: a tick that will not return is the one failure this
    // process cannot log its way out of, and the handle has to exist before the tick that needs it.
    let watchdog = Watchdog::arm(isolate.terminator(), opts.tick_budget, &io);

    let mut clock = Clock::new(opts.sim_rate, opts.send_rate);
    let mut writers: HashMap<ConnectionId, mpsc::Sender<Outgoing>> = HashMap::new();
    let mut pending = Pending::default();
    let mut drains: Vec<bool> = Vec::new();
    let mut draining = false;

    let interval = Duration::from_secs_f64(1.0 / opts.sim_rate);
    let started = Instant::now();

    loop {
        // Non-blocking: the loop's pace is the clock's, not the channel's, and a wake that waited on
        // a message would run the game at the rate its players happened to type.
        while let Ok(event) = events.try_recv() {
            match event {
                HostEvent::Opened { connection_id, identity, writes } => {
                    writers.insert(connection_id.clone(), writes);
                    pending
                        .opened
                        .push(OpenedConnection { connection_id, identity: Some(identity) });
                }
                HostEvent::Frame { connection_id, message } => {
                    pending.frames.push(InboundFrame { connection_id, message });
                }
                HostEvent::Closed { connection_id } => {
                    writers.remove(&connection_id);
                    pending.closed.push(connection_id);
                }
                HostEvent::Loaded { connection_id, fields } => {
                    pending.records.push(LoadedRecord { connection_id, fields });
                }
                HostEvent::Saved { host_key } => pending.saved.push(host_key),
                HostEvent::Drain => draining = true,
            }
        }

        let wake = clock.wake(started.elapsed().as_secs_f64(), &mut drains);
        if wake.shed {
            tracing::warn!(shed = clock.shed_count(), "the world is behind and shed its backlog");
        }

        for drain in drains.iter().copied() {
            let mut batch = InputBatch::new(unix_millis(), drain);
            pending.take_into(&mut batch);

            watchdog.enter();
            let out = isolate.tick(&batch);
            watchdog.leave();

            match out {
                Ok(out) => apply(out, &mut writers, &opts.store, &io, &answers),
                // A tick that threw is a world that cannot be trusted to be advanced again — it
                // mutates in place and there is no transaction, so half a step is a world no later
                // delta repairs. Every peer is told why, and the process ends.
                Err(error) => {
                    let reason = isolate.death().map_or("sim-threw", Death::token);
                    tracing::error!(%error, reason, "the tick failed; ending the session");
                    for connection_id in writers.keys() {
                        tracing::info!(conn = %connection_id, reason, "close conn");
                    }
                    writers.clear();
                    return Err(error);
                }
            }
        }

        if draining && writers.is_empty() {
            break;
        }
        std::thread::sleep(interval);
    }

    // The last batch, and the only one that carries every online player's save.
    let out = isolate.close()?;
    apply(out, &mut writers, &opts.store, &io, &answers);
    Ok(())
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
fn apply(
    out: OutputBatch,
    writers: &mut HashMap<ConnectionId, mpsc::Sender<Outgoing>>,
    store: &Store,
    io: &tokio::runtime::Handle,
    events: &mpsc::UnboundedSender<HostEvent>,
) {
    for line in &out.log {
        match line.level.as_str() {
            "error" => tracing::error!("{}", line.line),
            "warn" => tracing::warn!("{}", line.line),
            _ => tracing::info!("{}", line.line),
        }
    }

    for send in out.sends {
        // The sim's own bytes, written verbatim and shared across the whole list — which is the only
        // reason `to` is a list. Re-serializing here would hand a peer bytes the sim never measured.
        let text = Arc::new(send.envelope.get().to_owned());
        for connection_id in &send.to {
            let Some(writer) = writers.get(connection_id) else { continue };
            let outgoing = Outgoing { text: text.clone(), class: send.class };
            match writer.try_send(outgoing) {
                Ok(()) => {}
                // A full queue is a peer that cannot keep up. A droppable frame is superseded by the
                // next of its kind, so discarding it is the backpressure policy; a reliable one is
                // not, and a peer that cannot take it has to go rather than fall silently behind.
                Err(mpsc::error::TrySendError::Full(dropped)) => {
                    if dropped.class == SendClass::Reliable {
                        tracing::warn!(conn = %connection_id, "close conn reason=write-backpressure");
                        writers.remove(connection_id);
                    }
                }
                Err(mpsc::error::TrySendError::Closed(_)) => {
                    writers.remove(connection_id);
                }
            }
        }
    }

    // After the sends, so a `Reject` reaches the wire before the close that follows it.
    for order in out.closes {
        tracing::info!(conn = %order.connection_id, reason = %order.reason, "close conn");
        writers.remove(&order.connection_id);
    }

    for load in out.loads {
        let store = store.clone();
        let events = events.clone();
        io.spawn(async move {
            let fields = match store.load(&load.host_key).await {
                // `{}` for a store that held nothing, so the leave still writes; `null` only for the
                // read that failed, which is what stops the leave overwriting a save nobody read.
                Ok(Some(fields)) => Some(fields),
                Ok(None) => RawValue::from_string("{}".to_owned()).ok(),
                Err(error) => {
                    tracing::warn!(%error, key = %load.host_key, "reading state failed");
                    None
                }
            };
            let _ = events.send(HostEvent::Loaded { connection_id: load.connection_id, fields });
        });
    }

    for save in out.saves {
        let store = store.clone();
        let events = events.clone();
        io.spawn(async move {
            match store.save(&save.host_key, &save.fields).await {
                Ok(()) => {
                    let _ = events.send(HostEvent::Saved { host_key: save.host_key });
                }
                // Not acknowledged: the sim holds the record so a rejoin inside this session still
                // reads its own values back, which is the better of the two wrong answers.
                Err(error) => tracing::warn!(%error, key = %save.host_key, "persisting failed"),
            }
        });
    }
}

/// Terminates a tick that has outstayed its budget.
///
/// V8 will not yield to anything on this thread while a script is running, so the only thing that
/// can stop an infinite loop in creator code is another thread holding an `IsolateHandle`.
struct Watchdog {
    entered: Arc<std::sync::atomic::AtomicU64>,
}

impl Watchdog {
    fn arm(
        handle: deno_core::v8::IsolateHandle,
        budget: Duration,
        io: &tokio::runtime::Handle,
    ) -> Self {
        let entered = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let watched = entered.clone();
        io.spawn(async move {
            let mut ticker = tokio::time::interval(budget / 4);
            loop {
                ticker.tick().await;
                let at = watched.load(std::sync::atomic::Ordering::SeqCst);
                if at == 0 {
                    continue;
                }
                if unix_millis() - at as f64 > budget.as_millis() as f64 {
                    tracing::error!("a tick outstayed its budget; terminating the isolate");
                    handle.terminate_execution();
                }
            }
        });
        Self { entered }
    }

    fn enter(&self) {
        self.entered
            .store(unix_millis() as u64, std::sync::atomic::Ordering::SeqCst);
    }

    fn leave(&self) {
        self.entered.store(0, std::sync::atomic::Ordering::SeqCst);
    }
}

/// Wall-clock milliseconds — the only reading this process takes, and the only one the sim stamps.
fn unix_millis() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

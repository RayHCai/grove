//! One V8 isolate per session, holding the compiled `@platform/sim` bundle and the creator's code.
//!
//! The isolate is the containment: its own heap limit, its own `terminate_execution` handle, and no
//! ambient capability at all — the bundle reaches the outside world only through the ops declared
//! here, which is why this module is where `storage` and the session's own `console` live.
//!
//! A `JsRuntime` is neither `Send` nor re-entrant, so everything here runs on the one session thread
//! and never inside a `tokio` task.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll, Wake, Waker};

use anyhow::{anyhow, bail, Context as _, Result};
use deno_core::{extension, op2, JsRuntime, OpState, PollEventLoopOptions, RuntimeOptions};

use crate::protocol::{InputBatch, OutputBatch};

/// What the bundle is called in a stack trace, and what a module specifier resolves against.
const BUNDLE_URL: &str = "grove:sim";

/// Boot, one tick, and close — the three scripts this host ever runs, held as constants so a tick
/// never builds a source string out of peer-influenced bytes.
const BOOT_SOURCE: &str = "globalThis.__grove.boot(Deno.core.ops.op_grove_take_message());";
const TICK_SOURCE: &str =
    "Deno.core.ops.op_grove_put_message(globalThis.__grove.tick(Deno.core.ops.op_grove_take_message()));";
const CLOSE_SOURCE: &str = "Deno.core.ops.op_grove_put_message(globalThis.__grove.close());";

/// The one slot a message crosses in, in either direction.
///
/// A slot rather than a call argument because `execute_script` takes source and returns a V8 value:
/// building the batch into the source would re-parse a megabyte of JSON as JAVASCRIPT every tick,
/// and reading the result back out of a `v8::Value` needs a scope this side does not otherwise open.
#[derive(Default)]
struct Mailbox {
    inbound: Option<String>,
    outbound: Option<String>,
}

#[op2]
#[string]
fn op_grove_take_message(state: &mut OpState) -> String {
    state
        .borrow_mut::<Rc<RefCell<Mailbox>>>()
        .borrow_mut()
        .inbound
        .take()
        .unwrap_or_else(|| "null".to_owned())
}

#[op2(fast)]
fn op_grove_put_message(state: &mut OpState, #[string] message: String) {
    state.borrow_mut::<Rc<RefCell<Mailbox>>>().borrow_mut().outbound = Some(message);
}

extension!(
    grove_host,
    ops = [op_grove_take_message, op_grove_put_message],
    options = { mailbox: Rc<RefCell<Mailbox>> },
    state = |state, options| {
        state.put(options.mailbox);
    },
);

/// A waker that does nothing, so the event loop can be polled from a thread that is not a reactor.
struct Idle;

impl Wake for Idle {
    fn wake(self: Arc<Self>) {}
}

pub struct IsolateOptions {
    /// The compiled sim bundle, one ESM-free script that assigns `globalThis.__grove`.
    pub bundle: String,
    /// What `Sim` is constructed with, already JSON.
    pub config: String,
    /// Bytes this session's heap may reach before it is torn down rather than left to thrash.
    pub heap_limit_bytes: usize,
}

/// The session's isolate: booted once, ticked until it is closed or killed.
pub struct Isolate {
    runtime: JsRuntime,
    mailbox: Rc<RefCell<Mailbox>>,
    /// Set by the near-heap-limit callback, which V8 calls on ITS thread and which may not allocate.
    over_heap: Arc<AtomicBool>,
}

impl Isolate {
    /// Builds the isolate, loads the bundle, and runs the sim's own boot to its first await.
    pub fn boot(opts: IsolateOptions) -> Result<Self> {
        let mailbox = Rc::new(RefCell::new(Mailbox::default()));
        let mut runtime = JsRuntime::new(RuntimeOptions {
            extensions: vec![grove_host::init(mailbox.clone())],
            create_params: Some(
                deno_core::v8::CreateParams::default().heap_limits(0, opts.heap_limit_bytes),
            ),
            ..Default::default()
        });

        // Termination rather than a growth grant: a session over its limit is a session whose world
        // is already wrong, and letting V8 grow the heap turns one bad game into the whole host's
        // problem. The flag is read on the session thread, which is where the tear-down belongs.
        let over_heap = Arc::new(AtomicBool::new(false));
        let flag = over_heap.clone();
        let terminator = runtime.v8_isolate().thread_safe_handle();
        runtime.add_near_heap_limit_callback(move |current, _initial| {
            flag.store(true, Ordering::SeqCst);
            terminator.terminate_execution();
            // Returned unchanged: raising it here would be the grant this callback exists to refuse.
            current
        });

        runtime
            .execute_script(BUNDLE_URL, deno_core::FastString::from(opts.bundle))
            .context("the sim bundle threw while it was being evaluated")?;

        mailbox.borrow_mut().inbound = Some(opts.config);
        let mut isolate = Self { runtime, mailbox, over_heap };
        isolate.run("[grove:boot]", BOOT_SOURCE)?;
        Ok(isolate)
    }

    /// One fixed step. The batch crosses as JSON and the output comes back the same way.
    pub fn tick(&mut self, batch: &InputBatch) -> Result<OutputBatch> {
        let encoded = serde_json::to_string(batch).context("encoding the input batch")?;
        self.mailbox.borrow_mut().inbound = Some(encoded);
        self.run("[grove:tick]", TICK_SOURCE)?;
        self.take_output()
    }

    /// Releases the world and takes the last batch — every online player's save, and nothing else.
    pub fn close(&mut self) -> Result<OutputBatch> {
        self.run("[grove:close]", CLOSE_SOURCE)?;
        self.take_output()
    }

    /// A handle a watchdog on another thread can use to stop a tick that will not return.
    pub fn terminator(&mut self) -> deno_core::v8::IsolateHandle {
        self.runtime.v8_isolate().thread_safe_handle()
    }

    fn run(&mut self, name: &'static str, source: &'static str) -> Result<()> {
        self.runtime
            .execute_script(name, deno_core::FastString::from_static(source))
            .map_err(|error| {
                if self.over_heap.load(Ordering::SeqCst) {
                    anyhow!("the session exceeded its heap limit")
                } else {
                    anyhow!(error)
                }
            })?;

        // Polled to `Pending` rather than awaited: core's `startGame` is deliberately not awaited and
        // a handler may await a timer that only the NEXT tick advances, so a loop that ran to
        // completion would deadlock the world against its own clock. What this drains is the
        // microtask queue and whatever settled already, which is exactly the synchronous-to-the-
        // first-await guarantee the sim is written against.
        let waker = Waker::from(Arc::new(Idle));
        let mut cx = Context::from_waker(&waker);
        match self.runtime.poll_event_loop(
            &mut cx,
            PollEventLoopOptions { wait_for_inspector: false, pump_v8_message_loop: true },
        ) {
            Poll::Ready(Err(error)) => bail!(error),
            Poll::Ready(Ok(())) | Poll::Pending => Ok(()),
        }
    }

    fn take_output(&mut self) -> Result<OutputBatch> {
        let raw = self
            .mailbox
            .borrow_mut()
            .outbound
            .take()
            .ok_or_else(|| anyhow!("the sim returned no output batch"))?;
        serde_json::from_str(&raw).context("decoding the output batch")
    }
}

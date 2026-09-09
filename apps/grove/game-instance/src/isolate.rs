//! One V8 isolate per session, holding the compiled `@platform/sim` bundle and the creator's code.
//!
//! The isolate is the containment: its own heap limit, its own `terminate_execution` handle, and no
//! ambient capability at all — the bundle reaches the outside world only through the two ops
//! declared here, which carry one JSON message in each direction and nothing else.
//!
//! A `JsRuntime` is neither `Send` nor re-entrant, so everything here runs on the one session thread
//! and never inside a `tokio` task.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use anyhow::{anyhow, Context as _, Result};
use deno_core::{extension, op2, JsRuntime, OpState, RuntimeOptions};

use crate::protocol::{InputBatch, OutputBatch};

/// What the bundle is called in a stack trace.
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
/// building the batch into the source would re-parse a megabyte of JSON as JAVASCRIPT every tick.
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
    state
        .borrow_mut::<Rc<RefCell<Mailbox>>>()
        .borrow_mut()
        .outbound = Some(message);
}

extension!(
    grove_host,
    ops = [op_grove_take_message, op_grove_put_message],
    options = { mailbox: Rc<RefCell<Mailbox>> },
    state = |state, options| {
        state.put(options.mailbox);
    },
);

/// Why an isolate stopped. Terminal in every arm: `Sim.tick` mutates the world in place and there is
/// no transaction, so a half-run tick leaves a world no later delta repairs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Death {
    /// The session reached its heap limit.
    OutOfMemory,
    /// A tick outstayed its budget and the watchdog terminated it.
    Runaway,
    /// The bundle threw.
    Threw,
}

impl Death {
    /// The token an operator greps for, and the reason every open socket is closed with.
    pub fn token(self) -> &'static str {
        match self {
            Self::OutOfMemory => "heap-limit",
            Self::Runaway => "tick-budget",
            Self::Threw => "sim-threw",
        }
    }
}

pub struct IsolateOptions {
    /// The compiled sim bundle: one classic script that assigns `globalThis.__grove`.
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
    /// Once set, every later call fails fast rather than re-entering a world that is already wrong.
    dead: Option<Death>,
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

        let over_heap = Arc::new(AtomicBool::new(false));
        let flag = over_heap.clone();
        let terminator = runtime.v8_isolate().thread_safe_handle();
        runtime.add_near_heap_limit_callback(move |current, _initial| {
            flag.store(true, Ordering::SeqCst);
            terminator.terminate_execution();
            // The grant is REQUIRED, not a concession: `terminate_execution` is not instantaneous —
            // V8 keeps allocating while it unwinds — and a callback that returned the limit
            // unchanged would hit it again and reach `FatalProcessOutOfMemory`, aborting the whole
            // process and every other session in it. The isolate is discarded either way, so the
            // headroom is never actually spent.
            current * 2
        });

        runtime
            .execute_script(BUNDLE_URL, deno_core::FastString::from(opts.bundle))
            .context("the sim bundle threw while it was being evaluated")?;

        mailbox.borrow_mut().inbound = Some(opts.config);
        let mut isolate = Self {
            runtime,
            mailbox,
            over_heap,
            dead: None,
        };
        isolate.run("[grove:boot]", BOOT_SOURCE)?;
        Ok(isolate)
    }

    /// Why this isolate stopped, or `None` while it is still live.
    pub fn death(&self) -> Option<Death> {
        self.dead
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
        if let Some(death) = self.dead {
            return Err(anyhow!("the isolate is dead: {}", death.token()));
        }

        let outcome = self
            .runtime
            .execute_script(name, deno_core::FastString::from_static(source));

        // Drained explicitly, because deno_core runs V8 under an Explicit microtask policy and
        // nothing else here polls an event loop: this is what lets `startGame` — deliberately not
        // awaited — and every awaiting handler make progress. It runs even on a throw, so a
        // rejection settled before the throw still reaches its own handler.
        {
            deno_core::scope!(scope, &mut self.runtime);
            scope.perform_microtask_checkpoint();
        }

        match outcome {
            Ok(_) => Ok(()),
            Err(error) => {
                let death = if self.over_heap.load(Ordering::SeqCst) {
                    Death::OutOfMemory
                } else if self.runtime.v8_isolate().is_execution_terminating() {
                    Death::Runaway
                } else {
                    Death::Threw
                };
                self.dead = Some(death);
                Err(anyhow!("{}: {error}", death.token()))
            }
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

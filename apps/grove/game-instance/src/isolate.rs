//! One V8 isolate per session, holding the compiled `@platform/sim` bundle and the creator's code.
//! The isolate is the containment: its own heap limit, its own `terminate_execution` handle, and
//! no ambient capability; the bundle is reached only through a function this side alone holds.
//! A `JsRuntime` is neither `Send` nor re-entrant, so this runs on the one session thread.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use anyhow::{anyhow, Context as _, Result};
use deno_core::error::JsError;
use deno_core::{v8, JsRuntime, RuntimeOptions};

use crate::protocol::{InputBatch, OutputBatch};

/// What the bundle is called in a stack trace.
const BUNDLE_URL: &str = "grove:sim";

const PRELUDE_URL: &str = "grove:prelude";

/// Runs before any byte of the bundle: it takes away every global that reaches a deno_core op, and
/// answers the one function the host calls the bundle through, pinning the entry at boot.
const PRELUDE: &str = r#"(() => {
    'use strict';
    const scope = globalThis;
    const { apply } = Reflect;
    const { then } = Promise.prototype;
    const settled = Promise.resolve();
    const quiet = () => {};
    for (const name of ['Deno', '__bootstrap', 'WebAssembly', 'SharedArrayBuffer']) {
        delete scope[name];
    }
    scope.console = Object.freeze({
        log: quiet, info: quiet, warn: quiet, error: quiet, debug: quiet, trace: quiet,
    });
    scope.queueMicrotask = function queueMicrotask(callback) {
        if (typeof callback !== 'function') throw new TypeError('queueMicrotask takes a function');
        apply(then, apply(then, settled, [() => callback()]), [undefined, quiet]);
    };
    let entry = null;
    return (phase, message) => {
        if (entry === null) {
            const published = scope.__grove ?? {};
            const { boot, tick, close } = published;
            if ([boot, tick, close].some((f) => typeof f !== 'function')) {
                throw new TypeError('the bundle left no boot, tick and close on globalThis.__grove');
            }
            entry = { published, boot, tick, close };
        }
        if (phase === 0) return apply(entry.boot, entry.published, [message]);
        if (phase === 1) return apply(entry.tick, entry.published, [message]);
        return apply(entry.close, entry.published, []);
    };
})()"#;

const BOOT: i32 = 0;
const TICK: i32 = 1;
const CLOSE: i32 = 2;

/// Why an isolate stopped. Terminal in every arm: `Sim.tick` mutates in place with no
/// transaction, so a half-run tick leaves a world no later delta repairs.
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

/// The watchdog's hold on an isolate from another thread: it stops a span and records that it did,
/// because V8 stops saying a termination happened once it has unwound.
#[derive(Clone)]
pub struct Kill {
    handle: v8::IsolateHandle,
    fired: Arc<AtomicBool>,
}

impl Kill {
    pub fn terminate(&self) {
        // Set first, so the run this stops cannot read its own ending before the flag.
        self.fired.store(true, Ordering::SeqCst);
        self.handle.terminate_execution();
    }

    /// Clears a termination that has been called for but not yet observed by the running script.
    pub fn cancel(&self) {
        self.handle.cancel_terminate_execution();
        self.fired.store(false, Ordering::SeqCst);
    }
}

/// How the bundle is entered: its own evaluation, or a call through the prelude's function.
enum Entry {
    Script(String),
    Call(i32, Option<String>),
}

/// What one entry left behind, copied out before any later script can run.
enum Ran {
    Returned(Option<String>),
    Threw(String),
    Terminated,
}

/// The session's isolate: booted once, ticked until it is closed or killed.
pub struct Isolate {
    /// Ahead of the runtime, since a handle has to be released before the isolate it lives in.
    entry: v8::Global<v8::Function>,
    runtime: JsRuntime,
    heap_limit_bytes: usize,
    /// Set by the near-heap-limit callback, which V8 calls on ITS thread and may not allocate.
    over_heap: Arc<AtomicBool>,
    fired: Arc<AtomicBool>,
    /// Once set, every later call fails fast rather than re-entering a world that is already wrong.
    dead: Option<Death>,
}

impl Isolate {
    /// Builds the isolate, arms its heap limit and strips its globals, evaluating none of the bundle.
    ///
    /// Separate from `boot` because a terminator can only be taken from a built runtime, and the
    /// watchdog has to hold one before the first line of creator code runs rather than after it.
    pub fn new(heap_limit_bytes: usize) -> Result<Self> {
        let mut runtime = JsRuntime::new(RuntimeOptions {
            create_params: Some(v8::CreateParams::default().heap_limits(0, heap_limit_bytes)),
            ..Default::default()
        });

        let over_heap = Arc::new(AtomicBool::new(false));
        let flag = over_heap.clone();
        let terminator = runtime.v8_isolate().thread_safe_handle();
        runtime.add_near_heap_limit_callback(move |current, _initial| {
            flag.store(true, Ordering::SeqCst);
            terminator.terminate_execution();
            // The grant is REQUIRED, not a concession: `terminate_execution` is not instantaneous:
            // V8 keeps allocating as it unwinds, so an unchanged limit reaches
            // `FatalProcessOutOfMemory` and aborts every other session here.
            current * 2
        });

        let isolate = runtime.v8_isolate();
        // With no shared memory left to wait on, a wait could only ever be a stall.
        isolate.set_allow_atomics_wait(false);
        // Nothing polls an event loop here, so deno_core's tracker would keep every rejection forever.
        isolate.set_promise_reject_callback(drop_rejection);
        isolate.set_host_import_module_dynamically_callback(refuse_import);
        isolate.set_host_import_module_with_phase_dynamically_callback(refuse_phased_import);

        let prelude = runtime
            .execute_script(PRELUDE_URL, deno_core::FastString::from_static(PRELUDE))
            .map_err(|error| anyhow!("the host prelude failed: {error}"))?;
        let entry = {
            deno_core::scope!(scope, &mut runtime);
            let answered = v8::Local::new(scope, prelude);
            let function = v8::Local::<v8::Function>::try_from(answered)
                .map_err(|_| anyhow!("the host prelude answered no function"))?;
            v8::Global::new(scope, function)
        };

        Ok(Self {
            entry,
            runtime,
            heap_limit_bytes,
            over_heap,
            fired: Arc::new(AtomicBool::new(false)),
            dead: None,
        })
    }

    /// Loads the bundle and runs the sim's own boot to its first await.
    pub fn boot(&mut self, bundle: String, config: String) -> Result<()> {
        self.run(Entry::Script(bundle))
            .context("the sim bundle failed while it was being evaluated")?;
        self.run(Entry::Call(BOOT, Some(config)))?;
        Ok(())
    }

    /// Why this isolate stopped, or `None` while it is still live.
    pub fn death(&self) -> Option<Death> {
        self.dead
    }

    /// One fixed step. The batch crosses as JSON and the output comes back the same way.
    pub fn tick(&mut self, batch: &InputBatch) -> Result<OutputBatch> {
        let encoded = serde_json::to_string(batch).context("encoding the input batch")?;
        let answer = self.run(Entry::Call(TICK, Some(encoded)))?;
        self.decode(answer)
    }

    /// Releases the world and takes the last batch: every online player's save, and nothing else.
    pub fn close(&mut self) -> Result<OutputBatch> {
        let answer = self.run(Entry::Call(CLOSE, None))?;
        self.decode(answer)
    }

    /// A handle a watchdog on another thread can use to stop a tick that will not return.
    pub fn kill(&mut self) -> Kill {
        Kill {
            handle: self.runtime.v8_isolate().thread_safe_handle(),
            fired: self.fired.clone(),
        }
    }

    fn decode(&mut self, answer: Option<String>) -> Result<OutputBatch> {
        let decoded = answer
            .ok_or_else(|| anyhow!("the sim returned no output batch"))
            .and_then(|raw| serde_json::from_str(&raw).context("decoding the output batch"));
        // A sim that answered nothing usable is one there is no batch to tick again from.
        if decoded.is_err() {
            self.dead = Some(Death::Threw);
        }
        decoded
    }

    fn run(&mut self, entry: Entry) -> Result<Option<String>> {
        if let Some(death) = self.dead {
            return Err(anyhow!("the isolate is dead: {}", death.token()));
        }

        let (answer, failure) = match self.enter(&entry) {
            Ran::Returned(answer) => (answer, None),
            Ran::Threw(error) => (None, Some(error)),
            Ran::Terminated => (None, Some("terminated".to_owned())),
        };
        let death = if self.over_heap.load(Ordering::SeqCst) {
            Some(Death::OutOfMemory)
        } else if failure.is_some() {
            Some(if self.fired.load(Ordering::SeqCst) {
                Death::Runaway
            } else {
                Death::Threw
            })
        } else if self.over_external() {
            Some(Death::OutOfMemory)
        } else {
            None
        };

        let Some(death) = death else {
            return Ok(answer);
        };
        self.dead = Some(death);
        Err(anyhow!(
            "{}: {}",
            death.token(),
            failure.as_deref().unwrap_or("past the heap limit")
        ))
    }

    /// Runs one entry and then the microtasks it queued; the answer is read before they run, so no
    /// later script can change the batch this entry returned.
    fn enter(&mut self, entry: &Entry) -> Ran {
        deno_core::scope!(scope, &mut self.runtime);
        let ran = {
            v8::tc_scope!(let tc, scope);
            let value = match entry {
                Entry::Script(source) => evaluate(tc, source),
                Entry::Call(phase, message) => call(tc, &self.entry, *phase, message.as_deref()),
            };
            match value {
                Some(value) => {
                    Ran::Returned(value.is_string().then(|| value.to_rust_string_lossy(tc)))
                }
                None if tc.has_terminated() => Ran::Terminated,
                // From the message V8 already built, because reading `stack` would run a creator getter.
                None => Ran::Threw(tc.message().map_or_else(
                    || "an exception with no message".to_owned(),
                    |message| JsError::from_v8_message(tc, message).to_string(),
                )),
            }
        };
        let Ran::Returned(answer) = ran else {
            return ran;
        };

        // Drained here because nothing polls an event loop: it is what moves `startGame` (never
        // awaited) and every awaiting handler forward.
        v8::tc_scope!(let tc, scope);
        tc.perform_microtask_checkpoint();
        if tc.has_terminated() {
            Ran::Terminated
        } else {
            Ran::Returned(answer)
        }
    }

    /// Whether array buffers, which V8 keeps outside the heap its limit holds, now hold more than it.
    fn over_external(&mut self) -> bool {
        let limit = self.heap_limit_bytes;
        let isolate = self.runtime.v8_isolate();
        if isolate.get_heap_statistics().external_memory() <= limit {
            return false;
        }
        // Measured again after a full collection, so a buffer nothing holds any more is not counted.
        isolate.low_memory_notification();
        isolate.get_heap_statistics().external_memory() > limit
    }
}

fn evaluate<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    source: &str,
) -> Option<v8::Local<'s, v8::Value>> {
    let source = v8::String::new(scope, source)?;
    let name = v8::String::new(scope, BUNDLE_URL)?;
    let origin = v8::ScriptOrigin::new(
        scope,
        name.into(),
        0,
        0,
        false,
        0,
        None,
        false,
        false,
        false,
        None,
    );
    v8::Script::compile(scope, source, Some(&origin))?.run(scope)
}

fn call<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    entry: &v8::Global<v8::Function>,
    phase: i32,
    message: Option<&str>,
) -> Option<v8::Local<'s, v8::Value>> {
    let function = v8::Local::new(scope, entry);
    let receiver = v8::undefined(scope).into();
    let phase = v8::Integer::new(scope, phase).into();
    let message = match message {
        Some(text) => v8::String::new(scope, text)?.into(),
        None => v8::undefined(scope).into(),
    };
    function.call(scope, receiver, &[phase, message])
}

extern "C" fn drop_rejection(_message: v8::PromiseRejectMessage<'_>) {}

/// This host has no module loader, and an import nothing ever settles is a promise held all session.
fn refuse_import<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    _options: v8::Local<'s, v8::Data>,
    _resource: v8::Local<'s, v8::Value>,
    _specifier: v8::Local<'s, v8::String>,
    _attributes: v8::Local<'s, v8::FixedArray>,
) -> Option<v8::Local<'s, v8::Promise>> {
    let refusal = v8::PromiseResolver::new(scope)?;
    let message = v8::String::new(scope, "a world cannot import a module")?;
    let error = v8::Exception::type_error(scope, message);
    refusal.reject(scope, error)?;
    Some(refusal.get_promise(scope))
}

fn refuse_phased_import<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    options: v8::Local<'s, v8::Data>,
    resource: v8::Local<'s, v8::Value>,
    specifier: v8::Local<'s, v8::String>,
    _phase: v8::ModuleImportPhase,
    attributes: v8::Local<'s, v8::FixedArray>,
) -> Option<v8::Local<'s, v8::Promise>> {
    refuse_import(scope, options, resource, specifier, attributes)
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    const LIMIT: usize = 32 * 1024 * 1024;

    /// A bundle whose tick runs `body` and otherwise answers a numbered empty batch.
    fn bundle(body: &str) -> String {
        format!(
            r#"(() => {{
                let ticks = 0;
                const batch = (line) => JSON.stringify({{
                    tick: ticks, rates: {{ simRate: 60, sendRate: 20 }}, sends: [], closes: [],
                    loads: [], saves: [], diagnostics: {{ dropped: 0, stale: 0 }},
                    log: line === undefined ? [] : [{{ level: 'info', line: String(line) }}],
                }});
                globalThis.__grove = {{
                    boot() {{}},
                    tick() {{ ticks += 1; {body}; return batch(); }},
                    close() {{ return batch(); }},
                }};
            }})();"#
        )
    }

    /// Boots `body` under an entered runtime, as the session thread holds one for deno_core.
    fn world(body: &str, test: impl FnOnce(&mut Isolate)) {
        let io = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        let _entered = io.enter();
        let mut isolate = Isolate::new(LIMIT).unwrap();
        isolate.boot(bundle(body), "{}".to_owned()).unwrap();
        test(&mut isolate);
    }

    fn tick(isolate: &mut Isolate) -> Result<OutputBatch> {
        isolate.tick(&InputBatch::new(0.0, false))
    }

    /// Stops the isolate from another thread after `after`, as the watchdog does.
    fn kill_after(isolate: &mut Isolate, after: Duration) -> std::thread::JoinHandle<()> {
        let kill = isolate.kill();
        std::thread::spawn(move || {
            std::thread::sleep(after);
            kill.terminate();
        })
    }

    #[test]
    fn answers_the_batch_its_tick_returned() {
        world("", |isolate| {
            assert_eq!(tick(isolate).unwrap().tick, 1);
            assert_eq!(tick(isolate).unwrap().tick, 2);
            assert_eq!(isolate.death(), None);
        });
    }

    /// Each of these held a function that reaches one of deno_core's ops, `op_panic` among them.
    #[test]
    fn leaves_a_script_no_route_to_the_hosts_ops() {
        world(
            "return batch([typeof Deno, typeof __bootstrap, typeof WebAssembly, \
             typeof SharedArrayBuffer, Object.getOwnPropertyNames(globalThis) \
             .filter((name) => /deno|bootstrap/i.test(name)).length, \
             String(console.log('quiet')), typeof queueMicrotask].join(' '))",
            |isolate| {
                assert_eq!(
                    tick(isolate).unwrap().log[0].line,
                    "undefined undefined undefined undefined 0 undefined function"
                );
            },
        );
    }

    /// An import the host can never serve is refused at once rather than left pending for good.
    #[test]
    fn refuses_a_dynamic_import_outright() {
        world(
            "if (ticks === 1) { import('ext:core/ops').then(() => { globalThis.seen = 'loaded' }, \
             (error) => { globalThis.seen = error.message }) } \
             else { return batch(globalThis.seen) }",
            |isolate| {
                tick(isolate).unwrap();
                assert_eq!(
                    tick(isolate).unwrap().log[0].line,
                    "a world cannot import a module"
                );
            },
        );
    }

    /// A microtask a tick leaves behind runs after the batch was taken, and cannot reach the entry.
    #[test]
    fn a_microtask_cannot_replace_the_batch_its_tick_returned() {
        world(
            "Promise.resolve().then(() => { \
                const forged = JSON.stringify({ tick: 999, rates: { simRate: 60, sendRate: 20 }, \
                    sends: [], closes: [], loads: [], log: [], diagnostics: { dropped: 0, stale: 0 }, \
                    saves: [{ hostKey: 'player:someone-else', fields: { coins: 1000000 } }] }); \
                globalThis.__grove = { boot() {}, tick: () => forged, close: () => forged }; \
            })",
            |isolate| {
                let first = tick(isolate).unwrap();
                let second = tick(isolate).unwrap();
                assert_eq!((first.tick, second.tick), (1, 2));
                assert!(first.saves.is_empty() && second.saves.is_empty());
            },
        );
    }

    #[test]
    fn a_queued_microtask_that_throws_does_not_end_the_world() {
        world(
            "queueMicrotask(() => { throw new Error('ignored') })",
            |isolate| {
                assert!(tick(isolate).is_ok());
                assert!(tick(isolate).is_ok());
            },
        );
    }

    #[test]
    fn a_tick_that_never_returns_dies_of_its_budget() {
        world("for (;;) {}", |isolate| {
            let killer = kill_after(isolate, Duration::from_millis(100));
            let failure = tick(isolate).unwrap_err();
            killer.join().unwrap();

            assert_eq!(isolate.death(), Some(Death::Runaway));
            assert!(failure.to_string().starts_with("tick-budget"), "{failure}");
        });
    }

    /// The checkpoint is creator code too, so a handler that never yields there is the same runaway.
    #[test]
    fn a_microtask_that_never_yields_dies_of_its_budget() {
        world("(async () => { for (;;) { await null; } })()", |isolate| {
            let killer = kill_after(isolate, Duration::from_millis(100));
            assert!(tick(isolate).is_err());
            killer.join().unwrap();

            assert_eq!(isolate.death(), Some(Death::Runaway));
        });
    }

    #[test]
    fn a_tick_that_throws_dies_as_the_sim_throwing() {
        world("throw new Error('a typo in a handler')", |isolate| {
            let failure = tick(isolate).unwrap_err().to_string();

            assert_eq!(isolate.death(), Some(Death::Threw));
            assert!(failure.contains("a typo in a handler"), "{failure}");
            assert!(tick(isolate).is_err());
        });
    }

    /// The flag is what a late kill leaves behind, and a span that finished must not die of it.
    #[test]
    fn a_kill_cancelled_before_it_lands_spares_the_next_tick() {
        world("", |isolate| {
            let kill = isolate.kill();
            kill.terminate();
            kill.cancel();

            assert_eq!(tick(isolate).unwrap().tick, 1);
        });
    }

    #[test]
    fn the_heap_limit_ends_a_world_that_outgrows_it() {
        world(
            "globalThis.held = []; for (;;) { held.push(new Array(4096).fill(ticks)) }",
            |isolate| {
                assert!(tick(isolate).is_err());
                assert_eq!(isolate.death(), Some(Death::OutOfMemory));
            },
        );
    }

    /// V8 keeps a buffer's bytes outside the heap it limits, so those are counted after every run.
    #[test]
    fn array_buffers_count_against_the_heap_limit() {
        let body = format!(
            "globalThis.held = globalThis.held ?? []; \
             if (ticks === 2) {{ held.push(new Uint8Array({LIMIT}), new ArrayBuffer({LIMIT})) }}"
        );
        world(&body, |isolate| {
            assert!(tick(isolate).is_ok());
            assert!(tick(isolate).is_err());
            assert_eq!(isolate.death(), Some(Death::OutOfMemory));
        });
    }

    /// A buffer the world let go of is garbage awaiting a collection, not a world over its limit.
    #[test]
    fn a_buffer_let_go_of_is_not_held_against_the_world() {
        world(
            &format!("new Uint8Array({}).fill(1)", LIMIT * 2),
            |isolate| {
                assert!(tick(isolate).is_ok());
                assert_eq!(isolate.death(), None);
            },
        );
    }

    #[test]
    fn refuses_a_bundle_that_publishes_no_entry() {
        let io = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        let _entered = io.enter();
        let mut isolate = Isolate::new(LIMIT).unwrap();

        let failure = isolate
            .boot("1 + 1".to_owned(), "{}".to_owned())
            .unwrap_err();

        assert!(
            format!("{failure:#}").contains("no boot, tick and close"),
            "{failure:#}"
        );
        assert_eq!(isolate.death(), Some(Death::Threw));
    }
}

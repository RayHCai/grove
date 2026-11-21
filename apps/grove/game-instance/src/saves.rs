//! The writes `@serverState` owes the store. One writer per host key, so the newest fields a key
//! was handed are the last ones written, and a retry never puts older fields over newer ones.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde_json::value::RawValue;
use tokio::sync::mpsc;

use crate::session::HostEvent;

/// Attempts one set of fields gets before the sim is left holding the record.
const SAVE_ATTEMPTS: u32 = 3;

/// Wait before the attempt after a failure, doubled for each one after it.
const SAVE_BACKOFF: Duration = Duration::from_millis(200);

/// All one set of fields may sleep between attempts: three 2 s requests and this fit the 8 s settle.
const SAVE_WAIT_BUDGET: Duration = Duration::from_millis(1500);

/// What a writer needs of the store, and all it needs, which is what lets one run without it.
pub trait Records: Clone + Send + Sync + 'static {
    /// One unconditional write, so between two sessions writing one key the last to land wins.
    fn write(
        &self,
        key: &str,
        fields: &RawValue,
    ) -> impl Future<Output = Result<(), Unwritten>> + Send;
}

/// A write that did not land, and how long the store asked to be left alone where it said.
#[derive(Debug)]
pub struct Unwritten {
    pub error: anyhow::Error,
    pub retry_after: Option<Duration>,
}

impl From<anyhow::Error> for Unwritten {
    fn from(error: anyhow::Error) -> Self {
        Self {
            error,
            retry_after: None,
        }
    }
}

#[derive(Clone)]
pub struct Saves<R> {
    records: R,
    /// A key is here while its writer runs, with the newest fields that writer has not taken yet.
    queued: Arc<Mutex<HashMap<String, Option<Box<RawValue>>>>>,
}

impl<R: Records> Saves<R> {
    pub fn new(records: R) -> Self {
        Self {
            records,
            queued: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Hands `fields` to `key`'s writer, superseding any it has not started on, and answers the
    /// writer to spawn when the key had none running.
    pub fn queue(
        &self,
        key: String,
        fields: Box<RawValue>,
        landed: mpsc::Sender<HostEvent>,
    ) -> Option<impl Future<Output = ()> + Send + 'static> {
        let mut queued = self.queued();
        if let Some(waiting) = queued.get_mut(&key) {
            *waiting = Some(fields);
            return None;
        }
        queued.insert(key.clone(), Some(fields));
        drop(queued);
        Some(self.clone().write(key, landed))
    }

    async fn write(self, key: String, landed: mpsc::Sender<HostEvent>) {
        let Some(mut fields) = self.next(&key) else {
            return;
        };
        loop {
            let landed_these = match self.attempt(&key, &fields).await {
                Attempted::Landed => true,
                Attempted::GaveUp => false,
                Attempted::Superseded(newer) => {
                    fields = newer;
                    continue;
                }
            };
            match self.next(&key) {
                // Acknowledged for the newest fields only: the sim lets its copy go at the first one.
                None if landed_these => {
                    let _ = landed.send(HostEvent::Saved { host_key: key }).await;
                    return;
                }
                None => return,
                Some(newer) => fields = newer,
            }
        }
    }

    /// Writes `fields` until they land, newer ones arrive, or the attempts or the waiting run out.
    async fn attempt(&self, key: &str, fields: &RawValue) -> Attempted {
        let mut waited = Duration::ZERO;
        let mut backoff = SAVE_BACKOFF;
        for attempt in 1..=SAVE_ATTEMPTS {
            let unwritten = match self.records.write(key, fields).await {
                Ok(()) => return Attempted::Landed,
                Err(unwritten) => unwritten,
            };
            tracing::warn!(error = %unwritten.error, key = %key, attempt, "persisting failed");
            if let Some(newer) = self.newer(key) {
                return Attempted::Superseded(newer);
            }
            // A store's own word on when to come back outranks the guess, but never the drain.
            let wait = unwritten.retry_after.unwrap_or(backoff);
            if attempt == SAVE_ATTEMPTS || waited + wait > SAVE_WAIT_BUDGET {
                // Not acknowledged: the sim holds the record so a rejoin inside this session
                // still reads its own values back: the better of two wrong answers.
                tracing::error!(
                    key = %key,
                    attempt,
                    retry_after = ?unwritten.retry_after,
                    "persisting gave up; the sim keeps the record"
                );
                return Attempted::GaveUp;
            }
            tokio::time::sleep(wait).await;
            waited += wait;
            backoff *= 2;
        }
        Attempted::GaveUp
    }

    /// The fields to write next, or `None` once there are none, which retires this key's writer.
    fn next(&self, key: &str) -> Option<Box<RawValue>> {
        let mut queued = self.queued();
        let newer = queued.get_mut(key).and_then(Option::take);
        if newer.is_none() {
            queued.remove(key);
        }
        newer
    }

    /// Fields queued since the writer last took some, leaving the writer in place either way.
    fn newer(&self, key: &str) -> Option<Box<RawValue>> {
        self.queued().get_mut(key).and_then(Option::take)
    }

    /// Poison is ignored: every write under this lock leaves the map whole.
    fn queued(&self) -> MutexGuard<'_, HashMap<String, Option<Box<RawValue>>>> {
        self.queued
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// How one set of fields went.
enum Attempted {
    Landed,
    GaveUp,
    /// Newer fields arrived after a failure, and those are the ones worth the remaining attempts.
    Superseded(Box<RawValue>),
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;

    use tokio::sync::Semaphore;

    use super::*;

    /// How the fake manager answers one write.
    #[derive(Clone, Copy)]
    enum Answer {
        Land,
        Fail,
        /// A 429 carrying this `Retry-After`.
        Throttle(Duration),
    }

    #[derive(Default)]
    struct Inner {
        /// Every write, as `(key, fields)`, in the order the writers sent them.
        writes: Mutex<Vec<(String, String)>>,
        /// One answer per write, in order; a write past the end lands.
        answers: Mutex<VecDeque<Answer>>,
        /// A call for a key with a gate here waits for a permit, which is how a test holds one open.
        gates: Mutex<HashMap<String, Arc<Semaphore>>>,
        started: Mutex<Option<mpsc::UnboundedSender<&'static str>>>,
    }

    #[derive(Clone, Default)]
    struct Manager(Arc<Inner>);

    impl Manager {
        fn answering(answers: &[Answer]) -> Self {
            let manager = Self::default();
            manager.0.answers.lock().unwrap().extend(answers);
            manager
        }

        /// Holds every call for `key` until `release` lets it through, and reports each one starting.
        fn hold(&self, key: &str) -> mpsc::UnboundedReceiver<&'static str> {
            let (started, starts) = mpsc::unbounded_channel();
            *self.0.started.lock().unwrap() = Some(started);
            self.0
                .gates
                .lock()
                .unwrap()
                .insert(key.to_owned(), Arc::new(Semaphore::new(0)));
            starts
        }

        fn release(&self, key: &str, calls: usize) {
            self.0.gates.lock().unwrap()[key].add_permits(calls);
        }

        async fn pass(&self, key: &str, call: &'static str) {
            let gate = self.0.gates.lock().unwrap().get(key).cloned();
            if let Some(gate) = gate {
                if let Some(started) = &*self.0.started.lock().unwrap() {
                    let _ = started.send(call);
                }
                gate.acquire().await.unwrap().forget();
            }
        }

        fn writes(&self) -> Vec<(String, String)> {
            self.0.writes.lock().unwrap().clone()
        }
    }

    impl Records for Manager {
        fn write(
            &self,
            key: &str,
            fields: &RawValue,
        ) -> impl Future<Output = Result<(), Unwritten>> + Send {
            let (manager, key, fields) = (self.clone(), key.to_owned(), fields.get().to_owned());
            async move {
                manager.pass(&key, "write").await;
                manager.0.writes.lock().unwrap().push((key, fields));
                let answer = manager.0.answers.lock().unwrap().pop_front();
                match answer.unwrap_or(Answer::Land) {
                    Answer::Land => Ok(()),
                    Answer::Fail => Err(anyhow::anyhow!("the manager answered 503").into()),
                    Answer::Throttle(wait) => Err(Unwritten {
                        error: anyhow::anyhow!("the manager answered 429"),
                        retry_after: Some(wait),
                    }),
                }
            }
        }
    }

    const KEY: &str = "player:wren";

    fn fields(coins: u32) -> Box<RawValue> {
        RawValue::from_string(format!(r#"{{"coins":{coins}}}"#)).unwrap()
    }

    fn written(coins: u32) -> (String, String) {
        (KEY.to_owned(), format!(r#"{{"coins":{coins}}}"#))
    }

    /// Every acknowledgement the sim would be handed, once the writers have stopped.
    fn acknowledged(events: &mut mpsc::Receiver<HostEvent>) -> Vec<String> {
        let mut keys = Vec::new();
        while let Ok(event) = events.try_recv() {
            if let HostEvent::Saved { host_key } = event {
                keys.push(host_key);
            }
        }
        keys
    }

    #[tokio::test]
    async fn writes_a_save_and_acknowledges_it() {
        let saves = Saves::new(Manager::default());
        let (landed, mut events) = mpsc::channel(8);

        saves
            .queue(KEY.to_owned(), fields(3), landed)
            .unwrap()
            .await;

        assert_eq!(saves.records.writes(), vec![written(3)]);
        assert_eq!(acknowledged(&mut events), vec![KEY.to_owned()]);
    }

    /// Two departures of one player while a write is out: the older is never written over the newer.
    #[tokio::test]
    async fn the_newest_save_is_the_last_written_and_the_only_one_acknowledged() {
        let manager = Manager::default();
        let mut starts = manager.hold(KEY);
        let saves = Saves::new(manager.clone());
        let (landed, mut events) = mpsc::channel(8);

        let writer = tokio::spawn(
            saves
                .queue(KEY.to_owned(), fields(1), landed.clone())
                .unwrap(),
        );
        assert_eq!(starts.recv().await, Some("write"));
        assert!(saves
            .queue(KEY.to_owned(), fields(2), landed.clone())
            .is_none());
        assert!(saves.queue(KEY.to_owned(), fields(3), landed).is_none());
        manager.release(KEY, 2);
        writer.await.unwrap();

        assert_eq!(manager.writes(), vec![written(1), written(3)]);
        assert_eq!(acknowledged(&mut events), vec![KEY.to_owned()]);
    }

    /// Fields that arrived while a write was failing are the ones its retry carries.
    #[tokio::test]
    async fn a_retry_after_a_failure_carries_the_newest_fields() {
        let manager = Manager::answering(&[Answer::Fail]);
        let mut starts = manager.hold(KEY);
        let saves = Saves::new(manager.clone());
        let (landed, mut events) = mpsc::channel(8);

        let writer = tokio::spawn(
            saves
                .queue(KEY.to_owned(), fields(1), landed.clone())
                .unwrap(),
        );
        assert_eq!(starts.recv().await, Some("write"));
        assert!(saves.queue(KEY.to_owned(), fields(2), landed).is_none());
        manager.release(KEY, 2);
        writer.await.unwrap();

        assert_eq!(manager.writes(), vec![written(1), written(2)]);
        assert_eq!(acknowledged(&mut events), vec![KEY.to_owned()]);
    }

    /// A 429 names when the manager will take the write, which a doubling backoff would guess at.
    #[tokio::test(start_paused = true)]
    async fn a_throttled_write_waits_as_long_as_the_manager_asked() {
        let asked = Duration::from_secs(1);
        let manager = Manager::answering(&[Answer::Throttle(asked)]);
        let saves = Saves::new(manager.clone());
        let (landed, mut events) = mpsc::channel(8);

        let began = tokio::time::Instant::now();
        saves
            .queue(KEY.to_owned(), fields(5), landed)
            .unwrap()
            .await;

        assert_eq!(began.elapsed(), asked);
        assert_eq!(manager.writes(), vec![written(5), written(5)]);
        assert_eq!(acknowledged(&mut events), vec![KEY.to_owned()]);
    }

    /// The drain's settle has to finish inside the agent's kill, so no `Retry-After` is honoured past it.
    #[tokio::test(start_paused = true)]
    async fn a_throttled_write_told_to_wait_past_the_budget_gives_up_at_once() {
        let manager = Manager::answering(&[Answer::Throttle(SAVE_WAIT_BUDGET * 10)]);
        let saves = Saves::new(manager.clone());
        let (landed, mut events) = mpsc::channel(8);

        let began = tokio::time::Instant::now();
        saves
            .queue(KEY.to_owned(), fields(5), landed.clone())
            .unwrap()
            .await;

        assert_eq!(began.elapsed(), Duration::ZERO);
        assert_eq!(manager.writes(), vec![written(5)]);
        assert!(acknowledged(&mut events).is_empty());
        assert!(saves.queue(KEY.to_owned(), fields(6), landed).is_some());
    }

    /// Unacknowledged, the sim still holds the record, which is what a rejoin reads back.
    #[tokio::test(start_paused = true)]
    async fn a_save_that_never_lands_is_never_acknowledged() {
        let manager = Manager::answering(&[Answer::Fail; SAVE_ATTEMPTS as usize]);
        let saves = Saves::new(manager.clone());
        let (landed, mut events) = mpsc::channel(8);

        let began = tokio::time::Instant::now();
        saves
            .queue(KEY.to_owned(), fields(7), landed.clone())
            .unwrap()
            .await;

        assert_eq!(manager.writes(), vec![written(7); SAVE_ATTEMPTS as usize]);
        assert!(began.elapsed() <= SAVE_WAIT_BUDGET);
        assert!(acknowledged(&mut events).is_empty());
        // The writer retired, so the next save for this key starts one of its own.
        assert!(saves.queue(KEY.to_owned(), fields(8), landed).is_some());
    }

    #[tokio::test]
    async fn one_key_waiting_on_the_manager_holds_up_no_other() {
        let manager = Manager::default();
        let _starts = manager.hold(KEY);
        let saves = Saves::new(manager.clone());
        let (landed, mut events) = mpsc::channel(8);

        let held = tokio::spawn(
            saves
                .queue(KEY.to_owned(), fields(1), landed.clone())
                .unwrap(),
        );
        saves
            .queue("player:ash".to_owned(), fields(2), landed)
            .unwrap()
            .await;

        assert_eq!(
            manager.writes(),
            vec![("player:ash".to_owned(), r#"{"coins":2}"#.to_owned())]
        );
        assert_eq!(acknowledged(&mut events), vec!["player:ash".to_owned()]);
        held.abort();
    }
}

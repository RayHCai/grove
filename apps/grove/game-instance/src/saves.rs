//! The writes `@serverState` owes the store. One writer per host key, so the newest fields a key
//! was handed are the last ones written, and a retry never puts older fields over newer ones.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use anyhow::Result;
use serde_json::value::RawValue;
use tokio::sync::mpsc;

use crate::session::HostEvent;

/// Attempts one set of fields gets before the sim is left holding the record.
const SAVE_ATTEMPTS: u32 = 3;

/// Wait before the attempt after a failure, doubled for each one after it.
const SAVE_BACKOFF: Duration = Duration::from_millis(200);

/// What a writer needs of the store, and all it needs, which is what lets one run without it.
pub trait Records: Clone + Send + Sync + 'static {
    /// One compare-and-set: `Ok(false)` when another writer moved the record first.
    fn write(&self, key: &str, fields: &RawValue) -> impl Future<Output = Result<bool>> + Send;
    /// Re-reads the revision a lost compare-and-set has to be tried against again.
    fn reread(&self, key: &str) -> impl Future<Output = Result<()>> + Send;
}

/// How one attempt went.
enum Attempt {
    Landed,
    /// Another writer got there first, and the revision is read again.
    Lost,
    Failed(anyhow::Error),
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
        let mut attempt = 0;
        let mut wait = SAVE_BACKOFF;
        loop {
            attempt += 1;
            let outcome = match self.records.write(&key, &fields).await {
                Ok(true) => Attempt::Landed,
                Ok(false) => {
                    tracing::warn!(key = %key, "another session moved this record; re-reading");
                    match self.records.reread(&key).await {
                        Ok(()) => Attempt::Lost,
                        Err(error) => Attempt::Failed(error),
                    }
                }
                Err(error) => Attempt::Failed(error),
            };

            let newer = match outcome {
                // Acknowledged for the newest fields only: the sim lets its copy go at the first one.
                Attempt::Landed => match self.next(&key) {
                    None => {
                        let _ = landed.send(HostEvent::Saved { host_key: key }).await;
                        return;
                    }
                    newer => newer,
                },
                Attempt::Lost | Attempt::Failed(_) => self.newer(&key),
            };
            if let Some(newer) = newer {
                fields = newer;
                attempt = 0;
                wait = SAVE_BACKOFF;
                continue;
            }

            if let Attempt::Failed(error) = &outcome {
                tracing::warn!(%error, key = %key, attempt, "persisting failed");
            }
            if attempt == SAVE_ATTEMPTS {
                // Not acknowledged: the sim holds the record so a rejoin inside this session
                // still reads its own values back: the better of two wrong answers.
                tracing::warn!(key = %key, "persisting gave up; the sim keeps the record");
                let Some(newer) = self.next(&key) else {
                    return;
                };
                fields = newer;
                attempt = 0;
                wait = SAVE_BACKOFF;
                continue;
            }
            // A lost compare-and-set is retried at once, since the re-read already answered.
            if matches!(outcome, Attempt::Failed(_)) {
                tokio::time::sleep(wait).await;
                wait *= 2;
            }
        }
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

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;

    use tokio::sync::Semaphore;

    use super::*;

    /// How the fake manager answers one write.
    #[derive(Clone, Copy)]
    enum Answer {
        Land,
        Lose,
        Fail,
    }

    #[derive(Default)]
    struct Inner {
        /// Every write, as `(key, fields)`, in the order the writers sent them.
        writes: Mutex<Vec<(String, String)>>,
        /// One answer per write, in order; a write past the end lands.
        answers: Mutex<VecDeque<Answer>>,
        rereads: Mutex<usize>,
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
        fn write(&self, key: &str, fields: &RawValue) -> impl Future<Output = Result<bool>> + Send {
            let (manager, key, fields) = (self.clone(), key.to_owned(), fields.get().to_owned());
            async move {
                manager.pass(&key, "write").await;
                manager.0.writes.lock().unwrap().push((key, fields));
                let answer = manager.0.answers.lock().unwrap().pop_front();
                match answer.unwrap_or(Answer::Land) {
                    Answer::Land => Ok(true),
                    Answer::Lose => Ok(false),
                    Answer::Fail => Err(anyhow::anyhow!("the manager answered 503")),
                }
            }
        }

        fn reread(&self, key: &str) -> impl Future<Output = Result<()>> + Send {
            let (manager, key) = (self.clone(), key.to_owned());
            async move {
                manager.pass(&key, "reread").await;
                *manager.0.rereads.lock().unwrap() += 1;
                Ok(())
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

    /// The re-read after a lost compare-and-set is where a newer save can arrive, and it is the one written.
    #[tokio::test]
    async fn a_retry_after_a_conflict_carries_the_newest_fields() {
        let manager = Manager::answering(&[Answer::Lose]);
        let mut starts = manager.hold(KEY);
        let saves = Saves::new(manager.clone());
        let (landed, mut events) = mpsc::channel(8);

        let writer = tokio::spawn(
            saves
                .queue(KEY.to_owned(), fields(1), landed.clone())
                .unwrap(),
        );
        manager.release(KEY, 1);
        assert_eq!(starts.recv().await, Some("write"));
        assert_eq!(starts.recv().await, Some("reread"));
        assert!(saves.queue(KEY.to_owned(), fields(2), landed).is_none());
        manager.release(KEY, 2);
        writer.await.unwrap();

        assert_eq!(manager.writes(), vec![written(1), written(2)]);
        assert_eq!(acknowledged(&mut events), vec![KEY.to_owned()]);
    }

    #[tokio::test]
    async fn a_conflict_with_nothing_newer_retries_the_same_fields_against_a_fresh_revision() {
        let manager = Manager::answering(&[Answer::Lose]);
        let saves = Saves::new(manager.clone());
        let (landed, mut events) = mpsc::channel(8);

        saves
            .queue(KEY.to_owned(), fields(5), landed)
            .unwrap()
            .await;

        assert_eq!(manager.writes(), vec![written(5), written(5)]);
        assert_eq!(*manager.0.rereads.lock().unwrap(), 1);
        assert_eq!(acknowledged(&mut events), vec![KEY.to_owned()]);
    }

    /// Unacknowledged, the sim still holds the record, which is what a rejoin reads back.
    #[tokio::test(start_paused = true)]
    async fn a_save_that_never_lands_is_never_acknowledged() {
        let manager = Manager::answering(&[Answer::Fail; SAVE_ATTEMPTS as usize]);
        let saves = Saves::new(manager.clone());
        let (landed, mut events) = mpsc::channel(8);

        saves
            .queue(KEY.to_owned(), fields(7), landed.clone())
            .unwrap()
            .await;

        assert_eq!(manager.writes(), vec![written(7); SAVE_ATTEMPTS as usize]);
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

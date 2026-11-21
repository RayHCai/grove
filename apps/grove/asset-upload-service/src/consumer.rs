//! The asset stream, read with a consumer group. A save that lands an asset writes a row and pushes
//! its id here, and a claimed task is inspected and copied before it is settled.
//!
//! A group rather than a list, because a worker that dies mid-asset has to hand its claim back
//! instead of taking the asset with it.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use redis::aio::{ConnectionManager, ConnectionManagerConfig};
use redis::streams::{
    StreamAutoClaimOptions, StreamAutoClaimReply, StreamPendingCountReply, StreamReadOptions,
    StreamReadReply,
};
use redis::{AsyncCommands, RedisError};
use tokio::sync::watch;

use crate::inspect::{self, Bucket, Invalid};
use crate::tasks::{Claim, Inspection, Outcome, Settled, Tasks, SETTLE_TIMEOUT};

/// The stream a save pushes an asset upload onto; `@grove/api-contract` spells the same name.
pub const STREAM: &str = "grove:tasks:asset-upload";

/// The group every upload worker reads under, so a second process shares the work.
const GROUP: &str = "upload-service";

/// How long a read waits for work before the loop comes back round to reclaim and check for a stop.
const BLOCK: Duration = Duration::from_secs(5);

/// One at a time: what lands here is about to become real work, and ten claimed is nine waiting.
const BATCH: usize = 1;

/// How long a claimed asset may sit before another worker may take it back.
const RECLAIM_AFTER: Duration = Duration::from_secs(300);

/// Past `BLOCK`, because the driver's own default would time out every blocking read it is sent.
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(10);

/// Long enough for a TLS handshake to a managed cache in another zone.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// How long a consumer that failed waits before it is started again.
const RESTART_AFTER: Duration = Duration::from_secs(5);

/// Passes over the stream that may fail in a row before `/health` reports the consumer down.
const MAX_FAILED_PASSES: u32 = 3;

/// Times one message may be handed out before it is dropped as one no worker can finish.
const MAX_DELIVERIES: u64 = 5;

/// How long a consumer whose credential the API refused waits before it tries the same message again.
const LOCKED_BACKOFF: Duration = Duration::from_secs(30);

/// What one asset did with its message.
///
/// `Ack` is acknowledged: the outcome is written down, whatever it was. `Retry` leaves it claimed
/// so another worker takes it back after the reclaim window, which is what a failure of the fleet
/// rather than of the asset earns.
#[derive(Debug, PartialEq, Eq)]
pub enum Handled {
    Ack,
    Retry,
    /// The API refused this service's credential, so every message would be refused alike.
    Locked,
}

/// What claiming and inspecting an asset needs: the API that settles it and the bucket holding it.
pub struct Worker {
    pub tasks: Arc<dyn Tasks>,
    pub bucket: Arc<dyn Bucket>,
}

/// Claims one asset upload, holds its bytes to the type they were declared as, and settles it.
pub async fn run_upload(task: &str, worker: &Worker) -> Handled {
    let outcome = match worker.tasks.claim(task).await {
        Claim::Claimed(inspection) => {
            // Settled inside the lease or not at all: past it another worker may hold the task.
            let Some(deadline) = work_deadline(inspection.expires_at) else {
                tracing::warn!(task, "the claim's lease is too short to settle inside");
                return Handled::Retry;
            };
            let inspecting = inspected(&inspection, worker.bucket.as_ref());
            match tokio::time::timeout_at(deadline, inspecting).await {
                Ok(Ok(outcome)) => outcome,
                Ok(Err(error)) => {
                    tracing::warn!(task, error = ?error, "asset upload could not be inspected");
                    return Handled::Retry;
                }
                Err(_) => {
                    tracing::warn!(task, "the lease ran out before the inspection did");
                    return Handled::Retry;
                }
            }
        }
        Claim::Uninspectable => Outcome::Failed {
            message: "this upload could not be checked; save it again".to_owned(),
        },
        Claim::Not(Settled::Unavailable | Settled::Held) => return Handled::Retry,
        Claim::Not(Settled::Unauthorized) => return Handled::Locked,
        // Somebody already holds or settled it, or the API never will take it: either way a retry
        // brings the same message straight back, so it is acknowledged.
        Claim::Not(settled) => {
            tracing::info!(task, ?settled, "asset upload not claimed");
            return Handled::Ack;
        }
    };

    match worker.tasks.settle(task, &outcome).await {
        // The outcome could not be written down, so the work has to come back: acknowledging here
        // would leave a creator watching a task nothing will ever move.
        Settled::Unavailable => Handled::Retry,
        Settled::Unauthorized => Handled::Locked,
        _ => Handled::Ack,
    }
}

/// When the transfers must be done by, so the settle's own timeout still lands before `expires_at`.
fn work_deadline(expires_at: SystemTime) -> Option<tokio::time::Instant> {
    let left = expires_at.duration_since(SystemTime::now()).ok()?;
    Some(tokio::time::Instant::now() + left.checked_sub(SETTLE_TIMEOUT)?)
}

/// The verdict on one upload, or an error where the bucket rather than the upload failed.
async fn inspected(inspection: &Inspection, bucket: &dyn Bucket) -> anyhow::Result<Outcome> {
    let Some(bytes) = bucket
        .fetch(&inspection.source, inspection.byte_length + 1)
        .await?
    else {
        return Ok(Outcome::Failed {
            message: "this upload is no longer there; upload it again".to_owned(),
        });
    };
    if let Err(Invalid(message)) =
        inspect::check(&inspection.content_type, inspection.byte_length, &bytes)
    {
        return Ok(Outcome::Failed {
            message: inspect::clipped(&message),
        });
    }
    let version_id = bucket
        .publish(&inspection.destination, &inspection.content_type, bytes)
        .await?;
    Ok(Outcome::Passed { version_id })
}

/// One message off the stream, as far as a worker needs to know it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Delivery {
    pub id: String,
    /// `None` for a message that names no task this service could ever settle.
    pub task: Option<String>,
    /// Counting this one.
    pub deliveries: u64,
}

/// A failed call to the stream, and whether it failed because the group is gone.
#[derive(Debug)]
pub struct QueueError {
    pub missing_group: bool,
    pub error: anyhow::Error,
}

impl From<RedisError> for QueueError {
    fn from(error: RedisError) -> Self {
        Self {
            missing_group: error.code() == Some("NOGROUP"),
            error: error.into(),
        }
    }
}

/// The asset stream, as the loop below reads it.
#[async_trait::async_trait]
pub trait Queue: Send {
    /// Creates the group where it is missing, which a stream lost with its cache needs again.
    async fn join(&mut self) -> Result<(), QueueError>;
    /// Messages another worker held past the reclaim window, now this one's.
    async fn reclaim(&mut self) -> Result<Vec<Delivery>, QueueError>;
    /// Messages nobody has been handed yet, waiting up to `BLOCK` for one.
    async fn read(&mut self) -> Result<Vec<Delivery>, QueueError>;
    async fn ack(&mut self, id: &str) -> Result<(), QueueError>;
}

/// Runs the consumer until `stop` is sent, starting it again whenever it fails or panics.
/// `alive` is true only while one has joined its group and is being answered, which `/health` reports.
pub async fn supervise(
    client: redis::Client,
    worker: Arc<Worker>,
    name: String,
    mut stop: watch::Receiver<bool>,
    alive: Arc<AtomicBool>,
) {
    loop {
        let run = tokio::spawn(consume(
            client.clone(),
            worker.clone(),
            name.clone(),
            stop.clone(),
            alive.clone(),
        ));
        let failure = match run.await {
            Ok(Ok(())) => return,
            Ok(Err(err)) => format!("{err:?}"),
            Err(join) => join.to_string(),
        };
        alive.store(false, Ordering::Relaxed);
        tracing::error!(error = %failure, "asset consumer stopped; restarting");

        let _ = tokio::time::timeout(RESTART_AFTER, stop.changed()).await;
        if *stop.borrow() {
            return;
        }
    }
}

/// Connects, joins the group and reads until `stop` is sent.
async fn consume(
    client: redis::Client,
    worker: Arc<Worker>,
    name: String,
    stop: watch::Receiver<bool>,
    alive: Arc<AtomicBool>,
) -> anyhow::Result<()> {
    let config = ConnectionManagerConfig::new()
        .set_response_timeout(Some(RESPONSE_TIMEOUT))
        .set_connection_timeout(Some(CONNECT_TIMEOUT));
    let redis = ConnectionManager::new_with_config(client, config).await?;
    let mut queue = RedisQueue { redis, name };
    queue.join().await.map_err(|failed| failed.error)?;
    alive.store(true, Ordering::Relaxed);
    drain(&mut queue, &worker, stop, &alive).await;
    Ok(())
}

/// Reads the stream until `stop` is sent: what another worker abandoned first, then what is new.
pub async fn drain(
    queue: &mut dyn Queue,
    worker: &Worker,
    mut stop: watch::Receiver<bool>,
    alive: &AtomicBool,
) {
    let mut failed_passes = 0;
    // A message whose claim the API refused our credential for, tried again alone until it is not.
    let mut locked: Option<Delivery> = None;
    while !*stop.borrow() {
        let passed = match locked.take() {
            Some(delivery) => Ok(handle(queue, worker, delivery)
                .await
                .map_or(Pass::Done, Pass::Locked)),
            None => pass(queue, worker, &mut stop).await,
        };
        match passed {
            Ok(Pass::Done) => {
                failed_passes = 0;
                alive.store(true, Ordering::Relaxed);
            }
            // Down rather than draining: acking what a wrong secret is refused for empties the stream.
            Ok(Pass::Locked(delivery)) => {
                alive.store(false, Ordering::Relaxed);
                tracing::error!(
                    id = %delivery.id,
                    "the API refused ASSET_SERVICE_SECRET; holding the stream until it does not"
                );
                locked = Some(delivery);
                let _ = tokio::time::timeout(LOCKED_BACKOFF, stop.changed()).await;
            }
            // A stream that would not answer is the next pass's problem: this loop is the whole of
            // what the process does, and giving up on it would be a worker that never comes back.
            Err(failed) => {
                failed_passes += 1;
                if failed_passes >= MAX_FAILED_PASSES {
                    alive.store(false, Ordering::Relaxed);
                }
                tracing::warn!(error = ?failed.error, failed_passes, "asset stream read failed");
                if failed.missing_group {
                    tracing::warn!("the consumer group is gone; creating it again");
                    if let Err(again) = queue.join().await {
                        tracing::warn!(error = ?again.error, "the consumer group could not be created");
                    }
                }
                let _ = tokio::time::timeout(BLOCK, stop.changed()).await;
            }
        }
    }
}

/// How one pass over the stream ended.
enum Pass {
    Done,
    /// The API refused this service's credential for this message, which is left unacknowledged.
    Locked(Delivery),
}

/// Reclaimed first: an asset another worker died holding is older work than anything new, and the
/// creator waiting on it has been waiting longest.
async fn pass(
    queue: &mut dyn Queue,
    worker: &Worker,
    stop: &mut watch::Receiver<bool>,
) -> Result<Pass, QueueError> {
    for delivery in queue.reclaim().await? {
        if let Some(locked) = handle(queue, worker, delivery).await {
            return Ok(Pass::Locked(locked));
        }
    }
    // Checked again here and raced below, so a stop is never followed by a claim.
    if *stop.borrow() {
        return Ok(Pass::Done);
    }
    let read = tokio::select! {
        biased;
        Ok(()) = stop.changed() => return Ok(Pass::Done),
        read = queue.read() => read?,
    };
    for delivery in read {
        if let Some(locked) = handle(queue, worker, delivery).await {
            return Ok(Pass::Locked(locked));
        }
    }
    Ok(Pass::Done)
}

/// Runs one message and acknowledges it once its outcome is written down; a locked one comes back.
async fn handle(queue: &mut dyn Queue, worker: &Worker, delivery: Delivery) -> Option<Delivery> {
    let finished = match &delivery.task {
        // Nothing this service can ever do with it, and leaving it pending would make every
        // reclaim pass pick it up again.
        None => {
            tracing::error!(id = %delivery.id, "message names no task");
            true
        }
        Some(task) if delivery.deliveries > MAX_DELIVERIES => {
            tracing::error!(
                task,
                deliveries = delivery.deliveries,
                "asset upload handed out too often; dropping it"
            );
            true
        }
        Some(task) => match run_upload(task, worker).await {
            Handled::Ack => true,
            Handled::Retry => false,
            Handled::Locked => return Some(delivery),
        },
    };
    if finished {
        if let Err(failed) = queue.ack(&delivery.id).await {
            tracing::warn!(error = ?failed.error, id = %delivery.id, "acknowledging failed");
        }
    }
    None
}

struct RedisQueue {
    redis: ConnectionManager,
    name: String,
}

#[async_trait::async_trait]
impl Queue for RedisQueue {
    async fn join(&mut self) -> Result<(), QueueError> {
        // From the start, since a recreated group should hand out what was waiting when it was lost.
        let created: Result<(), RedisError> =
            self.redis.xgroup_create_mkstream(STREAM, GROUP, "0").await;
        match created {
            Err(error) if error.code() != Some("BUSYGROUP") => Err(error.into()),
            _ => Ok(()),
        }
    }

    async fn reclaim(&mut self) -> Result<Vec<Delivery>, QueueError> {
        let reply: StreamAutoClaimReply = self
            .redis
            .xautoclaim_options(
                STREAM,
                GROUP,
                &self.name,
                RECLAIM_AFTER.as_millis() as usize,
                "0",
                StreamAutoClaimOptions::default().count(BATCH),
            )
            .await?;
        let mut reclaimed = Vec::with_capacity(reply.claimed.len());
        for entry in reply.claimed {
            let pending: StreamPendingCountReply = self
                .redis
                .xpending_count(STREAM, GROUP, &entry.id, &entry.id, 1)
                .await?;
            let deliveries = pending
                .ids
                .first()
                .map_or(1, |pending| pending.times_delivered as u64);
            reclaimed.push(delivery(entry.id, &entry.map, deliveries));
        }
        Ok(reclaimed)
    }

    async fn read(&mut self) -> Result<Vec<Delivery>, QueueError> {
        let options = StreamReadOptions::default()
            .group(GROUP, &self.name)
            .count(BATCH)
            .block(BLOCK.as_millis() as usize);
        let reply: Option<StreamReadReply> = self
            .redis
            .xread_options(&[STREAM], &[">"], &options)
            .await?;
        Ok(reply
            .into_iter()
            .flat_map(|reply| reply.keys)
            .flat_map(|key| key.ids)
            .map(|entry| delivery(entry.id, &entry.map, 1))
            .collect())
    }

    async fn ack(&mut self, id: &str) -> Result<(), QueueError> {
        let _: usize = self.redis.xack(STREAM, GROUP, &[id]).await?;
        Ok(())
    }
}

fn delivery(id: String, fields: &HashMap<String, redis::Value>, deliveries: u64) -> Delivery {
    Delivery {
        task: fields.get("taskId").and_then(task_id),
        id,
        deliveries,
    }
}

/// A field as the driver hands it over, which for a string is bulk bytes rather than a `String`.
/// Held to the request-id alphabet, because the id becomes a URL path segment and a header value.
fn task_id(value: &redis::Value) -> Option<String> {
    let id = match value {
        redis::Value::BulkString(bytes) => String::from_utf8(bytes.clone()).ok(),
        redis::Value::SimpleString(text) => Some(text.clone()),
        _ => None,
    }?;
    request_id::valid(&id).then_some(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::Mutex;

    const TASK: &str = "8c2e4a60-5d17-4b93-8f0a-1e6d2c4b7a35";
    /// A 1×1 PNG, as far as the end of the header the inspection reads its size from.
    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x01\0\0\0\x01\x08\x06\0\0\0";

    /// The API's own lease for an asset upload, as a claim would name its end.
    fn leased_for(lease: Duration) -> Inspection {
        Inspection {
            source: "https://bucket/uploads/leaf".to_owned(),
            destination: "https://bucket/assets/leaf".to_owned(),
            content_type: "image/png".to_owned(),
            byte_length: PNG.len() as u64,
            expires_at: SystemTime::now() + lease,
        }
    }

    /// A status route that claims as `claim` says and keeps every outcome it was told.
    struct Writing {
        claim: Mutex<Option<Claim>>,
        settle: Mutex<VecDeque<Settled>>,
        settled: Mutex<Vec<Outcome>>,
        /// What `/health` read at each claim, where a test hands over the flag it watches.
        health: Mutex<Option<Arc<AtomicBool>>>,
        healthy_at_claims: Mutex<Vec<bool>>,
    }

    impl Writing {
        fn new(claim: Claim, settle: Vec<Settled>) -> Self {
            Self {
                claim: Mutex::new(Some(claim)),
                settle: Mutex::new(settle.into()),
                settled: Mutex::new(Vec::new()),
                health: Mutex::new(None),
                healthy_at_claims: Mutex::new(Vec::new()),
            }
        }

        fn claiming(content_type: &str, byte_length: u64) -> Self {
            Self::new(
                Claim::Claimed(Inspection {
                    content_type: content_type.to_owned(),
                    byte_length,
                    ..leased_for(Duration::from_secs(240))
                }),
                vec![Settled::Written],
            )
        }
    }

    #[async_trait::async_trait]
    impl Tasks for Writing {
        async fn claim(&self, _task: &str) -> Claim {
            if let Some(health) = &*self.health.lock().unwrap() {
                let healthy = health.load(Ordering::Relaxed);
                self.healthy_at_claims.lock().unwrap().push(healthy);
            }
            self.claim
                .lock()
                .unwrap()
                .take()
                .unwrap_or(Claim::Not(Settled::Refused))
        }

        async fn settle(&self, _task: &str, outcome: &Outcome) -> Settled {
            self.settled.lock().unwrap().push(outcome.clone());
            self.settle
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or(Settled::Written)
        }
    }

    /// A bucket holding `upload`, or failing every call where it holds nothing.
    struct Holding {
        upload: Option<Vec<u8>>,
        copied: Mutex<Vec<(String, Vec<u8>)>>,
        publishes: bool,
        /// How long each read takes to answer.
        reading: Duration,
    }

    impl Holding {
        fn of(upload: &[u8]) -> Self {
            Self {
                upload: Some(upload.to_vec()),
                copied: Mutex::new(Vec::new()),
                publishes: true,
                reading: Duration::ZERO,
            }
        }
    }

    #[async_trait::async_trait]
    impl Bucket for Holding {
        async fn fetch(&self, _url: &str, limit: u64) -> anyhow::Result<Option<Vec<u8>>> {
            tokio::time::sleep(self.reading).await;
            let upload = self
                .upload
                .clone()
                .ok_or_else(|| anyhow::anyhow!("the bucket answered 503"))?;
            Ok(Some(upload.into_iter().take(limit as usize).collect()))
        }

        async fn publish(
            &self,
            _url: &str,
            content_type: &str,
            bytes: Vec<u8>,
        ) -> anyhow::Result<String> {
            if !self.publishes {
                anyhow::bail!("the bucket answered 503");
            }
            self.copied
                .lock()
                .unwrap()
                .push((content_type.to_owned(), bytes));
            Ok("version-1".to_owned())
        }
    }

    fn worker(tasks: Writing, bucket: Holding) -> (Worker, Arc<Writing>, Arc<Holding>) {
        let (tasks, bucket) = (Arc::new(tasks), Arc::new(bucket));
        (
            Worker {
                tasks: tasks.clone(),
                bucket: bucket.clone(),
            },
            tasks,
            bucket,
        )
    }

    #[tokio::test]
    async fn copies_an_upload_that_is_what_it_says_and_settles_it_with_the_copys_version() {
        let (worker, tasks, bucket) = worker(
            Writing::claiming("image/png", PNG.len() as u64),
            Holding::of(PNG),
        );

        assert_eq!(run_upload(TASK, &worker).await, Handled::Ack);
        assert_eq!(
            *bucket.copied.lock().unwrap(),
            vec![("image/png".to_owned(), PNG.to_vec())]
        );
        assert_eq!(
            *tasks.settled.lock().unwrap(),
            vec![Outcome::Passed {
                version_id: "version-1".to_owned()
            }]
        );
    }

    /// The upload stays in quarantine, and the creator is told why in words they can act on.
    #[tokio::test]
    async fn fails_an_upload_that_is_not_what_it_says_and_copies_nothing() {
        let (worker, tasks, bucket) =
            worker(Writing::claiming("image/png", 4), Holding::of(b"GIF8"));

        assert_eq!(run_upload(TASK, &worker).await, Handled::Ack);
        assert!(bucket.copied.lock().unwrap().is_empty());
        assert_eq!(
            *tasks.settled.lock().unwrap(),
            vec![Outcome::Failed {
                message: "this upload is not a PNG image".to_owned()
            }]
        );
    }

    #[tokio::test]
    async fn fails_an_upload_longer_than_it_was_declared() {
        let (worker, tasks, _bucket) = worker(Writing::claiming("image/png", 8), Holding::of(PNG));

        assert_eq!(run_upload(TASK, &worker).await, Handled::Ack);
        assert!(matches!(
            &tasks.settled.lock().unwrap()[..],
            [Outcome::Failed { message }] if message.contains("longer than")
        ));
    }

    /// The bucket failing is the fleet's fault, so the message comes back rather than the asset failing.
    #[tokio::test]
    async fn leaves_the_message_claimed_when_the_bucket_cannot_be_read_or_written() {
        let mut unreadable = Holding::of(PNG);
        unreadable.upload = None;
        let mut unwritable = Holding::of(PNG);
        unwritable.publishes = false;

        for bucket in [unreadable, unwritable] {
            let (worker, tasks, _) =
                worker(Writing::claiming("image/png", PNG.len() as u64), bucket);
            assert_eq!(run_upload(TASK, &worker).await, Handled::Retry);
            assert!(tasks.settled.lock().unwrap().is_empty());
        }
    }

    /// Past the lease another worker may hold the task, so a late settle could undo its verdict.
    #[tokio::test(start_paused = true)]
    async fn gives_an_inspection_up_unsettled_before_its_lease_lapses() {
        let lease = Duration::from_secs(20);
        let mut slow = Holding::of(PNG);
        slow.reading = Duration::from_secs(600);
        let (worker, tasks, _) = worker(
            Writing::new(Claim::Claimed(leased_for(lease)), vec![]),
            slow,
        );

        let began = tokio::time::Instant::now();
        assert_eq!(run_upload(TASK, &worker).await, Handled::Retry);

        assert!(tasks.settled.lock().unwrap().is_empty());
        // Gone with the settle's own timeout still to spare, so even a settle started then would land.
        assert!(began.elapsed() <= lease - SETTLE_TIMEOUT);
        assert!(began.elapsed() >= lease - SETTLE_TIMEOUT - Duration::from_secs(1));
    }

    #[tokio::test]
    async fn starts_no_inspection_on_a_lease_too_short_to_settle_inside() {
        let (worker, tasks, bucket) = worker(
            Writing::new(Claim::Claimed(leased_for(SETTLE_TIMEOUT / 2)), vec![]),
            Holding::of(PNG),
        );

        assert_eq!(run_upload(TASK, &worker).await, Handled::Retry);
        assert!(tasks.settled.lock().unwrap().is_empty());
        assert!(bucket.copied.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn fails_a_claim_that_carried_nothing_to_inspect() {
        let (worker, tasks, _bucket) = worker(
            Writing::new(Claim::Uninspectable, vec![Settled::Written]),
            Holding::of(PNG),
        );

        assert_eq!(run_upload(TASK, &worker).await, Handled::Ack);
        assert!(matches!(
            &tasks.settled.lock().unwrap()[..],
            [Outcome::Failed { .. }]
        ));
    }

    #[tokio::test]
    async fn acknowledges_a_claim_that_was_refused_or_rejected_and_retries_one_left_unanswered() {
        for (settled, handled) in [
            (Settled::Refused, Handled::Ack),
            (Settled::Rejected, Handled::Ack),
            (Settled::Unavailable, Handled::Retry),
            // A reclaim that beat another worker's lease is taken again once that lease lapses.
            (Settled::Held, Handled::Retry),
            (Settled::Unauthorized, Handled::Locked),
        ] {
            let (worker, tasks, _bucket) =
                worker(Writing::new(Claim::Not(settled), vec![]), Holding::of(PNG));
            assert_eq!(run_upload(TASK, &worker).await, handled);
            assert!(tasks.settled.lock().unwrap().is_empty());
        }
    }

    #[tokio::test]
    async fn leaves_the_message_claimed_when_the_outcome_could_not_be_written() {
        for (settled, handled) in [
            (Settled::Unavailable, Handled::Retry),
            (Settled::Unauthorized, Handled::Locked),
        ] {
            let (worker, _tasks, _bucket) = worker(
                Writing::new(
                    Claim::Claimed(leased_for(Duration::from_secs(240))),
                    vec![settled],
                ),
                Holding::of(PNG),
            );

            assert_eq!(run_upload(TASK, &worker).await, handled);
        }
    }

    #[test]
    fn refuses_a_task_id_that_would_leave_its_path_segment() {
        let named = |raw: &str| task_id(&redis::Value::BulkString(raw.as_bytes().to_vec()));
        assert_eq!(named(TASK), Some(TASK.to_owned()));
        assert_eq!(named("../accounts"), None);
        assert_eq!(named("a\r\nx-injected: yes"), None);
    }

    /// One scripted answer, or a read held open until a test lets it go.
    enum Step {
        Answer(Result<Vec<Delivery>, bool>),
        /// A blocking read that answers these deliveries only after an hour.
        Blocks(Vec<Delivery>),
    }

    /// Each call answers from a script; once a script runs dry the stream is quiet and the test stops.
    struct Scripted {
        joins: usize,
        reclaims: VecDeque<Result<Vec<Delivery>, bool>>,
        reads: VecDeque<Step>,
        read_calls: usize,
        acked: Vec<String>,
        alive_seen: Vec<bool>,
        alive: Arc<AtomicBool>,
        stop: watch::Sender<bool>,
    }

    impl Scripted {
        fn answer(
            step: Option<Result<Vec<Delivery>, bool>>,
            stop: &watch::Sender<bool>,
        ) -> Result<Vec<Delivery>, QueueError> {
            match step {
                Some(Ok(deliveries)) => Ok(deliveries),
                Some(Err(missing_group)) => Err(QueueError {
                    missing_group,
                    error: anyhow::anyhow!("the stream did not answer"),
                }),
                None => {
                    let _ = stop.send(true);
                    Ok(Vec::new())
                }
            }
        }
    }

    #[async_trait::async_trait]
    impl Queue for Scripted {
        async fn join(&mut self) -> Result<(), QueueError> {
            self.joins += 1;
            Ok(())
        }

        async fn reclaim(&mut self) -> Result<Vec<Delivery>, QueueError> {
            self.alive_seen.push(self.alive.load(Ordering::Relaxed));
            Self::answer(self.reclaims.pop_front(), &self.stop)
        }

        async fn read(&mut self) -> Result<Vec<Delivery>, QueueError> {
            self.read_calls += 1;
            match self.reads.pop_front() {
                Some(Step::Blocks(deliveries)) => {
                    tokio::time::sleep(Duration::from_secs(3600)).await;
                    Ok(deliveries)
                }
                Some(Step::Answer(answer)) => Self::answer(Some(answer), &self.stop),
                None => Self::answer(None, &self.stop),
            }
        }

        async fn ack(&mut self, id: &str) -> Result<(), QueueError> {
            self.acked.push(id.to_owned());
            Ok(())
        }
    }

    fn scripted_steps(
        reclaims: Vec<Result<Vec<Delivery>, bool>>,
        reads: Vec<Step>,
    ) -> (Scripted, watch::Receiver<bool>, Arc<AtomicBool>) {
        let (stop, stopped) = watch::channel(false);
        let alive = Arc::new(AtomicBool::new(true));
        (
            Scripted {
                joins: 0,
                reclaims: reclaims.into(),
                reads: reads.into(),
                read_calls: 0,
                acked: Vec::new(),
                alive_seen: Vec::new(),
                alive: alive.clone(),
                stop,
            },
            stopped,
            alive,
        )
    }

    fn scripted(
        reclaims: Vec<Result<Vec<Delivery>, bool>>,
        reads: Vec<Result<Vec<Delivery>, bool>>,
    ) -> (Scripted, watch::Receiver<bool>, Arc<AtomicBool>) {
        scripted_steps(reclaims, reads.into_iter().map(Step::Answer).collect())
    }

    fn message(id: &str, deliveries: u64) -> Delivery {
        Delivery {
            id: id.to_owned(),
            task: Some(TASK.to_owned()),
            deliveries,
        }
    }

    /// A cache that lost its data lost the group with it, and only creating it again reads anything.
    #[tokio::test(start_paused = true)]
    async fn creates_the_group_again_when_the_stream_says_it_is_gone() {
        let (mut queue, stop, alive) = scripted(vec![Err(true), Ok(vec![])], vec![Ok(vec![])]);
        let (worker, _, _) = worker(Writing::claiming("image/png", 1), Holding::of(PNG));

        drain(&mut queue, &worker, stop, &alive).await;

        assert_eq!(queue.joins, 1);
    }

    #[tokio::test(start_paused = true)]
    async fn reports_the_consumer_down_after_passes_that_keep_failing_and_up_once_one_answers() {
        let failing = vec![Err(false); MAX_FAILED_PASSES as usize];
        let (mut queue, stop, alive) = scripted(
            failing
                .into_iter()
                .chain([Ok(vec![]), Ok(vec![])])
                .collect(),
            vec![Ok(vec![])],
        );
        let (worker, _, _) = worker(Writing::claiming("image/png", 1), Holding::of(PNG));

        drain(&mut queue, &worker, stop, &alive).await;

        assert_eq!(queue.alive_seen, vec![true, true, true, false, true]);
        assert!(alive.load(Ordering::Relaxed));
    }

    /// A message that keeps coming back is one no worker can finish, and it would come back forever.
    #[tokio::test(start_paused = true)]
    async fn drops_a_message_handed_out_too_often_without_running_it() {
        let (mut queue, stop, alive) =
            scripted(vec![Ok(vec![message("1-0", MAX_DELIVERIES + 1)])], vec![]);
        let (worker, tasks, _) = worker(Writing::claiming("image/png", 1), Holding::of(PNG));

        drain(&mut queue, &worker, stop, &alive).await;

        assert_eq!(queue.acked, vec!["1-0".to_owned()]);
        assert!(
            tasks.claim.lock().unwrap().is_some(),
            "the task was claimed"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn acknowledges_a_message_only_once_its_outcome_is_written() {
        let (mut queue, stop, alive) = scripted(
            vec![Ok(vec![]), Ok(vec![])],
            vec![
                Ok(vec![message("1-0", 1)]),
                Ok(vec![Delivery {
                    id: "2-0".to_owned(),
                    task: None,
                    deliveries: 1,
                }]),
            ],
        );
        let (worker, _, _) = worker(
            Writing::new(Claim::Not(Settled::Unavailable), vec![]),
            Holding::of(PNG),
        );

        drain(&mut queue, &worker, stop, &alive).await;

        assert_eq!(queue.acked, vec!["2-0".to_owned()]);
    }

    /// A wrong secret refuses every claim alike, and acknowledging each would empty the stream.
    #[tokio::test(start_paused = true)]
    async fn holds_the_stream_and_reports_itself_down_while_its_credential_is_refused() {
        let (mut queue, stop, alive) =
            scripted(vec![Ok(vec![])], vec![Ok(vec![message("1-0", 1)])]);
        let tasks = Writing::new(Claim::Not(Settled::Unauthorized), vec![]);
        *tasks.health.lock().unwrap() = Some(alive.clone());
        let (worker, tasks, _) = worker(tasks, Holding::of(PNG));

        let began = tokio::time::Instant::now();
        drain(&mut queue, &worker, stop, &alive).await;

        // Refused, held unacknowledged and tried alone with `/health` down, then taken once answered.
        assert_eq!(*tasks.healthy_at_claims.lock().unwrap(), vec![true, false]);
        assert!(began.elapsed() >= LOCKED_BACKOFF);
        assert_eq!(queue.acked, vec!["1-0".to_owned()]);
        assert_eq!(queue.read_calls, 1);
        assert!(alive.load(Ordering::Relaxed));
    }

    /// The drain stops the consumer to settle what it holds, not to start on something new.
    #[tokio::test(start_paused = true)]
    async fn reads_nothing_more_once_a_stop_has_landed() {
        let (mut queue, stop, alive) = scripted(vec![], vec![Ok(vec![message("1-0", 1)])]);
        let (worker, tasks, _) = worker(Writing::claiming("image/png", 1), Holding::of(PNG));

        drain(&mut queue, &worker, stop, &alive).await;

        assert_eq!(queue.read_calls, 0);
        assert!(
            tasks.claim.lock().unwrap().is_some(),
            "a task was claimed after the stop"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_stop_ends_a_read_still_waiting_on_the_stream() {
        let (mut queue, stop, alive) = scripted_steps(
            vec![Ok(vec![])],
            vec![Step::Blocks(vec![message("1-0", 1)])],
        );
        let (worker, tasks, _) = worker(Writing::claiming("image/png", 1), Holding::of(PNG));
        let stopping = queue.stop.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(1)).await;
            let _ = stopping.send(true);
        });

        let began = tokio::time::Instant::now();
        drain(&mut queue, &worker, stop, &alive).await;

        assert!(
            began.elapsed() < Duration::from_secs(5),
            "{:?}",
            began.elapsed()
        );
        assert!(
            tasks.claim.lock().unwrap().is_some(),
            "a task was claimed after the stop"
        );
    }
}

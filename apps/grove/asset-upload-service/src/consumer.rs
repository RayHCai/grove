//! The asset stream, read with a consumer group. A save that lands an asset writes a row and pushes
//! its id here, and a claimed task is inspected and copied before it is settled.
//!
//! A group rather than a list, because a worker that dies mid-asset has to hand its claim back
//! instead of taking the asset with it.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use redis::aio::{ConnectionManager, ConnectionManagerConfig};
use redis::streams::{
    StreamAutoClaimOptions, StreamAutoClaimReply, StreamPendingCountReply, StreamReadOptions,
    StreamReadReply,
};
use redis::{AsyncCommands, RedisError};
use tokio::sync::watch;

use crate::inspect::{self, Bucket, Invalid};
use crate::tasks::{Claim, Inspection, Outcome, Settled, Tasks};

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

/// What one asset did with its message.
///
/// `Ack` is acknowledged: the outcome is written down, whatever it was. `Retry` leaves it claimed
/// so another worker takes it back after the reclaim window, which is what a failure of the fleet
/// rather than of the asset earns.
#[derive(Debug, PartialEq, Eq)]
pub enum Handled {
    Ack,
    Retry,
}

/// What claiming and inspecting an asset needs: the API that settles it and the bucket holding it.
pub struct Worker {
    pub tasks: Arc<dyn Tasks>,
    pub bucket: Arc<dyn Bucket>,
}

/// Claims one asset upload, holds its bytes to the type they were declared as, and settles it.
pub async fn run_upload(task: &str, worker: &Worker) -> Handled {
    let outcome = match worker.tasks.claim(task).await {
        Claim::Claimed(inspection) => match inspected(&inspection, worker.bucket.as_ref()).await {
            Ok(outcome) => outcome,
            Err(error) => {
                tracing::warn!(task, error = ?error, "asset upload could not be inspected");
                return Handled::Retry;
            }
        },
        Claim::Uninspectable => Outcome::Failed {
            message: "this upload could not be checked; save it again".to_owned(),
        },
        Claim::Not(Settled::Unavailable) => return Handled::Retry,
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
        _ => Handled::Ack,
    }
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
    while !*stop.borrow() {
        match pass(queue, worker).await {
            Ok(()) => {
                failed_passes = 0;
                alive.store(true, Ordering::Relaxed);
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

/// Reclaimed first: an asset another worker died holding is older work than anything new, and the
/// creator waiting on it has been waiting longest.
async fn pass(queue: &mut dyn Queue, worker: &Worker) -> Result<(), QueueError> {
    for delivery in queue.reclaim().await? {
        handle(queue, worker, delivery).await;
    }
    for delivery in queue.read().await? {
        handle(queue, worker, delivery).await;
    }
    Ok(())
}

/// Runs one message and acknowledges it if its outcome is written down.
async fn handle(queue: &mut dyn Queue, worker: &Worker, delivery: Delivery) {
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
        Some(task) => run_upload(task, worker).await == Handled::Ack,
    };
    if finished {
        if let Err(failed) = queue.ack(&delivery.id).await {
            tracing::warn!(error = ?failed.error, id = %delivery.id, "acknowledging failed");
        }
    }
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
    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";

    /// A status route that claims as `claim` says and keeps every outcome it was told.
    struct Writing {
        claim: Mutex<Option<Claim>>,
        settle: Mutex<VecDeque<Settled>>,
        settled: Mutex<Vec<Outcome>>,
    }

    impl Writing {
        fn new(claim: Claim, settle: Vec<Settled>) -> Self {
            Self {
                claim: Mutex::new(Some(claim)),
                settle: Mutex::new(settle.into()),
                settled: Mutex::new(Vec::new()),
            }
        }

        fn claiming(content_type: &str, byte_length: u64) -> Self {
            Self::new(
                Claim::Claimed(Inspection {
                    source: "https://bucket/uploads/leaf".to_owned(),
                    destination: "https://bucket/assets/leaf".to_owned(),
                    content_type: content_type.to_owned(),
                    byte_length,
                }),
                vec![Settled::Written],
            )
        }
    }

    #[async_trait::async_trait]
    impl Tasks for Writing {
        async fn claim(&self, _task: &str) -> Claim {
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
    }

    impl Holding {
        fn of(upload: &[u8]) -> Self {
            Self {
                upload: Some(upload.to_vec()),
                copied: Mutex::new(Vec::new()),
                publishes: true,
            }
        }
    }

    #[async_trait::async_trait]
    impl Bucket for Holding {
        async fn fetch(&self, _url: &str, limit: u64) -> anyhow::Result<Option<Vec<u8>>> {
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
        ] {
            let (worker, tasks, _bucket) =
                worker(Writing::new(Claim::Not(settled), vec![]), Holding::of(PNG));
            assert_eq!(run_upload(TASK, &worker).await, handled);
            assert!(tasks.settled.lock().unwrap().is_empty());
        }
    }

    #[tokio::test]
    async fn leaves_the_message_claimed_when_the_outcome_could_not_be_written() {
        let (worker, _tasks, _bucket) = worker(
            Writing::new(
                Claim::Claimed(Inspection {
                    source: String::new(),
                    destination: String::new(),
                    content_type: "image/png".to_owned(),
                    byte_length: PNG.len() as u64,
                }),
                vec![Settled::Unavailable],
            ),
            Holding::of(PNG),
        );

        assert_eq!(run_upload(TASK, &worker).await, Handled::Retry);
    }

    #[test]
    fn refuses_a_task_id_that_would_leave_its_path_segment() {
        let named = |raw: &str| task_id(&redis::Value::BulkString(raw.as_bytes().to_vec()));
        assert_eq!(named(TASK), Some(TASK.to_owned()));
        assert_eq!(named("../accounts"), None);
        assert_eq!(named("a\r\nx-injected: yes"), None);
    }

    /// Each call answers from a script; once a script runs dry the stream is quiet and the test stops.
    struct Scripted {
        joins: usize,
        reclaims: VecDeque<Result<Vec<Delivery>, bool>>,
        reads: VecDeque<Result<Vec<Delivery>, bool>>,
        acked: Vec<String>,
        alive_seen: Vec<bool>,
        alive: Arc<AtomicBool>,
        stop: watch::Sender<bool>,
    }

    impl Scripted {
        fn answer(
            script: &mut VecDeque<Result<Vec<Delivery>, bool>>,
            stop: &watch::Sender<bool>,
        ) -> Result<Vec<Delivery>, QueueError> {
            match script.pop_front() {
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
            Self::answer(&mut self.reclaims, &self.stop)
        }

        async fn read(&mut self) -> Result<Vec<Delivery>, QueueError> {
            Self::answer(&mut self.reads, &self.stop)
        }

        async fn ack(&mut self, id: &str) -> Result<(), QueueError> {
            self.acked.push(id.to_owned());
            Ok(())
        }
    }

    fn scripted(
        reclaims: Vec<Result<Vec<Delivery>, bool>>,
        reads: Vec<Result<Vec<Delivery>, bool>>,
    ) -> (Scripted, watch::Receiver<bool>, Arc<AtomicBool>) {
        let (stop, stopped) = watch::channel(false);
        let alive = Arc::new(AtomicBool::new(true));
        (
            Scripted {
                joins: 0,
                reclaims: reclaims.into(),
                reads: reads.into(),
                acked: Vec::new(),
                alive_seen: Vec::new(),
                alive: alive.clone(),
                stop,
            },
            stopped,
            alive,
        )
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
}

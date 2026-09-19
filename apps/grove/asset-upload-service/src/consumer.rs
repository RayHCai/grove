//! The asset stream, read with a consumer group.
//!
//! A save that lands an asset writes a row and pushes its id here, so this is where every asset a
//! creator uploads arrives. What happens to one is the seam being built: the task is claimed and
//! settled, and thumbnailing, transcoding and format validation land behind it later.
//!
//! A group rather than a list, because a worker that dies mid-asset has to hand its claim back
//! instead of taking the asset with it.

use std::sync::Arc;
use std::time::Duration;

use redis::streams::{StreamAutoClaimReply, StreamReadOptions, StreamReadReply};
use redis::AsyncCommands;
use tokio::sync::watch;

use crate::tasks::{Settled, Tasks};

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

/// What one asset did with its message.
///
/// `Ack` is acknowledged — the outcome is written down, whatever it was. `Retry` leaves it claimed
/// so another worker takes it back after the reclaim window, which is what a failure of the fleet
/// rather than of the asset earns.
#[derive(Debug, PartialEq, Eq)]
pub enum Handled {
    Ack,
    Retry,
}

/// Claims one asset upload and settles it.
///
/// Nothing is processed yet, and that is deliberate: a worker that settles honestly is what lets a
/// creator's editor stop watching, and the processing lands behind this without the seam moving.
pub async fn run_upload(task: &str, tasks: &dyn Tasks) -> Handled {
    match tasks.advance(task, "IN_PROGRESS", None).await {
        // Somebody already settled it, so this is a redelivery of finished work: acknowledged
        // rather than retried, or it comes back forever.
        Settled::Refused => {
            tracing::info!(task, "asset upload already settled");
            return Handled::Ack;
        }
        Settled::Unavailable => return Handled::Retry,
        Settled::Written => {}
    }

    match tasks.advance(task, "SUCCESSFUL", None).await {
        // The outcome could not be written down, so the work has to come back: acknowledging here
        // would leave a creator watching a task nothing will ever move.
        Settled::Unavailable => Handled::Retry,
        _ => Handled::Ack,
    }
}

/// Reads the asset stream until `stop` is sent.
pub async fn consume(
    client: redis::Client,
    tasks: Arc<dyn Tasks>,
    name: String,
    mut stop: watch::Receiver<bool>,
) -> anyhow::Result<()> {
    let mut redis = client.get_multiplexed_async_connection().await?;

    // MKSTREAM, because the group has to exist before the first push rather than after it.
    let _: Result<String, _> = redis.xgroup_create_mkstream(STREAM, GROUP, "0").await;

    while !*stop.borrow() {
        // Reclaimed first: an asset another worker died holding is older work than anything new,
        // and the creator waiting on it has been waiting longest.
        let reclaimed: Result<StreamAutoClaimReply, _> = redis
            .xautoclaim_options(
                STREAM,
                GROUP,
                &name,
                RECLAIM_AFTER.as_millis() as usize,
                "0",
                redis::streams::StreamAutoClaimOptions::default().count(BATCH),
            )
            .await;
        if let Ok(reply) = reclaimed {
            for entry in reply.claimed {
                settle(&mut redis, &entry.id, &entry.map, tasks.as_ref()).await;
            }
        }

        let options = StreamReadOptions::default()
            .group(GROUP, &name)
            .count(BATCH)
            .block(BLOCK.as_millis() as usize);
        let read: Result<Option<StreamReadReply>, _> =
            redis.xread_options(&[STREAM], &[">"], &options).await;

        match read {
            Ok(Some(reply)) => {
                for key in reply.keys {
                    for entry in key.ids {
                        settle(&mut redis, &entry.id, &entry.map, tasks.as_ref()).await;
                    }
                }
            }
            Ok(None) => {}
            // A stream that would not answer is the next pass's problem: this loop is the whole of
            // what the process does, and giving up on it would be a worker that never comes back.
            Err(err) => {
                tracing::warn!(error = ?err, "asset stream read failed");
                let _ = tokio::time::timeout(BLOCK, stop.changed()).await;
            }
        }
    }
    Ok(())
}

/// Runs one message and acknowledges it if its outcome is written down.
async fn settle(
    redis: &mut redis::aio::MultiplexedConnection,
    id: &str,
    fields: &std::collections::HashMap<String, redis::Value>,
    tasks: &dyn Tasks,
) {
    let Some(task) = fields.get("taskId").and_then(task_id) else {
        // Nothing this service can ever do with it, and leaving it pending would make every
        // reclaim pass pick it up again.
        tracing::error!(id, "message names no task");
        let _: Result<i32, _> = redis.xack(STREAM, GROUP, &[id]).await;
        return;
    };

    if run_upload(&task, tasks).await == Handled::Ack {
        let _: Result<i32, _> = redis.xack(STREAM, GROUP, &[id]).await;
    }
}

/// A field as the driver hands it over, which for a string is bulk bytes rather than a `String`.
fn task_id(value: &redis::Value) -> Option<String> {
    match value {
        redis::Value::BulkString(bytes) => String::from_utf8(bytes.clone()).ok(),
        redis::Value::SimpleString(text) => Some(text.clone()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// A status route that answers each call from `answers`, in order, and keeps what it was told.
    struct Writing {
        answers: Mutex<Vec<Settled>>,
        wrote: Mutex<Vec<String>>,
    }

    impl Writing {
        fn new(answers: Vec<Settled>) -> Self {
            Self {
                answers: Mutex::new(answers.into_iter().rev().collect()),
                wrote: Mutex::new(Vec::new()),
            }
        }
    }

    #[async_trait::async_trait]
    impl Tasks for Writing {
        async fn advance(&self, _task: &str, status: &str, _message: Option<&str>) -> Settled {
            self.wrote.lock().unwrap().push(status.to_owned());
            self.answers
                .lock()
                .unwrap()
                .pop()
                .unwrap_or(Settled::Written)
        }
    }

    const TASK: &str = "8c2e4a60-5d17-4b93-8f0a-1e6d2c4b7a35";

    #[tokio::test]
    async fn claims_the_task_and_settles_it() {
        let tasks = Writing::new(vec![Settled::Written, Settled::Written]);
        assert_eq!(run_upload(TASK, &tasks).await, Handled::Ack);
        assert_eq!(
            *tasks.wrote.lock().unwrap(),
            vec!["IN_PROGRESS".to_owned(), "SUCCESSFUL".to_owned()]
        );
    }

    #[tokio::test]
    async fn acknowledges_work_somebody_already_settled() {
        // Retrying would put it back on the stream forever; nothing is left to do with it.
        let tasks = Writing::new(vec![Settled::Refused]);
        assert_eq!(run_upload(TASK, &tasks).await, Handled::Ack);
        assert_eq!(tasks.wrote.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn leaves_the_message_claimed_when_the_claim_could_not_be_written() {
        let tasks = Writing::new(vec![Settled::Unavailable]);
        assert_eq!(run_upload(TASK, &tasks).await, Handled::Retry);
    }

    #[tokio::test]
    async fn leaves_the_message_claimed_when_the_outcome_could_not_be_written() {
        let tasks = Writing::new(vec![Settled::Written, Settled::Unavailable]);
        assert_eq!(run_upload(TASK, &tasks).await, Handled::Retry);
    }
}

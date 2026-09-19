//! Where this service says what it did with a task.
//!
//! The one call it makes to `@grove/api`, and the reason it holds no database credential: the
//! transitions are checked there, so a worker that comes back from the dead and tries to settle a
//! task another process already finished is refused rather than overwriting it.

use std::time::Duration;

use anyhow::{Context, Result};
use serde::Serialize;

/// Settling a task is a row update behind a bearer, not a transcode: it answers or it is down.
const SETTLE_TIMEOUT: Duration = Duration::from_secs(5);

/// The correlation id the rest of the fleet carries, so one task is one line across three services.
const REQUEST_ID_HEADER: &str = "x-request-id";

/// What the status route took.
///
/// `Refused` is `@grove/api` declining to move the task — already settled, or gone — which is the
/// one failure a worker must acknowledge rather than retry.
#[derive(Debug, PartialEq, Eq)]
pub enum Settled {
    Written,
    Refused,
    Unavailable,
}

#[derive(Serialize)]
struct StatusUpdate<'a> {
    status: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<Detail<'a>>,
}

#[derive(Serialize)]
struct Detail<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<&'a str>,
}

/// The status route, as this service sees it.
#[async_trait::async_trait]
pub trait Tasks: Send + Sync {
    async fn advance(&self, task: &str, status: &str, message: Option<&str>) -> Settled;
}

/// `@grove/api` over HTTP, behind the bearer its gate compares.
pub struct HttpTasks {
    client: reqwest::Client,
    api_url: String,
    fleet_secret: String,
}

impl HttpTasks {
    pub fn new(api_url: String, fleet_secret: String) -> Result<Self> {
        Ok(Self {
            client: reqwest::Client::builder()
                .timeout(SETTLE_TIMEOUT)
                .build()
                .context("building the API client")?,
            api_url,
            fleet_secret,
        })
    }
}

#[async_trait::async_trait]
impl Tasks for HttpTasks {
    async fn advance(&self, task: &str, status: &str, message: Option<&str>) -> Settled {
        let body = StatusUpdate {
            status,
            detail: message.map(|message| Detail {
                message: Some(message),
            }),
        };

        let answered = self
            .client
            .patch(format!("{}/v1/tasks/{task}", self.api_url))
            .bearer_auth(&self.fleet_secret)
            .header(REQUEST_ID_HEADER, task)
            .json(&body)
            .send()
            .await;

        match answered {
            Err(err) => {
                tracing::warn!(task, error = ?err, "task could not be settled");
                Settled::Unavailable
            }
            // Told outright that this attempt lost rather than left to infer it: a worker that
            // keeps retrying a settled task is one that never acknowledges its message.
            Ok(response) if response.status() == 404 || response.status() == 409 => {
                Settled::Refused
            }
            Ok(response) if response.status().is_success() => Settled::Written,
            Ok(response) => {
                tracing::warn!(task, status = %response.status(), "task not settled");
                Settled::Unavailable
            }
        }
    }
}

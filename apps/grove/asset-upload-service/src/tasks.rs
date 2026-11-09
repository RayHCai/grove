//! Where this service claims a task and says what it did with it.
//!
//! The one call it makes to `@grove/api`, and the reason it holds no database credential: the
//! transitions are checked there, so a worker that comes back from the dead and tries to settle a
//! task another process already finished is refused rather than overwriting it.

use std::time::Duration;

use anyhow::{Context, Result};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};

/// Settling a task is a row update behind a bearer, not a transcode: it answers or it is down.
const SETTLE_TIMEOUT: Duration = Duration::from_secs(5);

/// What the status route took.
///
/// `Refused` is `@grove/api` declining to move the task (already settled, or gone), which is the
/// one failure a worker must acknowledge rather than retry.
#[derive(Debug, PartialEq, Eq)]
pub enum Settled {
    Written,
    Refused,
    /// A body or a credential the API will never take, which a retry would only send again.
    Rejected,
    Unavailable,
}

/// What a claim handed over, when it is this worker's to inspect.
#[derive(Debug, PartialEq, Eq)]
pub enum Claim {
    Claimed(Inspection),
    /// Claimed, with no inspection on the answer, so there is nothing a worker can check.
    Uninspectable,
    /// Not claimed, for the reason a settle would give.
    Not(Settled),
}

/// What the claim of an upload carries: `AssetInspection` in `libs/api-contract`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspection {
    /// A presigned GET of the quarantined bytes, pinned to the version the save recorded.
    pub source: String,
    /// A presigned PUT to the key the CDN serves, signed for `content_type`.
    pub destination: String,
    pub content_type: String,
    pub byte_length: u64,
}

/// What the worker found, which is what the task is settled with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Passed { version_id: String },
    Failed { message: String },
}

#[derive(Deserialize)]
struct ClaimedTask {
    inspection: Option<Inspection>,
}

#[derive(Serialize)]
struct StatusUpdate<'a> {
    status: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<Detail<'a>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Detail<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    version_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<&'a str>,
}

impl<'a> StatusUpdate<'a> {
    fn claim() -> Self {
        Self {
            status: "IN_PROGRESS",
            detail: None,
        }
    }

    fn settle(outcome: &'a Outcome) -> Self {
        let (status, detail) = match outcome {
            Outcome::Passed { version_id } => (
                "SUCCESSFUL",
                Detail {
                    version_id: Some(version_id),
                    message: None,
                },
            ),
            Outcome::Failed { message } => (
                "FAILED",
                Detail {
                    version_id: None,
                    message: Some(message),
                },
            ),
        };
        Self {
            status,
            detail: Some(detail),
        }
    }
}

/// The status route, as this service sees it.
#[async_trait::async_trait]
pub trait Tasks: Send + Sync {
    async fn claim(&self, task: &str) -> Claim;
    async fn settle(&self, task: &str, outcome: &Outcome) -> Settled;
}

/// `@grove/api` over HTTP, behind the credential it takes for asset uploads and nothing else.
pub struct HttpTasks {
    client: reqwest::Client,
    api_url: String,
    secret: String,
}

impl HttpTasks {
    pub fn new(api_url: String, secret: String) -> Result<Self> {
        Ok(Self {
            client: reqwest::Client::builder()
                .timeout(SETTLE_TIMEOUT)
                .build()
                .context("building the API client")?,
            api_url,
            secret,
        })
    }

    /// One status update, answered with the body when the API took it.
    async fn update(&self, task: &str, body: &StatusUpdate<'_>) -> Result<String, Settled> {
        let answered = self
            .client
            .patch(format!("{}/v1/tasks/{task}", self.api_url))
            .bearer_auth(&self.secret)
            .header(request_id::HEADER, task)
            .json(body)
            .send()
            .await;
        let response = match answered {
            Ok(response) => response,
            Err(err) => {
                tracing::warn!(task, error = ?err, "task could not be settled");
                return Err(Settled::Unavailable);
            }
        };

        let status = response.status();
        match status {
            // Told outright that this attempt lost rather than left to infer it: a worker that
            // keeps retrying a settled task is one that never acknowledges its message.
            StatusCode::NOT_FOUND | StatusCode::CONFLICT => return Err(Settled::Refused),
            // The contract or the credential is wrong, and the same request is all a retry would send.
            StatusCode::BAD_REQUEST | StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
                tracing::error!(task, %status, "the API rejected a status update outright");
                return Err(Settled::Rejected);
            }
            status if !status.is_success() => {
                tracing::warn!(task, %status, "task not settled");
                return Err(Settled::Unavailable);
            }
            _ => {}
        }
        response.text().await.map_err(|err| {
            tracing::warn!(task, error = ?err, "the API's answer was cut off");
            Settled::Unavailable
        })
    }
}

#[async_trait::async_trait]
impl Tasks for HttpTasks {
    async fn claim(&self, task: &str) -> Claim {
        let body = match self.update(task, &StatusUpdate::claim()).await {
            Ok(body) => body,
            Err(settled) => return Claim::Not(settled),
        };
        match serde_json::from_str::<ClaimedTask>(&body) {
            Ok(ClaimedTask {
                inspection: Some(inspection),
            }) => Claim::Claimed(inspection),
            _ => {
                tracing::error!(task, "the claim answered without an inspection");
                Claim::Uninspectable
            }
        }
    }

    async fn settle(&self, task: &str, outcome: &Outcome) -> Settled {
        match self.update(task, &StatusUpdate::settle(outcome)).await {
            Ok(_) => Settled::Written,
            Err(settled) => settled,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread::JoinHandle;

    const TASK: &str = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
    const SECRET: &str = "an-asset-service-secret-of-32-characters";

    fn fixture(name: &str) -> String {
        let path = format!("../../../libs/api-contract/fixtures/wire/{name}");
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"))
    }

    /// A stand-in for the API: answers one call and hands back everything it was sent.
    fn one_call(status: &'static str, body: String) -> (HttpTasks, JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_millis(500)))
                .unwrap();
            let mut seen = Vec::new();
            let mut chunk = [0_u8; 4096];
            loop {
                match socket.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(read) => seen.extend_from_slice(&chunk[..read]),
                }
                let text = String::from_utf8_lossy(&seen).to_lowercase();
                if let Some(end) = text.find("\r\n\r\n") {
                    let length = text
                        .lines()
                        .find_map(|line| line.strip_prefix("content-length:"))
                        .map_or(0, |value| value.trim().parse::<usize>().unwrap());
                    if seen.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            let answer = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            );
            socket.write_all(answer.as_bytes()).unwrap();
            String::from_utf8_lossy(&seen).into_owned()
        });
        (HttpTasks::new(base, SECRET.to_owned()).unwrap(), handle)
    }

    #[test]
    fn reads_the_inspection_off_the_contracts_claim_answer() {
        let claimed: ClaimedTask = serde_json::from_str(&fixture("asset-inspection.json")).unwrap();
        let inspection = claimed.inspection.unwrap();

        assert_eq!(inspection.content_type, "image/png");
        assert_eq!(inspection.byte_length, 2048);
        assert!(inspection.source.contains("versionId="));
        assert!(inspection
            .destination
            .contains("X-Amz-SignedHeaders=content-type"));
    }

    #[test]
    fn claims_with_the_contracts_status_update() {
        let body = serde_json::to_string(&StatusUpdate::claim()).unwrap();

        assert_eq!(body, fixture("asset-status-update.json").trim());
    }

    #[test]
    fn settles_with_the_version_on_a_pass_and_the_reason_on_a_failure() {
        let passed = Outcome::Passed {
            version_id: "3HL4kqtJlcpXroDT".to_owned(),
        };
        let failed = Outcome::Failed {
            message: "this upload is not a PNG image".to_owned(),
        };

        assert_eq!(
            serde_json::to_string(&StatusUpdate::settle(&passed)).unwrap(),
            r#"{"status":"SUCCESSFUL","detail":{"versionId":"3HL4kqtJlcpXroDT"}}"#
        );
        assert_eq!(
            serde_json::to_string(&StatusUpdate::settle(&failed)).unwrap(),
            r#"{"status":"FAILED","detail":{"message":"this upload is not a PNG image"}}"#
        );
    }

    #[tokio::test]
    async fn claims_under_the_asset_credential_and_hands_back_the_inspection() {
        let (tasks, api) = one_call("200 OK", fixture("asset-inspection.json"));

        let claim = tasks.claim(TASK).await;

        assert!(matches!(claim, Claim::Claimed(ref inspection) if inspection.byte_length == 2048));
        let sent = api.join().unwrap();
        assert!(
            sent.starts_with(&format!("PATCH /v1/tasks/{TASK} ")),
            "{sent}"
        );
        assert!(sent
            .to_lowercase()
            .contains(&format!("authorization: bearer {SECRET}")));
        assert!(sent.ends_with(r#"{"status":"IN_PROGRESS"}"#), "{sent}");
    }

    #[tokio::test]
    async fn a_claim_answered_without_an_inspection_is_uninspectable() {
        let (tasks, _api) = one_call("200 OK", fixture("asset-task.json"));

        assert_eq!(tasks.claim(TASK).await, Claim::Uninspectable);
    }

    /// A duplicate claim is somebody else's work, and acknowledging it is what stops it coming back.
    #[tokio::test]
    async fn a_claim_somebody_else_holds_is_refused() {
        let (tasks, _api) = one_call("409 Conflict", String::new());

        assert_eq!(tasks.claim(TASK).await, Claim::Not(Settled::Refused));
    }

    #[tokio::test]
    async fn tells_a_rejected_update_from_one_worth_retrying() {
        for (status, settled) in [
            ("400 Bad Request", Settled::Rejected),
            ("401 Unauthorized", Settled::Rejected),
            ("403 Forbidden", Settled::Rejected),
            ("404 Not Found", Settled::Refused),
            ("503 Service Unavailable", Settled::Unavailable),
            ("200 OK", Settled::Written),
        ] {
            let (tasks, _api) = one_call(status, "{}".to_owned());
            let outcome = Outcome::Failed {
                message: "no".to_owned(),
            };
            assert_eq!(tasks.settle(TASK, &outcome).await, settled, "{status}");
        }
    }

    #[tokio::test]
    async fn an_api_nobody_answers_is_unavailable() {
        let unbound = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", unbound.local_addr().unwrap());
        drop(unbound);
        let tasks = HttpTasks::new(base, SECRET.to_owned()).unwrap();

        assert_eq!(tasks.claim(TASK).await, Claim::Not(Settled::Unavailable));
    }
}

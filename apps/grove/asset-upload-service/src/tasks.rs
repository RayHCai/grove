//! Where this service claims a task and says what it did with it.
//!
//! The one call it makes to `@grove/api`, and the reason it holds no database credential: the
//! transitions are checked there, so a worker that comes back from the dead and tries to settle a
//! task another process already finished is refused rather than overwriting it.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use reqwest::header::RETRY_AFTER;
use reqwest::StatusCode;
use serde::{Deserialize, Deserializer, Serialize};

/// Settling a task is a row update behind a bearer, not a transcode: it answers or it is down.
pub const SETTLE_TIMEOUT: Duration = Duration::from_secs(5);

/// Where a worker names itself, which is what the API fences a settle by.
const WORKER_HEADER: &str = "x-grove-worker";

/// What the status route took.
///
/// `Refused` is `@grove/api` declining to move the task (already settled, or gone), which is the
/// one failure a worker must acknowledge rather than retry.
#[derive(Debug, PartialEq, Eq)]
pub enum Settled {
    Written,
    Refused,
    /// A body the API will never take, which a retry would only send again.
    Rejected,
    /// This service's credential, refused: nothing it sends is taken until a deploy fixes it.
    Unauthorized,
    /// Another worker's lease on the task is live, and lapses later.
    Held,
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
    /// When the claim's lease lapses, after which another worker may take the task.
    #[serde(deserialize_with = "timestamp")]
    pub expires_at: SystemTime,
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
    worker: String,
}

impl HttpTasks {
    pub fn new(api_url: String, secret: String, worker: &str) -> Result<Self> {
        Ok(Self {
            client: reqwest::Client::builder()
                .timeout(SETTLE_TIMEOUT)
                .build()
                .context("building the API client")?,
            api_url,
            secret,
            worker: worker_id(worker),
        })
    }

    /// One status update, answered with the body when the API took it.
    async fn update(&self, task: &str, body: &StatusUpdate<'_>) -> Result<String, Settled> {
        let answered = self
            .client
            .patch(format!("{}/v1/tasks/{task}", self.api_url))
            .bearer_auth(&self.secret)
            .header(request_id::HEADER, task)
            .header(WORKER_HEADER, &self.worker)
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
            // A live lease names when it lapses, and a claim that came early is taken again then.
            StatusCode::CONFLICT if response.headers().contains_key(RETRY_AFTER) => {
                return Err(Settled::Held);
            }
            // Told outright that this attempt lost rather than left to infer it: a worker that
            // keeps retrying a settled task is one that never acknowledges its message.
            StatusCode::NOT_FOUND | StatusCode::CONFLICT => return Err(Settled::Refused),
            // The contract is wrong, and the same request is all a retry would send.
            StatusCode::BAD_REQUEST => {
                tracing::error!(task, %status, "the API rejected a status update outright");
                return Err(Settled::Rejected);
            }
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
                tracing::error!(task, %status, "the API refused this service's credential");
                return Err(Settled::Unauthorized);
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

/// What this worker is called on the wire: the request-id alphabet the API holds a holder's name to.
pub fn worker_id(name: &str) -> String {
    let id: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' {
                c
            } else {
                '-'
            }
        })
        .take(request_id::MAX_LEN)
        .collect();
    if id.is_empty() {
        "asset-upload-service".to_owned()
    } else {
        id
    }
}

/// An instant in UTC as zod's `iso.datetime()` admits one: `2026-11-08T12:05:00.000Z`.
fn timestamp<'de, D: Deserializer<'de>>(deserializer: D) -> Result<SystemTime, D::Error> {
    let text = String::deserialize(deserializer)?;
    instant(&text).ok_or_else(|| serde::de::Error::custom(format!("{text:?} is not a UTC instant")))
}

fn instant(text: &str) -> Option<SystemTime> {
    let (date, time) = text.strip_suffix('Z')?.split_once('T')?;
    let (clock, fraction) = match time.split_once('.') {
        Some((clock, fraction)) => (clock, Some(fraction)),
        None => (time, None),
    };
    let [year, month, day] = fields(date, '-', [4, 2, 2])?;
    let [hour, minute, second] = fields(clock, ':', [2, 2, 2])?;
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return None;
    }
    let nanos = match fraction.map(str::len) {
        None => 0,
        Some(width @ 1..=9) => number(fraction?, width)? * 10_i64.pow(9 - width as u32),
        Some(_) => return None,
    };
    let seconds = days_from_civil(year, month, day) * 86_400 + hour * 3_600 + minute * 60 + second;
    Some(UNIX_EPOCH + Duration::new(u64::try_from(seconds).ok()?, u32::try_from(nanos).ok()?))
}

/// Three numbers of the given widths between `separator`s, and nothing else.
fn fields(text: &str, separator: char, widths: [usize; 3]) -> Option<[i64; 3]> {
    let mut parts = text.split(separator);
    let mut out = [0; 3];
    for (slot, width) in out.iter_mut().zip(widths) {
        *slot = number(parts.next()?, width)?;
    }
    parts.next().is_none().then_some(out)
}

fn number(text: &str, width: usize) -> Option<i64> {
    if text.len() != width || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

/// Days from 1970-01-01 to a proleptic Gregorian date, the inverse of Howard Hinnant's `civil_from_days`.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let of_era = year - era * 400;
    let of_year = (153 * ((month + 9) % 12) + 2) / 5 + day - 1;
    let of_cycle = of_era * 365 + of_era / 4 - of_era / 100 + of_year;
    era * 146_097 + of_cycle - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;
    use request_id::testing::OneCall;

    const TASK: &str = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
    const SECRET: &str = "an-asset-service-secret-of-32-characters";
    const WORKER: &str = "ip-10-0-1-7.ec2.internal";

    fn fixture(name: &str) -> String {
        let path = format!("../../../libs/api-contract/fixtures/wire/{name}");
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"))
    }

    /// The status route over a stand-in API that answers one call.
    fn one_call(status: &str, headers: &[&str], body: &str) -> (HttpTasks, OneCall) {
        let api = OneCall::replying(status, headers, body);
        let tasks = HttpTasks::new(api.base.clone(), SECRET.to_owned(), WORKER).unwrap();
        (tasks, api)
    }

    fn at(seconds: u64, nanos: u32) -> SystemTime {
        UNIX_EPOCH + Duration::new(seconds, nanos)
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
        // 2026-11-08T12:05:00.000Z, which `date -u -d` agrees is this many seconds.
        assert_eq!(inspection.expires_at, at(1_794_139_500, 0));
    }

    #[test]
    fn reads_an_instant_the_way_zod_writes_one() {
        assert_eq!(instant("1970-01-01T00:00:00Z"), Some(UNIX_EPOCH));
        assert_eq!(instant("2000-02-29T23:59:59Z"), Some(at(951_868_799, 0)));
        assert_eq!(
            instant("2026-11-08T12:05:00.25Z"),
            Some(at(1_794_139_500, 250_000_000))
        );
        for refused in [
            "2026-11-08T12:05:00+01:00",
            "2026-11-08T12:05:00",
            "2026-13-08T12:05:00Z",
            "2026-11-08T24:05:00Z",
            "2026-11-08 12:05:00Z",
            "2026-11-08T12:05:00.Z",
            "2026-11-08T12:05:00.1234567890Z",
            "26-11-08T12:05:00Z",
        ] {
            assert_eq!(instant(refused), None, "{refused}");
        }
    }

    /// A lease with no end the worker can read is a claim it cannot bound, so it is no inspection.
    #[test]
    fn refuses_an_inspection_whose_expiry_is_not_an_instant() {
        let mut claimed: serde_json::Value =
            serde_json::from_str(&fixture("asset-inspection.json")).unwrap();
        claimed["inspection"]["expiresAt"] = serde_json::json!("soon");

        assert!(serde_json::from_value::<ClaimedTask>(claimed).is_err());
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
        let (tasks, api) = one_call("200 OK", &[], &fixture("asset-inspection.json"));

        let claim = tasks.claim(TASK).await;

        assert!(matches!(claim, Claim::Claimed(ref inspection) if inspection.byte_length == 2048));
        let sent = api.received_text();
        assert!(
            sent.starts_with(&format!("PATCH /v1/tasks/{TASK} ")),
            "{sent}"
        );
        assert!(sent
            .to_lowercase()
            .contains(&format!("authorization: bearer {SECRET}")));
        assert!(sent.ends_with(r#"{"status":"IN_PROGRESS"}"#), "{sent}");
    }

    /// The API fences a settle to the worker holding the claim, and knows a worker only by this name.
    #[tokio::test]
    async fn names_itself_on_a_claim_and_a_settle_in_the_alphabet_the_api_accepts() {
        let (tasks, claimed) = one_call("200 OK", &[], &fixture("asset-inspection.json"));
        tasks.claim(TASK).await;
        let (tasks, settled) = one_call("200 OK", &[], "{}");
        let outcome = Outcome::Failed {
            message: "no".to_owned(),
        };
        tasks.settle(TASK, &outcome).await;

        for sent in [claimed.received_text(), settled.received_text()] {
            assert!(
                sent.to_lowercase()
                    .contains("\r\nx-grove-worker: ip-10-0-1-7-ec2-internal\r\n"),
                "{sent}"
            );
        }
    }

    #[test]
    fn names_a_worker_with_a_valid_request_id_whatever_its_host_is_called() {
        assert_eq!(worker_id("upload-1"), "upload-1");
        assert_eq!(worker_id("box.local"), "box-local");
        assert!(request_id::valid(&worker_id(&"é".repeat(100))));
        assert_eq!(worker_id(&"a".repeat(100)).len(), request_id::MAX_LEN);
        assert_eq!(worker_id(""), "asset-upload-service");
    }

    #[tokio::test]
    async fn a_claim_answered_without_an_inspection_is_uninspectable() {
        let (tasks, _api) = one_call("200 OK", &[], &fixture("asset-task.json"));

        assert_eq!(tasks.claim(TASK).await, Claim::Uninspectable);
    }

    /// A duplicate claim is somebody else's work, and acknowledging it is what stops it coming back.
    #[tokio::test]
    async fn a_claim_somebody_already_settled_is_refused() {
        let (tasks, _api) = one_call("409 Conflict", &[], "");

        assert_eq!(tasks.claim(TASK).await, Claim::Not(Settled::Refused));
    }

    /// A reclaim that came before the other worker's lease lapsed is told when it does.
    #[tokio::test]
    async fn a_claim_another_worker_holds_a_live_lease_on_is_held() {
        let (tasks, _api) = one_call("409 Conflict", &["Retry-After: 30"], "");

        assert_eq!(tasks.claim(TASK).await, Claim::Not(Settled::Held));
    }

    #[tokio::test]
    async fn tells_a_rejected_update_from_one_worth_retrying() {
        for (status, settled) in [
            ("400 Bad Request", Settled::Rejected),
            ("401 Unauthorized", Settled::Unauthorized),
            ("403 Forbidden", Settled::Unauthorized),
            ("404 Not Found", Settled::Refused),
            ("503 Service Unavailable", Settled::Unavailable),
            ("200 OK", Settled::Written),
        ] {
            let (tasks, _api) = one_call(status, &[], "{}");
            let outcome = Outcome::Failed {
                message: "no".to_owned(),
            };
            assert_eq!(tasks.settle(TASK, &outcome).await, settled, "{status}");
        }
    }

    #[tokio::test]
    async fn an_api_nobody_answers_is_unavailable() {
        let unbound = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", unbound.local_addr().unwrap());
        drop(unbound);
        let tasks = HttpTasks::new(base, SECRET.to_owned(), WORKER).unwrap();

        assert_eq!(tasks.claim(TASK).await, Claim::Not(Settled::Unavailable));
    }
}

//! `@serverState` that outlives a session, over `@grove/game-manager`. This process holds no
//! database credential (it presents a session-scoped bearer), so a load and a save are HTTP
//! calls, which is why neither can happen inside a tick.

use std::future::Future;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use reqwest::header::{HeaderMap, RETRY_AFTER};
use serde_json::value::RawValue;

use crate::saves::{Records, Unwritten};

/// What one call to the manager may take before it answers as a failure.
///
/// Under the sim's five-second join deadline, so a wedged manager reaches a joining player as the
/// documented failed read rather than after the session that was waiting for it has been closed.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(2);

/// The envelope `readState` answers with. Only `value` is the creator's; the rest is the store's.
///
/// `value` stays a `RawValue` so a record reaches the sim as the bytes a game wrote, and a creator
/// field named `revision` is theirs rather than the counter beside it.
#[derive(serde::Deserialize)]
struct StateRecord {
    value: Box<RawValue>,
}

/// The body `writeState` decodes. A bare field map is refused with a 400, so the envelope is built
/// here rather than assumed away.
///
/// No `ifRevision`: this host's one writer per key always holds the newest fields, so the last write wins.
#[derive(serde::Serialize)]
struct StateWrite<'a> {
    value: &'a RawValue,
}

#[derive(Clone)]
pub struct Store {
    client: reqwest::Client,
    base: String,
    token: String,
}

impl Store {
    pub fn new(base: String, token: String) -> Result<Self> {
        Ok(Self {
            client: reqwest::Client::builder()
                .timeout(REQUEST_TIMEOUT)
                .build()
                .context("building the store client")?,
            base,
            token,
        })
    }

    /// Reads one host's persisted fields. `Ok(Some)` for a record, `Ok(None)` for a key holding
    /// nothing, `Err` for a read that FAILED: three answers, because the sim writes back over the
    /// second and must never write back over the third.
    pub async fn load(&self, host_key: &str) -> Result<Option<Box<RawValue>>> {
        // Minted rather than inherited: a load is the sim's errand and sits inside no request of
        // this process's own, and a read that failed is still one line for an operator to find.
        let id = request_id::mint();
        let response = self
            .client
            .get(format!("{}/v1/state/{}", self.base, urlencode(host_key)))
            .bearer_auth(&self.token)
            .header(request_id::HEADER, id.as_str())
            .send()
            .await
            .with_context(|| format!("reaching the game manager (requestId {id})"))?;

        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !response.status().is_success() {
            bail!(
                "the game manager answered {} for {host_key} (requestId {id})",
                response.status()
            );
        }

        let record: StateRecord = response.json().await.context("reading a state record")?;
        Ok(Some(record.value))
    }

    /// One unconditional write, carrying the manager's `Retry-After` when it throttled the call.
    async fn put(&self, host_key: &str, fields: &RawValue) -> Result<(), Unwritten> {
        let id = request_id::mint();
        let response = self
            .client
            .put(format!("{}/v1/state/{}", self.base, urlencode(host_key)))
            .bearer_auth(&self.token)
            .header(request_id::HEADER, id.as_str())
            .json(&StateWrite { value: fields })
            .send()
            .await
            .with_context(|| format!("reaching the game manager (requestId {id})"))?;

        let status = response.status();
        if status.is_success() {
            return Ok(());
        }
        Err(Unwritten {
            error: anyhow!("the game manager answered {status} for {host_key} (requestId {id})"),
            retry_after: (status == reqwest::StatusCode::TOO_MANY_REQUESTS)
                .then(|| retry_after(response.headers()))
                .flatten(),
        })
    }
}

impl Records for Store {
    fn write(
        &self,
        key: &str,
        fields: &RawValue,
    ) -> impl Future<Output = Result<(), Unwritten>> + Send {
        self.put(key, fields)
    }
}

/// The delay-seconds form, which is the one `libs/go-grove`'s limiter writes.
fn retry_after(headers: &HeaderMap) -> Option<Duration> {
    let seconds = headers
        .get(RETRY_AFTER)?
        .to_str()
        .ok()?
        .trim()
        .parse()
        .ok()?;
    Some(Duration::from_secs(seconds))
}

/// A host key is `player:<id>`, so the colon must survive as a path SEGMENT, not a separator.
fn urlencode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use request_id::testing::OneCall;

    /// A store over a stand-in manager that answers one call.
    fn one_call(status: &str, headers: &[&str], body: &str) -> (Store, OneCall) {
        let manager = OneCall::replying(status, headers, body);
        let store = Store::new(manager.base.clone(), "a-session-scoped-bearer".to_owned()).unwrap();
        (store, manager)
    }

    fn presented_id(sent: &str) -> String {
        sent.to_lowercase()
            .lines()
            .find_map(|line| line.strip_prefix("x-request-id:"))
            .expect("a state call names the id the manager will log it under")
            .trim()
            .to_owned()
    }

    fn coins(count: u32) -> Box<RawValue> {
        RawValue::from_string(format!(r#"{{"coins":{count}}}"#)).unwrap()
    }

    /// The hop this file exists for: the manager logs every read under an id, and until this header
    /// rides along, that id is one nothing on this side can name.
    #[tokio::test]
    async fn names_the_call_the_manager_is_about_to_log() {
        let (store, manager) = one_call("404 Not Found", &[], "");

        assert!(store.load("player:alice").await.unwrap().is_none());

        assert!(request_id::valid(&presented_id(&manager.received_text())));
    }

    #[tokio::test]
    async fn names_a_write_the_same_way() {
        let (store, manager) = one_call("200 OK", &[], r#"{"revision":8}"#);

        assert!(store.put("player:alice", &coins(3)).await.is_ok());

        let sent = manager.received_text();
        assert!(sent.starts_with("PUT /v1/state/player%3Aalice"), "{sent}");
        assert!(request_id::valid(&presented_id(&sent)));
    }

    /// Last writer wins: a write names no revision for the manager to refuse it against.
    #[tokio::test]
    async fn writes_with_no_precondition() {
        let (store, manager) = one_call("200 OK", &[], r#"{"revision":8}"#);

        store.put("player:alice", &coins(3)).await.unwrap();

        assert!(manager
            .received_text()
            .ends_with("\r\n\r\n{\"value\":{\"coins\":3}}"));
    }

    /// The limiter says when it will take the write, where a guess spends attempts inside the window.
    #[tokio::test]
    async fn carries_the_wait_a_throttled_write_was_told() {
        let (store, _manager) = one_call("429 Too Many Requests", &["Retry-After: 2"], "");

        let unwritten = store.put("player:alice", &coins(3)).await.unwrap_err();

        assert_eq!(unwritten.retry_after, Some(Duration::from_secs(2)));
        assert!(unwritten.error.to_string().contains("429"));
    }

    /// Only a throttle carries a wait; every other refusal is a failure the writer backs off from.
    #[tokio::test]
    async fn a_refused_write_carries_no_wait() {
        let (store, _manager) = one_call("503 Service Unavailable", &["Retry-After: 2"], "");

        let unwritten = store.put("player:alice", &coins(3)).await.unwrap_err();

        assert_eq!(unwritten.retry_after, None);
    }

    /// A failed state call is only traceable if the failure says which id to grep the manager for.
    #[tokio::test]
    async fn a_refused_read_names_the_id_it_went_out_under() {
        let (store, manager) = one_call("500 Server Error", &[], "");

        let failure = store.load("player:alice").await.unwrap_err().to_string();

        assert!(
            failure.contains(&presented_id(&manager.received_text())),
            "{failure}"
        );
    }

    #[test]
    fn escapes_the_colon_a_host_key_carries() {
        assert_eq!(urlencode("player:alice"), "player%3Aalice");
        assert_eq!(urlencode("game"), "game");
    }

    #[test]
    fn escapes_a_slash_so_a_key_cannot_climb_the_path() {
        assert_eq!(urlencode("player:../admin"), "player%3A..%2Fadmin");
    }

    /// The seam this file exists for: `readState` answers with an envelope, and only one member of
    /// it is the creator's.
    #[test]
    fn reads_the_creators_fields_out_of_the_stores_envelope() {
        let body = r#"{"key":"player:alice","value":{"coins":3,"revision":"mine"},"revision":7}"#;
        let record: StateRecord = serde_json::from_str(body).unwrap();

        assert_eq!(record.value.get(), r#"{"coins":3,"revision":"mine"}"#);
    }

    fn fixture(name: &str) -> String {
        let path = format!("../../../libs/api-contract/fixtures/wire/{name}");
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"))
    }

    #[test]
    fn reads_the_contracts_state_record() {
        let record: StateRecord = serde_json::from_str(&fixture("state-record.json")).unwrap();

        assert_eq!(record.value.get(), r#"{"coins":3,"name":"Wren"}"#);
    }

    /// The contract's write with its optional precondition taken off, which is all this host sends.
    #[test]
    fn writes_the_contracts_state_write_without_its_precondition() {
        let mut wire: serde_json::Value =
            serde_json::from_str(&fixture("state-write.json")).unwrap();
        let value = wire["value"].to_string();
        wire.as_object_mut().unwrap().remove("ifRevision");

        let fields = RawValue::from_string(value).unwrap();
        let body = serde_json::to_string(&StateWrite { value: &fields }).unwrap();

        assert_eq!(body, wire.to_string());
    }
}

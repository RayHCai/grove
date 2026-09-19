//! `@serverState` that outlives a session, over `@grove/game-manager`. This process holds no
//! database credential — it presents a session-scoped bearer — so a load and a save are HTTP
//! calls, which is why neither can happen inside a tick.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use serde_json::value::RawValue;

use crate::request_id;

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
    revision: i64,
}

/// What a write answers with: a caller compares the revision, not the value it sent.
#[derive(serde::Deserialize)]
struct Written {
    revision: i64,
}

/// The body `writeState` decodes. A bare field map is refused with a 400, so the envelope is built
/// here rather than assumed away.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct StateWrite<'a> {
    value: &'a RawValue,
    if_revision: i64,
}

#[derive(Clone)]
pub struct Store {
    client: reqwest::Client,
    base: String,
    token: String,
    /// The revision each host key was last seen at, which is what makes a save a compare-and-set.
    ///
    /// Here rather than on the sim's record because it is the STORE's counter: the sim owns the
    /// fields and has no business carrying a number only this side can interpret.
    revisions: Arc<Mutex<HashMap<String, i64>>>,
}

impl Store {
    pub fn new(base: String, token: String) -> Self {
        Self {
            client: reqwest::Client::builder()
                .timeout(REQUEST_TIMEOUT)
                .build()
                .expect("building the store client"),
            base,
            token,
            revisions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Reads one host's persisted fields. `Ok(Some)` for a record, `Ok(None)` for a key holding
    /// nothing, `Err` for a read that FAILED — three answers, because the sim writes back over the
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
            // Zero is what an unwritten key is at, so the first save of this host is a real
            // compare-and-set rather than a blind write the mechanism cannot see.
            self.remember(host_key, 0);
            return Ok(None);
        }
        if !response.status().is_success() {
            bail!(
                "the game manager answered {} for {host_key} (requestId {id})",
                response.status()
            );
        }

        let record: StateRecord = response.json().await.context("reading a state record")?;
        self.remember(host_key, record.revision);
        Ok(Some(record.value))
    }

    /// Writes one host's fields, against the revision this process last read. A refused
    /// compare-and-set is re-read and retried ONCE: another session holding the record is a real
    /// race, and one re-read is the difference between a save landing and a session silently lost.
    pub async fn save(&self, host_key: &str, fields: &RawValue) -> Result<()> {
        if self.put(host_key, fields).await? {
            return Ok(());
        }

        tracing::warn!(key = %host_key, "another session moved this record; re-reading");
        self.load(host_key).await?;
        if self.put(host_key, fields).await? {
            return Ok(());
        }
        bail!("the game manager refused two compare-and-sets for {host_key}")
    }

    /// One attempt. `false` is a 409 and nothing else — every other failure is an `Err`.
    async fn put(&self, host_key: &str, fields: &RawValue) -> Result<bool> {
        let id = request_id::mint();
        let response = self
            .client
            .put(format!("{}/v1/state/{}", self.base, urlencode(host_key)))
            .bearer_auth(&self.token)
            .header(request_id::HEADER, id.as_str())
            .json(&StateWrite {
                value: fields,
                if_revision: self.revision(host_key),
            })
            .send()
            .await
            .with_context(|| format!("reaching the game manager (requestId {id})"))?;

        if response.status() == reqwest::StatusCode::CONFLICT {
            return Ok(false);
        }
        if !response.status().is_success() {
            bail!(
                "the game manager answered {} for {host_key} (requestId {id})",
                response.status()
            );
        }

        let written: Written = response.json().await.context("reading a write answer")?;
        self.remember(host_key, written.revision);
        Ok(true)
    }

    fn revision(&self, host_key: &str) -> i64 {
        self.revisions
            .lock()
            .expect("the revision map is never held across a panic")
            .get(host_key)
            .copied()
            .unwrap_or(0)
    }

    fn remember(&self, host_key: &str, revision: i64) {
        self.revisions
            .lock()
            .expect("the revision map is never held across a panic")
            .insert(host_key.to_owned(), revision);
    }
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
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread::JoinHandle;

    /// A stand-in for the manager: answers one call and hands back the head it was sent.
    ///
    /// Blocking std rather than tokio, so the fake needs no io feature this crate does not already
    /// carry for the sockets a session runs on.
    fn one_call(answer: &'static str) -> (Store, JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("binding a loopback port");
        let base = format!("http://{}", listener.local_addr().expect("the bound port"));

        let handle = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().expect("a call from the store");
            let mut head = Vec::new();
            let mut chunk = [0_u8; 512];
            while !head.windows(4).any(|four| four == b"\r\n\r\n") {
                match socket.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(read) => head.extend_from_slice(&chunk[..read]),
                }
            }
            socket.write_all(answer.as_bytes()).expect("answering");
            String::from_utf8_lossy(&head).to_lowercase()
        });

        (
            Store::new(base, "a-session-scoped-bearer".to_owned()),
            handle,
        )
    }

    fn presented_id(head: &str) -> String {
        head.lines()
            .find_map(|line| line.strip_prefix("x-request-id:"))
            .expect("a state call names the id the manager will log it under")
            .trim()
            .to_owned()
    }

    /// The hop this file exists for: the manager logs every read under an id, and until this header
    /// rides along, that id is one nothing on this side can name.
    #[tokio::test]
    async fn names_the_call_the_manager_is_about_to_log() {
        let (store, manager) = one_call("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");

        assert!(store.load("player:alice").await.unwrap().is_none());

        let head = manager.join().expect("the manager thread");
        assert!(request_id::valid(&presented_id(&head)));
    }

    #[tokio::test]
    async fn names_a_write_the_same_way() {
        let (store, manager) = one_call("HTTP/1.1 409 Conflict\r\nContent-Length: 0\r\n\r\n");
        let fields = RawValue::from_string(r#"{"coins":3}"#.to_owned()).unwrap();

        assert!(!store.put("player:alice", &fields).await.unwrap());

        let head = manager.join().expect("the manager thread");
        assert!(head.starts_with("put /v1/state/player%3aalice"));
        assert!(request_id::valid(&presented_id(&head)));
    }

    /// A failed state call is only traceable if the failure says which id to grep the manager for.
    #[tokio::test]
    async fn a_refused_read_names_the_id_it_went_out_under() {
        let (store, manager) = one_call("HTTP/1.1 500 Server Error\r\nContent-Length: 0\r\n\r\n");

        let failure = store.load("player:alice").await.unwrap_err().to_string();

        let head = manager.join().expect("the manager thread");
        assert!(failure.contains(&presented_id(&head)), "{failure}");
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

        assert_eq!(record.revision, 7);
        assert_eq!(record.value.get(), r#"{"coins":3,"revision":"mine"}"#);
    }

    /// `writeState` decodes `StateWrite` and 400s a body with no `value`, so the field map has to
    /// travel inside one.
    #[test]
    fn writes_the_envelope_the_manager_decodes() {
        let fields = RawValue::from_string(r#"{"coins":3}"#.to_owned()).unwrap();
        let body = serde_json::to_string(&StateWrite {
            value: &fields,
            if_revision: 7,
        })
        .unwrap();

        assert_eq!(body, r#"{"value":{"coins":3},"ifRevision":7}"#);
    }
}

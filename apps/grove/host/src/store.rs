//! `@serverState` that outlives a session, over `@grove/game-manager`.
//!
//! This process holds no database credential — it presents a session-scoped bearer, and the manager
//! decides which keys that token can reach. So a load and a save are HTTP calls, which is exactly
//! why neither can happen inside a tick: the sim asks in one output batch and is answered in a later
//! input batch, and the round trip costs a joiner one turn rather than blocking the world.

use anyhow::{bail, Context, Result};
use serde_json::value::RawValue;

#[derive(Clone)]
pub struct Store {
    client: reqwest::Client,
    base: String,
    token: String,
}

impl Store {
    pub fn new(base: String, token: String) -> Self {
        Self { client: reqwest::Client::new(), base, token }
    }

    /// Reads one host's persisted fields.
    ///
    /// `Ok(Some(fields))` for a record, `Ok(None)` for a key the store holds nothing under, and an
    /// `Err` for a read that FAILED — three answers, not two, because the sim writes back over the
    /// second and must never write back over the third.
    pub async fn load(&self, host_key: &str) -> Result<Option<Box<RawValue>>> {
        let response = self
            .client
            .get(format!("{}/v1/state/{}", self.base, urlencode(host_key)))
            .bearer_auth(&self.token)
            .send()
            .await
            .context("reaching the game manager")?;

        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !response.status().is_success() {
            bail!("the game manager answered {} for {host_key}", response.status());
        }
        // Taken as text and wrapped rather than deserialized: the host never reads a field, and a
        // record that round-tripped through a tree would reach the sim as different bytes.
        let body = response.text().await.context("reading a state record")?;
        Ok(Some(RawValue::from_string(body).context("a state record that is not JSON")?))
    }

    pub async fn save(&self, host_key: &str, fields: &RawValue) -> Result<()> {
        let response = self
            .client
            .put(format!("{}/v1/state/{}", self.base, urlencode(host_key)))
            .bearer_auth(&self.token)
            .json(fields)
            .send()
            .await
            .context("reaching the game manager")?;

        if !response.status().is_success() {
            bail!("the game manager answered {} for {host_key}", response.status());
        }
        Ok(())
    }
}

/// A host key is `player:<id>`, so the colon has to survive as a path SEGMENT rather than a separator.
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
    use super::urlencode;

    #[test]
    fn escapes_the_colon_a_host_key_carries() {
        assert_eq!(urlencode("player:alice"), "player%3Aalice");
        assert_eq!(urlencode("game"), "game");
    }

    #[test]
    fn escapes_a_slash_so_a_key_cannot_climb_the_path() {
        assert_eq!(urlencode("player:../admin"), "player%3A..%2Fadmin");
    }
}

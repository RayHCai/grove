//! The join ticket, verified exactly as `libs/api-contract/src/session-token.ts` mints it.
//!
//! `base64url(JSON(claims)) + "." + base64url(HMAC-SHA256(payload, secret))` — not a JWT, so there
//! is no header to parse and no `alg` for a peer to choose. The signature is checked BEFORE the
//! payload is parsed, so a forged payload never reaches a deserializer.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use hmac::{Hmac, Mac};
use serde::Deserialize;
use sha2::Sha256;
use subtle::ConstantTimeEq;

type HmacSha256 = Hmac<Sha256>;

/// What the API asserts about the bearer. Mirrors `SessionTokenClaims`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Claims {
    pub game_id: String,
    pub session_id: String,
    /// Who the game will call `player.id`. Taken from here and never from a frame.
    pub player_id: String,
    /// Seconds since the epoch.
    pub exp: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TicketFailure {
    Malformed,
    BadSignature,
    Expired,
    /// A ticket for a different game, which this process must never serve.
    WrongGame,
}

impl TicketFailure {
    /// The token an operator greps for. Deliberately coarse: detail belongs in a log this side of
    /// the socket, never in an answer to an unauthenticated peer.
    pub fn token(self) -> &'static str {
        match self {
            Self::Malformed => "malformed",
            Self::BadSignature => "bad_signature",
            Self::Expired => "expired",
            Self::WrongGame => "wrong_game",
        }
    }
}

/// Verifies `ticket` against `secret`, then checks it is for `game_id` and has not expired.
///
/// `now_seconds` is passed in rather than read here, so a test can put the clock where it needs it
/// and the skew allowance is one number in one place.
pub fn verify(
    ticket: &str,
    secret: &[u8],
    game_id: &str,
    now_seconds: i64,
) -> Result<Claims, TicketFailure> {
    let (payload, signature) = ticket.split_once('.').ok_or(TicketFailure::Malformed)?;
    if payload.is_empty() || signature.is_empty() {
        return Err(TicketFailure::Malformed);
    }

    let provided = URL_SAFE_NO_PAD
        .decode(signature)
        .map_err(|_| TicketFailure::Malformed)?;

    let mut mac = HmacSha256::new_from_slice(secret).expect("HMAC takes a key of any length");
    mac.update(payload.as_bytes());
    let expected = mac.finalize().into_bytes();

    // Constant time over the whole comparison, and the length is compared the same way: the format
    // fixes the length, so a mismatch there is already a forgery rather than a fact worth leaking.
    if provided.len() != expected.len() {
        return Err(TicketFailure::BadSignature);
    }
    if provided.ct_eq(expected.as_slice()).unwrap_u8() != 1 {
        return Err(TicketFailure::BadSignature);
    }

    let decoded = URL_SAFE_NO_PAD
        .decode(payload)
        .map_err(|_| TicketFailure::Malformed)?;
    let claims: Claims = serde_json::from_slice(&decoded).map_err(|_| TicketFailure::Malformed)?;

    if claims.exp <= now_seconds {
        return Err(TicketFailure::Expired);
    }
    // Checked here rather than at the data layer too: a process serving one game must refuse a
    // ticket for another outright, so the mistake cannot become a cross-game read later.
    if claims.game_id != game_id {
        return Err(TicketFailure::WrongGame);
    }

    Ok(claims)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &[u8] = b"a-secret-at-least-thirty-two-characters";
    const GAME: &str = "11111111-1111-4111-8111-111111111111";

    fn mint(claims: &serde_json::Value, secret: &[u8]) -> String {
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(claims).unwrap());
        let mut mac = HmacSha256::new_from_slice(secret).unwrap();
        mac.update(payload.as_bytes());
        format!(
            "{payload}.{}",
            URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
        )
    }

    fn claims(exp: i64) -> serde_json::Value {
        serde_json::json!({
            "gameId": GAME,
            "sessionId": "22222222-2222-4222-8222-222222222222",
            "playerId": "33333333-3333-4333-8333-333333333333",
            "exp": exp,
        })
    }

    #[test]
    fn accepts_a_ticket_this_secret_minted() {
        let ok = verify(&mint(&claims(2_000), SECRET), SECRET, GAME, 1_000).unwrap();
        assert_eq!(ok.player_id, "33333333-3333-4333-8333-333333333333");
    }

    #[test]
    fn refuses_another_secret() {
        let err = verify(
            &mint(&claims(2_000), b"another-secret-entirely"),
            SECRET,
            GAME,
            1_000,
        );
        assert_eq!(err.unwrap_err(), TicketFailure::BadSignature);
    }

    #[test]
    fn refuses_a_payload_edited_after_signing() {
        let token = mint(&claims(2_000), SECRET);
        let (_, signature) = token.split_once('.').unwrap();
        let forged = URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&serde_json::json!({
                "gameId": GAME,
                "sessionId": "22222222-2222-4222-8222-222222222222",
                "playerId": "someone-else",
                "exp": 2_000,
            }))
            .unwrap(),
        );
        let err = verify(&format!("{forged}.{signature}"), SECRET, GAME, 1_000);
        assert_eq!(err.unwrap_err(), TicketFailure::BadSignature);
    }

    #[test]
    fn refuses_an_expired_ticket_at_the_boundary() {
        // `exp <= now` rather than `<`, so the second it names is already gone.
        let err = verify(&mint(&claims(1_000), SECRET), SECRET, GAME, 1_000);
        assert_eq!(err.unwrap_err(), TicketFailure::Expired);
    }

    #[test]
    fn refuses_a_ticket_for_another_game() {
        let other = serde_json::json!({
            "gameId": "44444444-4444-4444-8444-444444444444",
            "sessionId": "22222222-2222-4222-8222-222222222222",
            "playerId": "33333333-3333-4333-8333-333333333333",
            "exp": 2_000,
        });
        let err = verify(&mint(&other, SECRET), SECRET, GAME, 1_000);
        assert_eq!(err.unwrap_err(), TicketFailure::WrongGame);
    }

    /// A token `libs/api-contract`'s own `signSessionToken` minted, pasted verbatim.
    ///
    /// The two halves are in different languages over one shared secret, so agreeing about the
    /// FORMAT is not the same as agreeing about the bytes: this is the only test that would catch a
    /// base64 variant, a key-order difference or a signing-input change on the far side.
    const MINTED_BY_TS: &str = concat!(
        "eyJnYW1lSWQiOiIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJzZXNzaW9uSWQiOiIy",
        "MjIyMjIyMi0yMjIyLTQyMjItODIyMi0yMjIyMjIyMjIyMjIiLCJwbGF5ZXJJZCI6IjMzMzMzMzMzLTMzMzMt",
        "NDMzMy04MzMzLTMzMzMzMzMzMzMzMyIsImV4cCI6MjAwMH0",
        ".TlkE2PGo2MpQQx5QxOz5fq1W9ljiINYjJe8cx-MVle0",
    );

    #[test]
    fn accepts_the_bytes_the_typescript_signer_actually_produces() {
        let ok = verify(MINTED_BY_TS, SECRET, GAME, 1_000).unwrap();
        assert_eq!(ok.player_id, "33333333-3333-4333-8333-333333333333");
        assert_eq!(ok.session_id, "22222222-2222-4222-8222-222222222222");
        assert_eq!(ok.exp, 2_000);
    }

    #[test]
    fn refuses_a_signature_lifted_from_another_ticket_by_the_same_signer() {
        // Also minted by the TypeScript signer, for the same claims but another `playerId`. Swapping
        // its signature onto the payload above is the forgery the HMAC exists to refuse.
        let other_signature = "qS6fp9f8V9dDtzhD6dKCGapDATg8eWSCHhMiLLGTaFM";
        let payload = MINTED_BY_TS.split_once('.').unwrap().0;
        let err = verify(&format!("{payload}.{other_signature}"), SECRET, GAME, 1_000);
        assert_eq!(err.unwrap_err(), TicketFailure::BadSignature);
    }

    #[test]
    fn refuses_a_token_with_no_signature_at_all() {
        assert_eq!(
            verify("no-dot-here", SECRET, GAME, 1_000).unwrap_err(),
            TicketFailure::Malformed
        );
        assert_eq!(
            verify("payload.", SECRET, GAME, 1_000).unwrap_err(),
            TicketFailure::Malformed
        );
    }
}

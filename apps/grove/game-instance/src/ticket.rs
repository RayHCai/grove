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

/// The audience a ticket presented here must name. The store bearer a game process holds is minted
/// with the same secret, and admitting it here would let one credential do both jobs.
const AUDIENCE: &str = "game-instance";

/// How long `@grove/api` mints a ticket for, which is the widest an honest expiry can miss by.
const TICKET_LIFETIME_SECONDS: i64 = 60;

/// What the API asserts about the bearer. Mirrors `SessionTokenClaims`.
///
/// Unknown members are ignored rather than refused: `z.object` strips them and the Go verifier
/// ignores them, so a claim added on the minting side must not take every game process offline at
/// the deploy that introduces it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Claims {
    pub game_id: String,
    pub session_id: String,
    /// Who the game will call `player.id`. Taken from here and never from a frame.
    pub player_id: String,
    /// Seconds since the epoch.
    pub exp: i64,
}

/// Just enough of the payload to say which credential this is.
#[derive(Deserialize)]
struct Audience {
    aud: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TicketFailure {
    Malformed,
    BadSignature,
    /// Carries the expiry it missed, because the gap between that and this box's clock is the whole
    /// diagnosis and neither number survives the token.
    Expired(i64),
    /// A ticket for a different game, which this process must never serve.
    WrongGame,
    /// A ticket for another session of this game, which is another world on another box.
    WrongSession,
    /// A credential minted for the data plane, presented here.
    WrongAudience,
    /// Expired by more than a ticket's whole life, which is the minting box's clock and not the peer.
    ClockSkew(i64),
}

impl TicketFailure {
    /// The token an operator greps for. Deliberately coarse: detail belongs in a log this side of
    /// the socket, never in an answer to an unauthenticated peer.
    pub fn token(self) -> &'static str {
        match self {
            Self::Malformed => "malformed",
            Self::BadSignature => "bad_signature",
            Self::Expired(_) => "expired",
            Self::WrongGame => "wrong_game",
            Self::WrongSession => "wrong_session",
            Self::WrongAudience => "wrong_audience",
            Self::ClockSkew(_) => "clock_skew",
        }
    }

    /// The expiry a refusal about time was measured against, for the log line to print beside the
    /// reading this box took — which is the only place the two clocks are ever compared.
    pub fn expiry(self) -> Option<i64> {
        match self {
            Self::Expired(exp) | Self::ClockSkew(exp) => Some(exp),
            _ => None,
        }
    }
}

/// Verifies `ticket` against `secret`, then checks it names this game, this session and this
/// service, and has not expired.
///
/// `now_seconds` is passed in rather than read here, so a test can put the clock where it needs it.
/// The expiry comparison is exact, and a ticket that missed by more than its own lifetime is
/// reported as the clock the two boxes disagree about rather than as an expiry.
pub fn verify(
    ticket: &str,
    secret: &[u8],
    game_id: &str,
    session_id: &str,
    now_seconds: i64,
) -> Result<Claims, TicketFailure> {
    let (payload, signature) = ticket.split_once('.').ok_or(TicketFailure::Malformed)?;
    if payload.is_empty() || signature.is_empty() {
        return Err(TicketFailure::Malformed);
    }

    // A signature segment that is not base64 is a bad signature, not a bad shape — which is the
    // verdict the TypeScript and Go halves reach for the same bytes.
    let provided = URL_SAFE_NO_PAD
        .decode(signature)
        .map_err(|_| TicketFailure::BadSignature)?;

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
    // Read before the rest: the store bearer carries no `playerId`, so deserializing the whole
    // claim set first would refuse it as malformed and hide which credential was presented.
    let audience: Audience =
        serde_json::from_slice(&decoded).map_err(|_| TicketFailure::Malformed)?;
    if audience.aud != AUDIENCE {
        return Err(TicketFailure::WrongAudience);
    }

    let claims: Claims = serde_json::from_slice(&decoded).map_err(|_| TicketFailure::Malformed)?;
    if claims.exp <= now_seconds {
        // A ticket cannot be handed over later than it lived, so a wider gap is two boxes
        // disagreeing about the time — which `expired` alone gives an operator no way to see.
        if now_seconds - claims.exp > TICKET_LIFETIME_SECONDS {
            return Err(TicketFailure::ClockSkew(claims.exp));
        }
        return Err(TicketFailure::Expired(claims.exp));
    }
    // Checked here rather than at the data layer too: a process serving one game must refuse a
    // ticket for another outright, so the mistake cannot become a cross-game read later.
    if claims.game_id != game_id {
        return Err(TicketFailure::WrongGame);
    }
    // And one session: a ticket the allocator minted for a world on another box must not admit its
    // bearer here, or the placement decision is one a player can route around.
    if claims.session_id != session_id {
        return Err(TicketFailure::WrongSession);
    }

    Ok(claims)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &[u8] = b"a-secret-at-least-thirty-two-characters";
    const GAME: &str = "11111111-1111-4111-8111-111111111111";
    const SESSION: &str = "22222222-2222-4222-8222-222222222222";
    const PLAYER: &str = "33333333-3333-4333-8333-333333333333";

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
            "sessionId": SESSION,
            "playerId": PLAYER,
            "aud": "game-instance",
            "exp": exp,
        })
    }

    fn check(ticket: &str, now: i64) -> Result<Claims, TicketFailure> {
        verify(ticket, SECRET, GAME, SESSION, now)
    }

    #[test]
    fn accepts_a_ticket_this_secret_minted() {
        let ok = check(&mint(&claims(2_000), SECRET), 1_000).unwrap();
        assert_eq!(ok.player_id, PLAYER);
    }

    #[test]
    fn refuses_another_secret() {
        let err = check(&mint(&claims(2_000), b"another-secret-entirely"), 1_000);
        assert_eq!(err.unwrap_err(), TicketFailure::BadSignature);
    }

    #[test]
    fn refuses_a_payload_edited_after_signing() {
        let token = mint(&claims(2_000), SECRET);
        let (_, signature) = token.split_once('.').unwrap();
        let forged = URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&serde_json::json!({
                "gameId": GAME,
                "sessionId": SESSION,
                "playerId": "someone-else",
                "aud": "game-instance",
                "exp": 2_000,
            }))
            .unwrap(),
        );
        let err = check(&format!("{forged}.{signature}"), 1_000);
        assert_eq!(err.unwrap_err(), TicketFailure::BadSignature);
    }

    #[test]
    fn refuses_an_expired_ticket_at_the_boundary() {
        // `exp <= now` rather than `<`, so the second it names is already gone.
        let err = check(&mint(&claims(1_000), SECRET), 1_000);
        assert_eq!(err.unwrap_err(), TicketFailure::Expired(1_000));
    }

    /// The box that mints and the box that verifies are two machines with two clocks, and only this
    /// line tells an operator which of the two the refusal is about.
    #[test]
    fn names_the_clock_when_a_ticket_missed_by_more_than_it_lived() {
        let minted = mint(&claims(1_000), SECRET);

        assert_eq!(
            check(&minted, 1_000 + TICKET_LIFETIME_SECONDS).unwrap_err(),
            TicketFailure::Expired(1_000)
        );
        assert_eq!(
            check(&minted, 1_000 + TICKET_LIFETIME_SECONDS + 1).unwrap_err(),
            TicketFailure::ClockSkew(1_000)
        );
    }

    /// A box whose clock has drifted refuses honest tickets as plainly expired, so the refusal line
    /// has to carry the expiry it measured against or no token tells an operator which box moved.
    #[test]
    fn a_refusal_about_time_carries_the_expiry_it_missed() {
        let minted = mint(&claims(1_000), SECRET);

        assert_eq!(check(&minted, 1_001).unwrap_err().expiry(), Some(1_000));
        assert_eq!(check(&minted, 5_000).unwrap_err().expiry(), Some(1_000));
        assert_eq!(check("no-dot-here", 1_000).unwrap_err().expiry(), None);
    }

    #[test]
    fn refuses_a_ticket_for_another_game() {
        let other = serde_json::json!({
            "gameId": "44444444-4444-4444-8444-444444444444",
            "sessionId": SESSION,
            "playerId": PLAYER,
            "aud": "game-instance",
            "exp": 2_000,
        });
        assert_eq!(
            check(&mint(&other, SECRET), 1_000).unwrap_err(),
            TicketFailure::WrongGame
        );
    }

    /// The placement decision a ticket must not route around: one world, on one box.
    #[test]
    fn refuses_a_ticket_for_another_session_of_this_game() {
        let other = serde_json::json!({
            "gameId": GAME,
            "sessionId": "55555555-5555-4555-8555-555555555555",
            "playerId": PLAYER,
            "aud": "game-instance",
            "exp": 2_000,
        });
        assert_eq!(
            check(&mint(&other, SECRET), 1_000).unwrap_err(),
            TicketFailure::WrongSession
        );
    }

    /// The store bearer is minted with this same secret, and it is not a join ticket.
    #[test]
    fn refuses_a_credential_minted_for_the_data_plane() {
        let store = serde_json::json!({
            "gameId": GAME,
            "sessionId": SESSION,
            "aud": "game-manager",
            "exp": 2_000,
        });
        assert_eq!(
            check(&mint(&store, SECRET), 1_000).unwrap_err(),
            TicketFailure::WrongAudience
        );
    }

    /// A claim added on the minting side must not take this process offline at that deploy.
    #[test]
    fn ignores_a_claim_a_newer_allocator_added() {
        let widened = serde_json::json!({
            "gameId": GAME,
            "sessionId": SESSION,
            "playerId": PLAYER,
            "aud": "game-instance",
            "region": "us-east-1",
            "exp": 2_000,
        });
        assert!(check(&mint(&widened, SECRET), 1_000).is_ok());
    }

    #[test]
    fn refuses_a_token_with_no_signature_at_all() {
        assert_eq!(
            check("no-dot-here", 1_000).unwrap_err(),
            TicketFailure::Malformed
        );
        assert_eq!(
            check("payload.", 1_000).unwrap_err(),
            TicketFailure::Malformed
        );
    }

    /// The vector `signSessionToken` actually produced, read from the file the Go verifier reads.
    ///
    /// The three halves are in three languages over one shared secret, so agreeing about the FORMAT
    /// is not the same as agreeing about the bytes: this is the only test that would catch a base64
    /// variant, a key-order difference or a signing-input change on either far side.
    #[test]
    fn accepts_the_bytes_the_typescript_signer_actually_produces() {
        let raw = std::fs::read_to_string("../../../libs/api-contract/fixtures/session-token.json")
            .expect("the shared token vector");
        let vector: serde_json::Value = serde_json::from_str(&raw).unwrap();

        let secret = vector["secret"].as_str().unwrap().as_bytes();
        let claims = &vector["ticket"]["claims"];
        let token = vector["ticket"]["token"].as_str().unwrap();

        let ok = verify(
            token,
            secret,
            claims["gameId"].as_str().unwrap(),
            claims["sessionId"].as_str().unwrap(),
            claims["exp"].as_i64().unwrap() - 1,
        )
        .unwrap();
        assert_eq!(ok.player_id, claims["playerId"].as_str().unwrap());

        // And the store bearer in the same file, which this side must never admit.
        let store = vector["storeBearer"]["token"].as_str().unwrap();
        let err = verify(
            store,
            secret,
            claims["gameId"].as_str().unwrap(),
            claims["sessionId"].as_str().unwrap(),
            claims["exp"].as_i64().unwrap() - 1,
        );
        assert_eq!(err.unwrap_err(), TicketFailure::WrongAudience);
    }

    #[test]
    fn refuses_a_signature_lifted_from_another_ticket_by_the_same_signer() {
        let mine = mint(&claims(2_000), SECRET);
        let theirs = mint(&claims(3_000), SECRET);
        let payload = mine.split_once('.').unwrap().0;
        let signature = theirs.split_once('.').unwrap().1;

        let err = check(&format!("{payload}.{signature}"), 1_000);
        assert_eq!(err.unwrap_err(), TicketFailure::BadSignature);
    }
}

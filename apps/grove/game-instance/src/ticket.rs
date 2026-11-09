//! The join ticket, verified exactly as `libs/api-contract/src/session-token.ts` mints it.
//! Not a JWT, so there is no header to parse and no `alg` for a peer to choose. The signature is
//! checked BEFORE the payload is parsed, so a forged payload never reaches a deserializer.
//! Ed25519 under public keys alone, so nothing this process holds can mint a ticket.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use anyhow::{bail, Result};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use ring::signature::{UnparsedPublicKey, ED25519};
use serde::Deserialize;

/// The audience a ticket presented here must name, checked however the signing keys are split.
const AUDIENCE: &str = "game-instance";

/// How long `@grove/api` mints a ticket for, which is the widest an honest expiry can miss by.
const TICKET_LIFETIME_SECONDS: i64 = 60;

/// The furthest ahead an expiry may sit, which is also how long a spent ticket must be remembered.
const MAX_TICKET_HORIZON_SECONDS: i64 = 300;

/// Spent tickets held at once: past it a join is refused rather than a spent ticket forgotten.
const MAX_SPENT_TICKETS: usize = 4096;

const PUBLIC_KEY_BYTES: usize = 32;
const SIGNATURE_BYTES: usize = 64;

/// The public keys a ticket may verify under: during a rotation, the incoming one and the outgoing.
pub struct TicketKeys(Vec<UnparsedPublicKey<[u8; PUBLIC_KEY_BYTES]>>);

impl TicketKeys {
    /// Reads a comma-separated list, each entry the unpadded base64url of a raw 32-byte key.
    pub fn parse(list: &str) -> Result<Self> {
        let mut keys = Vec::new();
        for entry in list.split(',').map(str::trim) {
            let Some(raw) = URL_SAFE_NO_PAD
                .decode(entry)
                .ok()
                .and_then(|bytes| <[u8; PUBLIC_KEY_BYTES]>::try_from(bytes).ok())
            else {
                bail!("{entry:?} is not the unpadded base64url of a {PUBLIC_KEY_BYTES}-byte key");
            };
            keys.push(UnparsedPublicKey::new(&ED25519, raw));
        }
        Ok(Self(keys))
    }

    fn signed(&self, message: &[u8], signature: &[u8]) -> bool {
        self.0
            .iter()
            .any(|key| key.verify(message, signature).is_ok())
    }
}

/// What the API asserts about the bearer, as `SessionTokenClaims` spells it.
#[derive(Debug, Clone)]
pub struct Claims {
    pub game_id: String,
    pub session_id: String,
    /// Who the game will call `player.id`. Taken from here and never from a frame.
    pub player_id: String,
    /// Seconds since the epoch.
    pub exp: i64,
}

/// The payload as the contract shapes it; a member a newer allocator adds is ignored, not refused.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Payload {
    game_id: String,
    session_id: String,
    player_id: Option<String>,
    aud: String,
    exp: i64,
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
    /// Expired by more than a ticket's whole life: that is the minting box's clock, not the peer.
    ClockSkew(i64),
    /// An expiry past the horizon, which no allocator mints and no spent set could outlast.
    ExpiresTooLate(i64),
    /// A ticket this process has already admitted once.
    Reused,
    /// Every slot for a spent ticket is taken, which is this process's limit and not the peer's fault.
    Crowded,
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
            Self::ExpiresTooLate(_) => "expires_too_late",
            Self::Reused => "reused",
            Self::Crowded => "too_many_tickets",
        }
    }

    /// The expiry a refusal about time was measured against, for the log line to print beside the
    /// reading this box took, which is the only place the two clocks are ever compared.
    pub fn expiry(self) -> Option<i64> {
        match self {
            Self::Expired(exp) | Self::ClockSkew(exp) | Self::ExpiresTooLate(exp) => Some(exp),
            _ => None,
        }
    }
}

/// A ticket whose signature and claims checked out, and the signature that names it.
pub struct Verified {
    pub claims: Claims,
    signature: [u8; SIGNATURE_BYTES],
}

/// Verifies `ticket` under any of `keys`, in the order the contract fixes: shape, signature,
/// claims, audience, expiry. `now_seconds` is passed in so a test can put the clock where it needs it.
pub fn verify(
    ticket: &str,
    keys: &TicketKeys,
    now_seconds: i64,
) -> Result<Verified, TicketFailure> {
    let (payload, signature) = ticket.split_once('.').ok_or(TicketFailure::Malformed)?;
    if payload.is_empty() || signature.is_empty() {
        return Err(TicketFailure::Malformed);
    }
    let decoded = URL_SAFE_NO_PAD
        .decode(payload)
        .map_err(|_| TicketFailure::Malformed)?;
    // A signature segment that is not base64 is a bad signature, not a bad shape, which is the
    // verdict the TypeScript and Go halves reach for the same bytes.
    let signature: [u8; SIGNATURE_BYTES] = URL_SAFE_NO_PAD
        .decode(signature)
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or(TicketFailure::BadSignature)?;
    if !keys.signed(payload.as_bytes(), &signature) {
        return Err(TicketFailure::BadSignature);
    }

    let claims: Payload = serde_json::from_slice(&decoded).map_err(|_| TicketFailure::Malformed)?;
    if claims.exp <= 0 || claims.player_id.is_some() != (claims.aud == AUDIENCE) {
        return Err(TicketFailure::Malformed);
    }
    let Some(player_id) = claims.player_id else {
        return Err(TicketFailure::WrongAudience);
    };
    if claims.exp <= now_seconds {
        // A ticket cannot be handed over later than it lived, so a wider gap is two boxes
        // disagreeing about the time, which `expired` alone gives an operator no way to see.
        if now_seconds - claims.exp > TICKET_LIFETIME_SECONDS {
            return Err(TicketFailure::ClockSkew(claims.exp));
        }
        return Err(TicketFailure::Expired(claims.exp));
    }

    Ok(Verified {
        claims: Claims {
            game_id: claims.game_id,
            session_id: claims.session_id,
            player_id,
            exp: claims.exp,
        },
        signature,
    })
}

/// Admits a ticket for this game and this session, and each ticket once.
pub struct Gate {
    keys: TicketKeys,
    game_id: String,
    session_id: String,
    /// Admitted tickets by signature, each until its expiry: Ed25519 gives one payload one signature.
    spent: Mutex<HashMap<[u8; SIGNATURE_BYTES], i64>>,
    room: usize,
}

impl Gate {
    pub fn new(keys: TicketKeys, game_id: String, session_id: String) -> Self {
        Self {
            keys,
            game_id,
            session_id,
            spent: Mutex::new(HashMap::new()),
            room: MAX_SPENT_TICKETS,
        }
    }

    /// Verifies `ticket` and spends it, so a second presentation of the same bytes is refused.
    pub fn admit(&self, ticket: &str, now_seconds: i64) -> Result<Claims, TicketFailure> {
        let Verified { claims, signature } = verify(ticket, &self.keys, now_seconds)?;
        // Checked here rather than at the data layer too: a process serving one game must refuse a
        // ticket for another outright, so the mistake cannot become a cross-game read later.
        if claims.game_id != self.game_id {
            return Err(TicketFailure::WrongGame);
        }
        // And one session: a ticket the allocator minted for a world on another box must not admit
        // its bearer here, or the placement decision is one a player can route around.
        if claims.session_id != self.session_id {
            return Err(TicketFailure::WrongSession);
        }
        if claims.exp - now_seconds > MAX_TICKET_HORIZON_SECONDS {
            return Err(TicketFailure::ExpiresTooLate(claims.exp));
        }

        let mut spent = self.spent();
        spent.retain(|_, exp| *exp > now_seconds);
        if spent.contains_key(&signature) {
            return Err(TicketFailure::Reused);
        }
        if spent.len() >= self.room {
            return Err(TicketFailure::Crowded);
        }
        spent.insert(signature, claims.exp);
        Ok(claims)
    }

    /// Poison is ignored: every write under this lock leaves the set whole.
    fn spent(&self) -> MutexGuard<'_, HashMap<[u8; SIGNATURE_BYTES], i64>> {
        self.spent
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use ring::signature::{Ed25519KeyPair, KeyPair as _};

    /// The contract's seed, so a ticket minted here is one its other verifiers would admit too.
    pub const SEED: &str = "nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A";
    const OTHER_SEED: &str = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA";
    pub const GAME: &str = "11111111-1111-4111-8111-111111111111";
    pub const SESSION: &str = "22222222-2222-4222-8222-222222222222";
    pub const PLAYER: &str = "33333333-3333-4333-8333-333333333333";
    const NOW: i64 = 1_800_000_000;
    const BASE64URL: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

    fn pair(seed: &str) -> Ed25519KeyPair {
        Ed25519KeyPair::from_seed_unchecked(&URL_SAFE_NO_PAD.decode(seed).unwrap()).unwrap()
    }

    pub fn public_key(seed: &str) -> String {
        URL_SAFE_NO_PAD.encode(pair(seed).public_key().as_ref())
    }

    pub fn keys() -> TicketKeys {
        TicketKeys::parse(&public_key(SEED)).unwrap()
    }

    /// Signs the first segment's ASCII, which is what `signTicket` signs.
    pub fn mint(claims: &serde_json::Value, seed: &str) -> String {
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(claims).unwrap());
        let signature = pair(seed).sign(payload.as_bytes());
        format!("{payload}.{}", URL_SAFE_NO_PAD.encode(signature.as_ref()))
    }

    pub fn claims(exp: i64) -> serde_json::Value {
        serde_json::json!({
            "gameId": GAME,
            "sessionId": SESSION,
            "playerId": PLAYER,
            "aud": "game-instance",
            "exp": exp,
        })
    }

    fn check(ticket: &str, now: i64) -> Result<Claims, TicketFailure> {
        verify(ticket, &keys(), now).map(|verified| verified.claims)
    }

    fn gate() -> Gate {
        Gate::new(keys(), GAME.to_owned(), SESSION.to_owned())
    }

    #[test]
    fn accepts_a_ticket_this_key_signed() {
        let ok = check(&mint(&claims(NOW + 60), SEED), NOW).unwrap();
        assert_eq!(ok.player_id, PLAYER);
    }

    #[test]
    fn refuses_another_key() {
        let err = check(&mint(&claims(NOW + 60), OTHER_SEED), NOW);
        assert_eq!(err.unwrap_err(), TicketFailure::BadSignature);
    }

    /// A rotation adds the incoming key beside the outgoing one, and a ticket from either is good.
    #[test]
    fn accepts_a_ticket_signed_by_any_key_in_the_list() {
        let both = TicketKeys::parse(&format!("{}, {}", public_key(OTHER_SEED), public_key(SEED)))
            .unwrap();

        assert!(verify(&mint(&claims(NOW + 60), SEED), &both, NOW).is_ok());
        assert!(verify(&mint(&claims(NOW + 60), OTHER_SEED), &both, NOW).is_ok());
    }

    #[test]
    fn refuses_a_key_list_with_anything_but_raw_keys_in_it() {
        assert!(TicketKeys::parse("").is_err());
        assert!(TicketKeys::parse(&format!("{},", public_key(SEED))).is_err());
        assert!(TicketKeys::parse(&format!("{}=", public_key(SEED))).is_err());
        assert!(TicketKeys::parse(&URL_SAFE_NO_PAD.encode([7u8; 31])).is_err());
        assert!(TicketKeys::parse(&"+".repeat(43)).is_err());
    }

    #[test]
    fn refuses_a_payload_edited_after_signing() {
        let token = mint(&claims(NOW + 60), SEED);
        let (_, signature) = token.split_once('.').unwrap();
        let mut edited = claims(NOW + 60);
        edited["playerId"] = serde_json::json!("someone-else");
        let forged = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&edited).unwrap());

        let err = check(&format!("{forged}.{signature}"), NOW);
        assert_eq!(err.unwrap_err(), TicketFailure::BadSignature);
    }

    #[test]
    fn refuses_an_expired_ticket_at_the_boundary() {
        // `exp <= now` rather than `<`, so the second it names is already gone.
        let err = check(&mint(&claims(NOW), SEED), NOW);
        assert_eq!(err.unwrap_err(), TicketFailure::Expired(NOW));
    }

    /// The box that mints and the box that verifies are two machines with two clocks, and only this
    /// line tells an operator which of the two the refusal is about.
    #[test]
    fn names_the_clock_when_a_ticket_missed_by_more_than_it_lived() {
        let minted = mint(&claims(NOW), SEED);

        assert_eq!(
            check(&minted, NOW + TICKET_LIFETIME_SECONDS).unwrap_err(),
            TicketFailure::Expired(NOW)
        );
        assert_eq!(
            check(&minted, NOW + TICKET_LIFETIME_SECONDS + 1).unwrap_err(),
            TicketFailure::ClockSkew(NOW)
        );
    }

    /// A box whose clock has drifted refuses honest tickets as plainly expired, so the refusal line
    /// has to carry the expiry it measured against or no token tells an operator which box moved.
    #[test]
    fn a_refusal_about_time_carries_the_expiry_it_missed() {
        let minted = mint(&claims(NOW), SEED);

        assert_eq!(check(&minted, NOW + 1).unwrap_err().expiry(), Some(NOW));
        assert_eq!(check(&minted, NOW + 5_000).unwrap_err().expiry(), Some(NOW));
        assert_eq!(check("no-dot-here", NOW).unwrap_err().expiry(), None);
    }

    /// The store bearer is a different credential with no player on it, and it is not a join ticket.
    #[test]
    fn refuses_a_credential_minted_for_the_data_plane() {
        let store = serde_json::json!({
            "gameId": GAME,
            "sessionId": SESSION,
            "aud": "game-manager",
            "exp": NOW + 60,
        });
        assert_eq!(
            check(&mint(&store, SEED), NOW).unwrap_err(),
            TicketFailure::WrongAudience
        );
    }

    /// The contract pairs a player with a ticket and nothing else, so either half alone is a bad shape.
    #[test]
    fn refuses_a_player_and_an_audience_the_contract_never_pairs() {
        let mut playerless = claims(NOW + 60);
        playerless.as_object_mut().unwrap().remove("playerId");
        let mut bearer_with_a_player = claims(NOW + 60);
        bearer_with_a_player["aud"] = serde_json::json!("game-manager");

        for shape in [playerless, bearer_with_a_player, claims(0)] {
            assert_eq!(
                check(&mint(&shape, SEED), NOW).unwrap_err(),
                TicketFailure::Malformed
            );
        }
    }

    /// A claim added on the minting side must not take this process offline at that deploy.
    #[test]
    fn ignores_a_claim_a_newer_allocator_added() {
        let mut widened = claims(NOW + 60);
        widened["region"] = serde_json::json!("us-east-1");
        assert!(check(&mint(&widened, SEED), NOW).is_ok());
    }

    #[test]
    fn refuses_a_token_with_no_signature_at_all() {
        for token in ["no-dot-here", "payload.", ".signature"] {
            assert_eq!(check(token, NOW).unwrap_err(), TicketFailure::Malformed);
        }
    }

    /// Base64url has one spelling for a given set of bytes, and a ticket in any other is not one.
    #[test]
    fn refuses_a_segment_spelled_any_way_but_canonically() {
        let token = mint(&claims(NOW + 60), SEED);
        let (payload, signature) = token.split_once('.').unwrap();
        // The last character of a 64-byte signature carries four bits that must be zero.
        let (head, last) = signature.split_at(signature.len() - 1);
        let value = BASE64URL.find(last).unwrap();
        let loose = format!("{head}{}", &BASE64URL[(value | 1)..=(value | 1)]);

        assert_eq!(
            check(&format!("{payload}.{loose}"), NOW).unwrap_err(),
            TicketFailure::BadSignature
        );
        assert_eq!(
            check(&format!("{payload}=.{signature}"), NOW).unwrap_err(),
            TicketFailure::Malformed
        );
        assert_eq!(
            check(&format!("{payload}.{signature}=="), NOW).unwrap_err(),
            TicketFailure::BadSignature
        );
    }

    #[test]
    fn refuses_a_signature_lifted_from_another_ticket_by_the_same_signer() {
        let mine = mint(&claims(NOW + 60), SEED);
        let theirs = mint(&claims(NOW + 61), SEED);
        let payload = mine.split_once('.').unwrap().0;
        let signature = theirs.split_once('.').unwrap().1;

        let err = check(&format!("{payload}.{signature}"), NOW);
        assert_eq!(err.unwrap_err(), TicketFailure::BadSignature);
    }

    fn contract() -> serde_json::Value {
        let raw = std::fs::read_to_string("../../../libs/api-contract/fixtures/session-token.json")
            .expect("the shared token vectors");
        serde_json::from_str(&raw).unwrap()
    }

    /// The bytes `signTicket` actually produced, from the file the TypeScript verifier reads too.
    #[test]
    fn reaches_the_contracts_verdict_on_every_shared_vector() {
        let contract = contract();
        let set = &contract["ticket"];
        let keys = TicketKeys::parse(set["publicKey"].as_str().unwrap()).unwrap();
        let now = set["now"].as_i64().unwrap();

        for vector in set["vectors"].as_array().unwrap() {
            let verdict = match verify(vector["token"].as_str().unwrap(), &keys, now) {
                Ok(verified) => {
                    assert_eq!(verified.claims.player_id, vector["claims"]["playerId"]);
                    "ok"
                }
                // The contract has one word for both; the second is this side's reading of the first.
                Err(TicketFailure::Expired(_) | TicketFailure::ClockSkew(_)) => "expired",
                Err(failure) => failure.token(),
            };
            assert_eq!(verdict, vector["expect"], "{}", vector["name"]);
        }
    }

    #[test]
    fn derives_the_contracts_public_key_from_its_seed() {
        let contract = contract();

        assert_eq!(SEED, contract["ticket"]["seed"]);
        assert_eq!(public_key(SEED), contract["ticket"]["publicKey"]);
    }

    #[test]
    fn admits_a_ticket_once() {
        let gate = gate();
        let ticket = mint(&claims(NOW + 60), SEED);

        assert_eq!(gate.admit(&ticket, NOW).unwrap().player_id, PLAYER);
        assert_eq!(
            gate.admit(&ticket, NOW + 1).unwrap_err(),
            TicketFailure::Reused
        );
    }

    /// The set of spent tickets is sized by the horizon, so an expiry past it is refused outright.
    #[test]
    fn refuses_an_expiry_past_the_horizon() {
        let gate = gate();
        let horizon = NOW + MAX_TICKET_HORIZON_SECONDS;

        assert!(gate.admit(&mint(&claims(horizon), SEED), NOW).is_ok());
        assert_eq!(
            gate.admit(&mint(&claims(horizon + 1), SEED), NOW)
                .unwrap_err(),
            TicketFailure::ExpiresTooLate(horizon + 1)
        );
    }

    #[test]
    fn refuses_a_ticket_for_another_game() {
        let mut other = claims(NOW + 60);
        other["gameId"] = serde_json::json!("44444444-4444-4444-8444-444444444444");
        assert_eq!(
            gate().admit(&mint(&other, SEED), NOW).unwrap_err(),
            TicketFailure::WrongGame
        );
    }

    /// The placement decision a ticket must not route around: one world, on one box.
    #[test]
    fn refuses_a_ticket_for_another_session_of_this_game() {
        let mut other = claims(NOW + 60);
        other["sessionId"] = serde_json::json!("55555555-5555-4555-8555-555555555555");
        assert_eq!(
            gate().admit(&mint(&other, SEED), NOW).unwrap_err(),
            TicketFailure::WrongSession
        );
    }

    /// A refused ticket is not spent, or a box that turned it away once would refuse it for good.
    #[test]
    fn spends_only_a_ticket_it_admitted() {
        let gate = gate();
        let ticket = mint(&claims(NOW + 60), SEED);

        assert_eq!(
            gate.admit(&ticket, NOW + 60).unwrap_err(),
            TicketFailure::Expired(NOW + 60)
        );
        assert!(gate.admit(&ticket, NOW).is_ok());
    }

    /// Full is a refusal, and a spent ticket is forgotten only once its expiry would refuse it anyway.
    #[test]
    fn holds_a_spent_ticket_until_its_expiry_and_no_longer() {
        let gate = Gate { room: 2, ..gate() };
        let soon = |player: &str| {
            let mut each = claims(NOW + 10);
            each["playerId"] = serde_json::json!(player);
            mint(&each, SEED)
        };
        assert!(gate.admit(&soon("a"), NOW).is_ok());
        assert!(gate.admit(&soon("b"), NOW).is_ok());

        let late = mint(&claims(NOW + 60), SEED);
        assert_eq!(gate.admit(&late, NOW).unwrap_err(), TicketFailure::Crowded);
        assert!(gate.admit(&late, NOW + 10).is_ok());
        assert_eq!(gate.spent().len(), 1);
    }
}

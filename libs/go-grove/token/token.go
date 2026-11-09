// Package token is the fleet's Ed25519 credential codec, in the one format session-token.ts signs.
package token

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
)

// The two audiences a credential is minted for. One minted for one is refused by the other, so a
// browser's 60-second join ticket is never also a write credential for the game's rows.
const (
	AudGameInstance = "game-instance"
	AudGameManager  = "game-manager"
)

// Claims is what one service asserts about the bearer and another believes.
//
// The field order is the TypeScript object literal's, and it is load bearing: the signature covers
// the encoded JSON, so a reordered struct signs a payload the other half cannot verify.
type Claims struct {
	GameID    string `json:"gameId"`
	SessionID string `json:"sessionId"`
	// Who the game will call `player.id`, on a game-instance ticket and only there. Taken from here
	// and never from a frame. A store bearer belongs to the process rather than to anyone in it.
	PlayerID string `json:"playerId,omitempty"`
	// Which service may accept this. Checked against what the verifier is, never against the URL.
	Aud string `json:"aud"`
	// Seconds since the epoch.
	Exp int64 `json:"exp"`
}

var (
	ErrMalformed     = errors.New("token is malformed")
	ErrBadSignature  = errors.New("token signature does not match")
	ErrExpired       = errors.New("token is expired")
	ErrWrongAudience = errors.New("token is for another service")
)

// Unpadded base64url is the only spelling of a key, a payload or a signature, and a decoder that
// tolerated spare bits would accept sixteen spellings of one signature.
var segment = base64.RawURLEncoding.Strict()

// ParseSigningKey reads a signer's key from the base64url of its 32-byte Ed25519 seed.
func ParseSigningKey(seed string) (ed25519.PrivateKey, error) {
	raw, ok := decode(strings.TrimSpace(seed))
	if !ok || len(raw) != ed25519.SeedSize {
		return nil, fmt.Errorf("a signing key must be %d bytes of unpadded base64url", ed25519.SeedSize)
	}
	return ed25519.NewKeyFromSeed(raw), nil
}

// ParsePublicKeys reads a verifier's comma-separated key list, which is what lets a signer rotate:
// the new key is added here first, and the old one leaves once nothing it signed is still alive.
func ParsePublicKeys(list string) ([]ed25519.PublicKey, error) {
	var keys []ed25519.PublicKey
	for _, entry := range strings.Split(list, ",") {
		raw, ok := decode(strings.TrimSpace(entry))
		if !ok || len(raw) != ed25519.PublicKeySize {
			return nil, fmt.Errorf("every public key must be %d bytes of unpadded base64url", ed25519.PublicKeySize)
		}
		keys = append(keys, ed25519.PublicKey(raw))
	}
	return keys, nil
}

// EncodeKey is the spelling ParseSigningKey and ParsePublicKeys read, for a seed or a public key.
func EncodeKey(raw []byte) string {
	return segment.EncodeToString(raw)
}

// Sign mints a credential. Only the service that owns an audience's signing key calls this.
func Sign(c Claims, key ed25519.PrivateKey) (string, error) {
	if problem := c.problem(); problem != nil {
		return "", problem
	}
	if len(key) != ed25519.PrivateKeySize {
		return "", errors.New("sign: not an Ed25519 signing key")
	}

	claims, err := encode(c)
	if err != nil {
		return "", fmt.Errorf("encode claims: %w", err)
	}

	payload := segment.EncodeToString(claims)
	return payload + "." + segment.EncodeToString(ed25519.Sign(key, []byte(payload))), nil
}

// Verify checks the signature before it parses, so a forged payload never reaches a decoder, and
// accepts one signed by any of keys.
//
// audience is required rather than defaulted: every caller knows which of the two it is, and a
// verifier that guessed would accept the other one by omission.
func Verify(tok string, keys []ed25519.PublicKey, audience string, nowUnix int64) (Claims, error) {
	// The FIRST dot, so the two segments split where the signer joined them.
	payload, signature, ok := strings.Cut(tok, ".")
	if !ok || payload == "" || signature == "" {
		return Claims{}, ErrMalformed
	}

	claims, ok := decode(payload)
	if !ok {
		return Claims{}, ErrMalformed
	}
	// A signature segment that is not base64url is a bad signature, not a bad shape, which is the
	// verdict the TypeScript and Rust halves reach too.
	provided, ok := decode(signature)
	if !ok || len(provided) != ed25519.SignatureSize || !signedByAny(keys, payload, provided) {
		return Claims{}, ErrBadSignature
	}

	var c Claims
	// Unknown fields are ignored because `z.object` strips them: a claim added on the minting side
	// must not take every verifier offline at the deploy that introduces it.
	if err := json.Unmarshal(claims, &c); err != nil || c.problem() != nil {
		return Claims{}, ErrMalformed
	}
	if c.Aud != audience {
		return c, ErrWrongAudience
	}
	if c.Exp <= nowUnix {
		return c, ErrExpired
	}
	return c, nil
}

// Bearer returns the credential from the Authorization header.
func Bearer(r *http.Request) (string, bool) {
	const scheme = "Bearer "

	header := r.Header.Get("Authorization")
	if len(header) <= len(scheme) || !strings.EqualFold(header[:len(scheme)], scheme) {
		return "", false
	}

	tok := strings.TrimSpace(header[len(scheme):])
	return tok, tok != ""
}

func signedByAny(keys []ed25519.PublicKey, payload string, signature []byte) bool {
	for _, key := range keys {
		if len(key) == ed25519.PublicKeySize && ed25519.Verify(key, []byte(payload), signature) {
			return true
		}
	}
	return false
}

// decode reads one canonical segment. The alphabet is checked first because the stdlib decoder
// skips newlines, which would make a token with one in it a second spelling of the same bytes.
func decode(s string) ([]byte, bool) {
	if s == "" {
		return nil, false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !('A' <= c && c <= 'Z' || 'a' <= c && c <= 'z' || '0' <= c && c <= '9' || c == '-' || c == '_') {
			return nil, false
		}
	}
	raw, err := segment.DecodeString(s)
	return raw, err == nil
}

// The other half parses into a schema that requires all of these; a missing one is that refusal.
func (c Claims) problem() error {
	if c.GameID == "" || c.SessionID == "" || c.Exp <= 0 {
		return ErrMalformed
	}
	// A player is exactly what separates the two: a join ticket is a claim about a person, and a
	// store bearer is one about a session.
	switch c.Aud {
	case AudGameInstance:
		if c.PlayerID == "" {
			return ErrMalformed
		}
	case AudGameManager:
		if c.PlayerID != "" {
			return ErrMalformed
		}
	default:
		return ErrMalformed
	}
	return nil
}

// The bytes the signature covers: compact JSON, in declaration order, and no trailing newline.
func encode(c Claims) ([]byte, error) {
	var buf bytes.Buffer

	enc := json.NewEncoder(&buf)
	// JSON.stringify leaves < > & alone, and the two encoders must agree byte for byte.
	enc.SetEscapeHTML(false)
	if err := enc.Encode(c); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), nil
}

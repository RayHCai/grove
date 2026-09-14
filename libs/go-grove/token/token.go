// Package token verifies and mints the join ticket exactly as libs/api-contract/src/session-token.ts
// does, because a codec written twice is a codec that drifts.
package token

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
)

// The two audiences one secret signs for. A credential minted for one is refused by the other, so a
// browser's 60-second join ticket is not also a write credential for the game's rows.
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
	// Seconds since the epoch. Short — a session outliving its token re-asks the allocator.
	Exp int64 `json:"exp"`
}

var (
	ErrMalformed     = errors.New("token is malformed")
	ErrBadSignature  = errors.New("token signature does not match")
	ErrExpired       = errors.New("token is expired")
	ErrWrongAudience = errors.New("token is for another service")
)

// Sign mints a token. The allocator is the only thing that should call this.
func Sign(c Claims, secret []byte) (string, error) {
	if problem := c.problem(); problem != nil {
		return "", problem
	}

	claims, err := encode(c)
	if err != nil {
		return "", fmt.Errorf("encode claims: %w", err)
	}

	payload := base64.RawURLEncoding.EncodeToString(claims)
	return payload + "." + base64.RawURLEncoding.EncodeToString(sign(payload, secret)), nil
}

// Verify checks the signature before it parses, so a forged payload never reaches a decoder.
//
// audience is required rather than defaulted: every caller knows which of the two it is, and a
// verifier that guessed would accept the other one by omission.
func Verify(tok string, secret []byte, audience string, nowUnix int64) (Claims, error) {
	// The FIRST dot, so a signature that somehow held another one still splits where it was joined.
	payload, signature, ok := strings.Cut(tok, ".")
	if !ok || payload == "" || signature == "" {
		return Claims{}, ErrMalformed
	}

	// A signature segment that is not base64 is a bad signature, not a bad shape — which is the
	// verdict the TypeScript and Rust halves reach too.
	provided, err := base64.RawURLEncoding.DecodeString(signature)
	if err != nil {
		return Claims{}, ErrBadSignature
	}
	if !hmac.Equal(provided, sign(payload, secret)) {
		return Claims{}, ErrBadSignature
	}

	claims, err := base64.RawURLEncoding.DecodeString(payload)
	if err != nil {
		return Claims{}, ErrMalformed
	}

	var c Claims
	// Unknown fields are ignored because `z.object` strips them: a claim added on the minting side
	// must not take every verifier offline at the deploy that introduces it.
	if err := json.Unmarshal(claims, &c); err != nil {
		return Claims{}, ErrMalformed
	}
	if c.problem() != nil {
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

func sign(payload string, secret []byte) []byte {
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(payload))
	return mac.Sum(nil)
}

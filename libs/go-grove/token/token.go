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

// Claims is what one service asserts about the bearer and another believes.
//
// The field order is the TypeScript object literal's, and it is load bearing: the signature covers
// the encoded JSON, so a reordered struct signs a payload the other half cannot verify.
type Claims struct {
	GameID    string `json:"gameId"`
	SessionID string `json:"sessionId"`
	// Who the game will call `player.id`. Taken from here and never from a frame.
	PlayerID string `json:"playerId"`
	// Seconds since the epoch. Short — a session outliving its token re-asks the allocator.
	Exp int64 `json:"exp"`
}

var (
	ErrMalformed    = errors.New("token is malformed")
	ErrBadSignature = errors.New("token signature does not match")
	ErrExpired      = errors.New("token is expired")
)

// Sign mints a token. The allocator is the only thing that should call this.
func Sign(c Claims, secret []byte) (string, error) {
	claims, err := encode(c)
	if err != nil {
		return "", fmt.Errorf("encode claims: %w", err)
	}

	payload := base64.RawURLEncoding.EncodeToString(claims)
	return payload + "." + base64.RawURLEncoding.EncodeToString(sign(payload, secret)), nil
}

// Verify checks the signature before it parses, so a forged payload never reaches a decoder.
func Verify(tok string, secret []byte, nowUnix int64) (Claims, error) {
	// The FIRST dot, so a signature that somehow held another one still splits where it was joined.
	payload, signature, ok := strings.Cut(tok, ".")
	if !ok || payload == "" || signature == "" {
		return Claims{}, ErrMalformed
	}

	// A signature segment that is not base64 is a bad signature, not a bad shape — which is the
	// verdict the TypeScript half reaches too, by decoding leniently and comparing lengths.
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
	if err := json.Unmarshal(claims, &c); err != nil {
		return Claims{}, ErrMalformed
	}
	// The other half parses into a schema that requires all four; a missing one is that refusal.
	if c.GameID == "" || c.SessionID == "" || c.PlayerID == "" || c.Exp <= 0 {
		return Claims{}, ErrMalformed
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

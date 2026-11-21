// The control credential: @grove/server-manager's signature over one call to one box.

package token

import (
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/RayHCai/grove/libs/go-grove/contract"
)

// AudInstanceManager is the only audience a control credential carries, so neither a join ticket nor
// a store bearer is ever one, and a control credential is never either of those.
const AudInstanceManager = "instance-manager"

// Control is @grove/server-manager's claim about one call, bound to its box, route and body so a box
// that read one can replay it nowhere else.
type Control struct {
	HostID string `json:"hostId"`
	Method string `json:"method"`
	// The path and query the call was sent to, exactly as the request line carries it.
	Target string `json:"target"`
	// Lowercase hex of the body's sha-256; an empty body hashes too, so a call with none is bound.
	BodySHA256 string `json:"bodySha256"`
	Aud        string `json:"aud"`
	// Seconds since the epoch.
	Exp int64 `json:"exp"`
}

// SignControl mints one control credential. Only @grove/server-manager holds a key that can.
func SignControl(c Control, key ed25519.PrivateKey) (string, error) {
	if err := c.problem(); err != nil {
		return "", err
	}
	if len(key) != ed25519.PrivateKeySize {
		return "", errors.New("sign: not an Ed25519 signing key")
	}
	claims, err := encode(c)
	if err != nil {
		return "", fmt.Errorf("encode control claims: %w", err)
	}
	return seal(claims, key), nil
}

// VerifyControl checks the signature before it parses, and the audience and expiry after. Whether the
// credential names this box and this request is the caller's to compare, since only it holds both.
func VerifyControl(tok string, keys []ed25519.PublicKey, nowUnix int64) (Control, error) {
	claims, err := open(tok, keys)
	if err != nil {
		return Control{}, err
	}
	var c Control
	if err := json.Unmarshal(claims, &c); err != nil || c.problem() != nil {
		return Control{}, ErrMalformed
	}
	if c.Exp <= nowUnix {
		return c, ErrExpired
	}
	return c, nil
}

func (c Control) problem() error {
	if c.HostID == "" || c.Method == "" || c.Target == "" || c.Exp <= 0 ||
		!contract.ValidContentHash(c.BodySHA256) {
		return ErrMalformed
	}
	if c.Aud != AudInstanceManager {
		return ErrWrongAudience
	}
	return nil
}

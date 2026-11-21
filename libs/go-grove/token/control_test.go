package token

import (
	"bytes"
	"crypto/ed25519"
	"errors"
	"strings"
	"testing"
)

var (
	router   = ed25519.NewKeyFromSeed(bytes.Repeat([]byte{4}, ed25519.SeedSize))
	impostor = ed25519.NewKeyFromSeed(bytes.Repeat([]byte{8}, ed25519.SeedSize))
)

func call(exp int64) Control {
	return Control{
		HostID:     "6f1e5a3c-0b2d-4c8e-9a71-2f3b4c5d6e70",
		Method:     "POST",
		Target:     "/v1/instances",
		BodySHA256: strings.Repeat("a", 64),
		Aud:        AudInstanceManager,
		Exp:        exp,
	}
}

func TestAControlCredentialVerifiesUnderTheRoutersKeyAlone(t *testing.T) {
	signed, err := SignControl(call(2000), router)
	if err != nil {
		t.Fatalf("SignControl: %v", err)
	}

	got, err := VerifyControl(signed, []ed25519.PublicKey{router.Public().(ed25519.PublicKey)}, 1000)
	if err != nil || got != call(2000) {
		t.Fatalf("got %+v, %v; want the claims as signed", got, err)
	}
	if _, err := VerifyControl(signed, []ed25519.PublicKey{impostor.Public().(ed25519.PublicKey)}, 1000); !errors.Is(err, ErrBadSignature) {
		t.Errorf("under another key: got %v, want %v", err, ErrBadSignature)
	}
	if _, err := VerifyControl(signed, []ed25519.PublicKey{router.Public().(ed25519.PublicKey)}, 2000); !errors.Is(err, ErrExpired) {
		t.Errorf("at its expiry: got %v, want %v", err, ErrExpired)
	}
}

// One key could sign both, but neither shape is ever the other: a store bearer commands no box, and
// a control credential reads no game's rows.
func TestAControlCredentialIsNeverABearerNorABearerOne(t *testing.T) {
	keys := []ed25519.PublicKey{router.Public().(ed25519.PublicKey)}

	control, err := SignControl(call(2000), router)
	if err != nil {
		t.Fatalf("SignControl: %v", err)
	}
	if _, err := Verify(control, keys, AudGameManager, 1000); err == nil {
		t.Error("a control credential verified as a store bearer")
	}

	bearer, err := Sign(Claims{GameID: "g", SessionID: "s", Aud: AudGameManager, Exp: 2000}, router)
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}
	if _, err := VerifyControl(bearer, keys, 1000); err == nil {
		t.Error("a store bearer verified as a control credential")
	}

	wrong := call(2000)
	wrong.Aud = AudGameInstance
	if _, err := SignControl(wrong, router); !errors.Is(err, ErrWrongAudience) {
		t.Errorf("another audience: got %v, want %v", err, ErrWrongAudience)
	}
}

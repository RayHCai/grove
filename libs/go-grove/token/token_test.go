package token

import (
	"encoding/base64"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"
)

// Signed by libs/api-contract/src/session-token.ts from exactly these claims and this secret.
//
// This is the drift test the whole package exists for: the two codecs are the same wire format
// written twice, and a change to either one's bytes must fail here rather than at a join.
const (
	vectorSecret = "grove-test-secret"
	vectorJSON   = `{"gameId":"0b3f8a5e-2c4d-4f7a-9b1e-6d5c4a3b2e10","sessionId":"7d2e1c9a-5b48-4c3d-8e7f-1a2b3c4d5e6f","playerId":"f1e2d3c4-b5a6-4978-8a9b-0c1d2e3f4a5b","exp":1893456000}`
	vectorToken  = "eyJnYW1lSWQiOiIwYjNmOGE1ZS0yYzRkLTRmN2EtOWIxZS02ZDVjNGEzYjJlMTAiLCJzZXNzaW9uSWQiOiI3ZDJlMWM5YS01YjQ4LTRjM2QtOGU3Zi0xYTJiM2M0ZDVlNmYiLCJwbGF5ZXJJZCI6ImYxZTJkM2M0LWI1YTYtNDk3OC04YTliLTBjMWQyZTNmNGE1YiIsImV4cCI6MTg5MzQ1NjAwMH0.fG8S83RLXmlPJfPjRhO3seTxroD0glxGXyC4EStbJZ8"
)

var vectorClaims = Claims{
	GameID:    "0b3f8a5e-2c4d-4f7a-9b1e-6d5c4a3b2e10",
	SessionID: "7d2e1c9a-5b48-4c3d-8e7f-1a2b3c4d5e6f",
	PlayerID:  "f1e2d3c4-b5a6-4978-8a9b-0c1d2e3f4a5b",
	Exp:       1893456000,
}

// The vector split at its dot, for the cases that tamper with one half and keep the other.
var vectorPayload, vectorSignature, _ = strings.Cut(vectorToken, ".")

// A claims set that differs from the vector's, to present under the vector's signature.
const otherExpJSON = `{"gameId":"0b3f8a5e-2c4d-4f7a-9b1e-6d5c4a3b2e10","sessionId":"7d2e1c9a-5b48-4c3d-8e7f-1a2b3c4d5e6f","playerId":"f1e2d3c4-b5a6-4978-8a9b-0c1d2e3f4a5b","exp":4102444800}`

// Changes the LEADING base64 character, a full six bits. The trailing one carries fewer bits than
// it spells, so two spellings of it decode to the same signature and tamper with nothing.
func swapLead(s string) string {
	if s[0] == 'a' {
		return "b" + s[1:]
	}
	return "a" + s[1:]
}

func TestSignMatchesTypeScript(t *testing.T) {
	got, err := Sign(vectorClaims, []byte(vectorSecret))
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}
	if got != vectorToken {
		t.Errorf("token drifted from the TypeScript codec\n got: %s\nwant: %s", got, vectorToken)
	}
}

// The rules the vector encodes, pinned one at a time so a failure says which one moved.
func TestEncodingRules(t *testing.T) {
	tok, err := Sign(vectorClaims, []byte(vectorSecret))
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}

	if strings.Contains(tok, "=") {
		t.Errorf("base64url is unpadded, got %q", tok)
	}
	if n := strings.Count(tok, "."); n != 1 {
		t.Errorf("token joins two segments, got %d dots in %q", n, tok)
	}

	payload, _, _ := strings.Cut(tok, ".")
	claims, err := base64.RawURLEncoding.DecodeString(payload)
	if err != nil {
		t.Fatalf("payload is not unpadded base64url: %v", err)
	}
	if string(claims) != vectorJSON {
		t.Errorf("signed bytes are not the compact JSON in declaration order\n got: %s\nwant: %s",
			claims, vectorJSON)
	}
}

func TestVerifyAcceptsTheVector(t *testing.T) {
	got, err := Verify(vectorToken, []byte(vectorSecret), vectorClaims.Exp-1)
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if got != vectorClaims {
		t.Errorf("claims round-tripped wrong\n got: %+v\nwant: %+v", got, vectorClaims)
	}
}

func TestRoundTrip(t *testing.T) {
	secret := []byte("a-secret-long-enough-to-be-one")

	tok, err := Sign(vectorClaims, secret)
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}
	got, err := Verify(tok, secret, 0)
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if got != vectorClaims {
		t.Errorf("got %+v, want %+v", got, vectorClaims)
	}
}

func TestVerifyRejects(t *testing.T) {
	// Signs whatever payload is given, so a malformed one still reaches the checks past the hmac.
	mint := func(payload string) string {
		return payload + "." + base64.RawURLEncoding.EncodeToString(sign(payload, []byte(vectorSecret)))
	}
	b64 := func(s string) string {
		return base64.RawURLEncoding.EncodeToString([]byte(s))
	}

	tests := []struct {
		name  string
		token string
		now   int64
		want  error
	}{
		{"no dot", "notatoken", 0, ErrMalformed},
		{"empty payload", ".c2ln", 0, ErrMalformed},
		{"empty signature", b64(vectorJSON) + ".", 0, ErrMalformed},
		{"signature is not base64", b64(vectorJSON) + ".!!!!", 0, ErrBadSignature},
		{"signature is another secret's", vectorPayload + "." + swapLead(vectorSignature), 0, ErrBadSignature},
		{"payload edited after signing", b64(otherExpJSON) + "." + vectorSignature, 0, ErrBadSignature},
		{"payload is not base64", mint("!!!!"), 0, ErrMalformed},
		{"payload is not json", mint(b64("not json")), 0, ErrMalformed},
		{"playerId is missing", mint(b64(`{"gameId":"g","sessionId":"s","exp":9}`)), 0, ErrMalformed},
		{"exp is missing", mint(b64(`{"gameId":"g","sessionId":"s","playerId":"p"}`)), 0, ErrMalformed},
		{"exp has passed", vectorToken, vectorClaims.Exp + 1, ErrExpired},
		{"exp is now", vectorToken, vectorClaims.Exp, ErrExpired},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := Verify(tt.token, []byte(vectorSecret), tt.now)
			if !errors.Is(err, tt.want) {
				t.Errorf("got %v, want %v", err, tt.want)
			}
		})
	}
}

func TestVerifyRejectsTheWrongSecret(t *testing.T) {
	if _, err := Verify(vectorToken, []byte("not-the-secret"), 0); !errors.Is(err, ErrBadSignature) {
		t.Errorf("got %v, want %v", err, ErrBadSignature)
	}
}

func TestBearer(t *testing.T) {
	tests := []struct {
		name   string
		header string
		want   string
		wantOK bool
	}{
		{"bearer", "Bearer abc123", "abc123", true},
		{"scheme is case-insensitive", "bearer abc123", "abc123", true},
		{"padded", "Bearer   abc123  ", "abc123", true},
		{"absent", "", "", false},
		{"another scheme", "Basic abc123", "", false},
		{"scheme with no credential", "Bearer ", "", false},
		{"only whitespace", "Bearer    ", "", false},
		{"bare credential", "abc123", "", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := httptest.NewRequest("GET", "/", nil)
			if tt.header != "" {
				r.Header.Set("Authorization", tt.header)
			}

			got, ok := Bearer(r)
			if got != tt.want || ok != tt.wantOK {
				t.Errorf("got (%q, %v), want (%q, %v)", got, ok, tt.want, tt.wantOK)
			}
		})
	}
}

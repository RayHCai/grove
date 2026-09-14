package token

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

// The vector libs/api-contract/src/session-token.ts actually produced, read from the file the Rust
// verifier reads too.
//
// This is the drift test the whole package exists for: three codecs are one wire format written
// three times, and a change to any one's bytes must fail here rather than at a join.
const vectorFile = "../../api-contract/fixtures/session-token.json"

type vectorCase struct {
	Claims  Claims `json:"claims"`
	Payload string `json:"payload"`
	Token   string `json:"token"`
}

type vectorSet struct {
	Secret      string     `json:"secret"`
	Ticket      vectorCase `json:"ticket"`
	StoreBearer vectorCase `json:"storeBearer"`
	Another     vectorCase `json:"anotherTicketByTheSameSigner"`
}

func vectors(t *testing.T) vectorSet {
	t.Helper()

	raw, err := os.ReadFile(vectorFile)
	if err != nil {
		t.Fatalf("read vector: %v", err)
	}
	var set vectorSet
	if err := json.Unmarshal(raw, &set); err != nil {
		t.Fatalf("decode vector: %v", err)
	}
	return set
}

// Changes the LEADING base64 character, a full six bits. The trailing one carries fewer bits than
// it spells, so two spellings of it decode to the same signature and tamper with nothing.
func swapLead(s string) string {
	if s[0] == 'a' {
		return "b" + s[1:]
	}
	return "a" + s[1:]
}

func TestSignMatchesTypeScript(t *testing.T) {
	set := vectors(t)

	for _, tt := range []struct {
		name string
		vec  vectorCase
	}{{"join ticket", set.Ticket}, {"store bearer", set.StoreBearer}} {
		t.Run(tt.name, func(t *testing.T) {
			got, err := Sign(tt.vec.Claims, []byte(set.Secret))
			if err != nil {
				t.Fatalf("Sign: %v", err)
			}
			if got != tt.vec.Token {
				t.Errorf("token drifted from the TypeScript codec\n got: %s\nwant: %s", got, tt.vec.Token)
			}
		})
	}
}

// The rules the vector encodes, pinned one at a time so a failure says which one moved.
func TestEncodingRules(t *testing.T) {
	set := vectors(t)

	tok, err := Sign(set.Ticket.Claims, []byte(set.Secret))
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
	if string(claims) != set.Ticket.Payload {
		t.Errorf("signed bytes are not the compact JSON in declaration order\n got: %s\nwant: %s",
			claims, set.Ticket.Payload)
	}
}

// A store bearer omits playerId rather than writing it empty, which is what keeps one signer's two
// payloads decodable by one struct in every language.
func TestStoreBearerOmitsThePlayer(t *testing.T) {
	set := vectors(t)

	payload, _, _ := strings.Cut(set.StoreBearer.Token, ".")
	claims, err := base64.RawURLEncoding.DecodeString(payload)
	if err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	if strings.Contains(string(claims), "playerId") {
		t.Errorf("store bearer carries a player: %s", claims)
	}
}

func TestVerifyAcceptsTheVector(t *testing.T) {
	set := vectors(t)

	for _, tt := range []struct {
		name     string
		vec      vectorCase
		audience string
	}{
		{"join ticket", set.Ticket, AudGameInstance},
		{"store bearer", set.StoreBearer, AudGameManager},
	} {
		t.Run(tt.name, func(t *testing.T) {
			got, err := Verify(tt.vec.Token, []byte(set.Secret), tt.audience, tt.vec.Claims.Exp-1)
			if err != nil {
				t.Fatalf("Verify: %v", err)
			}
			if got != tt.vec.Claims {
				t.Errorf("claims round-tripped wrong\n got: %+v\nwant: %+v", got, tt.vec.Claims)
			}
		})
	}
}

// The escalation the audience exists to stop: a browser's join ticket is not a store credential.
func TestVerifyRefusesTheOtherAudience(t *testing.T) {
	set := vectors(t)

	if _, err := Verify(set.Ticket.Token, []byte(set.Secret), AudGameManager, 0); !errors.Is(err, ErrWrongAudience) {
		t.Errorf("a join ticket reached the store: got %v", err)
	}
	if _, err := Verify(set.StoreBearer.Token, []byte(set.Secret), AudGameInstance, 0); !errors.Is(err, ErrWrongAudience) {
		t.Errorf("a store bearer reached a game process: got %v", err)
	}
}

func TestRoundTrip(t *testing.T) {
	set := vectors(t)
	secret := []byte("a-secret-long-enough-to-be-one")

	tok, err := Sign(set.Ticket.Claims, secret)
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}
	got, err := Verify(tok, secret, AudGameInstance, 0)
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if got != set.Ticket.Claims {
		t.Errorf("got %+v, want %+v", got, set.Ticket.Claims)
	}
}

// A claim added on the minting side must not take every verifier offline at the deploy that adds it.
func TestVerifyIgnoresAnUnknownClaim(t *testing.T) {
	set := vectors(t)

	widened := strings.Replace(set.Ticket.Payload, "{", `{"region":"us-east-1",`, 1)
	payload := base64.RawURLEncoding.EncodeToString([]byte(widened))
	tok := payload + "." + base64.RawURLEncoding.EncodeToString(sign(payload, []byte(set.Secret)))

	if _, err := Verify(tok, []byte(set.Secret), AudGameInstance, 0); err != nil {
		t.Errorf("a newer claim set was refused: %v", err)
	}
}

func TestVerifyRejects(t *testing.T) {
	set := vectors(t)

	// Signs whatever payload is given, so a malformed one still reaches the checks past the hmac.
	mint := func(payload string) string {
		return payload + "." + base64.RawURLEncoding.EncodeToString(sign(payload, []byte(set.Secret)))
	}
	b64 := func(s string) string {
		return base64.RawURLEncoding.EncodeToString([]byte(s))
	}
	payload, signature, _ := strings.Cut(set.Ticket.Token, ".")
	otherPayload, _, _ := strings.Cut(set.Another.Token, ".")

	tests := []struct {
		name  string
		token string
		now   int64
		want  error
	}{
		{"no dot", "notatoken", 0, ErrMalformed},
		{"empty payload", ".c2ln", 0, ErrMalformed},
		{"empty signature", b64(set.Ticket.Payload) + ".", 0, ErrMalformed},
		{"signature is not base64", b64(set.Ticket.Payload) + ".!!!!", 0, ErrBadSignature},
		{"signature is another secret's", payload + "." + swapLead(signature), 0, ErrBadSignature},
		{"payload edited after signing", otherPayload + "." + signature, 0, ErrBadSignature},
		{"payload is not base64", mint("!!!!"), 0, ErrMalformed},
		{"payload is not json", mint(b64("not json")), 0, ErrMalformed},
		{"no audience", mint(b64(`{"gameId":"g","sessionId":"s","playerId":"p","exp":9}`)), 0, ErrMalformed},
		{"an audience nothing serves", mint(b64(`{"gameId":"g","sessionId":"s","playerId":"p","aud":"editor","exp":9}`)), 0, ErrMalformed},
		{"a ticket with no player", mint(b64(`{"gameId":"g","sessionId":"s","aud":"game-instance","exp":9}`)), 0, ErrMalformed},
		{"a store bearer naming a player", mint(b64(`{"gameId":"g","sessionId":"s","playerId":"p","aud":"game-manager","exp":9}`)), 0, ErrMalformed},
		{"exp is missing", mint(b64(`{"gameId":"g","sessionId":"s","playerId":"p","aud":"game-instance"}`)), 0, ErrMalformed},
		{"exp has passed", set.Ticket.Token, set.Ticket.Claims.Exp + 1, ErrExpired},
		{"exp is now", set.Ticket.Token, set.Ticket.Claims.Exp, ErrExpired},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := Verify(tt.token, []byte(set.Secret), AudGameInstance, tt.now)
			if !errors.Is(err, tt.want) {
				t.Errorf("got %v, want %v", err, tt.want)
			}
		})
	}
}

func TestSignRefusesAClaimSetNoVerifierWouldTake(t *testing.T) {
	set := vectors(t)

	bad := set.Ticket.Claims
	bad.PlayerID = ""
	if _, err := Sign(bad, []byte(set.Secret)); !errors.Is(err, ErrMalformed) {
		t.Errorf("signed a ticket with no player: %v", err)
	}
}

func TestVerifyRejectsTheWrongSecret(t *testing.T) {
	set := vectors(t)

	_, err := Verify(set.Ticket.Token, []byte("not-the-secret"), AudGameInstance, 0)
	if !errors.Is(err, ErrBadSignature) {
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

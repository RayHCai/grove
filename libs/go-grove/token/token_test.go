package token

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

// Minted by node:crypto rather than by this package, so a vector this codec reproduces is one an
// independent Ed25519 signer agrees with.
const storeVectors = "testdata/store-bearer.json"

// The join-ticket vectors libs/api-contract signs and the Rust verifier reads, which pin this
// codec's format to the TypeScript one byte for byte.
const ticketVectors = "../../api-contract/fixtures/session-token.json"

type vector struct {
	Name   string `json:"name"`
	Token  string `json:"token"`
	Expect string `json:"expect"`
	Claims Claims `json:"claims"`
}

type storeSet struct {
	Seed           string   `json:"seed"`
	PublicKey      string   `json:"publicKey"`
	OtherSeed      string   `json:"otherSeed"`
	OtherPublicKey string   `json:"otherPublicKey"`
	Now            int64    `json:"now"`
	Vectors        []vector `json:"vectors"`
}

type ticketSet struct {
	Ticket struct {
		Seed      string   `json:"seed"`
		PublicKey string   `json:"publicKey"`
		Now       int64    `json:"now"`
		Vectors   []vector `json:"vectors"`
	} `json:"ticket"`
}

func read[T any](t *testing.T, path string) T {
	t.Helper()

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var set T
	if err := json.Unmarshal(raw, &set); err != nil {
		t.Fatalf("decode %s: %v", path, err)
	}
	return set
}

func signer(t *testing.T, seed string) ed25519.PrivateKey {
	t.Helper()

	key, err := ParseSigningKey(seed)
	if err != nil {
		t.Fatalf("ParseSigningKey: %v", err)
	}
	return key
}

func verifier(t *testing.T, list string) []ed25519.PublicKey {
	t.Helper()

	keys, err := ParsePublicKeys(list)
	if err != nil {
		t.Fatalf("ParsePublicKeys: %v", err)
	}
	return keys
}

func verdictOf(err error) string {
	switch {
	case err == nil:
		return "ok"
	case errors.Is(err, ErrMalformed):
		return "malformed"
	case errors.Is(err, ErrBadSignature):
		return "bad_signature"
	case errors.Is(err, ErrExpired):
		return "expired"
	case errors.Is(err, ErrWrongAudience):
		return "wrong_audience"
	}
	return err.Error()
}

func TestSignMatchesAnIndependentSigner(t *testing.T) {
	set := read[storeSet](t, storeVectors)
	first := set.Vectors[0]

	got, err := Sign(first.Claims, signer(t, set.Seed))
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}
	if got != first.Token {
		t.Errorf("token drifted from node:crypto's\n got: %s\nwant: %s", got, first.Token)
	}
}

func TestVerifyReachesEveryStoreVectorsVerdict(t *testing.T) {
	set := read[storeSet](t, storeVectors)
	keys := verifier(t, set.PublicKey)

	for _, v := range set.Vectors {
		t.Run(v.Name, func(t *testing.T) {
			got, err := Verify(v.Token, keys, AudGameManager, set.Now)
			if verdict := verdictOf(err); verdict != v.Expect {
				t.Fatalf("verdict: got %s, want %s", verdict, v.Expect)
			}
			if v.Expect == "ok" && v.Claims.GameID != "" && got != v.Claims {
				t.Errorf("claims: got %+v, want %+v", got, v.Claims)
			}
		})
	}
}

// The join ticket is the api's to mint, but its format is this one, so the TypeScript signer's own
// output is what this codec must produce and accept.
func TestTheTicketFormatIsTheTypeScriptOne(t *testing.T) {
	set := read[ticketSet](t, ticketVectors).Ticket
	key := signer(t, set.Seed)
	keys := verifier(t, set.PublicKey)

	if got := EncodeKey(key.Public().(ed25519.PublicKey)); got != set.PublicKey {
		t.Fatalf("public key: got %s, want %s", got, set.PublicKey)
	}
	for _, v := range set.Vectors {
		t.Run(v.Name, func(t *testing.T) {
			_, err := Verify(v.Token, keys, AudGameInstance, set.Now)
			if verdict := verdictOf(err); verdict != v.Expect {
				t.Fatalf("verdict: got %s, want %s", verdict, v.Expect)
			}
			if v.Expect != "ok" && v.Expect != "expired" {
				return
			}
			minted, err := Sign(v.Claims, key)
			if err != nil {
				t.Fatalf("Sign: %v", err)
			}
			if minted != v.Token {
				t.Errorf("token drifted from session-token.ts\n got: %s\nwant: %s", minted, v.Token)
			}
		})
	}
}

// Rotation: a verifier holds the incoming key beside the outgoing one, and either signature passes.
func TestVerifyAcceptsAnyConfiguredKey(t *testing.T) {
	set := read[storeSet](t, storeVectors)
	byOther, err := Sign(set.Vectors[0].Claims, signer(t, set.OtherSeed))
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}

	tests := []struct {
		name string
		keys string
		want string
	}{
		{"the incoming key listed first", set.OtherPublicKey + "," + set.PublicKey, "ok"},
		{"the incoming key listed last", set.PublicKey + ", " + set.OtherPublicKey, "ok"},
		{"only the outgoing key", set.PublicKey, "bad_signature"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := Verify(byOther, verifier(t, tt.keys), AudGameManager, set.Now)
			if verdict := verdictOf(err); verdict != tt.want {
				t.Errorf("verdict: got %s, want %s", verdict, tt.want)
			}
		})
	}

	if _, err := Verify(byOther, nil, AudGameManager, set.Now); !errors.Is(err, ErrBadSignature) {
		t.Errorf("a verifier holding no key: got %v, want %v", err, ErrBadSignature)
	}
}

func TestKeysAreReadInOneSpelling(t *testing.T) {
	set := read[storeSet](t, storeVectors)

	seeds := []struct {
		name string
		seed string
		ok   bool
	}{
		{"a seed", set.Seed, true},
		{"a seed with a trailing newline, as a file holds one", set.Seed + "\n", true},
		{"padded", set.Seed + "=", false},
		{"standard base64", strings.NewReplacer("-", "+", "_", "/").Replace(set.Seed), !strings.ContainsAny(set.Seed, "-_")},
		{"too short", set.Seed[:40], false},
		{"a public key's length but not a seed", set.Seed + "AA", false},
		{"empty", "", false},
	}
	for _, tt := range seeds {
		t.Run("seed: "+tt.name, func(t *testing.T) {
			if _, err := ParseSigningKey(tt.seed); (err == nil) != tt.ok {
				t.Errorf("got %v, want ok %t", err, tt.ok)
			}
		})
	}

	lists := []struct {
		name string
		list string
		keys int
	}{
		{"one key", set.PublicKey, 1},
		{"two keys", set.PublicKey + "," + set.OtherPublicKey, 2},
		{"an empty list", "", 0},
		{"a blank entry", set.PublicKey + ",", 0},
		{"a key with a newline inside it", set.PublicKey[:20] + "\n" + set.PublicKey[20:], 0},
	}
	for _, tt := range lists {
		t.Run("list: "+tt.name, func(t *testing.T) {
			keys, err := ParsePublicKeys(tt.list)
			if tt.keys == 0 && err == nil {
				t.Fatalf("got %d keys, want the list refused", len(keys))
			}
			if tt.keys > 0 && (err != nil || len(keys) != tt.keys) {
				t.Fatalf("got %d keys and %v, want %d", len(keys), err, tt.keys)
			}
		})
	}
}

// The rules the vectors encode, pinned one at a time so a failure says which one moved.
func TestEncodingRules(t *testing.T) {
	set := read[storeSet](t, storeVectors)
	tok, err := Sign(set.Vectors[0].Claims, signer(t, set.Seed))
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
	want := `{"gameId":"0b3f8a5e-2c4d-4f7a-9b1e-6d5c4a3b2e10","sessionId":"7d2e1c9a-5b48-4c3d-8e7f-1a2b3c4d5e6f","aud":"game-manager","exp":1800043200}`
	if string(claims) != want {
		t.Errorf("signed bytes are not the compact JSON in declaration order\n got: %s\nwant: %s", claims, want)
	}
}

// A claim added on the minting side must not take every verifier offline at the deploy that adds it.
func TestVerifyIgnoresAnUnknownClaim(t *testing.T) {
	set := read[storeSet](t, storeVectors)
	key := signer(t, set.Seed)

	widened := `{"region":"us-east-1","gameId":"g","sessionId":"s","aud":"game-manager","exp":1900000000}`
	payload := base64.RawURLEncoding.EncodeToString([]byte(widened))
	tok := payload + "." + base64.RawURLEncoding.EncodeToString(ed25519.Sign(key, []byte(payload)))

	if _, err := Verify(tok, verifier(t, set.PublicKey), AudGameManager, set.Now); err != nil {
		t.Errorf("a newer claim set was refused: %v", err)
	}
}

func TestSignRefusesWhatNoVerifierWouldTake(t *testing.T) {
	set := read[storeSet](t, storeVectors)
	key := signer(t, set.Seed)

	tests := []struct {
		name   string
		claims Claims
	}{
		{"a store bearer naming a player", Claims{GameID: "g", SessionID: "s", PlayerID: "p", Aud: AudGameManager, Exp: 9}},
		{"a ticket naming nobody", Claims{GameID: "g", SessionID: "s", Aud: AudGameInstance, Exp: 9}},
		{"an audience nothing serves", Claims{GameID: "g", SessionID: "s", Aud: "game-manager-admin", Exp: 9}},
		{"no expiry", Claims{GameID: "g", SessionID: "s", Aud: AudGameManager}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := Sign(tt.claims, key); !errors.Is(err, ErrMalformed) {
				t.Errorf("got %v, want %v", err, ErrMalformed)
			}
		})
	}

	if _, err := Sign(set.Vectors[0].Claims, nil); err == nil {
		t.Error("signed with no key")
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

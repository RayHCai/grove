package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/RayHCai/grove/apps/grove/game-manager/internal/store"
	"github.com/RayHCai/grove/libs/go-grove/contract"
	"github.com/RayHCai/grove/libs/go-grove/httpx"
	"github.com/RayHCai/grove/libs/go-grove/token"
)

const (
	secret      = "a-thirty-two-byte-signing-secret"
	otherSecret = "a-different-thirty-two-byte-secret"

	gameA = "3f2504e0-4f89-41d3-9a0c-0305e82c3301"
	gameB = "9c858901-8a57-4791-81fe-4c455b099bc9"
	gameC = "6ba7b810-9dad-41d1-80b4-00c04fd430c8"
)

func TestHealthAnswersWithoutAToken(t *testing.T) {
	_, handler := newServer()

	res := request(t, handler, http.MethodGet, "/health", "", "")

	if res.Code != http.StatusOK {
		t.Fatalf("status: got %d, want %d", res.Code, http.StatusOK)
	}
	if got := strings.TrimSpace(res.Body.String()); got != `{"ok":true}` {
		t.Fatalf("body: got %s", got)
	}
}

func TestReadyAnswersWithoutAToken(t *testing.T) {
	_, handler := newServer()

	res := request(t, handler, http.MethodGet, "/ready", "", "")

	if res.Code != http.StatusOK {
		t.Fatalf("status: got %d, want %d", res.Code, http.StatusOK)
	}
	if got := strings.TrimSpace(res.Body.String()); got != `{"ok":true}` {
		t.Fatalf("body: got %s", got)
	}
}

func TestReadyRefusesWhileTheStoreDoesNotAnswer(t *testing.T) {
	handler := New(unreachableStore{store.NewMemory()}, []byte(secret),
		slog.New(slog.NewTextHandler(io.Discard, nil)))

	res := request(t, handler, http.MethodGet, "/ready", "", "")

	if res.Code != http.StatusServiceUnavailable {
		t.Fatalf("status: got %d, want %d", res.Code, http.StatusServiceUnavailable)
	}
	expectCode(t, res, httpx.CodeInternal)
}

func TestAnAnswerEchoesTheIDTheCallerBrought(t *testing.T) {
	const brought = "1e1b6f0e-7c9a-4a6b-9f4c-9f1a2b3c4d5e"

	_, handler := newServer()

	res := answerPresenting(t, handler, brought)

	if got := res.Header().Get(contract.RequestIDHeader); got != brought {
		t.Fatalf("echo: got %q, want %q", got, brought)
	}
}

// The id is logged, echoed and forwarded, so one this service would not have minted is replaced.
func TestAnAnswerMintsTheIDTheCallerDidNot(t *testing.T) {
	_, handler := newServer()

	cases := []struct {
		name      string
		presented string
	}{
		{
			name: "no id at all",
		},
		{
			name:      "an id that is not one grep token",
			presented: "../../etc/passwd",
		},
		{
			name:      "an id past the bound",
			presented: strings.Repeat("a", contract.RequestIDMaxLen+1),
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			res := answerPresenting(t, handler, c.presented)

			if got := res.Header().Get(contract.RequestIDHeader); !contract.ValidUUID(got) {
				t.Fatalf("id: got %q, want one this service minted", got)
			}
		})
	}
}

func TestScopeAdmitsOnlyAVerifiedToken(t *testing.T) {
	memory, handler := newServer()
	seedState(t, memory, gameA, "score", `{"points":7}`)

	cases := []struct {
		name   string
		bearer string
		status int
		code   httpx.ErrorCode
	}{
		{
			name:   "no token at all",
			status: http.StatusUnauthorized,
			code:   httpx.CodeUnauthorized,
		},
		{
			name:   "gibberish where a token goes",
			bearer: "not-a-token",
			status: http.StatusUnauthorized,
			code:   httpx.CodeUnauthorized,
		},
		{
			name:   "a token this service did not sign",
			bearer: signWith(t, gameA, otherSecret, time.Hour),
			status: http.StatusUnauthorized,
			code:   httpx.CodeUnauthorized,
		},
		{
			name:   "a token past its exp",
			bearer: signWith(t, gameA, secret, -time.Minute),
			status: http.StatusUnauthorized,
			code:   httpx.CodeUnauthorized,
		},
		{
			name:   "a token the allocator signed",
			bearer: ticket(t, gameA),
			status: http.StatusOK,
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			res := request(t, handler, http.MethodGet, "/v1/state/score", c.bearer, "")

			if res.Code != c.status {
				t.Fatalf("status: got %d, want %d", res.Code, c.status)
			}
			if c.status != http.StatusOK {
				expectCode(t, res, c.code)
			}
		})
	}
}

func TestATokenReachesOnlyItsOwnGame(t *testing.T) {
	memory, handler := newServer()
	seedState(t, memory, gameA, "score", `{"points":1}`)
	seedState(t, memory, gameB, "score", `{"points":2}`)

	held := decodeAs[contract.StateRecord](
		t, request(t, handler, http.MethodGet, "/v1/state/score", ticket(t, gameB), ""),
	)
	if got := string(held.Value); got != `{"points":2}` {
		t.Fatalf("value: got %s, want the row of the game the token named", got)
	}

	// A key one game holds is not a key another game has, so the answer is a 404 rather than a
	// neighbouring game's row.
	missing := request(t, handler, http.MethodGet, "/v1/state/score", ticket(t, gameC), "")
	if missing.Code != http.StatusNotFound {
		t.Fatalf("status: got %d, want %d", missing.Code, http.StatusNotFound)
	}
	expectCode(t, missing, httpx.CodeNotFound)

	body := `{"value":{"points":9}}`
	if res := request(t, handler, http.MethodPut, "/v1/state/score", ticket(t, gameB), body); res.Code != http.StatusOK {
		t.Fatalf("status: got %d, want %d", res.Code, http.StatusOK)
	}

	untouched := decodeAs[contract.StateRecord](
		t, request(t, handler, http.MethodGet, "/v1/state/score", ticket(t, gameA), ""),
	)
	if got := string(untouched.Value); got != `{"points":1}` {
		t.Fatalf("value: got %s, want a write by one game to leave another alone", got)
	}
	if untouched.Revision != 1 {
		t.Fatalf("revision: got %d, want 1", untouched.Revision)
	}
}

func TestCompareAndSetRefusesAStaleRevision(t *testing.T) {
	_, handler := newServer()
	bearer := ticket(t, gameA)

	cases := []struct {
		name     string
		key      string
		body     string
		status   int
		code     httpx.ErrorCode
		revision int64
	}{
		{
			name:     "a blind first write",
			key:      "score",
			body:     `{"value":{"points":1}}`,
			status:   http.StatusOK,
			revision: 1,
		},
		{
			name:     "a compare-and-set against where the key is",
			key:      "score",
			body:     `{"value":{"points":2},"ifRevision":1}`,
			status:   http.StatusOK,
			revision: 2,
		},
		{
			name:   "a compare-and-set against where the key was",
			key:    "score",
			body:   `{"value":{"points":3},"ifRevision":1}`,
			status: http.StatusConflict,
			code:   httpx.CodeConflict,
		},
		{
			name:   "a first write to a key that already exists",
			key:    "score",
			body:   `{"value":{"points":4},"ifRevision":0}`,
			status: http.StatusConflict,
			code:   httpx.CodeConflict,
		},
		{
			name:     "a first write to a key that does not",
			key:      "seed",
			body:     `{"value":true,"ifRevision":0}`,
			status:   http.StatusOK,
			revision: 1,
		},
		{
			name:   "a write carrying no value",
			key:    "score",
			body:   `{"ifRevision":2}`,
			status: http.StatusBadRequest,
			code:   httpx.CodeInvalidRequest,
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			res := request(t, handler, http.MethodPut, "/v1/state/"+c.key, bearer, c.body)

			if res.Code != c.status {
				t.Fatalf("status: got %d, want %d", res.Code, c.status)
			}
			if c.status != http.StatusOK {
				expectCode(t, res, c.code)
				return
			}
			if got := decodeAs[written](t, res).Revision; got != c.revision {
				t.Fatalf("revision: got %d, want %d", got, c.revision)
			}
		})
	}

	// A refused write is refused rather than deferred: the key still holds what the accepted one
	// left, at the revision that write landed on.
	final := decodeAs[contract.StateRecord](
		t, request(t, handler, http.MethodGet, "/v1/state/score", bearer, ""),
	)
	if string(final.Value) != `{"points":2}` || final.Revision != 2 {
		t.Fatalf("state: got %s at revision %d", final.Value, final.Revision)
	}
}

func TestLeaderboardClampsItsLimit(t *testing.T) {
	const players = 150

	memory, handler := newServer()
	for i := range players {
		memory.PutScore(gameA, "high", contract.LeaderboardEntry{
			PlayerID:    fmt.Sprintf("00000000-0000-4000-8000-%012d", i),
			DisplayName: fmt.Sprintf("player %d", i),
			Score:       float64(i),
		})
	}

	cases := []struct {
		name    string
		query   string
		status  int
		code    httpx.ErrorCode
		entries int
	}{
		{
			name:    "no limit takes the default",
			query:   "board=high",
			status:  http.StatusOK,
			entries: contract.LeaderboardLimitDefault,
		},
		{
			name:    "a limit inside the range is honoured",
			query:   "board=high&limit=10",
			status:  http.StatusOK,
			entries: 10,
		},
		{
			name:    "a limit past the page cap",
			query:   "board=high&limit=500",
			status:  http.StatusOK,
			entries: contract.LeaderboardLimitMax,
		},
		{
			name:    "a limit below one row",
			query:   "board=high&limit=0",
			status:  http.StatusOK,
			entries: 1,
		},
		{
			name:    "a negative limit",
			query:   "board=high&limit=-5",
			status:  http.StatusOK,
			entries: 1,
		},
		{
			name:    "a board nobody has played",
			query:   "board=quiet",
			status:  http.StatusOK,
			entries: 0,
		},
		{
			name:   "a limit that is not a number",
			query:  "board=high&limit=lots",
			status: http.StatusBadRequest,
			code:   httpx.CodeInvalidRequest,
		},
		{
			name:   "a cursor this board never issued",
			query:  "board=high&cursor=later",
			status: http.StatusBadRequest,
			code:   httpx.CodeInvalidRequest,
		},
		{
			name:   "no board named",
			query:  "",
			status: http.StatusBadRequest,
			code:   httpx.CodeInvalidRequest,
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			res := request(t, handler, http.MethodGet, "/v1/leaderboard?"+c.query, ticket(t, gameA), "")

			if res.Code != c.status {
				t.Fatalf("status: got %d, want %d", res.Code, c.status)
			}
			if c.status != http.StatusOK {
				expectCode(t, res, c.code)
				return
			}

			page := decodeAs[contract.LeaderboardPage](t, res)
			if len(page.Entries) != c.entries {
				t.Fatalf("entries: got %d, want %d", len(page.Entries), c.entries)
			}
			if c.entries == 0 {
				if page.NextCursor != nil {
					t.Fatalf("nextCursor: got %q, want null at the end of a board", *page.NextCursor)
				}
				return
			}

			// The highest score is rank one, and a page short of the board carries the cursor that
			// reaches the rest of it.
			if page.Entries[0].Rank != 1 || page.Entries[0].Score != players-1 {
				t.Fatalf("first row: rank %d, score %v", page.Entries[0].Rank, page.Entries[0].Score)
			}
			if page.NextCursor == nil {
				t.Fatal("nextCursor: got null, want the offset of the next page")
			}
		})
	}
}

func TestBundlesAnswerOnceAGameHasPublished(t *testing.T) {
	memory, handler := newServer()
	published := contract.BundleSet{
		Server: contract.BundleRef{
			Side:       contract.SideServer,
			Hash:       strings.Repeat("a", 64),
			URL:        "https://objects.grove.test/a",
			ByteLength: 2048,
		},
		Client: contract.BundleRef{
			Side:       contract.SideClient,
			Hash:       strings.Repeat("b", 64),
			URL:        "https://objects.grove.test/b",
			ByteLength: 4096,
		},
		SyncedHash: strings.Repeat("c", 64),
	}
	memory.PutBundles(gameA, published)

	never := request(t, handler, http.MethodGet, "/v1/bundles", ticket(t, gameB), "")
	if never.Code != http.StatusNotFound {
		t.Fatalf("status: got %d, want %d", never.Code, http.StatusNotFound)
	}
	expectCode(t, never, httpx.CodeNotFound)

	got := decodeAs[contract.BundleSet](
		t, request(t, handler, http.MethodGet, "/v1/bundles", ticket(t, gameA), ""),
	)
	if got != published {
		t.Fatalf("bundles: got %+v, want %+v", got, published)
	}
}

func newServer() (*store.Memory, http.Handler) {
	memory := store.NewMemory()
	return memory, New(memory, []byte(secret), slog.New(slog.NewTextHandler(io.Discard, nil)))
}

// What a database-backed store is while it is still connecting.
type unreachableStore struct {
	*store.Memory
}

func (unreachableStore) Ping(context.Context) error { return errors.New("still dialing") }

func answerPresenting(t *testing.T, h http.Handler, requestID string) *httptest.ResponseRecorder {
	t.Helper()

	r := httptest.NewRequest(http.MethodGet, "/health", nil)
	if requestID != "" {
		r.Header.Set(contract.RequestIDHeader, requestID)
	}

	res := httptest.NewRecorder()
	h.ServeHTTP(res, r)
	return res
}

func request(t *testing.T, h http.Handler, method, target, bearer, body string) *httptest.ResponseRecorder {
	t.Helper()

	var payload io.Reader
	if body != "" {
		payload = strings.NewReader(body)
	}

	r := httptest.NewRequest(method, target, payload)
	if bearer != "" {
		r.Header.Set("Authorization", "Bearer "+bearer)
	}

	res := httptest.NewRecorder()
	h.ServeHTTP(res, r)
	return res
}

func ticket(t *testing.T, game string) string {
	t.Helper()
	return signWith(t, game, secret, time.Hour)
}

func signWith(t *testing.T, game, key string, life time.Duration) string {
	t.Helper()

	signed, err := token.Sign(token.Claims{
		GameID:    game,
		SessionID: "1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d",
		PlayerID:  "7f8e9d0c-1b2a-4c3d-8e5f-6a7b8c9d0e1f",
		Exp:       time.Now().Add(life).Unix(),
	}, []byte(key))
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return signed
}

func seedState(t *testing.T, memory *store.Memory, game, key, value string) {
	t.Helper()

	write := contract.StateWrite{Value: json.RawMessage(value)}
	if _, err := memory.Write(context.Background(), game, key, write); err != nil {
		t.Fatalf("seed %s: %v", key, err)
	}
}

func decodeAs[T any](t *testing.T, res *httptest.ResponseRecorder) T {
	t.Helper()

	var out T
	if err := json.Unmarshal(res.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode %s: %v", res.Body.String(), err)
	}
	return out
}

func expectCode(t *testing.T, res *httptest.ResponseRecorder, want httpx.ErrorCode) {
	t.Helper()

	if got := decodeAs[httpx.ErrorBody](t, res).Code; got != want {
		t.Fatalf("code: got %q, want %q", got, want)
	}
}

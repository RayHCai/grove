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
	"sync"
	"testing"
	"time"

	"github.com/RayHCai/grove/apps/grove/instance-manager/internal/supervisor"
	"github.com/RayHCai/grove/libs/go-grove/contract"
	"github.com/RayHCai/grove/libs/go-grove/httpx"
)

const fleetSecret = "a-fleet-secret-of-at-least-32-chars"

// What a child that was never forked answers when asked which process it is; nothing here goes
// looking for one.
const stubPid = 4242

// A child that was never forked: it answers a drain and it ends when told to.
type stubChild struct {
	exit chan struct{}
	once sync.Once
}

func (c *stubChild) Pid() int     { return stubPid }
func (c *stubChild) Drain() error { c.end(); return nil }
func (c *stubChild) Kill() error  { c.end(); return nil }
func (c *stubChild) Wait() error  { <-c.exit; return nil }
func (c *stubChild) end()         { c.once.Do(func() { close(c.exit) }) }

type stubLauncher struct{}

func (stubLauncher) Start(context.Context, supervisor.Spec, io.Writer) (supervisor.Child, error) {
	return &stubChild{exit: make(chan struct{})}, nil
}

// No test here outlives its own registry, so there is never a survivor of an earlier one to take.
func (stubLauncher) Adopt(pid int) (supervisor.Child, error) {
	return nil, fmt.Errorf("pid %d is not a game process", pid)
}

// A child that refuses the drain and outlives the kill that refusal earns it, so a stop takes the
// supervisor's whole budget rather than returning the moment it is asked.
type stubbornChild struct {
	exit chan struct{}
	once sync.Once

	mu    sync.Mutex
	kills int
}

func (c *stubbornChild) Pid() int { return stubPid }

func (c *stubbornChild) Drain() error { return errors.New("drain refused") }

func (c *stubbornChild) Kill() error {
	c.mu.Lock()
	defer c.mu.Unlock()

	// The first kill is the one a refused drain earns; only the one at the end of the budget lands.
	c.kills++
	if c.kills > 1 {
		c.once.Do(func() { close(c.exit) })
	}
	return nil
}

func (c *stubbornChild) Wait() error { <-c.exit; return nil }

type stubbornLauncher struct{}

func (stubbornLauncher) Start(
	context.Context, supervisor.Spec, io.Writer,
) (supervisor.Child, error) {
	return &stubbornChild{exit: make(chan struct{})}, nil
}

func (stubbornLauncher) Adopt(pid int) (supervisor.Child, error) {
	return nil, fmt.Errorf("pid %d is not a game process", pid)
}

type stubProber struct{}

func (stubProber) Probe(context.Context, string) (supervisor.Vitals, string, error) {
	return supervisor.Vitals{}, "probe-id", nil
}

type stubPorts struct {
	mu   sync.Mutex
	next int
}

func (p *stubPorts) Take() (int, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.next++
	return 30000 + p.next, nil
}

func (p *stubPorts) Hold(int) {}

func (p *stubPorts) Release(int) {}

func newTestService(max int) http.Handler {
	return newTestServiceWith(supervisor.Options{MaxInstances: max}, nil)
}

// newTestServiceWith is the same service where a test needs a seam, a budget or a readiness answer
// of its own; a nil probe is the answer a box with its binary in place gives.
func newTestServiceWith(opts supervisor.Options, ready func(context.Context) error) http.Handler {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))

	if opts.Launcher == nil {
		opts.Launcher = stubLauncher{}
	}
	if ready == nil {
		ready = func(context.Context) error { return nil }
	}
	opts.Prober = stubProber{}
	opts.Ports = &stubPorts{}
	opts.Log = log
	opts.TokenSecret = []byte(strings.Repeat("s", 32))

	return New(supervisor.New(opts), ready, []byte(fleetSecret), log)
}

func startBodyFor(i int) string {
	return fmt.Sprintf(`{
		"instanceId": "%08d-2222-4222-8222-222222222222",
		"gameId": "6f1e5a3c-0b2d-4c8e-9a71-2f3b4c5d6e70",
		"sessionId": "%08d-1111-4111-8111-111111111111",
		"bundlePath": "/srv/bundles/sim.js",
		"simConfigPath": "/srv/bundles/sim.json",
		"managerUrl": "http://game-manager:4001"
	}`, i, i)
}

// The id the placement named, which is the one the player was handed.
func placedID(i int) string {
	return fmt.Sprintf("%08d-2222-4222-8222-222222222222", i)
}

func call(handler http.Handler, method, path, body string) *httptest.ResponseRecorder {
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}

	req := httptest.NewRequest(method, path, reader)
	req.Header.Set("Authorization", "Bearer "+fleetSecret)

	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	return w
}

// answerPresenting calls an open route with whatever the caller put in the request-id header, so
// the echo is read without the fleet bearer in the way.
func answerPresenting(handler http.Handler, presented string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	if presented != "" {
		req.Header.Set(contract.RequestIDHeader, presented)
	}

	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	return w
}

func startOne(t *testing.T, handler http.Handler, i int) supervisor.View {
	t.Helper()

	res := call(handler, http.MethodPost, "/v1/instances", startBodyFor(i))
	if res.Code != http.StatusCreated {
		t.Fatalf("start %d: got %d, body %s", i, res.Code, res.Body.String())
	}

	var view supervisor.View
	if err := json.Unmarshal(res.Body.Bytes(), &view); err != nil {
		t.Fatalf("decode a started instance: %v", err)
	}
	return view
}

func failure(t *testing.T, res *httptest.ResponseRecorder) httpx.ErrorBody {
	t.Helper()

	var body httpx.ErrorBody
	if err := json.Unmarshal(res.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode a failure: %v (%s)", err, res.Body.String())
	}
	return body
}

func TestStartingOneReportsThePortItBound(t *testing.T) {
	view := startOne(t, newTestService(2), 0)

	if view.Port == 0 {
		t.Error("the report carries no port, so nothing can reach this session")
	}
	if view.State != "starting" {
		t.Errorf("state: got %q, want starting", view.State)
	}
	if view.SessionID != "00000000-1111-4111-8111-111111111111" {
		t.Errorf("sessionId: got %q", view.SessionID)
	}
	// The placement already told the player this id; a second one minted here names nothing they hold.
	if view.InstanceID != placedID(0) {
		t.Errorf("instanceId: got %q, want the placed %q", view.InstanceID, placedID(0))
	}
}

func TestAFullBoxAnswers409(t *testing.T) {
	cases := []struct {
		name string
		cap  int
	}{
		{name: "one session at a time", cap: 1},
		{name: "a small box", cap: 3},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			handler := newTestService(tc.cap)
			for i := range tc.cap {
				startOne(t, handler, i)
			}

			res := call(handler, http.MethodPost, "/v1/instances", startBodyFor(tc.cap))
			if res.Code != http.StatusConflict {
				t.Fatalf("past the cap: got %d, want 409", res.Code)
			}
			// The fleet branches on the code: a status alone does not say which 409 this is.
			if body := failure(t, res); body.Code != httpx.CodeConflict {
				t.Errorf("code: got %q, want conflict", body.Code)
			}
		})
	}
}

func TestABadStartIsRefused(t *testing.T) {
	cases := []struct {
		name string
		body string
	}{
		{name: "no body at all", body: ""},
		{name: "not json", body: "{"},
		{name: "no game", body: `{"sessionId":"00000000-1111-4111-8111-111111111111"}`},
		{
			name: "a game id that is not a uuid",
			body: `{"gameId":"grove","sessionId":"00000000-1111-4111-8111-111111111111",
				"bundlePath":"/b","simConfigPath":"/c","managerUrl":"http://m"}`,
		},
		{
			name: "no bundle to run",
			body: `{"instanceId":"00000000-2222-4222-8222-222222222222",
				"gameId":"6f1e5a3c-0b2d-4c8e-9a71-2f3b4c5d6e70",
				"sessionId":"00000000-1111-4111-8111-111111111111","bundlePath":"",
				"simConfigPath":"/c","managerUrl":"http://m"}`,
		},
		{
			name: "a placement that names no instance",
			body: `{"gameId":"6f1e5a3c-0b2d-4c8e-9a71-2f3b4c5d6e70",
				"sessionId":"00000000-1111-4111-8111-111111111111","bundlePath":"/b",
				"simConfigPath":"/c","managerUrl":"http://m"}`,
		},
		{
			name: "an instance id that is not a uuid",
			body: `{"instanceId":"instance-7",
				"gameId":"6f1e5a3c-0b2d-4c8e-9a71-2f3b4c5d6e70",
				"sessionId":"00000000-1111-4111-8111-111111111111","bundlePath":"/b",
				"simConfigPath":"/c","managerUrl":"http://m"}`,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res := call(newTestService(2), http.MethodPost, "/v1/instances", tc.body)

			if res.Code != http.StatusBadRequest {
				t.Fatalf("got %d, want 400 (%s)", res.Code, res.Body.String())
			}
			if body := failure(t, res); body.Code != httpx.CodeInvalidRequest {
				t.Errorf("code: got %q, want invalid_request", body.Code)
			}
		})
	}
}

func TestTheFleetScopeIsClosed(t *testing.T) {
	handler := newTestService(2)

	cases := []struct {
		name   string
		header string
	}{
		{name: "no header", header: ""},
		{name: "not a bearer", header: "Basic " + fleetSecret},
		{name: "another fleet's secret", header: "Bearer " + strings.Repeat("x", len(fleetSecret))},
		{name: "a prefix of the secret", header: "Bearer " + fleetSecret[:8]},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/v1/instances", nil)
			if tc.header != "" {
				req.Header.Set("Authorization", tc.header)
			}

			w := httptest.NewRecorder()
			handler.ServeHTTP(w, req)

			if w.Code != http.StatusUnauthorized {
				t.Fatalf("got %d, want 401", w.Code)
			}
		})
	}
}

// Polled by whatever supervises this agent, which holds no fleet secret.
func TestHealthIsOutsideTheScope(t *testing.T) {
	w := httptest.NewRecorder()
	newTestService(2).ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/health", nil))

	if w.Code != http.StatusOK || w.Body.String() != `{"ok":true}` {
		t.Errorf("got %d %s", w.Code, w.Body.String())
	}
}

// Polled by the same supervisor as /health, and just as early, so it sits outside the scope too.
func TestReadyIsOutsideTheScope(t *testing.T) {
	w := httptest.NewRecorder()
	newTestService(2).ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/ready", nil))

	if w.Code != http.StatusOK || w.Body.String() != `{"ok":true}` {
		t.Errorf("got %d %s", w.Code, w.Body.String())
	}
}

// A box that would accept every start request and fail every one of them should be given none.
func TestReadyIs503WhenTheGameBinaryIsGone(t *testing.T) {
	handler := newTestServiceWith(supervisor.Options{MaxInstances: 2}, func(context.Context) error {
		return errors.New("no such file")
	})

	w := httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/ready", nil))

	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("got %d, want 503", w.Code)
	}
	// Scrubbed with every other 5xx: the status is what a prober reads, the log keeps the reason.
	if body := failure(t, w); body.Code != httpx.CodeInternal {
		t.Errorf("code: got %q, want internal", body.Code)
	}
}

// The id a caller quotes in a bug report is the id this box's log lines carry, so it is echoed.
func TestAnAnswerEchoesTheIDTheCallerBrought(t *testing.T) {
	const brought = "1e1b6f0e-7c9a-4a6b-9f4c-9f1a2b3c4d5e"

	res := answerPresenting(newTestService(2), brought)

	if got := res.Header().Get(contract.RequestIDHeader); got != brought {
		t.Errorf("echo: got %q, want %q", got, brought)
	}
}

// The id is echoed, logged and forwarded, so one this box would not have minted is replaced.
func TestAnAnswerMintsTheIDTheCallerDidNot(t *testing.T) {
	handler := newTestService(2)

	cases := []struct {
		name      string
		presented string
	}{
		{name: "no id at all"},
		{name: "an id that is not one grep token", presented: "../../etc/passwd"},
		{name: "an id past the bound", presented: strings.Repeat("a", contract.RequestIDMaxLen+1)},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := answerPresenting(handler, tc.presented).Header().Get(contract.RequestIDHeader)

			if !contract.ValidUUID(got) {
				t.Errorf("echo: got %q, want a minted uuid", got)
			}
		})
	}
}

func TestListingAndReadingOne(t *testing.T) {
	handler := newTestService(3)
	first := startOne(t, handler, 0)
	startOne(t, handler, 1)

	var listed struct {
		Instances []supervisor.View `json:"instances"`
	}
	res := call(handler, http.MethodGet, "/v1/instances", "")
	if err := json.Unmarshal(res.Body.Bytes(), &listed); err != nil {
		t.Fatalf("decode the list: %v", err)
	}
	if len(listed.Instances) != 2 {
		t.Fatalf("listed: got %d, want 2", len(listed.Instances))
	}

	one := call(handler, http.MethodGet, "/v1/instances/"+first.InstanceID, "")
	if one.Code != http.StatusOK {
		t.Fatalf("read one: got %d", one.Code)
	}

	var view supervisor.View
	if err := json.Unmarshal(one.Body.Bytes(), &view); err != nil {
		t.Fatalf("decode one: %v", err)
	}
	if view.InstanceID != first.InstanceID {
		t.Errorf("got %q, want %q", view.InstanceID, first.InstanceID)
	}
}

func TestStoppingOneAnswers204ThenGone(t *testing.T) {
	handler := newTestService(2)
	view := startOne(t, handler, 0)

	stopped := call(handler, http.MethodDelete, "/v1/instances/"+view.InstanceID, "")
	if stopped.Code != http.StatusNoContent {
		t.Fatalf("stop: got %d, body %s", stopped.Code, stopped.Body.String())
	}
	if stopped.Body.Len() != 0 {
		t.Errorf("a 204 carried a body: %s", stopped.Body.String())
	}

	again := call(handler, http.MethodDelete, "/v1/instances/"+view.InstanceID, "")
	if again.Code != http.StatusNotFound {
		t.Errorf("stopping it twice: got %d, want 404", again.Code)
	}
}

// A stop outlasts the write deadline the rest of this service is written under, so it is proved
// over a real connection: a recorder holds no deadline for the handler to miss.
func TestStoppingOneAnswers204PastTheWriteDeadline(t *testing.T) {
	const drainTakes = 2 * time.Second

	handler := newTestServiceWith(supervisor.Options{
		MaxInstances: 1,
		Launcher:     stubbornLauncher{},
		StopTimeout:  drainTakes,
	}, nil)
	view := startOne(t, handler, 0)

	srv := httptest.NewUnstartedServer(handler)
	// Well short of the drain, so a stop that did not extend its own deadline reaches the caller as
	// a closed connection rather than as a 204.
	srv.Config.WriteTimeout = drainTakes / 4
	srv.Start()
	defer srv.Close()

	req, err := http.NewRequest(http.MethodDelete, srv.URL+"/v1/instances/"+view.InstanceID, nil)
	if err != nil {
		t.Fatalf("build the stop: %v", err)
	}
	req.Header.Set("Authorization", "Bearer "+fleetSecret)

	res, err := srv.Client().Do(req)
	if err != nil {
		t.Fatalf("stop over a real connection: %v", err)
	}
	defer res.Body.Close()

	if res.StatusCode != http.StatusNoContent {
		t.Errorf("stop: got %d, want 204", res.StatusCode)
	}
}

func TestAnUnknownInstanceIsNotFound(t *testing.T) {
	handler := newTestService(2)
	const unknown = "6f1e5a3c-0b2d-4c8e-9a71-000000000000"

	paths := []string{"/v1/instances/" + unknown, "/v1/instances/" + unknown + "/logs"}

	for _, path := range paths {
		res := call(handler, http.MethodGet, path, "")
		if res.Code != http.StatusNotFound {
			t.Errorf("%s: got %d, want 404", path, res.Code)
		}
		if body := failure(t, res); body.Code != httpx.CodeNotFound {
			t.Errorf("%s: code %q, want not_found", path, body.Code)
		}
	}
}

func TestReadingTheLogTail(t *testing.T) {
	handler := newTestService(2)
	view := startOne(t, handler, 0)

	res := call(handler, http.MethodGet, "/v1/instances/"+view.InstanceID+"/logs?limit=10", "")
	if res.Code != http.StatusOK {
		t.Fatalf("got %d", res.Code)
	}

	var page struct {
		InstanceID string   `json:"instanceId"`
		Lines      []string `json:"lines"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &page); err != nil {
		t.Fatalf("decode the page: %v", err)
	}
	if page.InstanceID != view.InstanceID {
		t.Errorf("instanceId: got %q", page.InstanceID)
	}
	// A child that has written nothing has an empty tail, not a missing one.
	if page.Lines == nil {
		t.Error("lines came back null, which a caller has to special-case")
	}

	notANumber := "/v1/instances/" + view.InstanceID + "/logs?limit=soon"
	refused := call(handler, http.MethodGet, notANumber, "")
	if refused.Code != http.StatusBadRequest {
		t.Errorf("a limit that is not a number: got %d, want 400", refused.Code)
	}
}

func TestAWrongPathAnswersInTheSharedShape(t *testing.T) {
	handler := newTestService(2)

	for _, path := range []string{"/v1/nothing", "/nothing"} {
		res := call(handler, http.MethodGet, path, "")
		if res.Code != http.StatusNotFound {
			t.Errorf("%s: got %d, want 404", path, res.Code)
		}
		if body := failure(t, res); body.Code != httpx.CodeNotFound {
			t.Errorf("%s: code %q, want not_found", path, body.Code)
		}
	}
}

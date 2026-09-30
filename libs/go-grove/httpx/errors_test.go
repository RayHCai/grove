package httpx

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestWriteJSON(t *testing.T) {
	w := httptest.NewRecorder()
	WriteJSON(w, http.StatusCreated, map[string]int{"revision": 7})

	if w.Code != http.StatusCreated {
		t.Errorf("status: got %d", w.Code)
	}
	if got := w.Header().Get("Content-Type"); got != "application/json; charset=utf-8" {
		t.Errorf("content type: got %q", got)
	}
	if got := w.Body.String(); got != `{"revision":7}` {
		t.Errorf("body: got %s", got)
	}
}

// A value that cannot marshal must still leave a parseable failure, not a truncated success.
func TestWriteJSONOnAnUnmarshalableValue(t *testing.T) {
	w := httptest.NewRecorder()
	WriteJSON(w, http.StatusOK, make(chan int))

	if w.Code != http.StatusInternalServerError {
		t.Errorf("status: got %d, want 500", w.Code)
	}

	var body ErrorBody
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("body is not the shared shape: %v", err)
	}
	if body.Code != CodeInternal {
		t.Errorf("code: got %q", body.Code)
	}
}

func TestWriteError(t *testing.T) {
	tests := []struct {
		name        string
		status      int
		code        ErrorCode
		message     string
		wantCode    ErrorCode
		wantMessage string
	}{
		{"a 404 says what was not found", http.StatusNotFound, CodeNotFound, "no such game", CodeNotFound, "no such game"},
		{"a 409 keeps its message", http.StatusConflict, CodeConflict, "revision 4 is stale", CodeConflict, "revision 4 is stale"},
		// The log keeps what went wrong; a caller gets the status and nothing about the internals.
		{"a 500 is flattened", http.StatusInternalServerError, CodeConflict, "pq: relation does not exist", CodeInternal, "internal error"},
		{"a 503 is flattened", http.StatusServiceUnavailable, CodeInternal, "upstream refused at 10.0.1.7", CodeInternal, "internal error"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			WriteError(w, tt.status, tt.code, tt.message)

			if w.Code != tt.status {
				t.Errorf("status: got %d, want %d", w.Code, tt.status)
			}

			var body ErrorBody
			if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
				t.Fatalf("Unmarshal: %v", err)
			}
			if body.Code != tt.wantCode || body.Message != tt.wantMessage {
				t.Errorf("got %+v, want {%q %q}", body, tt.wantCode, tt.wantMessage)
			}
		})
	}
}

func TestNotFound(t *testing.T) {
	w := httptest.NewRecorder()
	NotFound(w, httptest.NewRequest("GET", "/nope", nil))

	if w.Code != http.StatusNotFound {
		t.Errorf("status: got %d", w.Code)
	}
	if got := w.Body.String(); got != `{"code":"not_found","message":"no such route"}` {
		t.Errorf("body: got %s", got)
	}
}

type stateWrite struct {
	Value    string `json:"value"`
	Revision int    `json:"revision"`
}

func TestDecodeJSON(t *testing.T) {
	tests := []struct {
		name        string
		body        string
		wantOK      bool
		wantMessage string
	}{
		{name: "a well formed body", body: `{"value":"a","revision":3}`, wantOK: true},
		// `z.object` strips what it does not know, so a newer caller's extra field is not an error.
		{name: "an unknown field", body: `{"value":"a","revision":3,"sentBy":"a newer caller"}`, wantOK: true},
		{name: "an empty body", body: ``, wantMessage: "body is empty"},
		{name: "malformed json", body: `{"value":"a",}`, wantMessage: "malformed json at byte"},
		{name: "a truncated body", body: `{"value":`, wantMessage: "body is truncated"},
		{name: "the wrong type", body: `{"revision":"three"}`, wantMessage: `field "revision" must be a int`},
		{name: "two values", body: `{"value":"a"}{"value":"b"}`, wantMessage: "body must hold one json value"},
		{name: "not an object", body: `"a bare string"`, wantMessage: "field"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			r := httptest.NewRequest("POST", "/v1/state/world", strings.NewReader(tt.body))

			var dst stateWrite
			ok := DecodeJSON(w, r, &dst, 1<<20)

			if ok != tt.wantOK {
				t.Fatalf("got ok=%v, want %v (body %q)", ok, tt.wantOK, w.Body.String())
			}
			if ok {
				return
			}

			if w.Code != http.StatusBadRequest {
				t.Errorf("status: got %d, want 400", w.Code)
			}

			var body ErrorBody
			if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
				t.Fatalf("Unmarshal: %v", err)
			}
			if body.Code != CodeInvalidRequest {
				t.Errorf("code: got %q", body.Code)
			}
			if !strings.Contains(body.Message, tt.wantMessage) {
				t.Errorf("message: got %q, want it to contain %q", body.Message, tt.wantMessage)
			}
		})
	}
}

func TestDecodeJSONCapsTheBody(t *testing.T) {
	w := httptest.NewRecorder()
	oversized := `{"value":"` + strings.Repeat("x", 512) + `"}`
	r := httptest.NewRequest("POST", "/v1/state/world", strings.NewReader(oversized))

	var dst stateWrite
	if DecodeJSON(w, r, &dst, 64) {
		t.Fatal("a body past the cap must not decode")
	}
	if w.Code != http.StatusBadRequest {
		t.Errorf("status: got %d, want 400", w.Code)
	}
	if got := w.Body.String(); !strings.Contains(got, "body exceeds 64 bytes") {
		t.Errorf("body: got %s", got)
	}
}

// The failure names the field to fix and never quotes the body, which is where a secret would be.
func TestDecodeJSONNeverQuotesTheBody(t *testing.T) {
	w := httptest.NewRecorder()
	r := httptest.NewRequest("POST", "/v1/state/world", strings.NewReader(`{"revision":"hunter2"}`))

	var dst stateWrite
	if DecodeJSON(w, r, &dst, 1<<20) {
		t.Fatal("want a refusal")
	}
	if strings.Contains(w.Body.String(), "hunter2") {
		t.Errorf("the failure quotes the body: %s", w.Body.String())
	}
}

// A 500 carries nothing of the failure, and the log line carries all of it under the request's id.
func TestFailLogsWhatItHidesFromTheCaller(t *testing.T) {
	var logged strings.Builder
	l := slog.New(slog.NewJSONHandler(&logged, nil))

	w := httptest.NewRecorder()
	Fail(w, httptest.NewRequest("GET", "/v1/state/k", nil), l, "read state", errors.New("disk on fire"), "gameId", "g")

	if w.Code != http.StatusInternalServerError || strings.Contains(w.Body.String(), "disk") {
		t.Errorf("got %d %s", w.Code, w.Body.String())
	}
	for _, want := range []string{`"msg":"read state"`, `"err":"disk on fire"`, `"path":"/v1/state/k"`, `"gameId":"g"`} {
		if !strings.Contains(logged.String(), want) {
			t.Errorf("log missing %s:\n%s", want, logged.String())
		}
	}
}

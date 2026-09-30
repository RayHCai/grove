// Package httpx is the HTTP layer every Go service mounts: one error body, one JSON codec on the
// way in and out, the wraps around a handler, and the listener that drains.
package httpx

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
)

// ErrorCode is what a caller branches on, because a status alone does not say which 400 this is.
type ErrorCode string

const (
	CodeUnauthorized   ErrorCode = "unauthorized"
	CodeNotFound       ErrorCode = "not_found"
	CodeConflict       ErrorCode = "conflict"
	CodeRateLimited    ErrorCode = "rate_limited"
	CodeInvalidRequest ErrorCode = "invalid_request"
	CodeInternal       ErrorCode = "internal"
)

// ErrorBody is `ErrorBody` from libs/api-contract, so one client parser covers every service.
type ErrorBody struct {
	Code    ErrorCode `json:"code"`
	Message string    `json:"message"`
}

// WriteJSON is the only way a body leaves a handler, so every response carries the same header.
func WriteJSON(w http.ResponseWriter, status int, body any) {
	// Encoded before the header goes out, so a value that cannot marshal is still a 500 a caller
	// can parse rather than a 200 cut off mid-object.
	encoded, err := json.Marshal(body)
	if err != nil {
		status = http.StatusInternalServerError
		encoded = []byte(`{"code":"internal","message":"internal error"}`)
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(encoded)
}

// WriteError sends the shared failure shape.
func WriteError(w http.ResponseWriter, status int, code ErrorCode, message string) {
	// A 5xx says nothing about itself: the log keeps what went wrong, the caller gets the status.
	if status >= http.StatusInternalServerError {
		code, message = CodeInternal, "internal error"
	}
	WriteJSON(w, status, ErrorBody{Code: code, Message: message})
}

// BadRequest is the 400 for a request refused before any work was done for it.
func BadRequest(w http.ResponseWriter, message string) {
	WriteError(w, http.StatusBadRequest, CodeInvalidRequest, message)
}

// Fail keeps what went wrong in the log and tells the caller only that something did.
func Fail(w http.ResponseWriter, r *http.Request, l *slog.Logger, what string, err error, attrs ...any) {
	attrs = append([]any{"err", err, "path", r.URL.Path, "requestId", RequestIDFrom(r.Context())}, attrs...)
	l.ErrorContext(r.Context(), what, attrs...)
	WriteError(w, http.StatusInternalServerError, CodeInternal, "internal error")
}

// DecodeJSON fills dst from the body, and writes the 400 itself: a handler only has to return.
func DecodeJSON(w http.ResponseWriter, r *http.Request, dst any, maxBytes int64) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxBytes)

	// Unknown fields are ignored because `z.object` strips them: a newer caller sending one more
	// field is not an error on the TypeScript side, and must not be one here.
	dec := json.NewDecoder(r.Body)
	if err := dec.Decode(dst); err != nil {
		WriteError(w, http.StatusBadRequest, CodeInvalidRequest, decodeFailure(err, maxBytes))
		return false
	}
	if dec.More() {
		WriteError(w, http.StatusBadRequest, CodeInvalidRequest, "body must hold one json value")
		return false
	}
	return true
}

// NotFound is the shared 404, so a wrong path answers in the shape a wrong body does.
func NotFound(w http.ResponseWriter, _ *http.Request) {
	WriteError(w, http.StatusNotFound, CodeNotFound, "no such route")
}

// The message says what to fix without quoting the body back, which is where a secret would be.
func decodeFailure(err error, maxBytes int64) string {
	var syntax *json.SyntaxError
	var mistyped *json.UnmarshalTypeError
	var tooLarge *http.MaxBytesError

	switch {
	case errors.Is(err, io.EOF):
		return "body is empty"
	case errors.Is(err, io.ErrUnexpectedEOF):
		return "body is truncated"
	case errors.As(err, &tooLarge):
		return fmt.Sprintf("body exceeds %d bytes", maxBytes)
	case errors.As(err, &syntax):
		return fmt.Sprintf("malformed json at byte %d", syntax.Offset)
	case errors.As(err, &mistyped):
		return fmt.Sprintf("field %q must be a %s", mistyped.Field, mistyped.Type)
	default:
		return "body is not valid json"
	}
}

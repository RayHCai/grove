// The id that joins one request across the services it passes through.

package httpx

import (
	"context"
	"net/http"

	"github.com/RayHCai/grove/libs/go-grove/contract"
)

type ctxKey int

const requestIDKey ctxKey = 0

// RequestID puts a correlation id on every request: the caller's when it is one token this service
// can log unchanged, and a fresh one when it is not.
//
// Mounted outermost, so the panic net's line carries the id too and the echo header is set before
// any handler beneath has written a status.
func RequestID() Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			id := r.Header.Get(contract.RequestIDHeader)
			// Replaced rather than refused: what a caller put in a header is not the
			// request's fault.
			if !contract.ValidRequestID(id) {
				id = contract.NewUUID()
			}

			// Echoed so a caller can quote it against a service whose logs it cannot read.
			w.Header().Set(contract.RequestIDHeader, id)
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), requestIDKey, id)))
		})
	}
}

// RequestIDFrom is the id this request is logged under, or empty for one served outside RequestID.
func RequestIDFrom(ctx context.Context) string {
	id, _ := ctx.Value(requestIDKey).(string)
	return id
}

// Forward carries the id onto an outbound request, so the service it reaches logs under the
// same one.
//
// A call with no inbound request behind it — a ticker, a probe — mints rather than sends none,
// since a beat that failed is still one line to find.
func Forward(req *http.Request) string {
	id := RequestIDFrom(req.Context())
	if id == "" {
		id = contract.NewUUID()
	}

	req.Header.Set(contract.RequestIDHeader, id)
	return id
}

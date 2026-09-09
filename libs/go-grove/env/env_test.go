package env

import (
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestFallbacksWhenUnset(t *testing.T) {
	r := FromMap(nil)

	if got := r.String("HOST", "localhost"); got != "localhost" {
		t.Errorf("String: got %q", got)
	}
	if got := r.Int("PORT", 4001); got != 4001 {
		t.Errorf("Int: got %d", got)
	}
	if got := r.Duration("TIMEOUT", 30*time.Second); got != 30*time.Second {
		t.Errorf("Duration: got %v", got)
	}
	if got := r.OneOf("LOG_LEVEL", "info", "debug", "info", "warn"); got != "info" {
		t.Errorf("OneOf: got %q", got)
	}
	if err := r.Err(); err != nil {
		t.Errorf("an unset variable with a fallback is not a problem: %v", err)
	}
}

func TestReadsWhatIsSet(t *testing.T) {
	r := FromMap(map[string]string{
		"HOST":      "0.0.0.0",
		"PORT":      "4001",
		"TIMEOUT":   "2m30s",
		"LOG_LEVEL": "debug",
		"SECRET":    "a-secret-long-enough",
		"API_URL":   "https://api.grove.test/v1",
	})

	if got := r.String("HOST", "localhost"); got != "0.0.0.0" {
		t.Errorf("String: got %q", got)
	}
	if got := r.Required("HOST"); got != "0.0.0.0" {
		t.Errorf("Required: got %q", got)
	}
	if got := r.Int("PORT", 0); got != 4001 {
		t.Errorf("Int: got %d", got)
	}
	if got := r.Duration("TIMEOUT", 0); got != 150*time.Second {
		t.Errorf("Duration: got %v", got)
	}
	if got := r.OneOf("LOG_LEVEL", "info", "debug", "info"); got != "debug" {
		t.Errorf("OneOf: got %q", got)
	}
	if got := r.Secret("SECRET", 8); string(got) != "a-secret-long-enough" {
		t.Errorf("Secret: got %q", got)
	}
	if got := r.URL("API_URL"); got != "https://api.grove.test/v1" {
		t.Errorf("URL: got %q", got)
	}
	if err := r.Err(); err != nil {
		t.Errorf("Err: %v", err)
	}
}

func TestProblems(t *testing.T) {
	tests := []struct {
		name string
		env  map[string]string
		read func(*Reader)
		want string
	}{
		{
			name: "required is unset",
			read: func(r *Reader) { r.Required("DATABASE_URL") },
			want: "DATABASE_URL is required",
		},
		{
			name: "required is blank",
			env:  map[string]string{"DATABASE_URL": "   "},
			read: func(r *Reader) { r.Required("DATABASE_URL") },
			want: "DATABASE_URL is required",
		},
		{
			name: "int is not a number",
			env:  map[string]string{"PORT": "four thousand"},
			read: func(r *Reader) { r.Int("PORT", 0) },
			want: "PORT must be an integer",
		},
		{
			name: "duration has no unit",
			env:  map[string]string{"TIMEOUT": "30"},
			read: func(r *Reader) { r.Duration("TIMEOUT", 0) },
			want: "TIMEOUT must be a duration",
		},
		{
			name: "secret is unset",
			read: func(r *Reader) { r.Secret("TOKEN_SECRET", 32) },
			want: "TOKEN_SECRET is required",
		},
		{
			name: "secret is too short",
			env:  map[string]string{"TOKEN_SECRET": "short"},
			read: func(r *Reader) { r.Secret("TOKEN_SECRET", 32) },
			want: "TOKEN_SECRET must be at least 32 characters",
		},
		{
			name: "url is unset",
			read: func(r *Reader) { r.URL("API_URL") },
			want: "API_URL is required",
		},
		{
			name: "url is relative",
			env:  map[string]string{"API_URL": "/v1/games"},
			read: func(r *Reader) { r.URL("API_URL") },
			want: "API_URL must be an absolute url",
		},
		{
			name: "url has no host",
			env:  map[string]string{"API_URL": "https://"},
			read: func(r *Reader) { r.URL("API_URL") },
			want: "API_URL must be an absolute url",
		},
		{
			name: "one-of is not allowed",
			env:  map[string]string{"LOG_LEVEL": "chatty"},
			read: func(r *Reader) { r.OneOf("LOG_LEVEL", "info", "debug", "info", "warn") },
			want: `LOG_LEVEL must be one of debug, info, warn, got "chatty"`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := FromMap(tt.env)
			tt.read(r)

			err := r.Err()
			if err == nil {
				t.Fatal("want a problem, got none")
			}
			if !strings.Contains(err.Error(), tt.want) {
				t.Errorf("got %q, want it to contain %q", err, tt.want)
			}
		})
	}
}

// The reason the Reader exists: three unset variables must not cost three restarts to find.
func TestErrReportsEveryProblemAtOnce(t *testing.T) {
	r := FromMap(map[string]string{"PORT": "nope"})
	r.Required("DATABASE_URL")
	r.Int("PORT", 4001)
	r.Secret("TOKEN_SECRET", 32)

	err := r.Err()
	if err == nil {
		t.Fatal("want a problem, got none")
	}
	for _, want := range []string{"DATABASE_URL is required", "PORT must be an integer", "TOKEN_SECRET is required"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("%q is missing from:\n%s", want, err)
		}
	}
}

// A secret's value must not reach a log line an operator pastes into a ticket.
func TestSecretNeverNamesItsValue(t *testing.T) {
	r := FromMap(map[string]string{"TOKEN_SECRET": "hunter2"})
	r.Secret("TOKEN_SECRET", 32)

	err := r.Err()
	if err == nil {
		t.Fatal("want a problem, got none")
	}
	if strings.Contains(err.Error(), "hunter2") {
		t.Errorf("the error quotes the secret: %s", err)
	}
}

// An empty value is a variable someone set and left blank, which says nothing a fallback does not.
func TestBlankReadsAsUnset(t *testing.T) {
	r := FromMap(map[string]string{"HOST": "", "LOG_LEVEL": "  "})

	if got := r.String("HOST", "localhost"); got != "localhost" {
		t.Errorf("String: got %q", got)
	}
	if got := r.OneOf("LOG_LEVEL", "info", "debug", "info"); got != "info" {
		t.Errorf("OneOf: got %q", got)
	}
	if err := r.Err(); err != nil {
		t.Errorf("Err: %v", err)
	}
}

func TestValuesAreTrimmed(t *testing.T) {
	r := FromMap(map[string]string{"PORT": "  4001  "})

	if got := r.Int("PORT", 0); got != 4001 {
		t.Errorf("got %d, want 4001", got)
	}
	if err := r.Err(); err != nil {
		t.Errorf("Err: %v", err)
	}
}

func TestNewReadsTheProcessEnvironment(t *testing.T) {
	t.Setenv("GROVE_TEST_HOST", "127.0.0.1")

	r := New()
	if got := r.Required("GROVE_TEST_HOST"); got != "127.0.0.1" {
		t.Errorf("got %q, want 127.0.0.1", got)
	}
	if err := r.Err(); err != nil {
		t.Errorf("Err: %v", err)
	}
}

// FromMap copies, so a caller's map cannot change a Reader after it has been read from.
func TestFromMapCopies(t *testing.T) {
	source := map[string]string{"HOST": "0.0.0.0"}
	r := FromMap(source)
	source["HOST"] = "changed"

	if got := r.String("HOST", ""); got != "0.0.0.0" {
		t.Errorf("got %q, want 0.0.0.0", got)
	}
}

func TestPortRefusesWhatAListenerWouldAccept(t *testing.T) {
	cases := []struct {
		name  string
		value string
		ok    bool
	}{
		{name: "a real port", value: "4001", ok: true},
		{name: "the lowest", value: "1", ok: true},
		{name: "the highest", value: "65535", ok: true},
		// net.Listen reads zero as "any free port", so a service given one binds somewhere the
		// fleet is not routing to and still reports healthy.
		{name: "zero", value: "0"},
		{name: "negative", value: "-1"},
		{name: "above the range", value: "65536"},
		{name: "not a number", value: "http"},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := FromMap(map[string]string{"PORT": c.value})
			port := r.Port("PORT", 4001)

			if c.ok {
				if err := r.Err(); err != nil {
					t.Fatalf("Err: got %v, want nil", err)
				}
				if want, _ := strconv.Atoi(c.value); port != want {
					t.Errorf("port: got %d, want %d", port, want)
				}
				return
			}
			if r.Err() == nil {
				t.Errorf("Err: got nil for %q, want a refusal", c.value)
			}
		})
	}
}

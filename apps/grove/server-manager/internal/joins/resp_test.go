package joins

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

const (
	key   = "grove:joins"
	depth = 4
	// Whole seconds, because that is the unit BLPOP is sent in.
	wait = time.Second
)

// Long enough that a loopback roundtrip never trips it, short enough that a fake which stops
// answering fails the run rather than hanging it.
const roundtrip = 2 * time.Second

func soon() time.Time { return time.Now().Add(roundtrip) }

// fakeRedis answers a fixed script and keeps the bytes it was sent, so a test pins what went on the
// wire rather than what the client believes it wrote.
type fakeRedis struct {
	ln      net.Listener
	replies []string

	mu   sync.Mutex
	sent []string
}

func serveRedis(t *testing.T, replies ...string) *fakeRedis {
	t.Helper()

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { ln.Close() })

	f := &fakeRedis{ln: ln, replies: replies}
	go f.accept()
	return f
}

func (f *fakeRedis) accept() {
	for {
		c, err := f.ln.Accept()
		if err != nil {
			return
		}
		go f.session(c)
	}
}

// session never touches *testing.T: it outlives the test that started it, and a fake reporting a
// failure after its test has finished panics the whole run.
func (f *fakeRedis) session(c net.Conn) {
	defer c.Close()

	in := bufio.NewReader(c)
	for {
		cmd, err := readCommand(in)
		if err != nil {
			return
		}
		reply, ok := f.record(cmd)
		if !ok {
			return
		}
		if _, err := io.WriteString(c, reply); err != nil {
			return
		}
	}
}

func (f *fakeRedis) record(cmd string) (string, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()

	f.sent = append(f.sent, cmd)
	if len(f.sent) > len(f.replies) {
		return "", false
	}
	return f.replies[len(f.sent)-1], true
}

func (f *fakeRedis) commands() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.sent...)
}

func (f *fakeRedis) url() string { return "redis://" + f.ln.Addr().String() }

// Reparsed rather than re-encoded, so what a test compares against is what actually went out.
func readCommand(in *bufio.Reader) (string, error) {
	var raw strings.Builder

	header, err := in.ReadString('\n')
	if err != nil {
		return "", err
	}
	raw.WriteString(header)

	args, err := strconv.Atoi(strings.TrimSuffix(header[1:], "\r\n"))
	if err != nil {
		return "", fmt.Errorf("array header %q: %w", header, err)
	}

	for range args {
		size, err := in.ReadString('\n')
		if err != nil {
			return "", err
		}
		raw.WriteString(size)

		n, err := strconv.Atoi(strings.TrimSuffix(size[1:], "\r\n"))
		if err != nil {
			return "", fmt.Errorf("bulk header %q: %w", size, err)
		}
		// Two more for the CRLF the client frames every argument with.
		arg := make([]byte, n+2)
		if _, err := io.ReadFull(in, arg); err != nil {
			return "", err
		}
		raw.Write(arg)
	}
	return raw.String(), nil
}

func redisFor(t *testing.T, rawURL string) *Redis {
	t.Helper()

	r, err := NewRedis(rawURL, key, depth, wait)
	if err != nil {
		t.Fatalf("NewRedis: %v", err)
	}
	t.Cleanup(r.Close)
	return r
}

func dialFake(t *testing.T, f *fakeRedis) *conn {
	t.Helper()

	d, err := parseRedisURL(f.url())
	if err != nil {
		t.Fatalf("parseRedisURL: %v", err)
	}
	c, err := d.dial(soon())
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { c.raw.Close() })
	return c
}

func idle(r *Redis) int {
	r.pushes.mu.Lock()
	defer r.pushes.mu.Unlock()
	return len(r.pushes.idle)
}

func TestParseRedisURLReadsTheSpellingAHostedCacheHandsOut(t *testing.T) {
	cases := []struct {
		name     string
		raw      string
		addr     string
		password string
		db       string
	}{
		{
			name: "a host on its own takes the port every server listens on",
			raw:  "redis://cache.internal",
			addr: "cache.internal:6379",
		},
		{
			name: "a port the url names",
			raw:  "redis://cache.internal:6380",
			addr: "cache.internal:6380",
		},
		{
			name:     "a password with no user in front of it",
			raw:      "redis://:hunter2@cache.internal",
			addr:     "cache.internal:6379",
			password: "hunter2",
		},
		{
			name:     "a user and a password",
			raw:      "redis://default:hunter2@cache.internal:6380",
			addr:     "cache.internal:6380",
			password: "hunter2",
		},
		{
			name: "a database",
			raw:  "redis://cache.internal/3",
			addr: "cache.internal:6379",
			db:   "3",
		},
		{
			name:     "every part at once",
			raw:      "redis://:hunter2@cache.internal:6380/7",
			addr:     "cache.internal:6380",
			password: "hunter2",
			db:       "7",
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := parseRedisURL(c.raw)
			if err != nil {
				t.Fatalf("parseRedisURL: %v", err)
			}
			if got.addr != c.addr {
				t.Errorf("addr: got %q, want %q", got.addr, c.addr)
			}
			if got.password != c.password {
				t.Errorf("password: got %q, want %q", got.password, c.password)
			}
			if got.db != c.db {
				t.Errorf("db: got %q, want %q", got.db, c.db)
			}
		})
	}
}

func TestParseRedisURLRefusesAUrlNoConnectionCouldBeMadeFrom(t *testing.T) {
	cases := []struct {
		name    string
		raw     string
		mention string
	}{
		{
			name:    "a scheme this client does not speak",
			raw:     "rediss://cache.internal",
			mention: "scheme must be redis",
		},
		{
			name:    "a url with nothing to dial",
			raw:     "redis:///3",
			mention: "no host",
		},
		{
			name:    "a database that is not a number",
			raw:     "redis://cache.internal/main",
			mention: "not a number",
		},
		{
			name:    "a port that is not a number",
			raw:     "redis://cache.internal:redis",
			mention: "parse",
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := parseRedisURL(c.raw)
			if err == nil {
				t.Fatalf("parseRedisURL: got %+v, want a refusal", got)
			}
			if !strings.Contains(err.Error(), c.mention) {
				t.Errorf("the error never names %s: %v", c.mention, err)
			}
		})
	}
}

func TestPushSendsItsCommandsAsArraysOfBulkStrings(t *testing.T) {
	f := serveRedis(t, ":0\r\n", ":1\r\n")
	r := redisFor(t, f.url())

	accepted, err := r.Push(context.Background(), []byte("job-1"))
	if err != nil {
		t.Fatalf("Push: %v", err)
	}
	if !accepted {
		t.Fatal("accepted: got false, want true on an empty line against a depth of four")
	}

	want := []string{
		"*2\r\n$4\r\nLLEN\r\n$11\r\ngrove:joins\r\n",
		"*3\r\n$5\r\nLPUSH\r\n$11\r\ngrove:joins\r\n$5\r\njob-1\r\n",
	}
	if got := f.commands(); !reflect.DeepEqual(got, want) {
		t.Fatalf("commands: got %q, want %q", got, want)
	}
}

func TestTheClientReadsEveryReplyShapeItsCommandsAnswerIn(t *testing.T) {
	cases := []struct {
		name  string
		reply string
		want  value
	}{
		{
			name:  "an integer, which is what a length answers",
			reply: ":7\r\n",
			want:  value{integer: 7},
		},
		{
			name:  "a simple string, which is what auth answers",
			reply: "+OK\r\n",
			want:  value{bulk: []byte("OK")},
		},
		{
			name:  "a bulk string",
			reply: "$5\r\nhello\r\n",
			want:  value{bulk: []byte("hello")},
		},
		{
			name:  "a null bulk",
			reply: "$-1\r\n",
			want:  value{null: true},
		},
		{
			name:  "the key and the element blpop answers with",
			reply: "*2\r\n$11\r\ngrove:joins\r\n$5\r\njob-1\r\n",
			want:  value{array: [][]byte{[]byte("grove:joins"), []byte("job-1")}},
		},
		{
			name:  "a null array",
			reply: "*-1\r\n",
			want:  value{null: true},
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := dialFake(t, serveRedis(t, c.reply)).do(soon(), "LLEN", key)
			if err != nil {
				t.Fatalf("do: %v", err)
			}
			if !reflect.DeepEqual(got, c.want) {
				t.Errorf("reply: got %+v, want %+v", got, c.want)
			}
		})
	}
}

func TestAnErrorReplyBecomesAnErrorCarryingTheServersWords(t *testing.T) {
	f := serveRedis(t, "-WRONGTYPE Operation against a key holding the wrong kind of value\r\n")

	got, err := dialFake(t, f).do(soon(), "LLEN", key)
	if err == nil {
		t.Fatalf("do: got %+v and no error, want the server's refusal", got)
	}
	if !strings.Contains(err.Error(), "WRONGTYPE Operation against a key") {
		t.Errorf("error: got %v, want the server's own words", err)
	}
}

func TestPopTakesTheSecondElementOfTheArrayBlpopAnswers(t *testing.T) {
	f := serveRedis(t, "*2\r\n$11\r\ngrove:joins\r\n$5\r\njob-1\r\n")
	r := redisFor(t, f.url())

	job, err := r.Pop(context.Background())
	if err != nil {
		t.Fatalf("Pop: %v", err)
	}
	if string(job) != "job-1" {
		t.Errorf("job: got %q, want %q", job, "job-1")
	}

	want := []string{"*3\r\n$5\r\nBLPOP\r\n$11\r\ngrove:joins\r\n$1\r\n1\r\n"}
	if got := f.commands(); !reflect.DeepEqual(got, want) {
		t.Fatalf("commands: got %q, want %q", got, want)
	}
}

func TestPopReadsANullArrayAsAWaitThatRanOutOnAnEmptyLine(t *testing.T) {
	f := serveRedis(t, "*-1\r\n")
	r := redisFor(t, f.url())

	job, err := r.Pop(context.Background())
	if !errors.Is(err, ErrEmpty) {
		t.Fatalf("Pop: got %v, want %v", err, ErrEmpty)
	}
	if job != nil {
		t.Errorf("job: got %q, want nothing", job)
	}
}

// LLEN before LPUSH, so a join refused on the depth leaves nothing behind for a worker to pop and
// answer nobody with.
func TestPushRefusesAtTheDepthWithoutSendingAnLpush(t *testing.T) {
	f := serveRedis(t, ":4\r\n", ":5\r\n")
	r := redisFor(t, f.url())

	accepted, err := r.Push(context.Background(), []byte("job-1"))
	if err != nil {
		t.Fatalf("Push: %v", err)
	}
	if accepted {
		t.Fatal("accepted: got true, want false on a line already at its depth of four")
	}

	got := f.commands()
	for _, sent := range got {
		if strings.Contains(sent, "LPUSH") {
			t.Fatalf("commands: got %q, want no LPUSH behind a refusal", got)
		}
	}
	if len(got) != 1 {
		t.Fatalf("commands: got %q, want the LLEN alone", got)
	}
}

func TestTheConnectionIsAuthenticatedAndOnItsDatabaseBeforeAnyCommand(t *testing.T) {
	f := serveRedis(t, "+OK\r\n", "+OK\r\n", ":0\r\n", ":1\r\n")
	r := redisFor(t, "redis://:hunter2@"+f.ln.Addr().String()+"/3")

	if _, err := r.Push(context.Background(), []byte("job-1")); err != nil {
		t.Fatalf("Push: %v", err)
	}

	want := []string{
		"*2\r\n$4\r\nAUTH\r\n$7\r\nhunter2\r\n",
		"*2\r\n$6\r\nSELECT\r\n$1\r\n3\r\n",
		"*2\r\n$4\r\nLLEN\r\n$11\r\ngrove:joins\r\n",
		"*3\r\n$5\r\nLPUSH\r\n$11\r\ngrove:joins\r\n$5\r\njob-1\r\n",
	}
	if got := f.commands(); !reflect.DeepEqual(got, want) {
		t.Fatalf("commands: got %q, want %q", got, want)
	}
}

func TestAPushThatReadBothItsRepliesKeepsItsConnection(t *testing.T) {
	f := serveRedis(t, ":0\r\n", ":1\r\n")
	r := redisFor(t, f.url())

	if _, err := r.Push(context.Background(), []byte("job-1")); err != nil {
		t.Fatalf("Push: %v", err)
	}
	if n := idle(r); n != 1 {
		t.Errorf("idle connections: got %d, want 1", n)
	}
}

// Unread bytes are still in the socket, so the next command to reuse that connection would read
// them as its own reply.
func TestAReplyTheClientCannotReadNeverGoesBackInTheIdlePool(t *testing.T) {
	cases := []struct {
		name  string
		reply string
	}{
		{name: "a reply with no crlf frame", reply: ":7\n"},
		{name: "a reply type this client does not speak", reply: "%2\r\n"},
		{name: "an integer that is not a number", reply: ":many\r\n"},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := redisFor(t, serveRedis(t, c.reply).url())

			accepted, err := r.Push(context.Background(), []byte("job-1"))
			if err == nil {
				t.Fatalf("Push: got accepted=%v and no error, want the unreadable reply reported", accepted)
			}
			if n := idle(r); n != 0 {
				t.Errorf("idle connections: got %d, want 0", n)
			}
		})
	}
}

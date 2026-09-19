// The little of RESP this service speaks, written out rather than imported: a client is a
// dependency, and this fleet's Go half keeps an empty go.sum so it builds with no network.

package joins

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// RESP2, because that is what every server answers without being asked. HELLO would buy typed
// replies this speaks four of.
const (
	respSimple  = '+'
	respError   = '-'
	respInteger = ':'
	respBulk    = '$'
	respArray   = '*'
)

// A reply larger than this is not one of the four shapes below, so reading it is spending memory on
// a server that is not the one this service was pointed at.
const maxReplyBytes = 1 << 20

// value is one RESP reply, in the four shapes these commands answer in.
//
// A null bulk and a null array are the same absence here: BLPOP answers one when it timed out, and
// nothing else this service sends can answer either.
type value struct {
	integer int64
	bulk    []byte
	array   [][]byte
	null    bool
}

// conn is one connection, which is one command at a time — RESP carries no request id, so a reply
// belongs to whoever sent the command before it.
type conn struct {
	raw net.Conn
	in  *bufio.Reader
}

// do writes one command and reads its reply, both inside deadline.
//
// The deadline covers the write as well as the read: a server that has stopped reading otherwise
// fills a socket buffer and holds a join for as long as the kernel allows.
func (c *conn) do(deadline time.Time, args ...string) (value, error) {
	if err := c.raw.SetDeadline(deadline); err != nil {
		return value{}, fmt.Errorf("set deadline: %w", err)
	}
	if _, err := c.raw.Write(encode(args)); err != nil {
		return value{}, fmt.Errorf("write %s: %w", args[0], err)
	}

	got, err := c.read()
	if err != nil {
		return value{}, fmt.Errorf("read %s: %w", args[0], err)
	}
	return got, nil
}

// encode writes the command as an array of bulk strings, which is the only form a server accepts
// from a client.
func encode(args []string) []byte {
	var b strings.Builder
	b.WriteByte(respArray)
	b.WriteString(strconv.Itoa(len(args)))
	b.WriteString("\r\n")
	for _, arg := range args {
		b.WriteByte(respBulk)
		b.WriteString(strconv.Itoa(len(arg)))
		b.WriteString("\r\n")
		b.WriteString(arg)
		b.WriteString("\r\n")
	}
	return []byte(b.String())
}

func (c *conn) read() (value, error) {
	line, err := c.line()
	if err != nil {
		return value{}, err
	}
	if len(line) == 0 {
		return value{}, errors.New("empty reply")
	}

	body := string(line[1:])
	switch line[0] {
	case respSimple:
		return value{bulk: []byte(body)}, nil
	case respError:
		// The server's own words, which name the command and the reason where a code would not.
		return value{}, errors.New(body)
	case respInteger:
		n, err := strconv.ParseInt(body, 10, 64)
		if err != nil {
			return value{}, fmt.Errorf("integer reply %q: %w", body, err)
		}
		return value{integer: n}, nil
	case respBulk:
		return c.bulk(body)
	case respArray:
		return c.arrayOfBulks(body)
	}
	return value{}, fmt.Errorf("reply type %q", line[0])
}

func (c *conn) bulk(header string) (value, error) {
	n, err := strconv.Atoi(header)
	if err != nil {
		return value{}, fmt.Errorf("bulk length %q: %w", header, err)
	}
	if n < 0 {
		return value{null: true}, nil
	}
	if n > maxReplyBytes {
		return value{}, fmt.Errorf("bulk reply of %d bytes", n)
	}

	// Two more for the trailing CRLF, which is framing rather than part of the value.
	buf := make([]byte, n+2)
	if _, err := io.ReadFull(c.in, buf); err != nil {
		return value{}, err
	}
	return value{bulk: buf[:n]}, nil
}

// arrayOfBulks reads the one array shape this service receives, which is BLPOP's key and element.
func (c *conn) arrayOfBulks(header string) (value, error) {
	n, err := strconv.Atoi(header)
	if err != nil {
		return value{}, fmt.Errorf("array length %q: %w", header, err)
	}
	if n < 0 {
		return value{null: true}, nil
	}

	out := make([][]byte, 0, n)
	for range n {
		member, err := c.read()
		if err != nil {
			return value{}, err
		}
		out = append(out, member.bulk)
	}
	return value{array: out}, nil
}

// line reads one CRLF-terminated frame, without its terminator.
func (c *conn) line() ([]byte, error) {
	raw, err := c.in.ReadSlice('\n')
	if err != nil {
		return nil, err
	}
	if len(raw) < 2 || raw[len(raw)-2] != '\r' {
		return nil, errors.New("reply is not crlf framed")
	}
	return raw[:len(raw)-2], nil
}

// dialer holds what one authenticated connection takes, parsed once at startup so a malformed url
// is a refusal to start rather than a failure on the first join.
type dialer struct {
	addr     string
	password string
	db       string
}

// parseRedisURL reads redis://[:password@]host[:port][/db], which is the spelling a hosted cache
// hands out.
func parseRedisURL(raw string) (dialer, error) {
	parsed, err := url.Parse(raw)
	if err != nil {
		return dialer{}, fmt.Errorf("parse %q: %w", raw, err)
	}
	if parsed.Scheme != "redis" {
		return dialer{}, fmt.Errorf("scheme must be redis, got %q", parsed.Scheme)
	}
	if parsed.Hostname() == "" {
		return dialer{}, fmt.Errorf("no host in %q", raw)
	}

	port := parsed.Port()
	if port == "" {
		port = "6379"
	}

	d := dialer{addr: net.JoinHostPort(parsed.Hostname(), port)}
	if parsed.User != nil {
		d.password, _ = parsed.User.Password()
	}
	if db := strings.TrimPrefix(parsed.Path, "/"); db != "" {
		if _, err := strconv.Atoi(db); err != nil {
			return dialer{}, fmt.Errorf("database %q is not a number", db)
		}
		d.db = db
	}
	return d, nil
}

func (d dialer) dial(deadline time.Time) (*conn, error) {
	raw, err := net.DialTimeout("tcp", d.addr, time.Until(deadline))
	if err != nil {
		return nil, fmt.Errorf("dial %s: %w", d.addr, err)
	}

	c := &conn{raw: raw, in: bufio.NewReader(raw)}
	// Both before the connection is handed out, so nothing can run unauthenticated or against a
	// database this service was not pointed at.
	if d.password != "" {
		if _, err := c.do(deadline, "AUTH", d.password); err != nil {
			c.raw.Close()
			return nil, err
		}
	}
	if d.db != "" {
		if _, err := c.do(deadline, "SELECT", d.db); err != nil {
			c.raw.Close()
			return nil, err
		}
	}
	return c, nil
}

// pool keeps the connections the pushing side reuses.
//
// The popping side is not in here: its BLPOP holds a connection for the whole of its wait, and
// lending that one out would block a push behind a line that is empty on purpose.
type pool struct {
	dialer dialer
	max    int

	mu   sync.Mutex
	idle []*conn
}

func newPool(d dialer, max int) *pool {
	return &pool{dialer: d, max: max}
}

func (p *pool) get(deadline time.Time) (*conn, error) {
	p.mu.Lock()
	if n := len(p.idle); n > 0 {
		c := p.idle[n-1]
		p.idle = p.idle[:n-1]
		p.mu.Unlock()
		return c, nil
	}
	p.mu.Unlock()

	return p.dialer.dial(deadline)
}

// put takes a connection back, and closes it when the idle set is already full.
func (p *pool) put(c *conn) {
	p.mu.Lock()
	if len(p.idle) >= p.max {
		p.mu.Unlock()
		c.raw.Close()
		return
	}
	p.idle = append(p.idle, c)
	p.mu.Unlock()
}

// discard closes a connection whose reply this service could not read.
//
// Never returned to the idle set: a protocol error leaves unread bytes in the socket, which the
// next command on that connection would read as its own reply.
func (p *pool) discard(c *conn) { c.raw.Close() }

func (p *pool) closeAll() {
	p.mu.Lock()
	idle := p.idle
	p.idle = nil
	p.mu.Unlock()

	for _, c := range idle {
		c.raw.Close()
	}
}

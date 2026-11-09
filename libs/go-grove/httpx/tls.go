// What a listener serves TLS with, and how many connections it holds at once.

package httpx

import (
	"crypto/tls"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os"
	"sync"
	"sync/atomic"
	"time"
)

// How often a handshake may look at the files again, so a renewed certificate is served without a
// restart and a busy listener does not stat the disk per connection.
const certRecheck = 30 * time.Second

// CertFiles is a TLS configuration serving the pair at certFile and keyFile, re-read when either
// changes, so a renewal reaches a listener whose restart would drop every socket it holds.
func CertFiles(certFile, keyFile string, l *slog.Logger) (*tls.Config, error) {
	c := &certs{certFile: certFile, keyFile: keyFile, log: l}
	if err := c.load(); err != nil {
		return nil, err
	}
	return &tls.Config{
		MinVersion:     tls.VersionTLS12,
		GetCertificate: c.get,
		// A WebSocket upgrade is an HTTP/1.1 exchange, and a browser offered h2 would try it there.
		NextProtos: []string{"http/1.1"},
	}, nil
}

type certs struct {
	certFile, keyFile string
	log               *slog.Logger

	mu      sync.Mutex
	current *tls.Certificate
	stamp   [2]time.Time
	checked time.Time
}

func (c *certs) get(*tls.ClientHelloInfo) (*tls.Certificate, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if time.Since(c.checked) >= certRecheck {
		c.checked = time.Now()
		if stamp, err := c.stat(); err == nil && stamp != c.stamp {
			// A pair caught mid-rename fails to load, and the certificate already held keeps serving.
			if err := c.reload(); err != nil {
				c.log.Warn("certificate not reloaded", "err", err, "certFile", c.certFile)
			}
		}
	}
	return c.current, nil
}

func (c *certs) load() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.checked = time.Now()
	return c.reload()
}

// reload reads the pair; callers hold mu.
func (c *certs) reload() error {
	stamp, err := c.stat()
	if err != nil {
		return err
	}
	pair, err := tls.LoadX509KeyPair(c.certFile, c.keyFile)
	if err != nil {
		return fmt.Errorf("load %s and %s: %w", c.certFile, c.keyFile, err)
	}
	c.current, c.stamp = &pair, stamp
	return nil
}

func (c *certs) stat() ([2]time.Time, error) {
	var stamp [2]time.Time
	for i, path := range []string{c.certFile, c.keyFile} {
		info, err := os.Stat(path)
		if err != nil {
			return stamp, fmt.Errorf("read %s: %w", path, err)
		}
		stamp[i] = info.ModTime()
	}
	return stamp, nil
}

// capped refuses a connection past max by closing it at accept, so a flood costs the flood a
// reset rather than costing every player behind it a stalled accept queue.
type capped struct {
	net.Listener
	max  int64
	open atomic.Int64
}

func capConns(l net.Listener, max int) net.Listener {
	if max <= 0 {
		return l
	}
	return &capped{Listener: l, max: int64(max)}
}

func (c *capped) Accept() (net.Conn, error) {
	for {
		conn, err := c.Listener.Accept()
		if err != nil {
			return nil, err
		}
		if c.open.Add(1) > c.max {
			c.open.Add(-1)
			_ = conn.Close()
			continue
		}
		return &counted{Conn: conn, release: func() { c.open.Add(-1) }}, nil
	}
}

type counted struct {
	net.Conn
	once    sync.Once
	release func()
}

func (c *counted) Close() error {
	err := c.Conn.Close()
	c.once.Do(c.release)
	return err
}

// errNoCertificate keeps a misconfigured listener from serving TLS with nothing to present.
var errNoCertificate = errors.New("a TLS listener needs a certificate")

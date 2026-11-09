package httpx

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"io"
	"log/slog"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// writePair writes a fresh self-signed certificate for 127.0.0.1 and returns its pool.
func writePair(t *testing.T, certFile, keyFile string, serial int64) *x509.CertPool {
	t.Helper()

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate a key: %v", err)
	}
	template := &x509.Certificate{
		SerialNumber:          big.NewInt(serial),
		Subject:               pkix.Name{CommonName: "grove test"},
		IPAddresses:           []net.IP{net.ParseIP("127.0.0.1")},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		IsCA:                  true,
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("create a certificate: %v", err)
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatalf("marshal the key: %v", err)
	}
	if err := os.WriteFile(certFile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o600); err != nil {
		t.Fatalf("write the certificate: %v", err)
	}
	if err := os.WriteFile(keyFile, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}), 0o600); err != nil {
		t.Fatalf("write the key: %v", err)
	}

	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatalf("parse the certificate: %v", err)
	}
	pool := x509.NewCertPool()
	pool.AddCert(cert)
	return pool
}

func TestAListenerServesTLSWithTheFilesItWasGiven(t *testing.T) {
	dir := t.TempDir()
	certFile, keyFile := filepath.Join(dir, "tls.crt"), filepath.Join(dir, "tls.key")
	pool := writePair(t, certFile, keyFile, 1)

	config, err := CertFiles(certFile, keyFile, discardLogger())
	if err != nil {
		t.Fatalf("CertFiles: %v", err)
	}

	var logged syncBuffer
	ctx, stop := context.WithCancel(context.Background())
	done := make(chan error, 1)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", Health)
	go func() {
		done <- ServeAll(ctx, slog.New(slog.NewJSONHandler(&logged, nil)),
			Listener{Addr: "127.0.0.1:0", Handler: mux, TLS: config})
	}()
	addr := waitForAddr(t, &logged)

	client := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool}}}
	res, err := client.Get("https://" + addr + "/health")
	if err != nil {
		t.Fatalf("GET over TLS: %v", err)
	}
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != http.StatusOK || string(body) != `{"ok":true}` {
		t.Errorf("got %d %s", res.StatusCode, body)
	}
	// A browser's WebSocket upgrade is HTTP/1.1, so h2 is never offered.
	if res.ProtoMajor != 1 {
		t.Errorf("protocol: got HTTP/%d, want HTTP/1.1", res.ProtoMajor)
	}

	stop()
	if err := <-done; err != nil {
		t.Errorf("ServeAll: %v", err)
	}
}

// A renewal reaches a running listener, and a pair caught mid-write leaves the old one serving.
func TestARenewedCertificateIsServedWithoutARestart(t *testing.T) {
	dir := t.TempDir()
	certFile, keyFile := filepath.Join(dir, "tls.crt"), filepath.Join(dir, "tls.key")
	writePair(t, certFile, keyFile, 1)

	c := &certs{certFile: certFile, keyFile: keyFile, log: discardLogger()}
	if err := c.load(); err != nil {
		t.Fatalf("load: %v", err)
	}
	serial := func() int64 {
		t.Helper()
		pair, err := c.get(nil)
		if err != nil {
			t.Fatalf("get: %v", err)
		}
		leaf, err := x509.ParseCertificate(pair.Certificate[0])
		if err != nil {
			t.Fatalf("parse the served certificate: %v", err)
		}
		return leaf.SerialNumber.Int64()
	}
	stale := func() {
		c.mu.Lock()
		c.checked = time.Now().Add(-2 * certRecheck)
		c.mu.Unlock()
	}

	writePair(t, certFile, keyFile, 2)
	future := time.Now().Add(time.Minute)
	_ = os.Chtimes(certFile, future, future)
	if got := serial(); got != 1 {
		t.Fatalf("before the recheck: got serial %d, want the 1 already held", got)
	}
	stale()
	if got := serial(); got != 2 {
		t.Fatalf("after the recheck: got serial %d, want the renewed 2", got)
	}

	if err := os.WriteFile(keyFile, []byte("half a key"), 0o600); err != nil {
		t.Fatalf("spoil the key: %v", err)
	}
	later := future.Add(time.Minute)
	_ = os.Chtimes(keyFile, later, later)
	stale()
	if got := serial(); got != 2 {
		t.Fatalf("after a broken renewal: got serial %d, want the 2 still served", got)
	}
}

func TestCertFilesRefusesAPairItCannotRead(t *testing.T) {
	dir := t.TempDir()
	if _, err := CertFiles(filepath.Join(dir, "no.crt"), filepath.Join(dir, "no.key"), discardLogger()); err == nil {
		t.Fatal("got a configuration for files that do not exist")
	}
}

// Past the cap a connection is closed at accept, and a slot that closes is a slot the next one gets.
func TestAListenerHoldsNoMoreConnectionsThanItsCap(t *testing.T) {
	raw, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	srv := httptest.NewUnstartedServer(http.HandlerFunc(Health))
	srv.Listener = capConns(raw, 1)
	srv.Start()
	defer srv.Close()

	first, err := net.Dial("tcp", raw.Addr().String())
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	if _, err := io.WriteString(first, "GET /health HTTP/1.1\r\nHost: x\r\n\r\n"); err != nil {
		t.Fatalf("write: %v", err)
	}
	if n, err := first.Read(make([]byte, 64)); err != nil || n == 0 {
		t.Fatalf("the first connection was not served: %v", err)
	}

	second, err := net.Dial("tcp", raw.Addr().String())
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	_ = second.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, err := second.Read(make([]byte, 1)); err != io.EOF && !isReset(err) {
		t.Fatalf("a connection past the cap: got %v, want it closed", err)
	}
	second.Close()

	first.Close()
	deadline := time.Now().Add(2 * time.Second)
	for {
		res, err := http.Get(srv.URL + "/health")
		if err == nil {
			res.Body.Close()
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("the slot the first connection held never came back: %v", err)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func isReset(err error) bool {
	var op *net.OpError
	return errors.As(err, &op)
}

func waitForAddr(t *testing.T, logged *syncBuffer) string {
	t.Helper()

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if match := loggedAddr.FindStringSubmatch(logged.String()); match != nil {
			return match[1]
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("ServeAll never logged an address:\n%s", logged.String())
	return ""
}

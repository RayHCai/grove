// A health probe for the service images. They are distroless: no shell, no curl, and nothing else
// that speaks HTTP, because a service binary is the only thing any of them is meant to run. Without
// this a container reports no health at all, and `depends_on: service_healthy` has nothing to gate on.
//
// Static and dependency-free, so one build of it serves the Go images and the Rust one alike.
package main

import (
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"time"
)

func main() {
	addrEnv := flag.String("addr-env", "", "variable holding a host:port to take the port from")
	portEnv := flag.String("port-env", "", "variable holding the port to probe")
	port := flag.String("port", "", "port to probe when neither variable is set")
	path := flag.String("path", "/health", "path to probe")
	timeout := flag.Duration("timeout", 3*time.Second, "how long to wait for a response")
	flag.Parse()

	target := resolvePort(*addrEnv, *portEnv, *port)
	if target == "" {
		fmt.Fprintln(os.Stderr, "healthcheck: no port to probe")
		os.Exit(2)
	}

	// Loopback rather than the bound address: the probe runs inside the container, and a service that
	// binds 0.0.0.0 to be reachable across a network is still reached here over its own stack.
	client := &http.Client{Timeout: *timeout}
	response, err := client.Get("http://127.0.0.1:" + target + *path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "healthcheck: %v\n", err)
		os.Exit(1)
	}
	defer response.Body.Close()

	if response.StatusCode < 200 || response.StatusCode >= 300 {
		fmt.Fprintf(os.Stderr, "healthcheck: %s\n", response.Status)
		os.Exit(1)
	}
}

// Services name their listener either as a port or as the whole host:port they bind, so the probe
// reads whichever this one was given and keeps the literal as the fallback.
func resolvePort(addrEnv, portEnv, fallback string) string {
	if addrEnv != "" {
		if addr := os.Getenv(addrEnv); addr != "" {
			if _, port, err := net.SplitHostPort(addr); err == nil {
				return port
			}
		}
	}
	if portEnv != "" {
		if port := os.Getenv(portEnv); port != "" {
			return port
		}
	}
	return fallback
}

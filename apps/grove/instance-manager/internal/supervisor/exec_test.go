package supervisor

import (
	"context"
	"fmt"
	"net"
	"os"
	"os/signal"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

// The session id that turns this test binary into a stand-in game process when it is spawned.
const helperSession = "00000000-1111-4111-8111-00000000beef"

func TestMain(m *testing.M) {
	if os.Getenv("GROVE_SESSION_ID") == helperSession {
		pretendToBeAGame()
		return
	}
	os.Exit(m.Run())
}

// pretendToBeAGame prints the environment it was handed and drains on SIGINT, as the real one does.
func pretendToBeAGame() {
	interrupted := make(chan os.Signal, 1)
	signal.Notify(interrupted, os.Interrupt)
	for _, entry := range os.Environ() {
		fmt.Println("env " + entry)
	}
	// What a sandbox is meant to have taken away, where the kernel says so.
	fmt.Println("uid " + strconv.Itoa(os.Getuid()))
	if status, err := os.ReadFile("/proc/self/status"); err == nil {
		for _, line := range strings.Split(string(status), "\n") {
			if strings.HasPrefix(line, "CapEff:") || strings.HasPrefix(line, "CapAmb:") {
				fmt.Println("status " + line)
			}
		}
	}
	if cgroup, err := os.ReadFile("/proc/self/cgroup"); err == nil {
		fmt.Println("cgroup " + strings.TrimSpace(string(cgroup)))
	}
	fmt.Println("ready")
	select {
	case <-interrupted:
		fmt.Println("drained")
	case <-time.After(30 * time.Second):
	}
	os.Exit(0)
}

// The launcher a box really runs: a fork told only what this agent decided, inheriting nothing.
func TestExecLauncherSpawnsAChildThatInheritsNothing(t *testing.T) {
	t.Setenv("GROVE_PARENT_ONLY", "the agent's own secret")
	self, err := os.Executable()
	if err != nil {
		t.Fatalf("find this test binary: %v", err)
	}

	logs := NewRing(64)
	child, err := NewExecLauncher(self, Sandbox{}).Start(context.Background(), Spec{
		InstanceID:       "7c9e6679-7425-40de-944b-e07fc1f90ae7",
		GameID:           "6f1e5a3c-0b2d-4c8e-9a71-2f3b4c5d6e70",
		SessionID:        helperSession,
		Bind:             "127.0.0.1:30001",
		TicketPublicKeys: ticketKeys,
		ManagerToken:     storeToken,
	}, logs)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if child.Pid() <= 0 {
		t.Errorf("pid: got %d", child.Pid())
	}
	waitFor(t, "the child to report in", func() bool { return contains(logs.Lines(-1), "ready") })

	lines := logs.Lines(-1)
	for _, want := range []string{
		"env GROVE_BIND=127.0.0.1:30001",
		"env GROVE_TICKET_PUBLIC_KEYS=" + ticketKeys,
		"env GROVE_MANAGER_TOKEN=" + storeToken,
	} {
		if !contains(lines, want) {
			t.Errorf("the child was not told %q", want)
		}
	}
	for _, line := range lines {
		if strings.Contains(line, "GROVE_PARENT_ONLY") {
			t.Errorf("the child inherited the agent's environment: %s", line)
		}
	}

	// Windows has no SIGINT to send another process, so there the drain falls back to the kill.
	ended := make(chan error, 1)
	go func() { ended <- child.Wait() }()
	if runtime.GOOS == "windows" {
		if err := child.Kill(); err != nil {
			t.Fatalf("Kill: %v", err)
		}
	} else if err := child.Drain(); err != nil {
		t.Fatalf("Drain: %v", err)
	}
	select {
	case <-ended:
	case <-time.After(10 * time.Second):
		t.Fatal("the child outlived its ending")
	}
	if runtime.GOOS != "windows" && !contains(logs.Lines(-1), "drained") {
		t.Error("the child was ended without the drain its saves hang off")
	}
}

func TestExecLauncherRefusesABinaryThatIsNotThere(t *testing.T) {
	missing := t.TempDir() + "/grove-game-instance"
	if _, err := NewExecLauncher(missing, Sandbox{}).Start(context.Background(), Spec{}, NewRing(4)); err == nil {
		t.Fatal("a start with nothing to fork was accepted")
	}
}

// The kernel's answer is a loopback port nothing holds, which is the one a child is told to bind.
func TestFreePortIsOneAChildCanBindOnLoopback(t *testing.T) {
	port, err := freePort()
	if err != nil {
		t.Fatalf("freePort: %v", err)
	}
	listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		t.Fatalf("bind the port handed out: %v", err)
	}
	listener.Close()
}

func contains(lines []string, want string) bool {
	for _, line := range lines {
		if line == want {
			return true
		}
	}
	return false
}

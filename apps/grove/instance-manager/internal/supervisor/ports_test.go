package supervisor

import "testing"

// The kernel offers a port again the moment the listener that asked about it closes, and a child
// handed one does not bind it until it has booted, so two children would be sent to one address.
func TestAPortStaysIssuedUntilItIsGivenBack(t *testing.T) {
	offered := []int{41000, 41000, 41001, 41000}
	at := 0
	ports := newKernelPorts(func() (int, error) {
		at++
		return offered[at-1], nil
	})

	first, err := ports.Take()
	if err != nil {
		t.Fatalf("Take: %v", err)
	}
	second, err := ports.Take()
	if err != nil {
		t.Fatalf("second Take: %v", err)
	}

	if second == first {
		t.Fatalf("both children were sent to port %d", second)
	}
	if second != 41001 {
		t.Errorf("second port: got %d, want 41001", second)
	}

	// A port is free again once the process holding it has ended, or a long-lived box runs out.
	ports.Release(first)
	third, err := ports.Take()
	if err != nil {
		t.Fatalf("Take after Release: %v", err)
	}
	if third != first {
		t.Errorf("port after it was given back: got %d, want %d", third, first)
	}
}

func TestTakeGivesUpRatherThanReissueAPortInFlight(t *testing.T) {
	ports := newKernelPorts(func() (int, error) { return 41000, nil })
	if _, err := ports.Take(); err != nil {
		t.Fatalf("Take: %v", err)
	}

	if port, err := ports.Take(); err == nil {
		t.Errorf("a port already handed to a child was handed out again: %d", port)
	}
}

// A survivor of the last agent holds a port this run never handed out, and the kernel goes on
// offering that number until the child bound to it ends.
func TestAHeldPortIsNeverOfferedToAChildOfThisRun(t *testing.T) {
	offered := []int{41000, 41001}
	at := 0
	ports := newKernelPorts(func() (int, error) {
		at++
		return offered[at-1], nil
	})

	ports.Hold(41000)

	port, err := ports.Take()
	if err != nil {
		t.Fatalf("Take: %v", err)
	}
	if port != 41001 {
		t.Errorf("port: got %d, want 41001, since an adopted child is on 41000", port)
	}
}

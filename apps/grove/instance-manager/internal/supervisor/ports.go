// Which port a child binds. This box decides it, never the child.

package supervisor

import (
	"fmt"
	"net"
	"sync"
)

// How many times the kernel is asked before a port already in flight is taken as a wedged box
// rather than a coincidence.
const portAttempts = 32

// Ports hands out the port for one child to bind, and takes it back once that child has ended.
type Ports interface {
	Take() (int, error)
	// Hold marks a port issued that this run of the agent never handed out, for a child adopted
	// from the run that did.
	Hold(port int)
	Release(port int)
}

// A port stays issued from the moment it is handed out until the process holding it ends, because
// the kernel will offer it again in the window before that child has bound it.
type kernelPorts struct {
	free func() (int, error)

	mu     sync.Mutex
	issued map[int]struct{}
}

// NewKernelPorts asks the kernel which port is free rather than keeping a range of its own, which
// would drift from what is actually bound on the box the moment anything else claimed one.
func NewKernelPorts() Ports {
	return newKernelPorts(freePort)
}

func newKernelPorts(free func() (int, error)) *kernelPorts {
	return &kernelPorts{free: free, issued: make(map[int]struct{})}
}

func (p *kernelPorts) Take() (int, error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	for range portAttempts {
		port, err := p.free()
		if err != nil {
			return 0, err
		}
		if _, held := p.issued[port]; held {
			continue
		}
		p.issued[port] = struct{}{}
		return port, nil
	}
	return 0, fmt.Errorf("reserve a port: %d in a row were already issued", portAttempts)
}

func (p *kernelPorts) Hold(port int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.issued[port] = struct{}{}
}

func (p *kernelPorts) Release(port int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	delete(p.issued, port)
}

func freePort() (int, error) {
	listener, err := net.Listen("tcp", "0.0.0.0:0")
	if err != nil {
		return 0, fmt.Errorf("reserve a port: %w", err)
	}
	defer listener.Close()

	addr, ok := listener.Addr().(*net.TCPAddr)
	if !ok {
		return 0, fmt.Errorf("reserve a port: got a %T", listener.Addr())
	}
	return addr.Port, nil
}

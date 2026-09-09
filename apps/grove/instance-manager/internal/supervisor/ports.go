// Which port a child binds. This box decides it, never the child.

package supervisor

import (
	"fmt"
	"net"
)

// Ports hands out the port for one child to bind.
type Ports interface {
	Take() (int, error)
}

type kernelPorts struct{}

// NewKernelPorts asks the kernel which port is free rather than keeping a range of its own, which
// would drift from what is actually bound on the box the moment anything else claimed one.
func NewKernelPorts() Ports {
	return kernelPorts{}
}

func (kernelPorts) Take() (int, error) {
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

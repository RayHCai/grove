// Package box is what the machine itself has left, as the kernel reports it.
package box

import (
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

// Sampler reads the two machine numbers a heartbeat carries.
//
// Zero from both where the kernel publishes neither, which is honest rather than optimistic: the
// fleet's hard bound on a box is its instance cap, and these two only break ties between boxes.
type Sampler interface {
	Sample() (cpuLoad float64, memoryFreeBytes int64)
}

type procSampler struct{ root string }

// NewProcSampler reads /proc, which is where a Linux box keeps both numbers.
func NewProcSampler() Sampler {
	return procSampler{root: "/proc"}
}

func (s procSampler) Sample() (float64, int64) {
	return s.load(), s.available()
}

// Divided by the core count, so one number compares two boxes of different sizes, and ceilinged at
// fully loaded because the fleet router refuses any beat above 1.
func (s procSampler) load() float64 {
	fields := strings.Fields(s.read("loadavg"))
	if len(fields) == 0 {
		return 0
	}
	one, err := strconv.ParseFloat(fields[0], 64)
	if err != nil {
		return 0
	}
	return min(one/float64(runtime.NumCPU()), 1)
}

// MemAvailable rather than MemFree: the page cache is memory a process can have back, and MemFree
// alone reads as exhausted on a box that is merely warm.
func (s procSampler) available() int64 {
	for _, line := range strings.Split(s.read("meminfo"), "\n") {
		rest, ok := strings.CutPrefix(line, "MemAvailable:")
		if !ok {
			continue
		}
		fields := strings.Fields(rest)
		if len(fields) == 0 {
			return 0
		}
		kb, err := strconv.ParseInt(fields[0], 10, 64)
		if err != nil {
			return 0
		}
		return kb * 1024
	}
	return 0
}

func (s procSampler) read(name string) string {
	raw, err := os.ReadFile(filepath.Join(s.root, name))
	if err != nil {
		return ""
	}
	return string(raw)
}

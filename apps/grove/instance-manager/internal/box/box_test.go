package box

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func procRoot(t *testing.T, files map[string]string) string {
	t.Helper()

	dir := t.TempDir()
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o600); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
	return dir
}

func TestSampleReadsTheKernel(t *testing.T) {
	root := procRoot(t, map[string]string{
		"loadavg": "1.50 1.20 0.90 2/523 9182\n",
		"meminfo": "MemTotal:       16316360 kB\nMemFree:          213456 kB\nMemAvailable:    8192000 kB\n",
	})

	load, free := procSampler{root: root}.Sample()

	if want := min(1.50/float64(runtime.NumCPU()), 1); load != want {
		t.Errorf("load: got %v, want %v", load, want)
	}
	if free != 8192000*1024 {
		t.Errorf("memory free: got %d", free)
	}
}

// A box whose kernel publishes neither reports neither, rather than reporting itself idle.
func TestSampleIsZeroWithoutProc(t *testing.T) {
	cases := []struct {
		name  string
		files map[string]string
	}{
		{name: "no proc at all", files: map[string]string{}},
		{name: "an empty loadavg", files: map[string]string{"loadavg": "\n"}},
		{name: "meminfo without MemAvailable", files: map[string]string{"meminfo": "MemFree: 1 kB\n"}},
		{name: "a load that is not a number", files: map[string]string{"loadavg": "warm 1.20 0.90\n"}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			load, free := procSampler{root: procRoot(t, tc.files)}.Sample()

			if load != 0 || free != 0 {
				t.Errorf("got load %v and %d bytes free", load, free)
			}
		})
	}
}

// An overloaded box stays in the fleet: the router refuses any beat above 1, so the number the
// kernel reports has to be ceilinged before it leaves the box.
func TestLoadIsCeilingedAtFullyLoaded(t *testing.T) {
	root := procRoot(t, map[string]string{"loadavg": "9999.00 1.20 0.90 2/523 9182\n"})

	if load, _ := (procSampler{root: root}).Sample(); load != 1 {
		t.Errorf("load: got %v, want 1", load)
	}
}

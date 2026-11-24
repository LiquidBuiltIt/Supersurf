package main

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"
)

func procKB(t *testing.T, pid int, field string) int {
	t.Helper()
	raw, err := os.ReadFile(fmt.Sprintf("/proc/%d/status", pid))
	if err != nil {
		t.Skip("no /proc: memory test needs Linux")
	}
	m := regexp.MustCompile(field + `:\s+(\d+)`).FindStringSubmatch(string(raw))
	n, _ := strconv.Atoi(m[1])
	return n
}

// bigDaemon answers every request that carries params.n with a line of n bytes.
func bigDaemon(t *testing.T, sock string) *fakeDaemon {
	d := startFakeDaemon(t, sock)
	go func() {
		re := regexp.MustCompile(`"id":(\d+)`)
		nre := regexp.MustCompile(`"n":(\d+)`)
		for l := range d.Lines {
			id := re.FindSubmatch(l.b)
			n := nre.FindSubmatch(l.b)
			if id == nil || n == nil {
				continue
			}
			size, _ := strconv.Atoi(string(n[1]))
			d.Send(l.conn, `{"jsonrpc":"2.0","id":`+string(id[1])+`,"result":{"pad":"`+strings.Repeat("x", size)+`"}}`)
		}
	}()
	return d
}

// TestBigLineMemory runs the real shim and checks that big lines do not leave
// memory behind: the shim must stay near one line plus its idle size.
func TestBigLineMemory(t *testing.T) {
	if raceBuild {
		t.Skip("RSS is not meaningful under the race detector")
	}
	home := shortDir(t)
	os.MkdirAll(filepath.Join(home, ".supersurf"), 0o755)
	d := bigDaemon(t, filepath.Join(home, ".supersurf", "daemon.sock"))

	exe, _ := os.Executable()
	cmd := exec.Command(exe, "__shim__")
	cmd.Env = []string{"HOME=" + home, "PATH=" + os.Getenv("PATH")}
	in, _ := cmd.StdinPipe()
	outPipe, _ := cmd.StdoutPipe()
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { in.Close(); cmd.Wait() })
	d.WaitReg(3 * time.Second)
	time.Sleep(100 * time.Millisecond)
	out := bufio.NewReaderSize(outPipe, 1<<20)

	next := 100
	call := func(n int, pad int) {
		next++
		fmt.Fprintf(in, `{"jsonrpc":"2.0","id":%d,"method":"tools/call","params":{"n":%d,"pad":"%s"}}`+"\n", next, n, strings.Repeat("y", pad))
		line, err := out.ReadBytes('\n')
		if err != nil || len(line) < n {
			t.Fatalf("short answer (%d bytes, %v) for a %d byte line", len(line), err, n)
		}
	}

	call(10, 0)
	time.Sleep(100 * time.Millisecond)
	idle := procKB(t, cmd.Process.Pid, "VmRSS")

	call(742_000, 0)
	time.Sleep(100 * time.Millisecond)
	peak742 := procKB(t, cmd.Process.Pid, "VmHWM")

	for i := 0; i < 20; i++ {
		call(5_000_000, 5_000_000) // a 5 MB request and a 5 MB answer
	}
	peak5 := procKB(t, cmd.Process.Pid, "VmHWM")
	time.Sleep(3 * time.Second)
	after := procKB(t, cmd.Process.Pid, "VmRSS")
	t.Logf("idle %d kB, HWM after 742k %d kB, HWM after 5 MB x20 %d kB, RSS 3 s after %d kB", idle, peak742, peak5, after)

	const line5 = 5000 // kB
	if peak742-idle > 4*742 {
		t.Errorf("742k line grew the shim by %d kB (limit %d kB)", peak742-idle, 4*742)
	}
	if peak5-idle > 3*line5 {
		t.Errorf("5 MB line grew the shim by %d kB (limit %d kB)", peak5-idle, 3*line5)
	}
	if after-idle > line5/2 {
		t.Errorf("RSS stayed %d kB above idle 3 s after the last big line (limit %d kB)", after-idle, line5/2)
	}
}

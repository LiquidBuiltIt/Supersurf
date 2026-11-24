package main

import (
	"bufio"
	"encoding/json"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// TestMain doubles as the fake daemon and the real shim binary for the
// process-level tests: the test binary re-executes itself.
func TestMain(m *testing.M) {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "__fake_daemon__":
			fakeDaemonMain(os.Args[2:])
			return
		case "__shim__":
			os.Exit(run(os.Args[2:], os.Stdin, os.Stdout, os.Stderr))
		}
	}
	os.Exit(m.Run())
}

// shortDir returns a short temp dir: unix socket paths are limited to ~104 bytes.
func shortDir(t *testing.T) string {
	t.Helper()
	d, err := os.MkdirTemp("", "ss")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(d) })
	return d
}

// ---- in-process fake daemon ----

type fline struct {
	conn int
	b    []byte
}

type fakeDaemon struct {
	t    *testing.T
	l    net.Listener
	Path string

	mu    sync.Mutex
	conns []net.Conn
	reply func(reg map[string]any) string // answers a shim_register; nil means a plain shim_ack
	Regs  chan map[string]any
	Lines chan fline
}

func startFakeDaemon(t *testing.T, path string) *fakeDaemon {
	t.Helper()
	l, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	d := &fakeDaemon{t: t, l: l, Path: path, Regs: make(chan map[string]any, 64), Lines: make(chan fline, 256)}
	t.Cleanup(d.Close)
	go d.accept()
	return d
}

func (d *fakeDaemon) Close() {
	d.l.Close()
	d.mu.Lock()
	for _, c := range d.conns {
		c.Close()
	}
	d.mu.Unlock()
}

func (d *fakeDaemon) accept() {
	for {
		c, err := d.l.Accept()
		if err != nil {
			return
		}
		d.mu.Lock()
		d.conns = append(d.conns, c)
		idx := len(d.conns) - 1
		d.mu.Unlock()
		go d.serve(idx, c)
	}
}

func (d *fakeDaemon) serve(idx int, c net.Conn) {
	br := bufio.NewReaderSize(c, 1<<20) // not the shim's reader: a partial line must show up here
	first, err := br.ReadBytes('\n')
	if err != nil {
		return
	}
	var reg map[string]any
	json.Unmarshal(first, &reg)
	d.Regs <- reg
	reply := `{"type":"shim_ack","protocol":1,"version":"test"}`
	d.mu.Lock()
	fn := d.reply
	d.mu.Unlock()
	if fn != nil {
		reply = fn(reg)
	}
	c.Write([]byte(reply + "\n"))
	if !strings.Contains(reply, "shim_ack") {
		c.Close()
		return
	}
	for {
		line, err := br.ReadBytes('\n')
		if len(line) > 0 {
			d.Lines <- fline{idx, line} // a line cut short has no newline
		}
		if err != nil {
			return
		}
	}
}

func (d *fakeDaemon) SetReply(fn func(map[string]any) string) {
	d.mu.Lock()
	d.reply = fn
	d.mu.Unlock()
}

func (d *fakeDaemon) conn(i int) net.Conn {
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		d.mu.Lock()
		if i < len(d.conns) {
			c := d.conns[i]
			d.mu.Unlock()
			return c
		}
		d.mu.Unlock()
		time.Sleep(5 * time.Millisecond)
	}
	d.t.Fatalf("daemon connection %d never arrived", i)
	return nil
}

func (d *fakeDaemon) Send(i int, line string) { d.conn(i).Write([]byte(line + "\n")) }
func (d *fakeDaemon) Drop(i int)              { d.conn(i).Close() }

func (d *fakeDaemon) WaitReg(timeout time.Duration) map[string]any {
	d.t.Helper()
	select {
	case r := <-d.Regs:
		return r
	case <-time.After(timeout):
		d.t.Fatal("no shim_register arrived")
	}
	return nil
}

// NextLine returns the next MCP line the daemon received.
func (d *fakeDaemon) NextLine(timeout time.Duration) (fline, bool) {
	select {
	case l := <-d.Lines:
		return l, true
	case <-time.After(timeout):
		return fline{}, false
	}
}

// ---- relay rig ----

type syncBuf struct {
	mu    sync.Mutex
	lines []string
	part  string
}

func (s *syncBuf) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.part += string(p)
	for {
		i := strings.IndexByte(s.part, '\n')
		if i < 0 {
			break
		}
		s.lines = append(s.lines, s.part[:i])
		s.part = s.part[i+1:]
	}
	return len(p), nil
}

func (s *syncBuf) find(sub string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, l := range s.lines {
		if strings.Contains(l, sub) {
			return l, true
		}
	}
	return "", false
}

type rig struct {
	t     *testing.T
	in    *io.PipeWriter
	out   *syncBuf
	relay *Relay
	done  chan struct{}
}

func newRig(t *testing.T, cfg Config) *rig {
	t.Helper()
	if cfg.Backoff0 == 0 {
		cfg.Backoff0 = 20 * time.Millisecond
		cfg.BackoffMax = 100 * time.Millisecond
	}
	if cfg.SessionID == "" {
		cfg.SessionID = "shim-test"
	}
	pr, pw := io.Pipe()
	g := &rig{t: t, in: pw, out: &syncBuf{}, done: make(chan struct{})}
	g.relay = NewRelay(cfg, g.out)
	go func() { g.relay.Run(pr); close(g.done) }()
	t.Cleanup(func() { pw.Close() })
	return g
}

func (g *rig) Send(s string) { g.in.Write([]byte(s + "\n")) }

func (g *rig) WaitOut(sub string, timeout time.Duration) string {
	g.t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if l, ok := g.out.find(sub); ok {
			return l
		}
		time.Sleep(5 * time.Millisecond)
	}
	g.out.mu.Lock()
	defer g.out.mu.Unlock()
	g.t.Fatalf("client never got a line containing %q; got %q", sub, g.out.lines)
	return ""
}

func (g *rig) NoOut(sub string, d time.Duration) {
	g.t.Helper()
	time.Sleep(d)
	if l, ok := g.out.find(sub); ok {
		g.t.Fatalf("client got an unexpected line %q", l)
	}
}

func mustJSON(t *testing.T, s string) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(s), &m); err != nil {
		t.Fatalf("not valid JSON: %v: %q", err, s)
	}
	return m
}

// ---- fake daemon as a process (the spawn tests) ----

// fakeDaemonMain listens on $HOME/.supersurf/daemon.sock, records its argv and
// the names of its env, and acks every shim_register. argv: <main> --port N ...
func fakeDaemonMain(args []string) {
	home := os.Getenv("HOME")
	rec := filepath.Join(home, "fake-daemon")
	os.MkdirAll(rec, 0o755)
	os.WriteFile(filepath.Join(rec, "pid"), []byte(strconv.Itoa(os.Getpid())), 0o644)
	os.WriteFile(filepath.Join(rec, "args"), []byte(strings.Join(args, " ")), 0o644)
	var names []string
	for _, kv := range os.Environ() {
		names = append(names, kv[:strings.IndexByte(kv, '=')])
	}
	os.WriteFile(filepath.Join(rec, "envnames"), []byte(strings.Join(names, "\n")), 0o644)
	if os.Getenv("FAKE_DAEMON_FAIL") != "" || fileExists(filepath.Join(home, "fake-fail")) {
		os.Stderr.WriteString("Error: listen EADDRINUSE: address already in use 127.0.0.1:5999\n")
		os.Exit(1)
	}
	if fileExists(filepath.Join(home, "fake-hang")) {
		time.Sleep(time.Hour)
	}
	sock := filepath.Join(home, ".supersurf", "daemon.sock")
	os.MkdirAll(filepath.Dir(sock), 0o755)
	os.Remove(sock)
	l, err := net.Listen("unix", sock)
	if err != nil {
		os.Exit(1)
	}
	n := 0
	if f, err := os.OpenFile(filepath.Join(rec, "starts"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644); err == nil {
		f.WriteString("x\n")
		f.Close()
	}
	for {
		c, err := l.Accept()
		if err != nil {
			return
		}
		n++
		go func() {
			r := bufio.NewReader(c)
			if line, err := r.ReadBytes('\n'); err == nil && strings.Contains(string(line), "shim_register") {
				c.Write([]byte(`{"type":"shim_ack","protocol":1}` + "\n"))
				io.Copy(io.Discard, r)
			}
			c.Close()
		}()
	}
}

func fileExists(p string) bool { _, err := os.Stat(p); return err == nil }

// fakeNode writes a /bin/sh script that runs the fake daemon. The shim scrubs
// the daemon's env, so the script carries the test binary path itself.
func fakeNode(t *testing.T, dir string) string {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, "node")
	if err := os.WriteFile(p, []byte("#!/bin/sh\nexec '"+exe+"' __fake_daemon__ \"$@\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

// fakePackage writes a package dir that Ensure can install.
func fakePackage(t *testing.T, dir, version string) string {
	t.Helper()
	os.MkdirAll(filepath.Join(dir, "dist"), 0o755)
	os.WriteFile(filepath.Join(dir, "package.json"), []byte(`{"name":"supersurf-daemon","version":"`+version+`","main":"dist/main.js"}`), 0o644)
	os.WriteFile(filepath.Join(dir, "dist", "main.js"), []byte("// fake\n"), 0o644)
	return dir
}

// killFakeDaemon ends the fake daemon this test's HOME started, by its recorded pid.
func killFakeDaemon(t *testing.T, home string) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(home, "fake-daemon", "pid"))
	if err != nil {
		return
	}
	if pid, err := strconv.Atoi(strings.TrimSpace(string(raw))); err == nil && pid > 1 {
		syscall.Kill(pid, syscall.SIGTERM)
	}
}

// WaitUp waits for the daemon to see the registration and for the relay to
// publish the connection: a call sent earlier is answered locally, not relayed.
func (g *rig) WaitUp(d *fakeDaemon) map[string]any {
	g.t.Helper()
	reg := d.WaitReg(2 * time.Second)
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		g.relay.mu.Lock()
		up := g.relay.conn != nil
		g.relay.mu.Unlock()
		if up {
			return reg
		}
		time.Sleep(2 * time.Millisecond)
	}
	g.t.Fatal("the relay never published the connection")
	return nil
}

func (g *rig) WaitCause(sub string) {
	g.t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		g.relay.mu.Lock()
		c := g.relay.cause
		g.relay.mu.Unlock()
		if strings.Contains(c, sub) {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	g.t.Fatalf("cause never contained %q", sub)
}

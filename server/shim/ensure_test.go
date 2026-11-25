package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

var t0 = time.UnixMilli(1_800_000_000_000)

func rec(outcome, ver string, ago time.Duration) spawnRec {
	return spawnRec{TS: t0.Add(-ago).UnixMilli(), EntryVersion: ver, Outcome: outcome}
}

func TestPlanEntry(t *testing.T) {
	cur := func(v string) *entry { return &entry{Node: "/n", Main: "/m", Version: v} }
	cases := []struct {
		name     string
		cur      *entry
		cand     string
		explicit bool
		recs     []spawnRec
		write    bool
		clear    bool
		cause    bool
	}{
		{"no entry, candidate", nil, "5.0.0", false, nil, true, false, false},
		{"newer candidate replaces", cur("5.0.0"), "5.1.0", false, nil, true, false, false},
		{"never moves to an older version", cur("5.1.0"), "5.0.0", false, nil, false, false, false},
		{"same version is not rewritten", cur("5.1.0"), "5.1.0", false, nil, false, false, false},
		{"explicit install does not downgrade either", cur("5.1.0"), "5.0.0", true, nil, false, false, false},
		{"prerelease is older than its release", cur("5.0.0"), "5.0.0-rc.1", false, nil, false, false, false},
		{"banned version is not written", cur("5.0.0"), "5.1.0", false, []spawnRec{rec("handoff_failed", "5.1.0", time.Hour)}, false, false, false},
		{"banned and no entry names the cause", nil, "5.1.0", false, []spawnRec{rec("handoff_failed", "5.1.0", time.Hour)}, false, false, true},
		{"ban expires after 24 h", cur("5.0.0"), "5.1.0", false, []spawnRec{rec("handoff_failed", "5.1.0", 25*time.Hour)}, true, false, false},
		{"ban_cleared lifts the ban", cur("5.0.0"), "5.1.0", false, []spawnRec{rec("handoff_failed", "5.1.0", 2*time.Hour), rec("ban_cleared", "5.1.0", time.Hour)}, true, false, false},
		{"a later failure bans again", cur("5.0.0"), "5.1.0", false, []spawnRec{rec("handoff_failed", "5.1.0", 3*time.Hour), rec("ban_cleared", "5.1.0", 2*time.Hour), rec("handoff_failed", "5.1.0", time.Hour)}, false, false, false},
		{"ban on another version is irrelevant", cur("5.0.0"), "5.1.0", false, []spawnRec{rec("handoff_failed", "5.2.0", time.Hour)}, true, false, false},
		{"explicit install clears the ban", cur("5.0.0"), "5.1.0", true, []spawnRec{rec("handoff_failed", "5.1.0", time.Hour)}, true, true, false},
		{"nothing to install and no entry", nil, "", false, nil, false, false, true},
		{"nothing to install, entry usable", cur("5.0.0"), "", false, nil, false, false, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			p := planEntry(c.cur, c.cand, c.explicit, c.recs, t0)
			if p.Write != c.write || p.ClearBan != c.clear || (p.Cause != "") != c.cause {
				t.Fatalf("got %+v", p)
			}
		})
	}
}

func TestBudgetWait(t *testing.T) {
	f := func(ago time.Duration) spawnRec { return rec("fail", "5.0.0", ago) }
	if w := budgetWait([]spawnRec{f(3 * time.Second), f(2 * time.Second)}, t0); w != 0 {
		t.Fatalf("two failures must not limit: %v", w)
	}
	three := []spawnRec{f(9 * time.Second), f(6 * time.Second), f(3 * time.Second)}
	if w := budgetWait(three, t0); w < 26*time.Second || w > 28*time.Second {
		t.Fatalf("after three failures wait ~27 s, got %v", w)
	}
	if w := budgetWait(three, t0.Add(time.Minute)); w != 0 {
		t.Fatalf("after 30 s one attempt is allowed: %v", w)
	}
	ok := []spawnRec{f(9 * time.Second), f(8 * time.Second), f(7 * time.Second), rec("ok", "5.0.0", 6*time.Second)}
	if w := budgetWait(ok, t0); w != 0 {
		t.Fatalf("a success resets the count: %v", w)
	}
	mixed := []spawnRec{f(9 * time.Second), f(8 * time.Second), rec("handoff_failed", "5.0.0", 7*time.Second), f(6 * time.Second)}
	if w := budgetWait(mixed, t0); w == 0 {
		t.Fatal("hand-off records are not spawn attempts and must not reset the count")
	}
}

type ensureRig struct {
	home, bin string
	opts      EnsureOpts
}

func newEnsureRig(t *testing.T, ver string) *ensureRig {
	t.Helper()
	home := shortDir(t)
	bin := shortDir(t)
	r := &ensureRig{home: home, bin: bin}
	t.Setenv("HOME", home) // the spawned daemon inherits HOME, as in real use
	r.opts = EnsureOpts{
		Home: home, Port: 5999, NodePath: fakeNode(t, bin),
		BundledDir:   fakePackage(t, filepath.Join(bin, "pkg"), ver),
		StartTimeout: 5 * time.Second, LockTimeout: 5 * time.Second,
	}
	t.Cleanup(func() { killFakeDaemon(t, home) })
	return r
}

func (r *ensureRig) starts() int {
	raw, _ := os.ReadFile(filepath.Join(r.home, "fake-daemon", "starts"))
	return strings.Count(string(raw), "x")
}

func TestEnsureInstallsWritesEntryAndSpawns(t *testing.T) {
	r := newEnsureRig(t, "5.0.0")
	if err := Ensure(r.opts); err != nil {
		t.Fatal(err)
	}
	dir := daemonDir(r.home)
	raw, err := os.ReadFile(filepath.Join(dir, "entry"))
	if err != nil {
		t.Fatal(err)
	}
	var e entry
	if json.Unmarshal(raw, &e) != nil || e.Version != "5.0.0" || !filepath.IsAbs(e.Node) || !filepath.IsAbs(e.Main) ||
		!strings.Contains(e.Main, filepath.Join("versions", "5.0.0")) || !fileExists(e.Main) {
		t.Fatalf("entry: %s", raw)
	}
	if recs := readSpawns(dir); len(recs) != 1 || recs[0].Outcome != "ok" || recs[0].EntryVersion != "5.0.0" || recs[0].PID == 0 {
		t.Fatalf("spawns.jsonl: %+v", recs)
	}
	args, _ := os.ReadFile(filepath.Join(r.home, "fake-daemon", "args"))
	if !strings.Contains(string(args), "--port 5999") || !strings.Contains(string(args), "--spawned-by=shim") || strings.Contains(string(args), "--debug") {
		t.Fatalf("daemon argv: %s", args)
	}
	if r.starts() != 1 {
		t.Fatalf("starts = %d", r.starts())
	}
}

// The daemon is started with no SUPERSURF_* and none of the agent's other env.
func TestEnsureScrubsEnvironment(t *testing.T) {
	t.Setenv("SUPERSURF_EXPERIMENTS", "x")
	t.Setenv("SUPERSURF_PORT", "1")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "s3cret")
	t.Setenv("LC_ALL", "C")
	r := newEnsureRig(t, "5.0.0")
	if err := Ensure(r.opts); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(filepath.Join(r.home, "fake-daemon", "envnames"))
	names := string(raw)
	for _, bad := range []string{"SUPERSURF_", "AWS_SECRET"} {
		if strings.Contains(names, bad) {
			t.Fatalf("daemon env leaked %s*: %s", bad, names)
		}
	}
	if !strings.Contains(names, "HOME") || !strings.Contains(names, "LC_ALL") {
		t.Fatalf("daemon env lost HOME/LC_*: %s", names)
	}
}

func TestEnsureDebugFlagReachesDaemon(t *testing.T) {
	r := newEnsureRig(t, "5.0.0")
	r.opts.Debug = true
	if err := Ensure(r.opts); err != nil {
		t.Fatal(err)
	}
	if args, _ := os.ReadFile(filepath.Join(r.home, "fake-daemon", "args")); !strings.Contains(string(args), "--debug") {
		t.Fatalf("argv: %s", args)
	}
}

func TestEnsureDoesNotSpawnWhenDaemonIsUp(t *testing.T) {
	r := newEnsureRig(t, "5.0.0")
	os.MkdirAll(supersurfDir(r.home), 0o700)
	d := startFakeDaemon(t, sockPath(r.home))
	defer d.Close()
	if err := Ensure(r.opts); err != nil {
		t.Fatal(err)
	}
	if r.starts() != 0 || len(readSpawns(daemonDir(r.home))) != 0 {
		t.Fatal("ensure spawned a second daemon")
	}
}

// Many shims at once: the flock lets exactly one spawn.
func TestEnsureLockGivesOneSpawn(t *testing.T) {
	r := newEnsureRig(t, "5.0.0")
	var wg sync.WaitGroup
	errs := make([]error, 8)
	for i := range errs {
		wg.Add(1)
		go func() { defer wg.Done(); errs[i] = Ensure(r.opts) }()
	}
	wg.Wait()
	for _, e := range errs {
		if e != nil {
			t.Fatal(e)
		}
	}
	if r.starts() != 1 {
		t.Fatalf("daemon started %d times, want 1", r.starts())
	}
}

func TestEnsureReportsEADDRINUSEFromStartupLog(t *testing.T) {
	r := newEnsureRig(t, "5.0.0")
	os.WriteFile(filepath.Join(r.home, "fake-fail"), nil, 0o644)
	err := Ensure(r.opts)
	if err == nil || !strings.Contains(err.Error(), "EADDRINUSE") || !strings.Contains(err.Error(), "5999") {
		t.Fatalf("error: %v", err)
	}
	if recs := readSpawns(daemonDir(r.home)); len(recs) != 1 || recs[0].Outcome != "fail" {
		t.Fatalf("spawns: %+v", recs)
	}
}

func TestEnsureBudgetStopsRespawnLoop(t *testing.T) {
	r := newEnsureRig(t, "5.0.0")
	os.WriteFile(filepath.Join(r.home, "fake-fail"), nil, 0o644)
	for i := 0; i < 3; i++ {
		Ensure(r.opts)
	}
	if r.starts() != 0 || len(readSpawns(daemonDir(r.home))) != 3 {
		t.Fatalf("setup: %+v", readSpawns(daemonDir(r.home)))
	}
	err := Ensure(r.opts)
	if err == nil || !strings.Contains(err.Error(), "next attempt is allowed") {
		t.Fatalf("the fourth start must be held back: %v", err)
	}
	if n := len(readSpawns(daemonDir(r.home))); n != 3 {
		t.Fatalf("a held-back start still spawned (%d records)", n)
	}
	// after the wait, one attempt goes through
	r.opts.Now = func() time.Time { return time.Now().Add(31 * time.Second) }
	os.Remove(filepath.Join(r.home, "fake-fail"))
	if err := Ensure(r.opts); err != nil {
		t.Fatalf("after 30 s: %v", err)
	}
}

func TestEnsureDoesNotDowngradeEntry(t *testing.T) {
	r := newEnsureRig(t, "5.0.0")
	dir := daemonDir(r.home)
	os.MkdirAll(dir, 0o700)
	newer := fakePackage(t, filepath.Join(r.bin, "newer"), "5.1.0")
	r.opts.InstallDir = newer
	if err := Ensure(r.opts); err != nil {
		t.Fatal(err)
	}
	r.opts.InstallDir = ""
	if e := readEntry(dir); e == nil || e.Version != "5.1.0" {
		t.Fatalf("setup: %+v", e)
	}
	// the bundled 5.0.0 shim must leave the 5.1.0 entry alone
	if err := Ensure(r.opts); err != nil {
		t.Fatal(err)
	}
	if e := readEntry(dir); e.Version != "5.1.0" {
		t.Fatalf("entry moved to %s", e.Version)
	}
}

func TestEnsureHonoursBanAndInstallClearsIt(t *testing.T) {
	r := newEnsureRig(t, "5.1.0")
	dir := daemonDir(r.home)
	os.MkdirAll(dir, 0o700)
	os.WriteFile(filepath.Join(dir, "entry"), []byte(`{"node":"`+r.opts.NodePath+`","main":"`+filepath.Join(r.bin, "pkg", "dist", "main.js")+`","version":"5.0.0"}`), 0o600)
	appendSpawn(dir, spawnRec{TS: time.Now().Add(-time.Hour).UnixMilli(), EntryVersion: "5.1.0", Outcome: "handoff_failed"})
	os.MkdirAll(supersurfDir(r.home), 0o700)
	d := startFakeDaemon(t, sockPath(r.home))
	defer d.Close()

	if err := Ensure(r.opts); err != nil {
		t.Fatal(err)
	}
	if e := readEntry(dir); e.Version != "5.0.0" {
		t.Fatalf("a banned version was written: %s", e.Version)
	}
	r.opts.InstallDir = r.opts.BundledDir
	if err := Ensure(r.opts); err != nil {
		t.Fatal(err)
	}
	if e := readEntry(dir); e.Version != "5.1.0" {
		t.Fatalf("--install did not take: %s", e.Version)
	}
	recs := readSpawns(dir)
	if recs[len(recs)-1].Outcome != "ban_cleared" {
		t.Fatalf("--install must record ban_cleared: %+v", recs)
	}
}

func TestEnsureNoEntryNoPackageGivesCause(t *testing.T) {
	r := newEnsureRig(t, "5.0.0")
	r.opts.BundledDir = ""
	err := Ensure(r.opts)
	if err == nil || !strings.Contains(err.Error(), "entry is missing") {
		t.Fatalf("error: %v", err)
	}
}

func TestParseArgs(t *testing.T) {
	a, err := parseArgs([]string{"ensure", "--install", "/p", "--node", "/n", "--port", "6000", "--debug"})
	if err != nil || !a.ensure || a.installDir != "/p" || a.nodePath != "/n" || a.port != 6000 || !a.debug {
		t.Fatalf("%+v %v", a, err)
	}
	a, err = parseArgs([]string{"--multi-agent", "--disable-secure-eval", "--disable-playbook-eval"})
	if err != nil || a.ensure || !a.multiAgent || !a.disableSecureEval || !a.disablePlaybookEval {
		t.Fatalf("%+v %v", a, err)
	}
	if _, err := parseArgs([]string{"--port"}); err == nil {
		t.Fatal("a flag without its value must fail")
	}
	if _, err := parseArgs([]string{"--log-file", "x", "--bogus"}); err != nil {
		t.Fatalf("unknown flags from an older MCP config must be ignored: %v", err)
	}
}

// Only a supersurf-daemon package with a plain version may be installed; the
// version names a directory under versions/.
func TestEnsureRefusesForeignOrUnsafePackage(t *testing.T) {
	for _, pkg := range []string{
		`{"name":"supersurf-server-linux-x64","version":"5.0.0"}`,
		`{"name":"supersurf-daemon","version":"../../escape"}`,
	} {
		r := newEnsureRig(t, "5.0.0")
		src := t.TempDir()
		os.WriteFile(filepath.Join(src, "package.json"), []byte(pkg), 0o644)
		r.opts.BundledDir, r.opts.InstallDir = "", src
		if err := Ensure(r.opts); err == nil || !strings.Contains(err.Error(), "not a supersurf-daemon package") {
			t.Fatalf("%s: error %v", pkg, err)
		}
	}
}

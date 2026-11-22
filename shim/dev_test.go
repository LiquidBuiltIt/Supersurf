package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeClone writes a dev clone root that devClone accepts.
func fakeClone(t *testing.T) string {
	t.Helper()
	root := shortDir(t)
	os.WriteFile(filepath.Join(root, "package.json"), []byte(`{"name":"supersurf"}`), 0o644)
	mkdirs(t, filepath.Join(root, "daemon", "dist"))
	os.WriteFile(filepath.Join(root, "daemon", "dist", "main.js"), []byte("// fake\n"), 0o644)
	return root
}

func TestDevClone(t *testing.T) {
	root := fakeClone(t)
	if got, problem := devClone(root); got != root || problem != "" {
		t.Fatalf("devClone(valid) = %q, %q", got, problem)
	}
	if got, problem := devClone(""); got != "" || problem != "" {
		t.Fatalf("devClone(unset) = %q, %q", got, problem)
	}
	notRepo := shortDir(t)
	os.WriteFile(filepath.Join(notRepo, "package.json"), []byte(`{"name":"other"}`), 0o644)
	noBuild := shortDir(t)
	os.WriteFile(filepath.Join(noBuild, "package.json"), []byte(`{"name":"supersurf"}`), 0o644)
	for dir, want := range map[string]string{
		shortDir(t): "no readable package.json",
		notRepo:     `package.json name is "other"`,
		noBuild:     "daemon/dist/main.js is missing",
	} {
		got, problem := devClone(dir)
		if got != "" || !strings.Contains(problem, want) {
			t.Fatalf("devClone(%s) = %q, %q; want a problem containing %q", dir, got, problem, want)
		}
	}
}

func devFiles(t *testing.T, home string) []string {
	t.Helper()
	var out []string
	for _, n := range []string{"entry", "versions"} {
		if fileExists(filepath.Join(daemonDir(home), n)) {
			out = append(out, n)
		}
	}
	return out
}

// In a dev clone Ensure writes no entry and no versions/, and runs the clone's main.js.
func TestEnsureDevWritesNoEntryAndSpawnsClone(t *testing.T) {
	t.Setenv("SUPERSURF_EXPERIMENTS", "x")
	t.Setenv("SUPERSURF_PORT", "1")
	r := newEnsureRig(t, "5.0.0")
	clone := fakeClone(t)
	r.opts.DevRoot = clone
	r.opts.Debug = true
	if err := Ensure(r.opts); err != nil {
		t.Fatal(err)
	}
	if f := devFiles(t, r.home); len(f) != 0 {
		t.Fatalf("dev wrote %v", f)
	}
	args, _ := os.ReadFile(filepath.Join(r.home, "fake-daemon", "args"))
	want := filepath.Join(clone, "daemon", "dist", "main.js") + " --port 5999 --spawned-by=shim --debug"
	if string(args) != want {
		t.Fatalf("daemon argv = %q, want %q", args, want)
	}
	raw, _ := os.ReadFile(filepath.Join(r.home, "fake-daemon", "envnames"))
	for _, n := range strings.Split(string(raw), "\n") {
		if strings.HasPrefix(n, "SUPERSURF_") && n != "SUPERSURF_DEV_ENVIRONMENT" {
			t.Fatalf("daemon env leaked %s", n)
		}
	}
	if !strings.Contains(string(raw), "SUPERSURF_DEV_ENVIRONMENT") || !strings.Contains(string(raw), "HOME") {
		t.Fatalf("daemon env lost SUPERSURF_DEV_ENVIRONMENT or HOME: %s", raw)
	}
	recs := readSpawns(daemonDir(r.home))
	if len(recs) != 1 || recs[0].Outcome != "ok" {
		t.Fatalf("spawns.jsonl: %+v", recs)
	}
}

// Outside dev the daemon gets no SUPERSURF_DEV_ENVIRONMENT, even when the shim's env has it.
func TestEnsureNormalPathNeverPassesDevEnv(t *testing.T) {
	t.Setenv("SUPERSURF_DEV_ENVIRONMENT", "/nope")
	r := newEnsureRig(t, "5.0.0")
	if err := Ensure(r.opts); err != nil {
		t.Fatal(err)
	}
	if raw, _ := os.ReadFile(filepath.Join(r.home, "fake-daemon", "envnames")); strings.Contains(string(raw), "SUPERSURF_") {
		t.Fatalf("daemon env: %s", raw)
	}
}

// Dev keeps the spawn lock's G1 budget.
func TestEnsureDevKeepsBudget(t *testing.T) {
	r := newEnsureRig(t, "5.0.0")
	r.opts.DevRoot = fakeClone(t)
	os.WriteFile(filepath.Join(r.home, "fake-fail"), nil, 0o644)
	for i := 0; i < budgetFails; i++ {
		if err := Ensure(r.opts); err == nil {
			t.Fatal("the failing daemon must fail Ensure")
		}
	}
	err := Ensure(r.opts)
	if err == nil || !strings.Contains(err.Error(), "next attempt is allowed") {
		t.Fatalf("fourth call: %v", err)
	}
	if r.starts() != 0 || len(readSpawns(daemonDir(r.home))) != budgetFails {
		t.Fatalf("the budget must stop the fourth spawn: %+v", readSpawns(daemonDir(r.home)))
	}
}

func devRun(t *testing.T, devEnv string, args ...string) (int, string, *ensureRig) {
	t.Helper()
	r := newEnsureRig(t, "5.0.0") // sets HOME
	t.Setenv("SUPERSURF_DEV_ENVIRONMENT", devEnv)
	var stderr bytes.Buffer
	code := run(append(args, "--port", "5999", "--node", r.opts.NodePath), strings.NewReader(""), &bytes.Buffer{}, &stderr)
	return code, stderr.String(), r
}

// A leftover entry (from an installed version) is removed in dev, so the daemon's hand-off
// (`readEntry() ?? self`) runs its own main.js and D3 sees no newer entry. versions/ stays.
func TestEnsureDevRemovesLeftoverEntry(t *testing.T) {
	r := newEnsureRig(t, "5.0.0")
	clone := fakeClone(t)
	r.opts.DevRoot = clone
	dir := daemonDir(r.home)
	mkdirs(t, dir)
	main := filepath.Join(r.home, "old-main.js")
	os.WriteFile(main, []byte("// old\n"), 0o644)
	os.WriteFile(filepath.Join(dir, "entry"), []byte(`{"node":"`+r.opts.NodePath+`","main":"`+main+`","version":"9.9.9"}`), 0o600)
	marker := filepath.Join(dir, "versions", "9.9.9", "marker")
	mkdirs(t, filepath.Dir(marker))
	os.WriteFile(marker, []byte("x"), 0o644)
	var note bytes.Buffer
	r.opts.Stderr = &note
	if err := Ensure(r.opts); err != nil {
		t.Fatal(err)
	}
	if fileExists(filepath.Join(dir, "entry")) {
		t.Fatal("dev ensure left the entry in place")
	}
	if !fileExists(marker) {
		t.Fatal("dev ensure touched versions/")
	}
	if !strings.Contains(note.String(), "removed a leftover entry (9.9.9)") {
		t.Fatalf("note: %q", note.String())
	}
	if args, _ := os.ReadFile(filepath.Join(r.home, "fake-daemon", "args")); !strings.HasPrefix(string(args), filepath.Join(clone, "daemon", "dist", "main.js")+" ") {
		t.Fatalf("daemon argv: %s", args)
	}
}

// `ensure --install <root>` (the restart path) installs nothing in dev: the hand-off then
// runs the dev daemon's own main.js, because dev ensure also removes any leftover entry.
func TestRunEnsureInstallIgnoredInDev(t *testing.T) {
	clone := fakeClone(t)
	pkg := fakePackage(t, filepath.Join(shortDir(t), "pkg"), "9.9.9")
	code, stderr, r := devRun(t, clone, "ensure", "--install", pkg)
	if code != 0 {
		t.Fatalf("exit %d: %s", code, stderr)
	}
	if !strings.Contains(stderr, "--install is ignored") {
		t.Fatalf("stderr: %q", stderr)
	}
	if f := devFiles(t, r.home); len(f) != 0 {
		t.Fatalf("dev wrote %v", f)
	}
	if args, _ := os.ReadFile(filepath.Join(r.home, "fake-daemon", "args")); !strings.HasPrefix(string(args), filepath.Join(clone, "daemon", "dist", "main.js")+" ") {
		t.Fatalf("daemon argv: %s", args)
	}
}

// A bad dev root says why on stderr and the normal path runs (here it installs the
// package named by --install, which dev would have ignored).
func TestRunBadDevRootFallsBackToNormalPath(t *testing.T) {
	pkg := fakePackage(t, filepath.Join(shortDir(t), "pkg"), "9.9.9")
	code, stderr, r := devRun(t, shortDir(t), "ensure", "--install", pkg)
	if code != 0 {
		t.Fatalf("exit %d: %s", code, stderr)
	}
	if !strings.Contains(stderr, "SUPERSURF_DEV_ENVIRONMENT") || !strings.Contains(stderr, "Using the packaged daemon instead") {
		t.Fatalf("stderr: %q", stderr)
	}
	if f := devFiles(t, r.home); len(f) != 2 {
		t.Fatalf("the normal path must write entry and versions/, got %v", f)
	}
}

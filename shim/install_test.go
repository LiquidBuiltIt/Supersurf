package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

// writePkg writes a package dir with a package.json and one file, and returns the dir.
func writePkg(t *testing.T, dir, name, version string, extra map[string]any) string {
	t.Helper()
	m := map[string]any{"name": name, "version": version}
	for k, v := range extra {
		m[k] = v
	}
	raw, _ := json.Marshal(m)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "package.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "index.js"), []byte("// "+name+"@"+version+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

func deps(names ...string) map[string]any {
	m := map[string]any{}
	for _, n := range names {
		m[n] = "*"
	}
	return m
}

// installRig is a project dir with node_modules/ and a daemon package under it.
type installRig struct {
	proj, src, home string
}

func newInstallRig(t *testing.T, extra map[string]any) *installRig {
	t.Helper()
	r := &installRig{proj: shortDir(t), home: shortDir(t)}
	r.src = filepath.Join(r.proj, "daemon")
	writePkg(t, r.src, "supersurf-daemon", "5.0.0", extra)
	os.MkdirAll(filepath.Join(r.src, "dist"), 0o755)
	os.WriteFile(filepath.Join(r.src, "dist", "main.js"), []byte("// main\n"), 0o644)
	return r
}

func (r *installRig) dep(t *testing.T, rel, name, version string, extra map[string]any) {
	t.Helper()
	writePkg(t, filepath.Join(r.proj, "node_modules", filepath.FromSlash(rel)), name, version, extra)
}

func (r *installRig) install(t *testing.T) (string, error) {
	t.Helper()
	return install(filepath.Join(r.home, ".supersurf", "daemon"), r.src, "5.0.0", "dist/main.js")
}

func (r *installRig) target() string {
	return filepath.Join(r.home, ".supersurf", "daemon", "versions", "5.0.0")
}

func mustInstall(t *testing.T, r *installRig) string {
	t.Helper()
	if _, err := r.install(t); err != nil {
		t.Fatalf("install: %v", err)
	}
	return r.target()
}

func versionAt(t *testing.T, dir string) string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(dir, "package.json"))
	if err != nil {
		return ""
	}
	var p struct{ Version string }
	json.Unmarshal(raw, &p)
	return p.Version
}

func TestInstallCopiesOnlyPackageFiles(t *testing.T) {
	r := newInstallRig(t, nil)
	os.WriteFile(filepath.Join(r.src, "README.md"), []byte("r"), 0o644)
	os.WriteFile(filepath.Join(r.src, "LICENSE"), []byte("l"), 0o644)
	// dev-tree litter that must never reach versions/<v>/
	os.MkdirAll(filepath.Join(r.src, ".tmp-test"), 0o755)
	os.WriteFile(filepath.Join(r.src, ".tmp-test", "d.sock"), []byte("x"), 0o644)
	os.MkdirAll(filepath.Join(r.src, "bin"), 0o755)
	os.WriteFile(filepath.Join(r.src, "bin", "supersurf-shim"), []byte("elf"), 0o755)
	os.MkdirAll(filepath.Join(r.src, "src"), 0o755)
	os.MkdirAll(filepath.Join(r.src, "tests"), 0o755)
	os.MkdirAll(filepath.Join(r.src, "node_modules", "own"), 0o755)
	// inside dist: a nested dir, a fifo, an escaping symlink, a contained relative symlink
	os.MkdirAll(filepath.Join(r.src, "dist", "engine"), 0o755)
	os.WriteFile(filepath.Join(r.src, "dist", "engine", "index.js"), []byte("e"), 0o644)
	if err := syscall.Mkfifo(filepath.Join(r.src, "dist", "pipe"), 0o644); err != nil {
		t.Fatal(err)
	}
	os.Symlink("../../outside", filepath.Join(r.src, "dist", "escape"))
	os.Symlink("/etc/passwd", filepath.Join(r.src, "dist", "abs"))
	os.Symlink("engine/index.js", filepath.Join(r.src, "dist", "inside"))

	tgt := mustInstall(t, r)
	for _, f := range []string{"package.json", "README.md", "LICENSE", "dist/main.js", "dist/engine/index.js"} {
		if !fileExists(filepath.Join(tgt, f)) {
			t.Errorf("missing %s", f)
		}
	}
	for _, f := range []string{".tmp-test", "bin", "src", "tests", "node_modules", "dist/pipe", "dist/escape", "dist/abs"} {
		if _, err := os.Lstat(filepath.Join(tgt, f)); err == nil {
			t.Errorf("%s must not be copied", f)
		}
	}
	if l, err := os.Readlink(filepath.Join(tgt, "dist", "inside")); err != nil || l != "engine/index.js" {
		t.Errorf("a relative symlink inside the package is kept: %q %v", l, err)
	}
	ents, _ := os.ReadDir(filepath.Join(r.home, ".supersurf", "daemon", "versions"))
	if len(ents) != 1 {
		t.Errorf("only versions/5.0.0 may exist, got %v", ents)
	}
}

func TestInstallCopiesHoistedClosure(t *testing.T) {
	r := newInstallRig(t, map[string]any{
		"dependencies":         deps("ws", "a"),
		"optionalDependencies": deps("opt"),
		"devDependencies":      deps("devonly"),
	})
	r.dep(t, "ws", "ws", "8.0.0", nil)
	r.dep(t, "a", "a", "1.0.0", map[string]any{"dependencies": deps("b")})
	r.dep(t, "b", "b", "1.0.0", map[string]any{"dependencies": deps("@s/c")})
	r.dep(t, "@s/c", "@s/c", "1.0.0", nil)
	r.dep(t, "opt", "opt", "1.0.0", nil)
	r.dep(t, "devonly", "devonly", "1.0.0", nil)
	r.dep(t, "unrelated", "unrelated", "1.0.0", nil)
	// a package's own node_modules is not copied wholesale; the closure places its deps
	os.MkdirAll(filepath.Join(r.proj, "node_modules", "a", "node_modules", "junk"), 0o755)

	tgt := mustInstall(t, r)
	for _, n := range []string{"ws", "a", "b", "@s/c", "opt"} {
		p := filepath.Join(tgt, "node_modules", filepath.FromSlash(n))
		if versionAt(t, p) == "" {
			t.Errorf("%s missing", n)
		}
		if fi, err := os.Lstat(p); err != nil || fi.Mode()&os.ModeSymlink != 0 {
			t.Errorf("%s must be a copied dir, not a symlink", n)
		}
	}
	for _, n := range []string{"devonly", "unrelated", "a/node_modules"} {
		if _, err := os.Lstat(filepath.Join(tgt, "node_modules", n)); err == nil {
			t.Errorf("%s must not be copied", n)
		}
	}
}

func TestInstallFollowsSymlinkedDependency(t *testing.T) {
	r := newInstallRig(t, map[string]any{"dependencies": deps("a")})
	writePkg(t, filepath.Join(r.proj, "elsewhere", "a"), "a", "1.0.0", nil)
	os.MkdirAll(filepath.Join(r.proj, "node_modules"), 0o755)
	os.Symlink("../elsewhere/a", filepath.Join(r.proj, "node_modules", "a"))
	tgt := mustInstall(t, r)
	p := filepath.Join(tgt, "node_modules", "a")
	if fi, err := os.Lstat(p); err != nil || !fi.IsDir() || versionAt(t, p) != "1.0.0" {
		t.Fatalf("a symlinked dependency is copied as a real dir: %v", err)
	}
}

func TestInstallNestsVersionClash(t *testing.T) {
	r := newInstallRig(t, map[string]any{"dependencies": deps("x", "a")})
	r.dep(t, "x", "x", "1.0.0", nil)
	r.dep(t, "a", "a", "1.0.0", map[string]any{"dependencies": deps("x")})
	writePkg(t, filepath.Join(r.proj, "node_modules", "a", "node_modules", "x"), "x", "2.0.0", nil)

	tgt := mustInstall(t, r)
	if v := versionAt(t, filepath.Join(tgt, "node_modules", "x")); v != "1.0.0" {
		t.Errorf("the daemon's own x stays at the top: %q", v)
	}
	if v := versionAt(t, filepath.Join(tgt, "node_modules", "a", "node_modules", "x")); v != "2.0.0" {
		t.Errorf("a's x@2 nests under a: %q", v)
	}
}

func TestInstallSameVersionIsDeduped(t *testing.T) {
	r := newInstallRig(t, map[string]any{"dependencies": deps("x", "a")})
	r.dep(t, "x", "x", "1.0.0", nil)
	r.dep(t, "a", "a", "1.0.0", map[string]any{"dependencies": deps("x")})
	writePkg(t, filepath.Join(r.proj, "node_modules", "a", "node_modules", "x"), "x", "1.0.0", nil)
	tgt := mustInstall(t, r)
	if _, err := os.Lstat(filepath.Join(tgt, "node_modules", "a", "node_modules")); err == nil {
		t.Error("the same name and version is placed once")
	}
}

// A nested copy must not shadow the top-level one for a sibling that needs the other version.
func TestInstallResolvesLikeNodeAfterNesting(t *testing.T) {
	r := newInstallRig(t, map[string]any{"dependencies": deps("d")})
	r.dep(t, "d", "d", "1.0.0", map[string]any{"dependencies": deps("x", "y")})
	writePkg(t, filepath.Join(r.proj, "node_modules", "d", "node_modules", "x"), "x", "2.0.0", nil)
	r.dep(t, "y", "y", "1.0.0", map[string]any{"dependencies": deps("x")})
	r.dep(t, "x", "x", "1.0.0", nil)

	tgt := mustInstall(t, r)
	want := map[string]string{"d": "x@2.0.0", "y": "x@1.0.0"}
	for dependent, w := range want {
		dir := filepath.Join(tgt, "node_modules", dependent)
		got := ""
		for d := dir; strings.HasPrefix(d, tgt); d = filepath.Dir(d) {
			if v := versionAt(t, filepath.Join(d, "node_modules", "x")); v != "" {
				got = "x@" + v
				break
			}
		}
		if got != w {
			t.Errorf("%s resolves %s, want %s", dependent, got, w)
		}
	}
}

func TestInstallSkipsMissingOptionalAndSoftPeers(t *testing.T) {
	r := newInstallRig(t, map[string]any{
		"dependencies":         deps("a"),
		"optionalDependencies": deps("absent-opt"),
	})
	r.dep(t, "a", "a", "1.0.0", map[string]any{
		"peerDependencies":     deps("zod", "absent-peer"),
		"peerDependenciesMeta": map[string]any{"absent-peer": map[string]any{"optional": true}},
	})
	r.dep(t, "zod", "zod", "3.0.0", nil)
	tgt := mustInstall(t, r)
	if versionAt(t, filepath.Join(tgt, "node_modules", "zod")) != "3.0.0" {
		t.Error("an installed non-optional peer is copied")
	}
	for _, n := range []string{"absent-opt", "absent-peer"} {
		if _, err := os.Lstat(filepath.Join(tgt, "node_modules", n)); err == nil {
			t.Errorf("%s is not installed and must be skipped", n)
		}
	}
}

func TestInstallMissingRequiredDependencyFails(t *testing.T) {
	r := newInstallRig(t, map[string]any{"dependencies": deps("a")})
	r.dep(t, "a", "a", "1.0.0", map[string]any{"dependencies": deps("gone")})
	_, err := r.install(t)
	if err == nil || !strings.Contains(err.Error(), "gone") {
		t.Fatalf("error must name the missing package: %v", err)
	}
	vdir := filepath.Join(r.home, ".supersurf", "daemon", "versions")
	if ents, _ := os.ReadDir(vdir); len(ents) != 0 {
		t.Errorf("a failed install leaves nothing behind (no target, no tmp): %v", ents)
	}
}

func TestInstallSkipsShimPackage(t *testing.T) {
	r := newInstallRig(t, map[string]any{"dependencies": deps("supersurf-shim", "a")})
	r.dep(t, "supersurf-shim", "supersurf-shim", "5.0.0", nil)
	r.dep(t, "a", "a", "1.0.0", nil)
	tgt := mustInstall(t, r)
	if _, err := os.Lstat(filepath.Join(tgt, "node_modules", "supersurf-shim")); err == nil {
		t.Error("supersurf-shim must not be copied")
	}
	if versionAt(t, filepath.Join(tgt, "node_modules", "a")) == "" {
		t.Error("other deps are still copied")
	}
}

func TestInstallLeavesExistingVersionAlone(t *testing.T) {
	r := newInstallRig(t, map[string]any{"dependencies": deps("a")})
	r.dep(t, "a", "a", "1.0.0", nil)
	tgt := r.target()
	os.MkdirAll(tgt, 0o755)
	os.WriteFile(filepath.Join(tgt, "sentinel"), []byte("keep"), 0o644)
	if _, err := r.install(t); err != nil {
		t.Fatal(err)
	}
	if !fileExists(filepath.Join(tgt, "sentinel")) || fileExists(filepath.Join(tgt, "package.json")) {
		t.Error("an existing versions/<v>/ is never rewritten")
	}
}

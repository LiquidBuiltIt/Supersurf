package main

import (
	"os"
	"path/filepath"
	"testing"
)

func realPath(t *testing.T, p string) string {
	t.Helper()
	r, err := filepath.EvalSymlinks(p)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func mkdirs(t *testing.T, p string) string {
	t.Helper()
	if err := os.MkdirAll(p, 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

// Hoisted install: the shim package and the daemon are siblings in <p>/node_modules.
func TestFindBundledHoisted(t *testing.T) {
	p := realPath(t, shortDir(t))
	daemon := fakePackage(t, filepath.Join(p, "node_modules", "supersurf-daemon"), "5.0.0")
	exeDir := mkdirs(t, filepath.Join(p, "node_modules", "supersurf-shim", "bin", "linux-amd64"))
	if got := findBundled(exeDir); got != daemon {
		t.Fatalf("findBundled = %q, want %q", got, daemon)
	}
}

// Nested install: the shim sits inside the daemon's own node_modules, which sits inside the server's.
func TestFindBundledNested(t *testing.T) {
	p := realPath(t, shortDir(t))
	daemon := fakePackage(t, filepath.Join(p, "node_modules", "supersurf-mcp", "node_modules", "supersurf-daemon"), "5.0.0")
	exeDir := mkdirs(t, filepath.Join(daemon, "node_modules", "supersurf-shim", "bin", "linux-arm64"))
	if got := findBundled(exeDir); got != daemon {
		t.Fatalf("findBundled = %q, want %q", got, daemon)
	}
}

// Dev layout: daemon/bin/supersurf-shim, with node_modules/supersurf-daemon a symlink to daemon/ at the clone root.
func TestFindBundledDevLayoutSymlink(t *testing.T) {
	clone := realPath(t, shortDir(t))
	daemon := fakePackage(t, filepath.Join(clone, "daemon"), "5.0.0")
	mkdirs(t, filepath.Join(clone, "node_modules"))
	if err := os.Symlink(filepath.Join("..", "daemon"), filepath.Join(clone, "node_modules", "supersurf-daemon")); err != nil {
		t.Fatal(err)
	}
	exeDir := mkdirs(t, filepath.Join(daemon, "bin"))
	if got := findBundled(exeDir); got != daemon {
		t.Fatalf("findBundled = %q, want the real daemon dir %q (copyTree does not follow a root symlink)", got, daemon)
	}
}

// A nearer supersurf-daemon directory that pkgVersion refuses is skipped.
func TestFindBundledSkipsUnusableCandidate(t *testing.T) {
	p := realPath(t, shortDir(t))
	daemon := fakePackage(t, filepath.Join(p, "node_modules", "supersurf-daemon"), "5.0.0")
	bad := mkdirs(t, filepath.Join(p, "node_modules", "x", "node_modules", "supersurf-daemon"))
	os.WriteFile(filepath.Join(bad, "package.json"), []byte(`{"name":"other","version":"1.0.0"}`), 0o644)
	exeDir := mkdirs(t, filepath.Join(p, "node_modules", "x", "bin"))
	if got := findBundled(exeDir); got != daemon {
		t.Fatalf("findBundled = %q, want %q", got, daemon)
	}
}

func TestFindBundledNone(t *testing.T) {
	p := realPath(t, shortDir(t))
	if got := findBundled(mkdirs(t, filepath.Join(p, "a", "b"))); got != "" {
		t.Fatalf("findBundled = %q, want empty", got)
	}
}

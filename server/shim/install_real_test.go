package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// The real daemon package, installed into versions/<v>/ in a throwaway HOME, must load
// its runtime dependencies from inside that dir. The HOME has no node_modules above it,
// so a lookup that escaped could only land in the source tree, which the check forbids.
// It lives in Go (not a daemon Vitest file) because it tests `install` directly and so
// needs no shim build; it skips without daemon/dist or node.
func TestInstallRealDaemonLoadsItsDependencies(t *testing.T) {
	src, err := filepath.Abs(filepath.Join("..", "daemon"))
	if err != nil || !fileExists(filepath.Join(src, "dist", "main.js")) {
		t.Skip("daemon/dist is not built (npm run build)")
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not on PATH")
	}
	ver, mainRel := pkgVersion(src)
	if ver == "" {
		t.Fatal("daemon/package.json is not a supersurf-daemon package")
	}
	home := realPath(t, shortDir(t))
	dir := daemonDir(home)
	main, err := install(dir, src, ver, mainRel)
	if err != nil {
		t.Fatal(err)
	}
	tgt := filepath.Join(dir, "versions", ver)
	for d := filepath.Dir(tgt); ; d = filepath.Dir(d) {
		if fileExists(filepath.Join(d, "node_modules", "package.json")) || dirExists(filepath.Join(d, "node_modules")) {
			t.Skipf("%s has a node_modules above the throwaway HOME; the escape check would prove nothing", d)
		}
		if filepath.Dir(d) == d {
			break
		}
	}

	js := `
const { createRequire } = require('module');
const r = createRequire(process.argv[1]);
const out = {};
for (const m of ['ws', 'acorn', 'acorn-walk', 'image-size', '@modelcontextprotocol/sdk/server/index.js', '@modelcontextprotocol/sdk/types.js']) {
  r(m); out[m] = r.resolve(m);
}
const re = createRequire(require('path').join(require('path').dirname(process.argv[1]), 'engine', 'index.js'));
const sharp = re('sharp');
out.sharp = re.resolve('sharp');
out.sharpWorks = sharp({ create: { width: 2, height: 2, channels: 3, background: '#fff' } }).png().toBuffer().then(b => b.length > 0);
Promise.resolve(out.sharpWorks).then(ok => {
  out.sharpWorks = ok;
  out.loaded = Object.keys(require.cache).concat(Object.values(out).filter(v => typeof v === 'string'));
  console.log(JSON.stringify(out));
});
`
	cmd := exec.Command(node, "-e", js, main)
	cmd.Dir = home
	cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + home}
	raw, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("node: %v\n%s", err, raw)
	}
	lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
	var out struct {
		SharpWorks bool
		Loaded     []string
	}
	if err := json.Unmarshal([]byte(lines[len(lines)-1]), &out); err != nil {
		t.Fatalf("node output: %v\n%s", err, raw)
	}
	if !out.SharpWorks {
		t.Error("sharp did not run")
	}
	for _, p := range out.Loaded {
		if strings.HasPrefix(p, tgt+string(filepath.Separator)) || !strings.Contains(p, string(filepath.Separator)) {
			continue
		}
		// require.cache also holds the -e script's own entry; only paths under node_modules matter
		if strings.Contains(p, string(filepath.Separator)+"node_modules"+string(filepath.Separator)) {
			t.Errorf("loaded from outside versions/%s: %s", ver, p)
		}
	}
	if len(out.Loaded) == 0 {
		t.Error("nothing was loaded")
	}
	t.Logf("versions/%s is %d bytes", ver, dirSize(t, tgt))
}

func dirExists(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && fi.IsDir()
}

func dirSize(t *testing.T, root string) (n int64) {
	filepath.Walk(root, func(_ string, fi os.FileInfo, err error) error {
		if err == nil && fi.Mode().IsRegular() {
			n += fi.Size()
		}
		return nil
	})
	return
}

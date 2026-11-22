package main

import (
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// EnsureOpts drives Ensure: find the daemon, or install and start it.
// Everything runs under ~/.supersurf/daemon/spawn.lock.
type EnsureOpts struct {
	Home         string
	Port         int
	Debug        bool
	InstallDir   string    // explicit --install: the package dir to install (the restart path)
	BundledDir   string    // the package dir this shim ships in; "" when unknown
	NodePath     string    // --node override
	DevRoot      string    // a validated dev clone (SUPERSURF_DEV_ENVIRONMENT); "" outside dev
	Stderr       io.Writer // notes for the user; os.Stderr when nil
	Now          func() time.Time
	LockTimeout  time.Duration
	StartTimeout time.Duration
}

type entry struct {
	Node    string `json:"node"`
	Main    string `json:"main"`
	Version string `json:"version"`
}

type spawnRec struct {
	TS           int64  `json:"ts"`
	PID          int    `json:"pid,omitempty"`
	EntryVersion string `json:"entryVersion"`
	Outcome      string `json:"outcome"`
}

const (
	banWindow     = 24 * time.Hour
	budgetFails   = 3
	budgetBackoff = 30 * time.Second
)

func supersurfDir(home string) string { return filepath.Join(home, ".supersurf") }
func daemonDir(home string) string    { return filepath.Join(supersurfDir(home), "daemon") }
func sockPath(home string) string     { return filepath.Join(supersurfDir(home), "daemon.sock") }

// ---- versions and the entry writer rules ----

// cmpVersion compares dotted numeric versions. A pre-release suffix sorts
// below the same release.
func cmpVersion(a, b string) int {
	pa, pra := splitVersion(a)
	pb, prb := splitVersion(b)
	for i := 0; i < 3; i++ {
		if pa[i] != pb[i] {
			if pa[i] < pb[i] {
				return -1
			}
			return 1
		}
	}
	switch {
	case pra == prb:
		return 0
	case pra == "":
		return 1
	case prb == "":
		return -1
	case pra < prb:
		return -1
	}
	return 1
}

func splitVersion(v string) (n [3]int, pre string) {
	v = strings.TrimPrefix(v, "v")
	if i := strings.IndexAny(v, "-+"); i >= 0 {
		v, pre = v[:i], v[i+1:]
	}
	for i, p := range strings.SplitN(v, ".", 3) {
		n[i], _ = strconv.Atoi(p)
	}
	return
}

// banned reports whether version has a handoff_failed record in the last 24 h
// that no later ban_cleared record for the same version follows.
func banned(recs []spawnRec, version string, now time.Time) bool {
	var failed int64 = -1
	for i, r := range recs {
		if r.EntryVersion != version {
			continue
		}
		switch r.Outcome {
		case "handoff_failed":
			if now.Sub(time.UnixMilli(r.TS)) < banWindow {
				failed = int64(i)
			}
		case "ban_cleared":
			if failed >= 0 {
				failed = -1
			}
		}
	}
	return failed >= 0
}

type entryPlan struct {
	Write    bool
	ClearBan bool
	Cause    string // set when no entry is usable and none may be written
}

// planEntry applies the writer rules. cur is the usable current entry or nil;
// cand is the version this writer can install, or "". It never moves entry to
// an older version and never writes a banned one.
func planEntry(cur *entry, cand string, explicit bool, recs []spawnRec, now time.Time) entryPlan {
	var p entryPlan
	if cand == "" {
		if cur == nil {
			p.Cause = "entry is missing or broken and this shim has no daemon to install"
		}
		return p
	}
	isBanned := banned(recs, cand, now)
	if explicit && isBanned {
		p.ClearBan, isBanned = true, false
	}
	if cur != nil && cmpVersion(cand, cur.Version) <= 0 {
		return p
	}
	if isBanned {
		if cur == nil {
			p.Cause = fmt.Sprintf("daemon %s is banned for 24 h after a failed hand-off; run `npx supersurf-daemon@latest restart` to clear it", cand)
		}
		return p
	}
	p.Write = true
	return p
}

func readEntry(dir string) *entry {
	raw, err := os.ReadFile(filepath.Join(dir, "entry"))
	if err != nil {
		return nil
	}
	var e entry
	if json.Unmarshal(raw, &e) != nil || !filepath.IsAbs(e.Node) || !filepath.IsAbs(e.Main) {
		return nil
	}
	for _, f := range []string{e.Node, e.Main} {
		if st, err := os.Stat(f); err != nil || st.IsDir() {
			return nil
		}
	}
	return &e
}

func writeFileAtomic(path string, data []byte) error {
	tmp := fmt.Sprintf("%s.tmp-%d", path, os.Getpid())
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// ---- spawns.jsonl ----

func readSpawns(dir string) []spawnRec {
	raw, _ := os.ReadFile(filepath.Join(dir, "spawns.jsonl"))
	var recs []spawnRec
	for _, l := range strings.Split(string(raw), "\n") {
		var r spawnRec
		if strings.TrimSpace(l) != "" && json.Unmarshal([]byte(l), &r) == nil {
			recs = append(recs, r)
		}
	}
	return recs
}

func appendSpawn(dir string, r spawnRec) {
	b, _ := json.Marshal(r)
	f, err := os.OpenFile(filepath.Join(dir, "spawns.jsonl"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	f.Write(append(b, '\n'))
	f.Close()
}

// budgetWait is how long the G1 budget still forbids a spawn: after three
// failed starts in a row, one attempt per 30 s.
func budgetWait(recs []spawnRec, now time.Time) time.Duration {
	fails, last := 0, int64(0)
	for i := len(recs) - 1; i >= 0; i-- {
		switch recs[i].Outcome {
		case "fail":
			fails++
			if last == 0 {
				last = recs[i].TS
			}
			continue
		case "ok":
		default:
			continue // hand-off and ban records are not spawn attempts
		}
		break
	}
	if fails < budgetFails {
		return 0
	}
	if w := budgetBackoff - now.Sub(time.UnixMilli(last)); w > 0 {
		return w
	}
	return 0
}

// ---- spawn.lock ----

func lockFile(path string, timeout time.Duration) (*os.File, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	deadline := time.Now().Add(timeout)
	for {
		err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			return f, nil
		}
		if err != syscall.EWOULDBLOCK || time.Now().After(deadline) {
			f.Close()
			return nil, fmt.Errorf("spawn.lock is held by another process")
		}
		time.Sleep(25 * time.Millisecond)
	}
}

// ---- install ----

func pkgVersion(dir string) (version, main string) {
	raw, err := os.ReadFile(filepath.Join(dir, "package.json"))
	if err != nil {
		return "", ""
	}
	var p struct{ Name, Version, Main string }
	// the version names a directory under versions/, so it may not hold a path separator
	if json.Unmarshal(raw, &p) != nil || p.Name != "supersurf-daemon" || p.Version == "" ||
		strings.ContainsAny(p.Version, `/\`) || strings.HasPrefix(p.Version, ".") {
		return "", ""
	}
	if p.Main == "" {
		p.Main = "dist/main.js"
	}
	return p.Version, p.Main
}

// copyPkg copies one package dir as plain files. It skips the package's own top-level
// node_modules (the closure places those), anything that is not a regular file or dir,
// and symlinks that are absolute or leave the package.
func copyPkg(src, dst string) error {
	return filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, p)
		t := filepath.Join(dst, rel)
		switch {
		case d.IsDir():
			if rel == "node_modules" {
				return filepath.SkipDir
			}
			return os.MkdirAll(t, 0o755)
		case d.Type()&fs.ModeSymlink != 0:
			l, err := os.Readlink(p)
			if err != nil || filepath.IsAbs(l) {
				return nil
			}
			if r, _ := filepath.Rel(src, filepath.Join(filepath.Dir(p), l)); r == ".." || strings.HasPrefix(r, ".."+string(filepath.Separator)) {
				return nil
			}
			return os.Symlink(l, t)
		case !d.Type().IsRegular():
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		return copyFile(p, t, info)
	})
}

func copyFile(p, t string, info fs.FileInfo) error {
	in, err := os.Open(p)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(t, os.O_CREATE|os.O_WRONLY|os.O_EXCL, info.Mode().Perm())
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

type depPkg struct {
	Name, Version        string
	Dependencies         map[string]string
	OptionalDependencies map[string]string
	PeerDependencies     map[string]string
	PeerDependenciesMeta map[string]struct{ Optional bool }
}

func readPkg(dir string) (*depPkg, bool) {
	raw, err := os.ReadFile(filepath.Join(dir, "package.json"))
	if err != nil {
		return nil, false
	}
	var p depPkg
	return &p, json.Unmarshal(raw, &p) == nil
}

// resolveSrc is Node's lookup: the first node_modules/<name> on the way up from the
// dependent's real dir, as a real path ("" when none).
func resolveSrc(from, name string) string {
	for d := from; ; d = filepath.Dir(d) {
		c := filepath.Join(d, "node_modules", filepath.FromSlash(name))
		if _, ok := readPkg(c); ok {
			if r, err := filepath.EvalSymlinks(c); err == nil {
				return r
			}
		}
		if filepath.Dir(d) == d {
			return ""
		}
	}
}

// placeAt says where name@ver goes under root for a dependent placed at dest: nowhere
// (already visible there, as Node would find it), at the top level, or nested under the
// dependent when a nearer copy at another version would shadow the top one.
func placeAt(root, dest, name, ver string) (at string, copy bool) {
	rel := filepath.FromSlash(name)
	for d := dest; ; d = filepath.Dir(d) {
		if p, ok := readPkg(filepath.Join(d, "node_modules", rel)); ok {
			if p.Version == ver {
				return "", false
			}
			return filepath.Join(dest, "node_modules", rel), true
		}
		if d == root {
			return filepath.Join(root, "node_modules", rel), true
		}
	}
}

// shimPkg is never part of the closure: nothing run from versions/<v>/ executes the shim.
const shimPkg = "supersurf-shim"

// copyClosure copies the daemon's runtime dependency closure into root/node_modules.
// Breadth first, so a package's own dependencies are placed before its children are read.
func copyClosure(srcReal, root string) error {
	type node struct{ real, dest string }
	queue := []node{{srcReal, root}}
	for len(queue) > 0 {
		n := queue[0]
		queue = queue[1:]
		p, ok := readPkg(n.real)
		if !ok {
			return fmt.Errorf("unreadable package.json in %s", n.real)
		}
		want := map[string]bool{} // name -> required
		for k := range p.PeerDependencies {
			if !p.PeerDependenciesMeta[k].Optional {
				want[k] = false
			}
		}
		for k := range p.OptionalDependencies {
			want[k] = false
		}
		for k := range p.Dependencies {
			want[k] = true
		}
		names := make([]string, 0, len(want))
		for k := range want {
			names = append(names, k)
		}
		sort.Strings(names)
		for _, name := range names {
			if name == shimPkg {
				continue
			}
			real := resolveSrc(n.real, name)
			if real == "" {
				if want[name] {
					return fmt.Errorf("required dependency %q of %s is not installed", name, p.Name)
				}
				continue
			}
			dp, _ := readPkg(real)
			at, doCopy := placeAt(root, n.dest, name, dp.Version)
			if !doCopy {
				continue
			}
			if err := copyPkg(real, at); err != nil {
				return err
			}
			queue = append(queue, node{real, at})
		}
	}
	return nil
}

// copyDaemon copies the daemon package's own files: package.json, dist/, README, LICENSE.
func copyDaemon(src, dst string) error {
	if err := os.MkdirAll(dst, 0o755); err != nil {
		return err
	}
	for _, f := range []string{"package.json", "dist", "README.md", "LICENSE"} {
		fi, err := os.Lstat(filepath.Join(src, f))
		if err != nil {
			if f == "package.json" || f == "dist" {
				return fmt.Errorf("%s is missing from %s", f, src)
			}
			continue
		}
		if fi.IsDir() {
			err = copyPkg(filepath.Join(src, f), filepath.Join(dst, f))
		} else {
			err = copyFile(filepath.Join(src, f), filepath.Join(dst, f), fi)
		}
		if err != nil {
			return err
		}
	}
	return nil
}

// install copies the package and its dependency closure into versions/<v>/ once and
// never rewrites it.
func install(dir, src, version, mainRel string) (string, error) {
	target := filepath.Join(dir, "versions", version)
	if _, err := os.Stat(target); err == nil {
		return filepath.Join(target, mainRel), nil
	}
	if err := os.MkdirAll(filepath.Join(dir, "versions"), 0o755); err != nil {
		return "", err
	}
	srcReal, err := filepath.EvalSymlinks(src)
	if err != nil {
		return "", err
	}
	tmp := fmt.Sprintf("%s.tmp-%d", target, os.Getpid())
	os.RemoveAll(tmp)
	if err := copyDaemon(srcReal, tmp); err != nil {
		os.RemoveAll(tmp)
		return "", err
	}
	if err := copyClosure(srcReal, tmp); err != nil {
		os.RemoveAll(tmp)
		return "", err
	}
	if err := os.Rename(tmp, target); err != nil {
		os.RemoveAll(tmp)
		return "", err
	}
	return filepath.Join(target, mainRel), nil
}

// ---- Ensure ----

// Ensure leaves a running daemon or returns the reason it cannot. It is the
// whole of `supersurf-shim ensure` and the shim's own start path.
func Ensure(o EnsureOpts) error {
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.LockTimeout == 0 {
		o.LockTimeout = 30 * time.Second
	}
	if o.StartTimeout == 0 {
		o.StartTimeout = 10 * time.Second
	}
	if o.Port == 0 {
		o.Port = 5555
	}
	dir := daemonDir(o.Home)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	lock, err := lockFile(filepath.Join(dir, "spawn.lock"), o.LockTimeout)
	if err != nil {
		return err
	}
	defer lock.Close()

	recs := readSpawns(dir)
	now := o.Now()
	if o.DevRoot != "" {
		return ensureDev(o, dir, recs, now)
	}
	cur := readEntry(dir)
	src, explicit := o.BundledDir, false
	if o.InstallDir != "" {
		src, explicit = o.InstallDir, true
	}
	cv, mainRel := "", ""
	if src != "" {
		cv, mainRel = pkgVersion(src)
	}
	if explicit && cv == "" {
		return fmt.Errorf("--install %s: not a supersurf-daemon package (no package.json with that name and a version)", src)
	}

	plan := planEntry(cur, cv, explicit, recs, now)
	if plan.ClearBan {
		appendSpawn(dir, spawnRec{TS: now.UnixMilli(), EntryVersion: cv, Outcome: "ban_cleared"})
	}
	if plan.Write {
		node := o.NodePath
		if node == "" && cur != nil {
			node = cur.Node
		}
		if node == "" {
			if node, err = exec.LookPath("node"); err != nil {
				return fmt.Errorf("node is not on PATH; install Node 18 or newer, or pass --node")
			}
		}
		if node, err = filepath.Abs(node); err != nil {
			return err
		}
		mainPath, err := install(dir, src, cv, mainRel)
		if err != nil {
			return fmt.Errorf("installing daemon %s: %v", cv, err)
		}
		b, _ := json.Marshal(entry{Node: node, Main: mainPath, Version: cv})
		if err := writeFileAtomic(filepath.Join(dir, "entry"), append(b, '\n')); err != nil {
			return err
		}
		cur = readEntry(dir)
	}
	if cur == nil {
		if plan.Cause == "" {
			plan.Cause = "entry is missing or broken"
		}
		return fmt.Errorf("%s", plan.Cause)
	}

	if daemonUp(o.Home) {
		return nil
	}
	if w := budgetWait(recs, now); w > 0 {
		return fmt.Errorf("the last %d daemon starts failed; the next attempt is allowed in %ds (see %s)",
			budgetFails, int(w.Seconds())+1, filepath.Join(supersurfDir(o.Home), "daemon.startup.log"))
	}
	return spawnDaemon(o, dir, cur)
}

func daemonUp(home string) bool {
	c, err := net.DialTimeout("unix", sockPath(home), time.Second)
	if err != nil {
		return false
	}
	c.Close()
	return true
}

// devClone mirrors shared/dev-source.ts for the daemon entry: raw is
// SUPERSURF_DEV_ENVIRONMENT, and the clone must be a SuperSurf repo root with a built
// daemon. It returns the absolute root, or a problem when the variable is set but
// unusable ("", "" when it is unset).
func devClone(raw string) (root, problem string) {
	if raw == "" {
		return "", ""
	}
	root, err := filepath.Abs(raw)
	if err != nil {
		return "", err.Error()
	}
	pkg, err := os.ReadFile(filepath.Join(root, "package.json"))
	var p struct{ Name string }
	if err != nil || json.Unmarshal(pkg, &p) != nil {
		return "", fmt.Sprintf("%s is not a SuperSurf repo root (no readable package.json)", root)
	}
	if p.Name != "supersurf" {
		return "", fmt.Sprintf("%s is not a SuperSurf repo root (package.json name is %q)", root, p.Name)
	}
	if _, err := os.Stat(devMain(root)); err != nil {
		return "", fmt.Sprintf("daemon/dist/main.js is missing. Run npm run build in %s", root)
	}
	return root, ""
}

func devMain(root string) string { return filepath.Join(root, "daemon", "dist", "main.js") }

// ensureDev is Ensure in a dev clone: it writes no entry and no versions/, and installs
// nothing (--install is ignored). It removes a leftover entry (from an installed version), so
// the daemon's hand-off (`readEntry() ?? self`) runs the clone's own main.js and D3 sees no
// newer entry. versions/ stays. The lock and the G1 budget stay.
func ensureDev(o EnsureOpts, dir string, recs []spawnRec, now time.Time) error {
	node := o.NodePath
	if node == "" {
		var err error
		if node, err = exec.LookPath("node"); err != nil {
			return fmt.Errorf("node is not on PATH; install Node 18 or newer, or pass --node")
		}
	}
	node, err := filepath.Abs(node)
	if err != nil {
		return err
	}
	if raw, err := os.ReadFile(filepath.Join(dir, "entry")); err == nil && os.Remove(filepath.Join(dir, "entry")) == nil {
		var left entry
		json.Unmarshal(raw, &left)
		w := o.Stderr
		if w == nil {
			w = os.Stderr
		}
		fmt.Fprintf(w, "supersurf-shim: dev clone: removed a leftover entry (%s) so the daemon restarts as the clone\n", left.Version)
	}
	if daemonUp(o.Home) {
		return nil
	}
	if w := budgetWait(recs, now); w > 0 {
		return fmt.Errorf("the last %d daemon starts failed; the next attempt is allowed in %ds (see %s)",
			budgetFails, int(w.Seconds())+1, filepath.Join(supersurfDir(o.Home), "daemon.startup.log"))
	}
	return spawnDaemon(o, dir, &entry{Node: node, Main: devMain(o.DevRoot), Version: "dev"})
}

func spawnDaemon(o EnsureOpts, dir string, e *entry) error {
	logPath := filepath.Join(supersurfDir(o.Home), "daemon.startup.log")
	errFile, _ := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	args := []string{e.Main, "--port", strconv.Itoa(o.Port), "--spawned-by=shim"}
	if o.Debug {
		args = append(args, "--debug")
	}
	cmd := exec.Command(e.Node, args...)
	cmd.Env = scrubbedEnv()
	if o.DevRoot != "" {
		// The only SUPERSURF_* name the daemon gets: it is how the daemon learns it is in dev (no extension pull).
		cmd.Env = append(cmd.Env, "SUPERSURF_DEV_ENVIRONMENT="+o.DevRoot)
	}
	cmd.Dir = o.Home
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	cmd.Stdin, cmd.Stdout = nil, nil
	if errFile != nil {
		cmd.Stderr = errFile
		defer errFile.Close()
	}
	rec := spawnRec{TS: o.Now().UnixMilli(), EntryVersion: e.Version}
	if err := cmd.Start(); err != nil {
		rec.Outcome = "fail"
		appendSpawn(dir, rec)
		return fmt.Errorf("could not start %s: %v", e.Node, err)
	}
	rec.PID = cmd.Process.Pid
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()

	deadline := time.Now().Add(o.StartTimeout)
	for time.Now().Before(deadline) {
		if daemonUp(o.Home) {
			rec.Outcome = "ok"
			appendSpawn(dir, rec)
			return nil
		}
		select {
		case werr := <-exited:
			rec.Outcome = "fail"
			appendSpawn(dir, rec)
			return fmt.Errorf("the daemon exited before it was ready (%v): %s", werr, explainStartup(logPath, o.Port))
		case <-time.After(50 * time.Millisecond):
		}
	}
	rec.Outcome = "fail"
	appendSpawn(dir, rec)
	return fmt.Errorf("the daemon did not open its socket within %ds; it is still running (pid %d)", int(o.StartTimeout.Seconds()), rec.PID)
}

func explainStartup(logPath string, port int) string {
	raw, _ := os.ReadFile(logPath)
	text := strings.TrimSpace(string(raw))
	if text == "" {
		return "no output captured; see " + logPath
	}
	if strings.Contains(text, "EADDRINUSE") {
		return fmt.Sprintf("port %d is already in use (EADDRINUSE); stop the process that holds it with `npx supersurf-daemon@latest stop`, then retry", port)
	}
	lines := strings.Split(text, "\n")
	return strings.TrimSpace(lines[len(lines)-1])
}

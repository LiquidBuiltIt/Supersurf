// supersurf-shim: a stdio to Unix-socket relay between an MCP client and the
// SuperSurf daemon, and `supersurf-shim ensure`, which finds or starts the daemon.
package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
)

// version is set at build time with -ldflags "-X main.version=...".
var version = "0.0.0-dev"

func main() {
	os.Exit(run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
}

type cliArgs struct {
	ensure                                        bool
	port                                          int
	installDir, nodePath                          string
	debug, disableSecureEval, disablePlaybookEval bool
	multiAgent, showVersion                       bool
}

func parseArgs(args []string) (a cliArgs, err error) {
	if len(args) > 0 && args[0] == "ensure" {
		a.ensure, args = true, args[1:]
	}
	val := func(i *int) (string, error) {
		if *i+1 >= len(args) {
			return "", fmt.Errorf("%s needs a value", args[*i])
		}
		*i++
		return args[*i], nil
	}
	for i := 0; i < len(args); i++ {
		var v string
		switch args[i] {
		case "--port":
			if v, err = val(&i); err == nil {
				if a.port, err = strconv.Atoi(v); err != nil || a.port < 1 || a.port > 65535 {
					err = fmt.Errorf("--port needs a number from 1 to 65535")
				}
			}
		case "--install":
			a.installDir, err = val(&i)
		case "--node":
			a.nodePath, err = val(&i)
		case "--debug":
			a.debug = true
		case "--disable-secure-eval":
			a.disableSecureEval = true
		case "--disable-playbook-eval":
			a.disablePlaybookEval = true
		case "--multi-agent":
			a.multiAgent = true
		case "--version":
			a.showVersion = true
		}
		if err != nil {
			return
		}
	}
	return
}

// allowUnsandboxed reads the one leaf the shim takes from config.json.
func allowUnsandboxed(home string) bool {
	raw, err := os.ReadFile(filepath.Join(supersurfDir(home), "config.json"))
	if err != nil {
		return false
	}
	var c struct {
		Security struct {
			Allow bool `json:"allow_unsandboxed_playbook"`
		} `json:"security"`
	}
	return json.Unmarshal(raw, &c) == nil && c.Security.Allow
}

func bundledDir() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	d := filepath.Dir(filepath.Dir(exe))
	if v, _ := pkgVersion(d); v != "" {
		return d
	}
	return ""
}

func run(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	a, err := parseArgs(args)
	if err != nil {
		fmt.Fprintln(stderr, "supersurf-shim:", err)
		return 2
	}
	if a.showVersion {
		fmt.Fprintln(stdout, version)
		return 0
	}
	home, err := os.UserHomeDir()
	if err != nil {
		fmt.Fprintln(stderr, "supersurf-shim: no home directory:", err)
		return 1
	}
	if a.port == 0 {
		a.port = 5555
		if p, err := strconv.Atoi(os.Getenv("SUPERSURF_PORT")); err == nil && p > 0 && p < 65536 {
			a.port = p
		}
	}
	eo := EnsureOpts{Home: home, Port: a.port, Debug: a.debug, InstallDir: a.installDir, BundledDir: bundledDir(), NodePath: a.nodePath}
	if a.ensure {
		if err := Ensure(eo); err != nil {
			fmt.Fprintln(stderr, "supersurf-shim ensure:", err)
			return 1
		}
		return 0
	}

	cwd, _ := os.Getwd()
	id := make([]byte, 8)
	rand.Read(id)
	flags := map[string]any{}
	for k, on := range map[string]bool{
		"debug": a.debug, "disable_secure_eval": a.disableSecureEval,
		"disable_playbook_eval": a.disablePlaybookEval, "multi_agent": a.multiAgent,
		"allow_unsandboxed_playbook": allowUnsandboxed(home),
	} {
		if on {
			flags[k] = true
		}
	}
	cfg := Config{
		Sock: sockPath(home), Version: version, Cwd: cwd, SessionID: "shim-" + hex.EncodeToString(id),
		Flags: flags, Env: collectHandshakeEnv(), Dotenv: loadDotenv(cwd),
		Ensure: func() error { return Ensure(eo) },
	}
	if a.debug {
		cfg.Log = func(f string, v ...any) { fmt.Fprintf(stderr, "supersurf-shim: "+f+"\n", v...) }
	}
	NewRelay(cfg, stdout).Run(stdin)
	return 0
}

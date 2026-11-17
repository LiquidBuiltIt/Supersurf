package main

import (
	"os"
	"path/filepath"
	"strings"
)

// envSource answers env.get and env.keys: the shim's own env first, then the
// .env file in the working directory (same precedence as engine/src/dotenv.ts,
// which never overrides an existing variable).
type envSource struct {
	dot  map[string]string
	keys []string
}

func loadDotenv(dir string) *envSource {
	e := &envSource{dot: map[string]string{}}
	raw, err := os.ReadFile(filepath.Join(dir, ".env"))
	if err != nil {
		return e
	}
	for _, l := range strings.Split(string(raw), "\n") {
		l = strings.TrimSpace(l)
		if l == "" || strings.HasPrefix(l, "#") {
			continue
		}
		eq := strings.Index(l, "=")
		if eq == -1 {
			continue
		}
		k, v := strings.TrimSpace(l[:eq]), strings.TrimSpace(l[eq+1:])
		if len(v) >= 2 && (v[0] == '"' && v[len(v)-1] == '"' || v[0] == '\'' && v[len(v)-1] == '\'') {
			v = v[1 : len(v)-1]
		}
		if _, seen := e.dot[k]; seen {
			continue // the first line wins, as in dotenv.ts
		}
		e.keys = append(e.keys, k)
		e.dot[k] = v
	}
	return e
}

func (e *envSource) get(name string) (string, bool) {
	if v, ok := os.LookupEnv(name); ok {
		return v, true
	}
	v, ok := e.dot[name]
	return v, ok
}

// handshakeEnv is the SUPERSURF_* allowlist sent in shim_register. The config
// path and the unsandboxed-playbook switch are never sent, and neither is the
// port (the spawner passes --port).
var handshakeEnv = []string{
	"SUPERSURF_DEBUG",
	"SUPERSURF_EXPERIMENTS",
	"SUPERSURF_DISABLE_SECURE_EVAL",
	"SUPERSURF_DISABLE_PLAYBOOK_EVAL",
	"SUPERSURF_MULTI_AGENT",
	"SUPERSURF_SCREENSHOT_OMIT_PATH",
}

func collectHandshakeEnv() map[string]string {
	m := map[string]string{}
	for _, k := range handshakeEnv {
		if v, ok := os.LookupEnv(k); ok {
			m[k] = v
		}
	}
	return m
}

// spawnEnvKeep is what a shim-spawned daemon inherits. No SUPERSURF_* name is
// in it: the daemon learns every setting from the handshake.
var spawnEnvKeep = []string{
	"HOME", "USER", "LOGNAME", "PATH", "LANG", "TMPDIR", "SHELL",
	"DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME",
	"XDG_DATA_HOME", "XDG_CACHE_HOME", "DBUS_SESSION_BUS_ADDRESS",
}

func scrubbedEnv() []string {
	var out []string
	for _, kv := range os.Environ() {
		k := kv[:strings.IndexByte(kv+"=", '=')]
		keep := strings.HasPrefix(k, "LC_")
		for _, a := range spawnEnvKeep {
			if k == a {
				keep = true
			}
		}
		if keep {
			out = append(out, kv)
		}
	}
	return out
}

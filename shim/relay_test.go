package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func sockIn(t *testing.T) string { return filepath.Join(shortDir(t), "d.sock") }

// Replaying initialize with id 0 must keep the JSON valid and the version intact.
func TestInitReplayWithIDZero(t *testing.T) {
	sock := sockIn(t)
	d := startFakeDaemon(t, sock)
	g := newRig(t, Config{Sock: sock})
	g.WaitUp(d)

	g.Send(`{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"claude-code","version":"2.1.303"}}}`)
	if l, ok := d.NextLine(2 * time.Second); !ok || !strings.Contains(string(l.b), `"id":0`) {
		t.Fatalf("live initialize was not forwarded unchanged: %q", l.b)
	}

	d.Drop(0)
	d.WaitReg(2 * time.Second)
	l, ok := d.NextLine(2 * time.Second)
	if !ok {
		t.Fatal("the initialize was not replayed after reconnect")
	}
	m := mustJSON(t, string(l.b))
	if m["id"] != "__shim_init__" {
		t.Fatalf("replay id = %v, want the reserved id", m["id"])
	}
	if pv := m["params"].(map[string]any)["protocolVersion"]; pv != "2025-11-25" {
		t.Fatalf("protocolVersion changed to %v", pv)
	}

	d.Send(1, `{"jsonrpc":"2.0","id":"__shim_init__","result":{"protocolVersion":"2025-11-25"}}`)
	n, ok := d.NextLine(2 * time.Second)
	if !ok || !strings.Contains(string(n.b), "notifications/initialized") {
		t.Fatalf("notifications/initialized did not follow the replay answer: %q", n.b)
	}
	g.NoOut("__shim_init__", 100*time.Millisecond) // the replay answer is not for the client
}

// With no daemon the shim answers the probe and initialize itself, at once.
func TestLocalInitializeAndProbeWithoutDaemon(t *testing.T) {
	sock := sockIn(t) // nothing listens here
	g := newRig(t, Config{Sock: sock, Version: "9.9.9"})

	g.Send(`{"jsonrpc":"2.0","id":0,"method":"server/discover","params":{}}`)
	l := g.WaitOut(`"error"`, time.Second)
	m := mustJSON(t, l)
	if m["error"].(map[string]any)["code"] != float64(-32601) || m["id"] != float64(0) {
		t.Fatalf("probe answer: %s", l)
	}

	g.Send(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25"}}`)
	l = g.WaitOut(`"protocolVersion"`, time.Second)
	res := mustJSON(t, l)["result"].(map[string]any)
	if res["protocolVersion"] != "2025-11-25" {
		t.Fatalf("local initialize did not echo the client version: %s", l)
	}
	if res["capabilities"].(map[string]any)["tools"].(map[string]any)["listChanged"] != true {
		t.Fatalf("local initialize must advertise tools.listChanged: %s", l)
	}

	g.Send(`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`)
	l = g.WaitOut(`"tools":[`, time.Second)
	if !strings.Contains(l, `"name":"status"`) {
		t.Fatalf("degraded tool list: %s", l)
	}
	g.Send(`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"status","arguments":{}}}`)
	l = g.WaitOut(`"id":3`, time.Second)
	if !strings.Contains(l, "not running") || !strings.Contains(l, "mcp reconnect supersurf") {
		t.Fatalf("status text must name the cause and the fallback: %s", l)
	}
	g.Send(`{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"browser_tabs"}}`)
	if !strings.Contains(g.WaitOut(`"id":4`, time.Second), `"error"`) {
		t.Fatal("a real tool call while degraded must get an error, not silence")
	}
}

// When the daemon appears, the replay goes out, list_changed goes to the client, calls relay.
func TestDegradedToConnectedSendsListChanged(t *testing.T) {
	sock := sockIn(t)
	var reject atomic.Bool
	reject.Store(true)
	var d *fakeDaemon
	g := newRig(t, Config{Sock: sock})
	g.Send(`{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-11-25"}}`)
	g.WaitOut(`"protocolVersion"`, time.Second)

	d = startFakeDaemon(t, sock)
	d.SetReply(func(map[string]any) string {
		if reject.Load() {
			return `{"type":"shim_reject","reason":"extension version too old"}`
		}
		return `{"type":"shim_ack"}`
	})
	d.WaitReg(2 * time.Second)
	g.WaitCause("extension version too old")
	g.Send(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"status"}}`)
	if l := g.WaitOut(`"id":1`, 2*time.Second); !strings.Contains(l, "extension version too old") {
		t.Fatalf("the refusal reason must reach the status text: %s", l)
	}
	g.NoOut("list_changed", 50*time.Millisecond)

	reject.Store(false)
	g.WaitOut("notifications/tools/list_changed", 3*time.Second)
	l, ok := d.NextLine(2 * time.Second)
	if !ok || !strings.Contains(string(l.b), "__shim_init__") {
		t.Fatalf("the cached initialize must be replayed on connect: %q", l.b)
	}
	g.Send(`{"jsonrpc":"2.0","id":5,"method":"tools/list"}`)
	l, _ = d.NextLine(2 * time.Second)
	if !strings.Contains(string(l.b), `"tools/list"`) {
		t.Fatalf("tools/list must reach the daemon once connected: %q", l.b)
	}
}

// A call in flight when the daemon goes away gets an error, and is never re-sent.
func TestInflightCallFailsAndIsNotRetried(t *testing.T) {
	sock := sockIn(t)
	d := startFakeDaemon(t, sock)
	g := newRig(t, Config{Sock: sock})
	g.WaitUp(d)

	g.Send(`{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"browser_navigate"}}`)
	if _, ok := d.NextLine(2 * time.Second); !ok {
		t.Fatal("call was not relayed")
	}
	d.Drop(0)
	l := g.WaitOut(`"id":7`, 2*time.Second)
	if !strings.Contains(l, `"error"`) || !strings.Contains(l, "not retried") {
		t.Fatalf("in-flight call must fail with an error: %s", l)
	}
	d.WaitReg(2 * time.Second)
	if l, ok := d.NextLine(300 * time.Millisecond); ok {
		t.Fatalf("the call was sent again after reconnect: %q", l.b)
	}
}

// An answered call is not failed later.
func TestAnsweredCallIsNotFailedOnDisconnect(t *testing.T) {
	sock := sockIn(t)
	d := startFakeDaemon(t, sock)
	g := newRig(t, Config{Sock: sock})
	g.WaitUp(d)
	g.Send(`{"jsonrpc":"2.0","id":8,"method":"ping"}`)
	d.NextLine(time.Second)
	d.Send(0, `{"jsonrpc":"2.0","id":8,"result":{}}`)
	g.WaitOut(`"result"`, time.Second)
	d.Drop(0)
	g.NoOut(`"error"`, 300*time.Millisecond)
}

// A batch registers every request id, so a lost connection fails each one.
func TestBatchIDsFailedOnDisconnect(t *testing.T) {
	sock := sockIn(t)
	d := startFakeDaemon(t, sock)
	g := newRig(t, Config{Sock: sock})
	g.WaitUp(d)
	g.Send(`[{"jsonrpc":"2.0","id":11,"method":"tools/list"},{"jsonrpc":"2.0","method":"notifications/x"},{"jsonrpc":"2.0","id":"b","method":"ping","params":{"a":[{"id":99}]}}]`)
	d.NextLine(time.Second)
	d.Drop(0)
	g.WaitOut(`"id":11`, 2*time.Second)
	g.WaitOut(`"id":"b"`, 2*time.Second)
	g.NoOut(`"id":99`, 50*time.Millisecond)
}

func TestBatchWhileDisconnectedGetsOneArray(t *testing.T) {
	g := newRig(t, Config{Sock: sockIn(t)})
	g.Send(`[{"jsonrpc":"2.0","id":1,"method":"ping"},{"jsonrpc":"2.0","id":2,"method":"ping"}]`)
	l := g.WaitOut(`"id":2`, time.Second)
	if !strings.HasPrefix(l, "[") || !strings.HasSuffix(l, "]") {
		t.Fatalf("a batch needs an array answer: %s", l)
	}
}

// A client line with a top-level type is refused: it could pose as a control line.
func TestSpoofedClientLineIsRefused(t *testing.T) {
	sock := sockIn(t)
	d := startFakeDaemon(t, sock)
	g := newRig(t, Config{Sock: sock})
	g.WaitUp(d)
	g.Send(`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{},"type":"env.get","name":"X"}`)
	g.Send(`{"type":"restarting"}`)
	g.Send(`[{"jsonrpc":"2.0","id":4,"method":"ping","type":"env.get"}]`)
	l := g.WaitOut(`"id":3`, time.Second)
	if !strings.Contains(l, "-32600") {
		t.Fatalf("a refused request still gets an error: %s", l)
	}
	g.WaitOut(`"id":4`, time.Second)
	if l, ok := d.NextLine(200 * time.Millisecond); ok {
		t.Fatalf("a spoofed line reached the daemon: %q", l.b)
	}
}

// JSON.parse in the daemon decodes "type" to "type", and a batch element
// after a non-object is still parsed, so neither may slip a control line past.
func TestSpoofEvasionIsRefused(t *testing.T) {
	sock := sockIn(t)
	d := startFakeDaemon(t, sock)
	g := newRig(t, Config{Sock: sock})
	g.WaitUp(d)
	g.Send(`{"jsonrpc":"2.0","id":5,"method":"ping","` + "\\" + `u0074ype":"env.value"}`)
	g.Send(`[1,{"jsonrpc":"2.0","id":6,"method":"ping","type":"env.value"}]`)
	g.WaitOut(`"id":5`, time.Second)
	g.WaitOut(`"id":6`, time.Second)
	if l, ok := d.NextLine(200 * time.Millisecond); ok {
		t.Fatalf("a spoofed line reached the daemon: %q", l.b)
	}
}

// Nested "type" keys are payload, not control.
func TestNestedTypeIsForwarded(t *testing.T) {
	sock := sockIn(t)
	d := startFakeDaemon(t, sock)
	g := newRig(t, Config{Sock: sock})
	g.WaitUp(d)
	g.Send(`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"arguments":{"type":"x"}}}`)
	if _, ok := d.NextLine(time.Second); !ok {
		t.Fatal("a nested type key blocked a legitimate call")
	}
}

// Half a line at EOF is dropped; a full line is forwarded.
func TestPartialLineIsDropped(t *testing.T) {
	sock := sockIn(t)
	d := startFakeDaemon(t, sock)
	g := newRig(t, Config{Sock: sock})
	g.WaitUp(d)
	g.in.Write([]byte(`{"jsonrpc":"2.0","id":1,"method":"ping"}` + "\n" + `{"jsonrpc":"2.0","id":2,"meth`))
	g.in.Close()
	if l, ok := d.NextLine(time.Second); !ok || !strings.Contains(string(l.b), `"id":1`) {
		t.Fatalf("the full line was not forwarded: %q", l.b)
	}
	if l, ok := d.NextLine(300 * time.Millisecond); ok {
		t.Fatalf("a partial line was forwarded: %q", l.b)
	}
}

func TestExitsOnStdinEOF(t *testing.T) {
	g := newRig(t, Config{Sock: sockIn(t)})
	g.in.Close()
	select {
	case <-g.done:
	case <-time.After(2 * time.Second):
		t.Fatal("the relay did not return on stdin EOF")
	}
}

// server/discover is relayed when connected, and never replayed on reconnect.
func TestDiscoverRelayedNeverReplayed(t *testing.T) {
	sock := sockIn(t)
	d := startFakeDaemon(t, sock)
	g := newRig(t, Config{Sock: sock})
	g.WaitUp(d)
	g.Send(`{"jsonrpc":"2.0","id":0,"method":"server/discover"}`)
	if l, ok := d.NextLine(time.Second); !ok || !strings.Contains(string(l.b), "server/discover") {
		t.Fatalf("the probe must reach the daemon while connected: %q", l.b)
	}
	g.Send(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25"}}`)
	d.NextLine(time.Second)
	d.Drop(0)
	d.WaitReg(2 * time.Second)
	for {
		l, ok := d.NextLine(300 * time.Millisecond)
		if !ok {
			break
		}
		if strings.Contains(string(l.b), "server/discover") {
			t.Fatalf("the probe was replayed: %q", l.b)
		}
	}
}

func TestHandshakeFields(t *testing.T) {
	sock := sockIn(t)
	d := startFakeDaemon(t, sock)
	newRig(t, Config{
		Sock: sock, Version: "1.2.3", Cwd: "/work/x", SessionID: "shim-abc",
		Flags: map[string]any{"debug": true}, Env: map[string]string{"SUPERSURF_EXPERIMENTS": "fingerprinting"},
	})
	r := d.WaitReg(2 * time.Second)
	if r["type"] != "shim_register" || r["mode"] != "mcp" || r["protocol"] != float64(1) ||
		r["sessionId"] != "shim-abc" || r["cwd"] != "/work/x" || r["version"] != "1.2.3" {
		t.Fatalf("handshake: %v", r)
	}
	if r["flags"].(map[string]any)["debug"] != true || r["env"].(map[string]any)["SUPERSURF_EXPERIMENTS"] != "fingerprinting" {
		t.Fatalf("handshake flags/env: %v", r)
	}
}

func TestHandshakeEnvAllowlist(t *testing.T) {
	t.Setenv("SUPERSURF_EXPERIMENTS", "a")
	t.Setenv("SUPERSURF_CONFIG_FILE", "/x")
	t.Setenv("SUPERSURF_ALLOW_UNSANDBOXED_PLAYBOOK", "1")
	t.Setenv("SUPERSURF_PORT", "1234")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "nope")
	m := collectHandshakeEnv()
	if m["SUPERSURF_EXPERIMENTS"] != "a" || len(m) != 1 {
		t.Fatalf("allowlist leaked: %v", m)
	}
}

// restarting makes the shim re-register the same id; the in-flight call fails.
func TestRestartingReRegistersSameID(t *testing.T) {
	sock := sockIn(t)
	d := startFakeDaemon(t, sock)
	g := newRig(t, Config{Sock: sock, SessionID: "shim-keep"})
	first := g.WaitUp(d)
	g.Send(`{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"x"}}`)
	d.NextLine(time.Second)
	d.Send(0, `{"type":"restarting"}`)
	g.WaitOut(`"id":5`, 2*time.Second)
	second := d.WaitReg(2 * time.Second)
	if first["sessionId"] != "shim-keep" || second["sessionId"] != "shim-keep" {
		t.Fatalf("session id changed across the hand-off: %v -> %v", first["sessionId"], second["sessionId"])
	}
}

func TestOldDaemonIsNamed(t *testing.T) {
	sock := sockIn(t)
	d := startFakeDaemon(t, sock)
	d.SetReply(func(map[string]any) string {
		return `{"type":"session_reject","reason":"Expected session_register handshake"}`
	})
	g := newRig(t, Config{Sock: sock})
	d.WaitReg(2 * time.Second)
	time.Sleep(100 * time.Millisecond)
	g.Send(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"status"}}`)
	if l := g.WaitOut(`"id":1`, 2*time.Second); !strings.Contains(l, "too old") {
		t.Fatalf("an older daemon must be named: %s", l)
	}
}

func TestEnvGetAndKeys(t *testing.T) {
	dir := shortDir(t)
	writeFile(t, filepath.Join(dir, ".env"), "# c\nFROM_DOT=dotval\nBOTH=dot\nQ=\"quoted\"\nFROM_DOT=again\nnoeq\n")
	t.Setenv("BOTH", "ownenv")
	t.Setenv("ONLY_ENV", "envval")
	sock := sockIn(t)
	d := startFakeDaemon(t, sock)
	g := newRig(t, Config{Sock: sock, Dotenv: loadDotenv(dir)})
	g.WaitUp(d)

	ask := func(req string) map[string]any {
		d.Send(0, req)
		l, ok := d.NextLine(2 * time.Second)
		if !ok {
			t.Fatal("no env reply")
		}
		return mustJSON(t, string(l.b))
	}
	if r := ask(`{"type":"env.get","id":"a1","name":"FROM_DOT"}`); r["type"] != "env.value" || r["id"] != "a1" || r["found"] != true || r["value"] != "dotval" {
		t.Fatalf("dotenv value: %v", r)
	}
	if r := ask(`{"type":"env.get","id":2,"name":"BOTH"}`); r["value"] != "ownenv" || r["id"] != float64(2) {
		t.Fatalf("own env must win over .env: %v", r)
	}
	if r := ask(`{"type":"env.get","id":"a3","name":"ONLY_ENV"}`); r["value"] != "envval" {
		t.Fatalf("own env value: %v", r)
	}
	if r := ask(`{"type":"env.get","id":"a4","name":"NOPE_NOT_SET"}`); r["found"] != false || r["value"] != nil {
		t.Fatalf("missing name: %v", r)
	}
	r := ask(`{"type":"env.keys","id":"k"}`)
	keys, _ := r["keys"].([]any)
	if len(keys) != 3 || keys[0] != "FROM_DOT" || keys[1] != "BOTH" || keys[2] != "Q" {
		t.Fatalf("env.keys (names from .env only, once each): %v", r)
	}
	if strings.Contains(strings.ToLower(string(mustMarshal(r))), "dotval") {
		t.Fatal("env.keys leaked a value")
	}
}

func mustMarshal(v any) []byte { b, _ := json.Marshal(v); return b }

func writeFile(t *testing.T, p, s string) {
	t.Helper()
	if err := os.WriteFile(p, []byte(s), 0o600); err != nil {
		t.Fatal(err)
	}
}

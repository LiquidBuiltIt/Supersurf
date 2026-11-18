package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	reservedID      = `"__shim_init__"`
	protocolVersion = 1
	defaultProtocol = "2025-06-18"
)

// Config is everything the relay needs; tests fill it directly.
type Config struct {
	Sock       string
	Version    string
	Cwd        string
	SessionID  string
	Flags      map[string]any
	Env        map[string]string
	Dotenv     *envSource
	Backoff0   time.Duration
	BackoffMax time.Duration
	// Ensure starts the daemon when the socket is not reachable. Nil means never.
	Ensure func() error
	Log    func(format string, a ...any)
}

// Relay copies MCP lines between the client (stdio) and the daemon socket.
type Relay struct {
	cfg  Config
	out  io.Writer
	outM sync.Mutex
	wmu  sync.Mutex // serializes writes to the daemon connection

	mu        sync.Mutex
	conn      net.Conn
	inflight  map[string][]byte // canonical id -> raw id bytes, kept for the loss error
	initLine  []byte            // client's initialize, id rewritten to reservedID
	cause     string            // why the shim is not connected
	localSeen bool              // the client got a local answer; send list_changed on connect

	done     chan struct{}
	doneOnce sync.Once
}

func NewRelay(cfg Config, out io.Writer) *Relay {
	if cfg.Backoff0 == 0 {
		cfg.Backoff0 = 200 * time.Millisecond
	}
	if cfg.BackoffMax == 0 {
		cfg.BackoffMax = 5 * time.Second
	}
	if cfg.Log == nil {
		cfg.Log = func(string, ...any) {}
	}
	if cfg.Dotenv == nil {
		cfg.Dotenv = &envSource{dot: map[string]string{}}
	}
	return &Relay{cfg: cfg, out: out, inflight: map[string][]byte{}, cause: "connecting to the daemon", done: make(chan struct{})}
}

// Run reads client lines until stdin EOF. The daemon connection is dialed in
// the background and never gates the first read.
func (r *Relay) Run(in io.Reader) {
	go r.daemonLoop()
	lr := newLineReader(in)
	for {
		line, err := lr.next()
		if err != nil {
			break
		}
		n := len(line)
		r.fromClient(line)
		line = nil
		release(n)
	}
	r.doneOnce.Do(func() { close(r.done) })
	r.mu.Lock()
	if r.conn != nil {
		r.conn.Close()
	}
	r.mu.Unlock()
}

func (r *Relay) toClient(b []byte) {
	r.outM.Lock()
	r.out.Write(b)
	r.outM.Unlock()
}

// errLine builds a JSON-RPC error. An id token that is not valid JSON becomes null.
func errLine(id []byte, code int, msg string) []byte {
	if !json.Valid(id) {
		id = []byte("null")
	}
	m, _ := json.Marshal(msg)
	return []byte(fmt.Sprintf(`{"jsonrpc":"2.0","id":%s,"error":{"code":%d,"message":%s}}`+"\n", id, code, m))
}

func resultLine(id []byte, result string) []byte {
	return []byte(fmt.Sprintf(`{"jsonrpc":"2.0","id":%s,"result":%s}`+"\n", id, result))
}

func (r *Relay) setCause(c string) {
	r.mu.Lock()
	r.cause = c
	r.mu.Unlock()
}

// ---- client side ----

func (r *Relay) fromClient(line []byte) {
	hs, batch := scanLine(line)
	for _, h := range hs {
		if h.typ != nil { // client lines never carry a top-level type
			r.refuse(hs, batch)
			return
		}
	}
	if batch {
		r.clientBatch(line, hs)
		return
	}
	h := hs[0]
	method := string(h.method)

	if method == `"initialize"` && h.id != nil {
		cached := make([]byte, 0, len(line)+len(reservedID))
		cached = append(cached, line[:h.idStart]...)
		cached = append(cached, reservedID...)
		cached = append(cached, line[h.idEnd:]...)
		r.mu.Lock()
		r.initLine = cached
		r.mu.Unlock()
	}

	r.mu.Lock()
	c := r.conn
	if c != nil && h.isRequest() {
		r.inflight[canonicalID(h.id)] = bytes.Clone(h.id) // h.id aliases the line: do not pin it
	}
	cause := r.cause
	if c == nil && (method == `"initialize"` || method == `"tools/list"`) {
		r.localSeen = true
	}
	r.mu.Unlock()

	if c != nil {
		r.writeConn(c, line)
		return
	}
	r.local(line, h, method, cause)
}

// refuse drops a spoofed line. A request in it still gets an answer.
func (r *Relay) refuse(hs []header, batch bool) {
	r.cfg.Log("refused a client line with a top-level type")
	var errs []byte
	for _, h := range hs {
		if h.isRequest() {
			errs = append(errs, errLine(h.id, -32600, "invalid request: top-level type is reserved")...)
		}
	}
	r.toClient(errs)
}

func (r *Relay) clientBatch(line []byte, hs []header) {
	r.mu.Lock()
	c := r.conn
	cause := r.cause
	if c != nil {
		for _, h := range hs {
			if h.isRequest() {
				r.inflight[canonicalID(h.id)] = bytes.Clone(h.id) // h.id aliases the line: do not pin it
			}
		}
	}
	r.mu.Unlock()
	if c != nil {
		r.writeConn(c, line)
		return
	}
	var errs [][]byte
	for _, h := range hs {
		if h.isRequest() {
			errs = append(errs, bytes.TrimSpace(errLine(h.id, -32000, "daemon not connected: "+cause)))
		}
	}
	if len(errs) > 0 { // a batch gets one array back
		r.toClient([]byte("[" + string(bytes.Join(errs, []byte(","))) + "]\n"))
	}
}

// local answers a client line while no daemon connection exists.
func (r *Relay) local(line []byte, h header, method, cause string) {
	if h.id == nil || h.method == nil {
		return // notifications and stray responses are dropped; the init replay covers initialized
	}
	switch method {
	case `"initialize"`:
		var p struct {
			Params struct {
				ProtocolVersion string `json:"protocolVersion"`
			} `json:"params"`
		}
		json.Unmarshal(line, &p)
		pv := p.Params.ProtocolVersion
		if pv == "" {
			pv = defaultProtocol
		}
		res, _ := json.Marshal(map[string]any{
			"protocolVersion": pv,
			"capabilities":    map[string]any{"tools": map[string]any{"listChanged": true}},
			"serverInfo":      map[string]any{"name": "supersurf", "version": r.cfg.Version},
		})
		r.toClient(resultLine(h.id, string(res)))
	case `"server/discover"`:
		r.toClient(errLine(h.id, -32601, "method not found"))
	case `"ping"`:
		r.toClient(resultLine(h.id, "{}"))
	case `"tools/list"`:
		tool, _ := json.Marshal(map[string]any{
			"name":        "status",
			"description": "SuperSurf is not connected to its daemon. Call this tool to see the cause and what to do.",
			"inputSchema": map[string]any{"type": "object", "properties": map[string]any{}},
		})
		r.toClient(resultLine(h.id, `{"tools":[`+string(tool)+`]}`))
	case `"tools/call"`:
		var p struct {
			Params struct {
				Name string `json:"name"`
			} `json:"params"`
		}
		json.Unmarshal(line, &p)
		if p.Params.Name == "status" {
			text, _ := json.Marshal(degradedText(cause))
			r.toClient(resultLine(h.id, `{"content":[{"type":"text","text":`+string(text)+`}]}`))
			return
		}
		r.toClient(errLine(h.id, -32000, "daemon not connected: "+cause))
	default:
		r.toClient(errLine(h.id, -32000, "daemon not connected: "+cause))
	}
}

func degradedText(cause string) string {
	return "SuperSurf is not connected to its daemon.\nCause: " + cause +
		"\nThe shim keeps retrying. When the cause is fixed the full tool list returns on its own." +
		" If your client does not refresh it, run /mcp reconnect supersurf."
}

func (r *Relay) writeConn(c net.Conn, line []byte) {
	r.wmu.Lock()
	_, err := c.Write(line)
	r.wmu.Unlock()
	if err != nil {
		c.Close() // the read loop sees the loss and fails every in-flight call
	}
}

// ---- daemon side ----

type ack struct {
	Type   string `json:"type"`
	Reason string `json:"reason"`
}

func (r *Relay) sleep(d time.Duration) bool {
	select {
	case <-time.After(d):
		return true
	case <-r.done:
		return false
	}
}

func (r *Relay) daemonLoop() {
	backoff := r.cfg.Backoff0
	for {
		select {
		case <-r.done:
			return
		default:
		}
		c, lr, err := r.dialRegister()
		if err != nil {
			r.setCause(err.Error())
			if !r.sleep(backoff) {
				return
			}
			if backoff *= 2; backoff > r.cfg.BackoffMax {
				backoff = r.cfg.BackoffMax
			}
			continue
		}
		backoff = r.cfg.Backoff0
		r.serve(c, lr)
	}
}

func (r *Relay) dialRegister() (net.Conn, *lineReader, error) {
	c, err := net.Dial("unix", r.cfg.Sock)
	if err != nil && r.cfg.Ensure != nil {
		if eerr := r.cfg.Ensure(); eerr != nil {
			return nil, nil, fmt.Errorf("the daemon is not running and could not be started: %v", eerr)
		}
		c, err = net.Dial("unix", r.cfg.Sock)
	}
	if err != nil {
		return nil, nil, fmt.Errorf("the daemon is not running (no socket at %s)", r.cfg.Sock)
	}
	reg, _ := json.Marshal(map[string]any{
		"type": "shim_register", "protocol": protocolVersion, "mode": "mcp",
		"sessionId": r.cfg.SessionID, "version": r.cfg.Version, "cwd": r.cfg.Cwd,
		"flags": r.cfg.Flags, "env": r.cfg.Env, "caps": []string{"env.get", "env.keys"},
	})
	c.SetDeadline(time.Now().Add(10 * time.Second))
	if _, err := c.Write(append(reg, '\n')); err != nil {
		c.Close()
		return nil, nil, fmt.Errorf("the daemon closed the connection during the handshake")
	}
	lr := newLineReader(c)
	line, err := lr.next()
	if err != nil {
		c.Close()
		return nil, nil, fmt.Errorf("the daemon did not answer the handshake")
	}
	var a ack
	json.Unmarshal(line, &a)
	c.SetDeadline(time.Time{})
	switch a.Type {
	case "shim_ack":
		return c, lr, nil
	case "shim_reject":
		c.Close()
		return nil, nil, fmt.Errorf("the daemon refused this session: %s", a.Reason)
	default:
		c.Close()
		return nil, nil, fmt.Errorf("the daemon is too old for this shim (it answered %q to the handshake): run `npx supersurf-daemon@latest restart`", a.Type)
	}
}

// serve relays one daemon connection until it ends, then fails every call
// that was in flight. It never re-sends a call.
func (r *Relay) serve(c net.Conn, lr *lineReader) {
	r.mu.Lock()
	if r.initLine != nil { // replay the client's initialize on the reserved id
		c.Write(r.initLine)
	}
	r.conn, r.cause = c, ""
	notify := r.localSeen
	r.localSeen = false
	r.mu.Unlock()
	if notify {
		r.toClient([]byte(`{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}` + "\n"))
	}

	for {
		line, err := lr.next()
		if err != nil {
			break
		}
		n := len(line)
		stop := r.fromDaemon(c, line)
		line = nil
		release(n)
		if stop {
			break
		}
	}

	r.mu.Lock()
	if r.conn == c {
		r.conn = nil
	}
	ids := r.inflight
	r.inflight = map[string][]byte{}
	r.cause = "the daemon connection was lost; reconnecting"
	r.mu.Unlock()
	c.Close()
	for _, id := range ids {
		r.toClient(errLine(id, -32000, "daemon connection lost; the call was not retried"))
	}
}

type control struct {
	Type string          `json:"type"`
	ID   json.RawMessage `json:"id"`
	Name string          `json:"name"`
}

// fromDaemon handles one daemon line. It returns true when the connection must end.
func (r *Relay) fromDaemon(c net.Conn, line []byte) bool {
	hs, batch := scanLine(line)
	if !batch && hs[0].typ != nil {
		return r.control(c, line)
	}
	if !batch && string(hs[0].id) == reservedID { // replay answer: not for the client
		r.writeConn(c, []byte(`{"jsonrpc":"2.0","method":"notifications/initialized"}`+"\n"))
		return false
	}
	r.mu.Lock()
	for _, h := range hs {
		if h.id != nil && h.method == nil {
			delete(r.inflight, canonicalID(h.id))
		}
	}
	r.mu.Unlock()
	r.toClient(line)
	return false
}

func (r *Relay) control(c net.Conn, line []byte) bool {
	var m control
	if json.Unmarshal(line, &m) != nil {
		return false
	}
	switch m.Type {
	case "restarting":
		return true
	case "env.get":
		v, ok := r.cfg.Dotenv.get(m.Name)
		reply := map[string]any{"type": "env.value", "id": m.ID, "name": m.Name, "found": ok}
		if ok {
			reply["value"] = v
		}
		r.sendControl(c, reply)
	case "env.keys":
		keys := r.cfg.Dotenv.keys
		if keys == nil {
			keys = []string{}
		}
		r.sendControl(c, map[string]any{"type": "env.value", "id": m.ID, "keys": keys})
	}
	return false
}

func (r *Relay) sendControl(c net.Conn, v map[string]any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	r.writeConn(c, append(b, '\n'))
}

// canonicalID keys an id the way the daemon's JSON.stringify(JSON.parse(x)) echoes it, so
// a request id 1.0 matches an answer id 1. Strings and anything unparsable stay raw.
func canonicalID(raw []byte) string {
	if len(raw) == 0 || (raw[0] != '-' && (raw[0] < '0' || raw[0] > '9')) {
		return string(raw)
	}
	f, err := strconv.ParseFloat(string(raw), 64)
	if err != nil || math.IsInf(f, 0) {
		return string(raw)
	}
	if f == 0 {
		return "0" // JSON.stringify(-0) is "0"
	}
	if a := math.Abs(f); a >= 1e21 || a < 1e-6 { // JS switches to exponent form outside this range
		e := strconv.FormatFloat(f, 'e', -1, 64) // Go pads the exponent to two digits: 1e-07
		m, x, _ := strings.Cut(e, "e")
		sign, digits := x[:1], strings.TrimLeft(x[1:], "0")
		return m + "e" + sign + digits
	}
	return strconv.FormatFloat(f, 'f', -1, 64)
}

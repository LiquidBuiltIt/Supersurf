package main

import "bytes"

// header holds the raw tokens of the three top-level fields the shim reads.
// Strings keep their quotes. idStart/idEnd are the byte offsets of the id
// token in the line, or -1 when the line has no id.
type header struct {
	id, method, typ []byte
	idStart, idEnd  int
}

func isSpace(c byte) bool { return c == ' ' || c == '\n' || c == '\t' || c == '\r' }

// parseHeader scans one top-level object once and skips nested values by
// depth and string tracking. It never decodes the message.
func parseHeader(b []byte) (h header) {
	h.idStart, h.idEnd = -1, -1
	i, n := 0, len(b)
	for i < n && b[i] != '{' {
		i++
	}
	i++
	for i < n {
		for i < n && (isSpace(b[i]) || b[i] == ',') {
			i++
		}
		if i >= n || b[i] != '"' {
			return
		}
		ks := i
		i = skipString(b, i)
		key := b[ks+1 : i-1]
		for i < n && (isSpace(b[i]) || b[i] == ':') {
			i++
		}
		vs := i
		i = skipValue(b, i)
		val := b[vs:i]
		switch string(key) {
		case "id":
			h.id, h.idStart, h.idEnd = val, vs, i
		case "method":
			h.method = val
		case "type":
			h.typ = val
		}
	}
	return
}

// skipString takes b[i]=='"' and returns the index after the closing quote.
func skipString(b []byte, i int) int {
	for i++; i < len(b); i++ {
		if b[i] == '\\' {
			i++
		} else if b[i] == '"' {
			return i + 1
		}
	}
	return len(b)
}

func skipValue(b []byte, i int) int {
	if i >= len(b) {
		return i
	}
	switch b[i] {
	case '"':
		return skipString(b, i)
	case '{', '[':
		d := 0
		for ; i < len(b); i++ {
			switch b[i] {
			case '"':
				i = skipString(b, i) - 1
			case '{', '[':
				d++
			case '}', ']':
				d--
				if d == 0 {
					return i + 1
				}
			}
		}
		return i
	}
	for i < len(b) && b[i] != ',' && b[i] != '}' && b[i] != ']' && !isSpace(b[i]) {
		i++
	}
	return i
}

// scanLine returns one header for an object line, or one per element for a
// JSON-RPC batch line (a top-level array).
func scanLine(b []byte) (hs []header, batch bool) {
	t := bytes.TrimLeft(b, " \t\r\n")
	if len(t) == 0 || t[0] != '[' {
		return []header{parseHeader(b)}, false
	}
	i := 1
	for i < len(t) {
		for i < len(t) && (isSpace(t[i]) || t[i] == ',') {
			i++
		}
		if i >= len(t) || t[i] != '{' {
			break
		}
		end := skipValue(t, i)
		hs = append(hs, parseHeader(t[i:end]))
		i = end
	}
	return hs, true
}

func (h header) isRequest() bool { return h.id != nil && h.method != nil }

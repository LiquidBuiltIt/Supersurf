package main

import (
	"bufio"
	"io"
	"runtime/debug"
)

const bigLine = 1 << 20

// lineReader returns whole lines, newline included. A line that fits the read
// buffer is returned in place (valid until the next call). A longer line is
// collected in a chunk list and joined once into an exact-size buffer, so no
// append growth leaves copies behind. A partial line at EOF is dropped: the
// shim never forwards half a message.
type lineReader struct{ r *bufio.Reader }

func newLineReader(r io.Reader) *lineReader {
	return &lineReader{r: bufio.NewReaderSize(r, 64<<10)}
}

func (l *lineReader) next() ([]byte, error) {
	chunk, err := l.r.ReadSlice('\n')
	if err == nil {
		return chunk, nil
	}
	if err != bufio.ErrBufferFull {
		return nil, err
	}
	chunks := [][]byte{append([]byte(nil), chunk...)}
	total := len(chunk)
	for {
		chunk, err = l.r.ReadSlice('\n')
		if err == nil || err == bufio.ErrBufferFull {
			chunks = append(chunks, append([]byte(nil), chunk...))
			total += len(chunk)
			if err == nil {
				break
			}
			continue
		}
		return nil, err
	}
	line := make([]byte, 0, total)
	for _, c := range chunks {
		line = append(line, c...)
	}
	return line, nil
}

// release hands memory back to the OS after a big line. The caller must have
// dropped its reference to the line first.
func release(n int) {
	if n >= bigLine {
		debug.FreeOSMemory()
	}
}

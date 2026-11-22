# supersurf-shim

Prebuilt `supersurf-shim` binaries for SuperSurf, a browser-control layer for AI agents. The shim relays an MCP client's stdio to the SuperSurf daemon.

You do not install this package yourself. `supersurf-daemon` depends on it, and `supersurf-mcp` reaches it through the daemon.

The binaries sit at `bin/<goos>-<goarch>/supersurf-shim` for linux and darwin on amd64 and arm64. The package has no `bin` field on purpose: a link on `PATH` would point at one platform only.

Project and docs: https://liquidbuiltit.github.io/Supersurf

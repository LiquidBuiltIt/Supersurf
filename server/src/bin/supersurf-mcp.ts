#!/usr/bin/env node
/**
 * `supersurf-mcp` — the MCP server entrypoint. One responsibility: start the
 * server. No subcommands, no routing through the bin selector, no argv
 * rewriting.
 *
 * This file used to splice `'mcp'` into process.argv before handing off to the
 * bin command router, so the documented `npx supersurf-mcp@latest mcp` produced
 * a duplicate positional and Commander rejected it with "too many arguments".
 * It also printed a deprecation notice pointing at `supersurf mcp` — a name
 * npm will never grant us (the bare `supersurf` package is permanently squatted;
 * `supersurf` is the curl-installed compiled binary, not an npm package).
 *
 * `../cli` parses process.argv at import time, so importing it IS the handoff.
 */

import '../cli';

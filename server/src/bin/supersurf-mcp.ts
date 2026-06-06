#!/usr/bin/env node

import { dispatch } from './dispatcher';

console.error('[supersurf-mcp] Deprecated: use `supersurf mcp` instead. This alias will be removed in a future release.');

const rewritten = [process.argv[0], process.argv[1], 'mcp', ...process.argv.slice(2)];
dispatch(rewritten).catch((err) => {
  console.error(`[supersurf-mcp] Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

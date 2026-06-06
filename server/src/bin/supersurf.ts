#!/usr/bin/env node

import { dispatch } from './dispatcher';

dispatch(process.argv).catch((err) => {
  console.error(`[supersurf] Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

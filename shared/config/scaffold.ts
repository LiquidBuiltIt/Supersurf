import * as fs from 'fs';
import * as path from 'path';
import { SCAFFOLD_DEFAULTS } from './defaults';

export interface ScaffoldResult {
  created: boolean;
  path: string;
}

export function ensureConfigFile(filePath: string): ScaffoldResult {
  if (fs.existsSync(filePath)) {
    return { created: false, path: filePath };
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    fs.writeFileSync(filePath, JSON.stringify(SCAFFOLD_DEFAULTS, null, 2) + '\n', { encoding: 'utf-8', flag: 'wx' });
    return { created: true, path: filePath };
  } catch (err: any) {
    if (err?.code === 'EEXIST') {
      // Lost the race to another writer (e.g., concurrent daemon spawn). Idempotent.
      return { created: false, path: filePath };
    }
    throw err;
  }
}

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  PLAYBOOK_EXT, getPlaybooksDir, setPlaybooksDirForTests, normalizeName,
  playbookFile, runsFile, listPlaybookFiles, nameFromFile,
} from '../src/playbooks/paths';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-paths-'));
  setPlaybooksDirForTests(dir);
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('normalizeName', () => {
  it('snake_cases and lowercases', () => {
    expect(normalizeName('Post Tweet')).toBe('post_tweet');
    expect(normalizeName('  post--tweet  ')).toBe('post_tweet');
    expect(normalizeName('postTweet')).toBe('posttweet');
  });

  it('strips path separators so a name cannot escape the directory', () => {
    expect(normalizeName('../../etc/passwd')).toBe('etc_passwd');
    expect(playbookFile('../../etc/passwd')).toBe(path.join(dir, `etc_passwd${PLAYBOOK_EXT}`));
  });
});

describe('file paths', () => {
  it('builds the script and runs sidecar paths', () => {
    expect(playbookFile('post_tweet')).toBe(path.join(dir, 'post_tweet.playbook.js'));
    expect(runsFile('post_tweet')).toBe(path.join(dir, 'post_tweet.runs.jsonl'));
  });

  it('recovers the name from a file path', () => {
    expect(nameFromFile(path.join(dir, 'post_tweet.playbook.js'))).toBe('post_tweet');
  });
});

describe('listPlaybookFiles', () => {
  it('returns only playbook scripts, sorted, as absolute paths', () => {
    fs.writeFileSync(path.join(dir, 'b.playbook.js'), '');
    fs.writeFileSync(path.join(dir, 'a.playbook.js'), '');
    fs.writeFileSync(path.join(dir, 'a.runs.jsonl'), '');
    fs.writeFileSync(path.join(dir, 'legacy.json'), '{}');
    fs.writeFileSync(path.join(dir, 'notes.js'), '');
    expect(listPlaybookFiles()).toEqual([
      path.join(dir, 'a.playbook.js'),
      path.join(dir, 'b.playbook.js'),
    ]);
  });

  it('returns an empty array when the directory does not exist', () => {
    setPlaybooksDirForTests(path.join(dir, 'nope'));
    expect(listPlaybookFiles()).toEqual([]);
  });
});

describe('getPlaybooksDir', () => {
  it('reports the directory in use', () => {
    expect(getPlaybooksDir()).toBe(dir);
  });
});

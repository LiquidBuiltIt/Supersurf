import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/playbooks/registry', () => ({
  getRecords: vi.fn(),
  getRecord: vi.fn(),
}));
vi.mock('../src/playbooks/runs', () => ({
  readRunRecords: vi.fn(() => []),
  formatRunSummary: vi.fn(() => 'runs: none'),
}));

import { doList, doInspect, doValidate } from '../src/playbooks/report';
import { getRecords, getRecord } from '../src/playbooks/registry';

const rec = (over: any = {}) => ({
  name: 'post_tweet',
  file: '/tmp/post_tweet.playbook.js',
  valid: true,
  signature: 'post_tweet(text)',
  meta: { description: 'posts a tweet', startingPoint: 'www.x.com', params: {} },
  ...over,
});

function body(res: any): string {
  return String(res?.content?.find((b: any) => b?.type === 'text')?.text ?? '');
}

describe('playbooks/report', () => {
  beforeEach(() => vi.clearAllMocks());

  it('doList renders one line per record with the normalized start host', () => {
    (getRecords as any).mockReturnValue([rec()]);
    const out = body(doList({}));
    expect(out).toContain('post_tweet(text)');
    expect(out).toContain('start: x.com');
  });

  it('doList reports the empty directory rather than an empty string', () => {
    (getRecords as any).mockReturnValue([]);
    expect(body(doList({}))).toContain('(no playbooks in ~/.supersurf/playbooks/)');
  });

  it('doInspect flags a missing playbook as an error result', () => {
    (getRecord as any).mockReturnValue(undefined);
    const res = doInspect({ name: 'nope' });
    expect(res.isError).toBe(true);
    expect(body(res)).toContain('No playbook named');
  });

  it('doValidate marks an invalid record with a cross and isError', () => {
    (getRecords as any).mockReturnValue([rec({ valid: false, error: 'bad syntax' })]);
    const res = doValidate({});
    expect(res.isError).toBe(true);
    expect(body(res)).toContain('✗ post_tweet');
  });
});

import { describe, it, expect } from 'vitest';
import { formatHistory, formatSteps } from '../src/playbooks/format';
import type { TrailEntry, Playbook } from '../src/playbooks/types';

function entry(id: number, over: Partial<TrailEntry> = {}): TrailEntry {
  return {
    id, at: 0, tool: 'browser_interact', type: 'click',
    outcome: 'ok', message: 'Clicked', params: { selector: '#a' },
    url: 'https://linkedin.com/jobs/1234', ...over,
  };
}

describe('formatHistory', () => {
  it('groups consecutive entries under one route divider', () => {
    const out = formatHistory([entry(1), entry(2), entry(3)], 3, 0);
    expect(out.match(/linkedin\.com\/jobs\/1234/g)).toHaveLength(1);
  });

  it('starts a new divider when the route changes', () => {
    const out = formatHistory(
      [entry(1), entry(2, { url: 'https://linkedin.com/jobs/1234/apply' })], 2, 0,
    );
    expect(out).toContain('linkedin.com/jobs/1234');
    expect(out).toContain('linkedin.com/jobs/1234/apply');
  });

  it('shows the id, verb and outcome for each entry', () => {
    const out = formatHistory([entry(5211)], 1, 0);
    expect(out).toContain('#5211');
    expect(out).toContain('click');
    expect(out).toContain('ok');
  });

  it('prefers a handle name over a raw selector as the target', () => {
    const out = formatHistory([entry(1, { params: { selector: '#a', name: 'apply_button' } })], 1, 0);
    expect(out).toContain('apply_button');
    expect(out).not.toContain('#a ');
  });

  it('marks failed entries distinctly', () => {
    const out = formatHistory([entry(1, { outcome: 'error', message: 'not found' })], 1, 0);
    expect(out).toContain('✗');
    expect(out).toContain('not found');
  });

  it('reports the window and the total so the agent knows to page', () => {
    const out = formatHistory([entry(5206), entry(5207)], 5215, 0);
    expect(out).toContain('5215');
  });

  it('says so plainly when the trail is empty', () => {
    const out = formatHistory([], 0, 0);
    expect(out.toLowerCase()).toContain('no actions');
  });

  it('handles entries with no url without emitting an empty divider', () => {
    const out = formatHistory([entry(1, { url: undefined })], 1, 0);
    expect(out).toContain('#1');
    expect(out).not.toContain('── ──');
  });
});

describe('formatSteps', () => {
  it('renders a playbook as a numbered step list', () => {
    const pb: Playbook = {
      name: 'apply_to_job', purpose: 'Apply to a job posting', version: 1, createdAt: 0,
      steps: [
        { tool: 'browser_interact', type: 'click', params: { type: 'click', selector: '#a', name: 'apply_button' }, url: 'https://x.com/', sourceId: 11 },
        { tool: 'browser_interact', type: 'type', params: { type: 'type', selector: '#b' }, url: 'https://x.com/', sourceId: 12 },
      ],
    };
    const out = formatSteps(pb);
    expect(out).toContain('apply_to_job');
    expect(out).toContain('Apply to a job posting');
    expect(out).toContain('1');
    expect(out).toContain('apply_button');
    expect(out).toContain('2');
  });

  it('displays key for press_key steps with no selector or name', () => {
    const pb: Playbook = {
      name: 'submit_form', purpose: 'Submit a form', version: 1, createdAt: 0,
      steps: [
        { tool: 'browser_interact', type: 'press_key', params: { type: 'press_key', key: 'Enter' }, url: 'https://x.com/', sourceId: 21 },
      ],
    };
    const out = formatSteps(pb);
    expect(out).toContain('Enter');
  });
});

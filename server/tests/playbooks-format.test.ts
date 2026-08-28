import { describe, it, expect } from 'vitest';
import { formatSteps } from '../src/playbooks/format';
import type { Playbook } from '../src/playbooks/types';

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

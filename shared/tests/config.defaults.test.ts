import { describe, it, expect } from 'vitest';
import { HARDCODED_DEFAULTS, SCAFFOLD_DEFAULTS } from '../config/defaults';

describe('config defaults', () => {
  it('HARDCODED_DEFAULTS has secure_eval on, usage_metrics off', () => {
    expect(HARDCODED_DEFAULTS.security.secure_eval).toBe(true);
    expect(HARDCODED_DEFAULTS.logging.usage_metrics).toBe(false);
  });

  it('HARDCODED_DEFAULTS has all experiments off', () => {
    expect(HARDCODED_DEFAULTS.experiments.page_diffing).toBe(false);
    expect(HARDCODED_DEFAULTS.experiments.smart_waiting).toBe(false);
    expect(HARDCODED_DEFAULTS.experiments.mouse_humanization).toBe(false);
  });

  it('regression lock: profiles is not an experiment (graduated)', () => {
    expect('profiles' in HARDCODED_DEFAULTS.experiments).toBe(false);
  });

  it('does not include graduated experiments', () => {
    expect('storage_inspection' in HARDCODED_DEFAULTS.experiments).toBe(false); // graduated v3.5.0
  });

  it('HARDCODED_DEFAULTS port is 5555', () => {
    expect(HARDCODED_DEFAULTS.daemon.port).toBe(5555);
  });

  it('HARDCODED_DEFAULTS tips on, debug off', () => {
    expect(HARDCODED_DEFAULTS.tips).toBe(true);
    expect(HARDCODED_DEFAULTS.logging.debug).toBe(false);
  });

  it('SCAFFOLD_DEFAULTS flips usage_metrics on', () => {
    expect(SCAFFOLD_DEFAULTS.logging.usage_metrics).toBe(true);
  });

  it('SCAFFOLD_DEFAULTS otherwise matches HARDCODED_DEFAULTS', () => {
    const cloneNoMetrics = JSON.parse(JSON.stringify(SCAFFOLD_DEFAULTS));
    cloneNoMetrics.logging.usage_metrics = false;
    expect(cloneNoMetrics).toEqual(HARDCODED_DEFAULTS);
  });

  it('HARDCODED_DEFAULTS has playbook_eval on', () => {
    expect(HARDCODED_DEFAULTS.security.playbook_eval).toBe(true);
  });
});

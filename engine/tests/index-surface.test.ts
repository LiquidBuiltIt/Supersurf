import { describe, it, expect } from 'vitest';
import * as engine from '../src/index';

describe('engine barrel', () => {
  it('exports what the server entry needs', () => {
    for (const name of [
      'AgentSessionManager', 'startScriptMode', 'runPlaybookCli',
      'loadDotenv', 'setSkillsInstalled', 'detectPluginSkills', 'getRegistry', 'getLogger',
    ]) {
      expect(typeof (engine as Record<string, unknown>)[name], name).toBe('function');
    }
  });
});

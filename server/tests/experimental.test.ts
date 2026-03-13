import { describe, it, expect, vi, beforeEach } from 'vitest';

// Import directly — no mocks needed for pure logic modules
import {
  experimentRegistry,
  applyInitialState,
  diffSnapshots,
  calculateConfidence,
  formatDiffSection,
} from '../src/experimental/index';
import type { PageState, DiffResult } from '../src/experimental/index';

// ── ExperimentRegistry ──────────────────────────────────────────

describe('ExperimentRegistry', () => {
  beforeEach(() => {
    experimentRegistry.reset();
  });

  describe('enable / disable / isEnabled', () => {
    it('starts with all experiments disabled', () => {
      expect(experimentRegistry.isEnabled('page_diffing')).toBe(false);
      expect(experimentRegistry.isEnabled('smart_waiting')).toBe(false);
    });

    it('enables an experiment', () => {
      experimentRegistry.enable('page_diffing');
      expect(experimentRegistry.isEnabled('page_diffing')).toBe(true);
    });

    it('disables an experiment', () => {
      experimentRegistry.enable('page_diffing');
      experimentRegistry.disable('page_diffing');
      expect(experimentRegistry.isEnabled('page_diffing')).toBe(false);
    });

    it('throws on unknown experiment name', () => {
      expect(() => experimentRegistry.enable('bogus')).toThrow('Unknown experiment');
      expect(() => experimentRegistry.disable('bogus')).toThrow('Unknown experiment');
    });
  });

  describe('reset()', () => {
    it('clears all enabled experiments', () => {
      experimentRegistry.enable('page_diffing');
      experimentRegistry.enable('smart_waiting');
      experimentRegistry.reset();
      expect(experimentRegistry.isEnabled('page_diffing')).toBe(false);
      expect(experimentRegistry.isEnabled('smart_waiting')).toBe(false);
    });
  });

  describe('listAvailable()', () => {
    it('returns expected experiment names', () => {
      const available = experimentRegistry.listAvailable();
      expect(available).toContain('page_diffing');
      expect(available).toContain('smart_waiting');
      expect(available).toContain('storage_inspection');
      expect(available).toContain('mouse_humanization');
      expect(available).toContain('secure_eval');
      expect(available.length).toBe(5);
    });
  });

  describe('getStates()', () => {
    it('returns state map for all experiments', () => {
      experimentRegistry.enable('smart_waiting');
      const states = experimentRegistry.getStates();
      expect(states).toEqual({ page_diffing: false, smart_waiting: true, storage_inspection: false, mouse_humanization: false, secure_eval: false });
    });
  });

  describe('isAvailable()', () => {
    it('returns true for known experiments', () => {
      expect(experimentRegistry.isAvailable('page_diffing')).toBe(true);
    });

    it('returns false for unknown experiments', () => {
      expect(experimentRegistry.isAvailable('warp_drive')).toBe(false);
    });
  });
});

// ── applyInitialState ───────────────────────────────────────────

describe('applyInitialState()', () => {
  beforeEach(() => {
    experimentRegistry.reset();
  });

  it('pre-enables session experiments from config', () => {
    applyInitialState({ enabledExperiments: ['page_diffing', 'smart_waiting'] });
    expect(experimentRegistry.isEnabled('page_diffing')).toBe(true);
    expect(experimentRegistry.isEnabled('smart_waiting')).toBe(true);
  });

  it('silently skips unknown experiment names not in AVAILABLE_EXPERIMENTS', () => {
    applyInitialState({ enabledExperiments: ['unknown_feature', 'page_diffing'] });
    expect(experimentRegistry.isEnabled('page_diffing')).toBe(true);
    // unknown_feature doesn't throw — just skipped
  });

  it('does nothing when no config', () => {
    applyInitialState({});
    expect(experimentRegistry.isEnabled('page_diffing')).toBe(false);
  });
});

// ── IPC Proxy Behavior ──────────────────────────────────────────

function mockTransport() {
  return {
    sendCmd: vi.fn().mockResolvedValue({ success: true }),
    connected: true,
    browser: 'chrome',
    buildTime: null,
    onReconnect: null,
    onTabInfoUpdate: null,
    notifyClientId: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  } as any;
}

describe('ExperimentRegistry (IPC proxy)', () => {
  beforeEach(() => {
    experimentRegistry.unbind();
  });

  describe('bind / unbind', () => {
    it('unbind clears the cache', () => {
      experimentRegistry.enable('page_diffing');
      expect(experimentRegistry.isEnabled('page_diffing')).toBe(true);

      experimentRegistry.unbind();
      expect(experimentRegistry.isEnabled('page_diffing')).toBe(false);
    });
  });

  describe('toggle()', () => {
    it('sends experiments.toggle IPC to daemon', async () => {
      const transport = mockTransport();
      experimentRegistry.bind(transport);

      await experimentRegistry.toggle('page_diffing', true);

      expect(transport.sendCmd).toHaveBeenCalledWith(
        'experiments.toggle',
        { experiment: 'page_diffing', enabled: true },
        5000,
      );
    });

    it('updates local cache after IPC', async () => {
      const transport = mockTransport();
      experimentRegistry.bind(transport);

      await experimentRegistry.toggle('smart_waiting', true);
      expect(experimentRegistry.isEnabled('smart_waiting')).toBe(true);

      await experimentRegistry.toggle('smart_waiting', false);
      expect(experimentRegistry.isEnabled('smart_waiting')).toBe(false);
    });

    it('throws on unknown experiment', async () => {
      experimentRegistry.bind(mockTransport());
      await expect(experimentRegistry.toggle('warp_drive', true)).rejects.toThrow('Unknown experiment');
    });
  });

  describe('enable() with transport', () => {
    it('fire-and-forget IPCs to daemon', () => {
      const transport = mockTransport();
      experimentRegistry.bind(transport);

      experimentRegistry.enable('page_diffing');

      expect(transport.sendCmd).toHaveBeenCalledWith(
        'experiments.toggle',
        { experiment: 'page_diffing', enabled: true },
        5000,
      );
      expect(experimentRegistry.isEnabled('page_diffing')).toBe(true);
    });
  });

  describe('disable() with transport', () => {
    it('fire-and-forget IPCs to daemon', () => {
      const transport = mockTransport();
      experimentRegistry.bind(transport);

      experimentRegistry.enable('page_diffing');
      experimentRegistry.disable('page_diffing');

      expect(transport.sendCmd).toHaveBeenCalledWith(
        'experiments.toggle',
        { experiment: 'page_diffing', enabled: false },
        5000,
      );
      expect(experimentRegistry.isEnabled('page_diffing')).toBe(false);
    });
  });

  describe('isEnabled() reads from cache, not IPC', () => {
    it('does not call sendCmd', () => {
      const transport = mockTransport();
      experimentRegistry.bind(transport);
      experimentRegistry.enable('page_diffing');

      transport.sendCmd.mockClear();
      experimentRegistry.isEnabled('page_diffing');

      expect(transport.sendCmd).not.toHaveBeenCalled();
    });
  });

  describe('works without transport bound', () => {
    it('enable/disable work as local-only cache', () => {
      experimentRegistry.enable('page_diffing');
      expect(experimentRegistry.isEnabled('page_diffing')).toBe(true);

      experimentRegistry.disable('page_diffing');
      expect(experimentRegistry.isEnabled('page_diffing')).toBe(false);
    });

    it('toggle works without transport', async () => {
      await experimentRegistry.toggle('page_diffing', true);
      expect(experimentRegistry.isEnabled('page_diffing')).toBe(true);
    });
  });
});

// ── Page Diffing ────────────────────────────────────────────────

describe('diffSnapshots()', () => {
  function makeState(overrides: Partial<PageState> = {}): PageState {
    return {
      elementCount: 100,
      textContent: ['Hello', 'World'],
      shadowRootCount: 0,
      iframeCount: 0,
      visibleIframeCount: 0,
      hiddenElementCount: 0,
      pageElementCount: 1000,
      formValues: {},
      ...overrides,
    };
  }

  it('detects added text', () => {
    const before = makeState({ textContent: ['Hello'] });
    const after = makeState({ textContent: ['Hello', 'New text'] });
    const diff = diffSnapshots(before, after);
    expect(diff.added).toEqual(['New text']);
    expect(diff.removed).toEqual([]);
  });

  it('detects removed text', () => {
    const before = makeState({ textContent: ['Hello', 'Gone'] });
    const after = makeState({ textContent: ['Hello'] });
    const diff = diffSnapshots(before, after);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual(['Gone']);
  });

  it('calculates element count delta', () => {
    const before = makeState({ elementCount: 100 });
    const after = makeState({ elementCount: 120 });
    const diff = diffSnapshots(before, after);
    expect(diff.countDelta).toBe(20);
  });

  it('returns empty diff when nothing changed', () => {
    const state = makeState();
    const diff = diffSnapshots(state, state);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.countDelta).toBe(0);
    expect(diff.formChanges).toEqual([]);
  });

  it('detects form field changes (empty to filled)', () => {
    const before = makeState({ formValues: { first_name: '' } });
    const after = makeState({ formValues: { first_name: 'Aidan' } });
    const diff = diffSnapshots(before, after);
    expect(diff.formChanges).toEqual([{ field: 'first_name', from: '', to: 'Aidan' }]);
  });

  it('detects form field changes (filled to different)', () => {
    const before = makeState({ formValues: { email: 'old@test.com' } });
    const after = makeState({ formValues: { email: 'new@test.com' } });
    const diff = diffSnapshots(before, after);
    expect(diff.formChanges).toEqual([{ field: 'email', from: 'old@test.com', to: 'new@test.com' }]);
  });

  it('detects form field changes (filled to empty)', () => {
    const before = makeState({ formValues: { name: 'John' } });
    const after = makeState({ formValues: {} });
    const diff = diffSnapshots(before, after);
    expect(diff.formChanges).toEqual([{ field: 'name', from: 'John', to: '' }]);
  });

  it('handles missing formValues gracefully (backward compat)', () => {
    const before = makeState();
    const after = makeState();
    // Simulate old extension that doesn't send formValues
    delete (before as any).formValues;
    delete (after as any).formValues;
    const diff = diffSnapshots(before, after);
    expect(diff.formChanges).toEqual([]);
  });

  it('detects new fields appearing', () => {
    const before = makeState({ formValues: {} });
    const after = makeState({ formValues: { first_name: 'Aidan', last_name: 'Rodriguez' } });
    const diff = diffSnapshots(before, after);
    expect(diff.formChanges).toHaveLength(2);
    expect(diff.formChanges.map(c => c.field)).toContain('first_name');
    expect(diff.formChanges.map(c => c.field)).toContain('last_name');
  });
});

describe('calculateConfidence()', () => {
  function makeState(overrides: Partial<PageState> = {}): PageState {
    return {
      elementCount: 100,
      textContent: [],
      shadowRootCount: 0,
      iframeCount: 0,
      visibleIframeCount: 0,
      hiddenElementCount: 0,
      pageElementCount: 1000,
      formValues: {},
      ...overrides,
    };
  }

  it('returns 1.0 for a simple page', () => {
    expect(calculateConfidence(makeState())).toBe(1.0);
  });

  it('deducts flat -0.05 for any shadow roots', () => {
    expect(calculateConfidence(makeState({ shadowRootCount: 5 }))).toBe(0.95);
  });

  it('deducts flat -0.05 for many shadow roots (same penalty)', () => {
    expect(calculateConfidence(makeState({ shadowRootCount: 15 }))).toBe(0.95);
  });

  it('deducts flat -0.05 for visible iframes', () => {
    expect(calculateConfidence(makeState({ visibleIframeCount: 3 }))).toBe(0.95);
  });

  it('deducts flat -0.05 for many visible iframes (same penalty)', () => {
    expect(calculateConfidence(makeState({ visibleIframeCount: 10 }))).toBe(0.95);
  });

  it('no penalty for hidden-only iframes (tracking pixels, analytics)', () => {
    expect(calculateConfidence(makeState({ iframeCount: 5, visibleIframeCount: 0 }))).toBe(1.0);
  });

  it('deducts for large page (>5000 elements)', () => {
    expect(calculateConfidence(makeState({ pageElementCount: 8000 }))).toBe(0.95);
  });

  it('no penalty for hidden elements', () => {
    expect(calculateConfidence(makeState({ hiddenElementCount: 5 }))).toBe(1.0);
  });

  it('stacks flat penalties but stays high', () => {
    const worstCase = makeState({
      shadowRootCount: 20,
      visibleIframeCount: 10,
      pageElementCount: 10000,
      hiddenElementCount: 100,
    });
    // -0.05 shadow + -0.05 visible iframe + -0.05 large = 0.85
    expect(calculateConfidence(worstCase)).toBeCloseTo(0.85);
  });
});

describe('formatDiffSection()', () => {
  it('includes confidence percentage', () => {
    const diff: DiffResult = { added: [], removed: [], countDelta: 0, formChanges: [] };
    const output = formatDiffSection(diff, 0.85);
    expect(output).toContain('85%');
  });

  it('shows element count delta', () => {
    const diff: DiffResult = { added: [], removed: [], countDelta: 15, formChanges: [] };
    const output = formatDiffSection(diff, 1.0);
    expect(output).toContain('+15');
  });

  it('shows negative element count delta', () => {
    const diff: DiffResult = { added: [], removed: [], countDelta: -5, formChanges: [] };
    const output = formatDiffSection(diff, 1.0);
    expect(output).toContain('-5');
  });

  it('shows added text', () => {
    const diff: DiffResult = { added: ['New content'], removed: [], countDelta: 0, formChanges: [] };
    const output = formatDiffSection(diff, 1.0);
    expect(output).toContain('Added text');
    expect(output).toContain('New content');
  });

  it('shows removed text', () => {
    const diff: DiffResult = { added: [], removed: ['Old content'], countDelta: 0, formChanges: [] };
    const output = formatDiffSection(diff, 1.0);
    expect(output).toContain('Removed text');
    expect(output).toContain('Old content');
  });

  it('truncates long text entries', () => {
    const longText = 'A'.repeat(80);
    const diff: DiffResult = { added: [longText], removed: [], countDelta: 0, formChanges: [] };
    const output = formatDiffSection(diff, 1.0);
    expect(output).toContain('...');
  });

  it('limits shown entries to 5 and shows overflow count', () => {
    const diff: DiffResult = {
      added: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
      removed: [],
      countDelta: 0,
      formChanges: [],
    };
    const output = formatDiffSection(diff, 1.0);
    expect(output).toContain('+2 more');
  });

  it('shows "No visible changes" for empty diff', () => {
    const diff: DiffResult = { added: [], removed: [], countDelta: 0, formChanges: [] };
    const output = formatDiffSection(diff, 1.0);
    expect(output).toContain('No visible changes');
  });

  it('shows shadow DOM annotation only when shadow roots present', () => {
    const diff: DiffResult = { added: [], removed: [], countDelta: 0, formChanges: [] };
    const state: PageState = { elementCount: 10, textContent: [], shadowRootCount: 2, iframeCount: 0, visibleIframeCount: 0, hiddenElementCount: 0, pageElementCount: 50, formValues: {} };
    const output = formatDiffSection(diff, 0.95, state);
    expect(output).toContain('partial — shadow DOM present');
    expect(output).not.toContain('iframes');
  });

  it('shows visible iframe annotation with count', () => {
    const diff: DiffResult = { added: [], removed: [], countDelta: 0, formChanges: [] };
    const state: PageState = { elementCount: 10, textContent: [], shadowRootCount: 0, iframeCount: 5, visibleIframeCount: 2, hiddenElementCount: 0, pageElementCount: 50, formValues: {} };
    const output = formatDiffSection(diff, 0.95, state);
    expect(output).toContain('iframes (2 visible)');
    expect(output).not.toContain('shadow DOM');
  });

  it('shows combined annotation for shadow DOM + visible iframes', () => {
    const diff: DiffResult = { added: [], removed: [], countDelta: 0, formChanges: [] };
    const state: PageState = { elementCount: 10, textContent: [], shadowRootCount: 1, iframeCount: 3, visibleIframeCount: 1, hiddenElementCount: 0, pageElementCount: 50, formValues: {} };
    const output = formatDiffSection(diff, 0.9, state);
    expect(output).toContain('shadow DOM + iframes (1 visible)');
  });

  it('no annotation when iframes exist but none visible', () => {
    const diff: DiffResult = { added: [], removed: [], countDelta: 0, formChanges: [] };
    const state: PageState = { elementCount: 10, textContent: [], shadowRootCount: 0, iframeCount: 5, visibleIframeCount: 0, hiddenElementCount: 0, pageElementCount: 50, formValues: {} };
    const output = formatDiffSection(diff, 1.0, state);
    expect(output).not.toContain('partial');
    expect(output).not.toContain('iframes');
  });

  it('renders form changes', () => {
    const diff: DiffResult = {
      added: [], removed: [], countDelta: 0,
      formChanges: [
        { field: 'first_name', from: '', to: 'Aidan' },
        { field: 'email', from: '', to: 'test@example.com' },
      ],
    };
    const output = formatDiffSection(diff, 1.0);
    expect(output).toContain('Form changes:');
    expect(output).toContain('first_name');
    expect(output).toContain('(empty)');
    expect(output).toContain('"Aidan"');
    expect(output).toContain('\u2192');
  });

  it('does not show "No visible changes" when only form changes present', () => {
    const diff: DiffResult = {
      added: [], removed: [], countDelta: 0,
      formChanges: [{ field: 'name', from: '', to: 'John' }],
    };
    const output = formatDiffSection(diff, 1.0);
    expect(output).not.toContain('No visible changes');
    expect(output).toContain('Form changes:');
  });

  it('truncates long form values at 40 chars', () => {
    const longValue = 'A'.repeat(50);
    const diff: DiffResult = {
      added: [], removed: [], countDelta: 0,
      formChanges: [{ field: 'bio', from: '', to: longValue }],
    };
    const output = formatDiffSection(diff, 1.0);
    expect(output).toContain('...');
  });

  it('caps form changes display at 8 fields', () => {
    const formChanges = Array.from({ length: 12 }, (_, i) => ({
      field: `field_${i}`, from: '', to: `val_${i}`,
    }));
    const diff: DiffResult = { added: [], removed: [], countDelta: 0, formChanges };
    const output = formatDiffSection(diff, 1.0);
    expect(output).toContain('+4 more');
    // Should show first 8
    expect(output).toContain('field_0');
    expect(output).toContain('field_7');
    // Should not show 9th
    expect(output).not.toContain('field_8');
  });

  it('shows "(viewport only)" label when mode is viewport', () => {
    const diff: DiffResult = { added: ['New content'], removed: [], countDelta: 5, formChanges: [] };
    const output = formatDiffSection(diff, 1.0, undefined, 'viewport');
    expect(output).toContain('(viewport only)');
    expect(output).toContain('100%');
  });

  it('does not show "(viewport only)" for document mode', () => {
    const diff: DiffResult = { added: [], removed: [], countDelta: 0, formChanges: [] };
    const output = formatDiffSection(diff, 1.0, undefined, 'document');
    expect(output).not.toContain('viewport only');
  });
});

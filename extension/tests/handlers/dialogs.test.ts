import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DialogHandler } from '../../src/handlers/dialogs';

function makeChrome() {
  return {
    debugger: { sendCommand: vi.fn().mockResolvedValue(undefined) },
  } as any;
}
function makeLogger() {
  return { log: vi.fn(), logAlways: vi.fn(), error: vi.fn(), warn: vi.fn(), setDebugMode: vi.fn() } as any;
}

describe('DialogHandler.onDialogOpening / getPending / clearPending', () => {
  let handler: DialogHandler;
  beforeEach(() => { handler = new DialogHandler(makeChrome(), makeLogger()); });

  it('records a held dialog from a javascriptDialogOpening payload', () => {
    handler.onDialogOpening(7, {
      type: 'confirm', message: 'Delete this?', defaultPrompt: '',
      url: 'https://example.com/', hasBrowserHandler: true,
    });
    const p = handler.getPending(7);
    expect(p).toMatchObject({
      type: 'confirm', message: 'Delete this?', defaultPrompt: '',
      url: 'https://example.com/', hasBrowserHandler: true,
    });
    expect(typeof p!.timestamp).toBe('number');
  });

  it('defaults missing optional fields safely', () => {
    handler.onDialogOpening(7, { type: 'alert', message: 'Hi' });
    expect(handler.getPending(7)).toMatchObject({
      type: 'alert', message: 'Hi', defaultPrompt: '', url: '', hasBrowserHandler: false,
    });
  });

  it('getPending returns null before any dialog', () => {
    expect(handler.getPending(7)).toBeNull();
  });

  it('clearPending drops the held dialog', () => {
    handler.onDialogOpening(7, { type: 'alert', message: 'Hi' });
    handler.clearPending(7);
    expect(handler.getPending(7)).toBeNull();
  });
});

describe('DialogHandler.handle (CDP Page.handleJavaScriptDialog)', () => {
  let chromeMock: any;
  let handler: DialogHandler;
  beforeEach(() => { chromeMock = makeChrome(); handler = new DialogHandler(chromeMock, makeLogger()); });

  it('accepts with promptText and clears pending', async () => {
    handler.onDialogOpening(7, { type: 'prompt', message: 'Name?', defaultPrompt: 'x' });
    await handler.handle(7, true, 'Alice');
    expect(chromeMock.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 7 }, 'Page.handleJavaScriptDialog', { accept: true, promptText: 'Alice' },
    );
    expect(handler.getPending(7)).toBeNull();
  });

  it('dismisses with empty promptText', async () => {
    handler.onDialogOpening(7, { type: 'confirm', message: 'Sure?' });
    await handler.handle(7, false, '');
    expect(chromeMock.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 7 }, 'Page.handleJavaScriptDialog', { accept: false, promptText: '' },
    );
    expect(handler.getPending(7)).toBeNull();
  });

  it('swallows "No dialog is showing" and still clears pending', async () => {
    chromeMock.debugger.sendCommand.mockRejectedValueOnce(new Error('No dialog is showing.'));
    handler.onDialogOpening(7, { type: 'alert', message: 'Hi' });
    await expect(handler.handle(7, true, '')).resolves.toBeUndefined();
    expect(handler.getPending(7)).toBeNull();
  });

  it('propagates non-"no dialog" CDP errors and keeps pending', async () => {
    chromeMock.debugger.sendCommand.mockRejectedValueOnce(new Error('Debugger is not attached to this tab.'));
    handler.onDialogOpening(7, { type: 'alert', message: 'Hi' });
    await expect(handler.handle(7, true, '')).rejects.toThrow(/not attached/);
    expect(handler.getPending(7)).not.toBeNull();
  });
});

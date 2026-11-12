import { registerAction } from './registry';
import { findElementInFrames, healSelectorAcrossFrames } from '../lib/frames';

registerAction({
  name: 'file_upload',
  async run(ctx, action) {
    const meta = { name: action.name, purpose: action.purpose };
    // Descend to the actual file input: uploader UIs hide input[type=file]
    // behind a styled dropzone/label, and DOM.setFileInputFiles rejects
    // anything else with "Node is not a file input element".
    const resolveExpr = `(() => {
        const el = ${ctx.getSelectorExpression(action.selector)};
        if (!el) return null;
        if (el.tagName === 'INPUT' && el.type === 'file') return el;
        return el.querySelector('input[type="file"]') || el;
      })()
    `;
    const verificationExpr = `(() => {
        const root = ${ctx.getSelectorExpression(action.selector)};
        if (!root) return { verified: false, count: 0 };
        const el = (root.tagName === 'INPUT' && root.type === 'file')
          ? root : (root.querySelector('input[type="file"]') || root);
        const count = el.files ? el.files.length : 0;
        return { verified: count === ${action.files.length}, count };
      })()
    `;

    const resolve = async (): Promise<{ objectId: string; frameContextId: number | null }> => {
      // Step 1: top frame first (happy path).
      const evalResult = await ctx.cdp('Runtime.evaluate', {
        expression: resolveExpr,
        returnByValue: false,
      });
      let objectId: string | undefined = evalResult.result?.objectId;
      let frameContextId: number | null = null;
      if (objectId && action.selector) {
        ctx.captureFingerprintInContext?.(null, action.selector, meta); // null contextId => top frame
      }
      // Step 2: DFS child frames on top-frame miss.
      if (!objectId) {
        const match = await findElementInFrames(ctx, resolveExpr);
        if (match) {
          objectId = match.objectId;
          frameContextId = match.contextId;
          if (action.selector) {
            ctx.captureFingerprintInContext?.(match.contextId, action.selector, meta);
          }
        } else if (action.selector) {
          // Step 3: no frame matched — try a fingerprint heal.
          const healed = await healSelectorAcrossFrames(ctx, action.selector);
          if (healed) {
            objectId = healed.objectId;
            frameContextId = healed.contextId;
          }
        }
      }
      if (!objectId) {
        // Report what IS on the page so the agent can self-correct the selector.
        const present: string[] = await ctx.eval(
          `[...document.querySelectorAll('input[type="file"]')].slice(0, 5).map(i =>
            i.id ? '#' + i.id : (i.name ? 'input[name="' + i.name + '"]' : 'input[type=file]'))`
        ).catch(() => []);
        const hint = Array.isArray(present) && present.length
          ? ` File inputs present on the page: ${present.join(', ')}` : '';
        throw new Error(`Element not found in any frame: ${action.selector}.${hint}`);
      }
      return { objectId, frameContextId };
    };

    const setFiles = async (objectId: string): Promise<void> => {
      const nodeResult = await ctx.cdp('DOM.describeNode', { objectId });
      await ctx.cdp('DOM.setFileInputFiles', {
        files: action.files,
        backendNodeId: nodeResult.node.backendNodeId,
      });
    };

    let { objectId, frameContextId } = await resolve();
    let retried = false;
    try {
      await setFiles(objectId);
    } catch (e: any) {
      const msg = String(e?.message || e);
      if (/object id|could not find object/i.test(msg)) {
        // The page re-rendered between resolution and use — re-resolve once.
        retried = true;
        ({ objectId, frameContextId } = await resolve());
        await setFiles(objectId);
      } else if (/not a file input/i.test(msg)) {
        throw new Error(
          `${action.selector} resolved to an element that is not a file input and contains ` +
          `no input[type=file] descendant. Target the <input type="file"> element directly.`,
        );
      } else {
        throw e;
      }
    }

    // Read-back must run in the SAME frame context as the input.
    let verification: any;
    if (frameContextId !== null) {
      const r = await ctx.cdp('Runtime.evaluate', {
        expression: verificationExpr,
        contextId: frameContextId,
        returnByValue: true,
      });
      verification = r.result?.value;
    } else {
      verification = await ctx.eval(verificationExpr);
    }

    const expectedCount = action.files.length;
    const via = retried ? ' (re-resolved after a page re-render)' : '';
    if (verification?.verified) {
      return `Uploaded ${expectedCount} file(s) to ${action.selector}${via}`;
    }
    return `⚠ Uploaded ${expectedCount} file(s) to ${action.selector}${via} (unverified — input reports ${verification?.count ?? 0} file(s) after upload; the page may not have observed the change)`;
  },
});

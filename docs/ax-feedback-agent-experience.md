# SuperSurf AX Feedback: Agent Experience on ATS Forms

**Context:** Real-world feedback from `job-search-operator` agent conducting overnight job application sprint (April 8, 2026). Covered ~10 ATS forms across Greenhouse Remix, Ashby, Lever, iCIMS, BambooHR, JazzHR, LinkedIn Easy Apply. ~10 applications submitted with significant friction on form automation. This document captures diagnosed issues, required fixes, and requested features.

---

## Bugs

### 1. `browser_evaluate` Function Form Returns `{}`

**Issue:** Calling `browser_evaluate` with `function` form (arrow function as second parameter) silently returns empty object across multiple attempts. Switching to `expression` form with `JSON.stringify()` wrapper works immediately.

**Symptom:** Agent observes empty object `{}` every time with function form; `expression` form works on first try every time.

**Root Cause:** Server-side scoping is correct (misc.ts:53-124 properly routes both `function` and `expression` forms). However, the extension-side handler for the function form is not serializing the return value back to the client. The code executes but the return object isn't being sent in the response.

**Proposed Fix Direction:** Verify extension's `evaluate` command handler (likely background.ts or within the `evaluate` case of the command dispatcher) is properly extracting and returning the result from `Runtime.evaluate` execution. Ensure return value is JSON-serialized back to the server response.

**Priority:** P1 (all function-form evaluate calls fail silently)

---

### 2. `secure_eval` Blocklist Overzealous on React State-Setter Patterns

**Issue:** `secure_eval` experiment blocks `Object.getOwnPropertyDescriptor` and `Reflect.*` methods, which are essential for working around controlled input state issues on React forms. Agent must disable `secure_eval` entirely to perform necessary state mutations, losing security guardrails.

**Symptom:** When `secure_eval` is enabled, user-submitted `browser_evaluate` code containing `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set` is blocked. The same pattern is necessary to trigger React synthetic onChange events on controlled inputs.

**Root Cause:** secure-eval.ts lines 124-131 and 174-184 block `Object.getOwnPropertyDescriptor` and `Reflect.*` as overly broad security measures to prevent descriptor-based proxy bypass and API exfiltration. However, these are required primitives for the specific use case of React controlled input state manipulation.

**Proposed Fix Direction:** Add a whitelist carve-out in the `secure_eval` blocklist for the specific pattern: `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(...)` and basic `Reflect.get/set/apply` when used for property access (not traversal). Alternatively, document this as an intentional gap and recommend disabling `secure_eval` for ATS form automation tasks.

**Priority:** P1 (gates ATS form automation work; agent currently disables experiment to work around)

---

### 3. `select_custom` Silent Failure on React-Select Dropdown State

**Issue:** `select_custom` updates the visible dropdown label on React-Select components but does not fire React's onChange handler, leaving form state unchanged. Form submission fails validation with "required field" error even though the visual dropdown shows the correct selection.

**Symptom:** Agent observes correct label in dropdown UI, but on submit form validation errors indicate field is still empty. Workaround requires fiber walking from input up through React fiber tree to locate `memoizedProps.selectProps.onChange` + `memoizedProps.options`, then invoking onChange directly.

**Root Cause:** interaction.ts lines 370-522 for `select_custom` only dispatch DOM events (`mousedown`, `mouseup`, `click`). React-Select listens for these but maintains state in the fiber tree; the DOM events alone don't trigger the synthetic onChange. No fallback detection when DOM dispatch fails to mutate form state.

**Proposed Fix Direction:** After DOM event dispatch, read back the React fiber state (or the form input's current data-bound value) to detect if onChange actually fired. If not, log a warning that includes the diagnosis (React fiber manipulation needed) and suggest the fiber walk fallback or a future fiber-aware mutation path.

**Priority:** P2 (ATS form pain point; workaround exists but requires manual fiber walks)

---

### 4. Missing Post-Action Validation on `fill_form`, `select_custom`, `file_upload`

**Issue:** Tools return `success: true` after performing mutations without validating that the underlying form state actually changed. Discovery of failure only occurs at form submission time with cryptic validation errors.

**Symptom:** `fill_form` sets input `.value`, `select_custom` dispatches click events, `file_upload` triggers file input — all return success — but React controlled inputs, form state, or hidden form fields (like Lever's `Resume_URL`) remain unchanged. Agent only discovers failure when submit returns validation error.

**Root Cause:** Tools (forms.ts, interaction.ts) lack post-action verification. They perform the mutation and assume success. No read-back of field state, no fiber inspection, no check of form's internal state object.

**Proposed Fix Direction:** Each tool should read back the relevant field state immediately after mutation: for text inputs, compare `.value`; for select, read React fiber or data attribute; for file uploads, check hidden form fields or fire a change event and listen for state update. Return a `validationStatus` field in response (or upgrade success to a confidence level) indicating whether form state matches expected post-mutation state.

**Priority:** P2 (worst failure mode — forces reverse-engineering which field broke)

---

## Feature Requests

### 1. `select_custom` React Fiber Walk Fallback

**Issue:** React-Select and similar libraries require fiber-based onChange invocation when DOM events alone don't propagate state. Current tool has no automatic fallback.

**Proposed Implementation:** When DOM dispatch on a select input doesn't update visible state, attempt a fiber walk from the input element upward to locate a React fiber node with `memoizedProps.selectProps.onChange` and `memoizedProps.options`. Invoke the onChange with the target option and action type. This is deterministic at depth 3-5 for most ATS form selects.

**Impact/Effort:** Medium effort (fiber walking logic needed), high impact (eliminates manual fiber walk workaround for agent)

---

### 2. `browser_snapshot` Server-Side InlineTextBox Coalescing

**Issue:** On content-heavy pages (e.g., LinkedIn job detail with "Similar jobs" sidebar), Chrome's accessibility tree returns per-character InlineTextBox nodes, ballooning snapshot size from ~300 lines to ~2000 lines with minimal signal gain.

**Proposed Implementation:** Post-processing in content.ts around lines 78-90. After receiving `Accessibility.getFullAXTree` result, iterate the nodes and group sibling InlineTextBox nodes with the same parent into a single collapsed entry (concatenate text, keep single node). This reduces verbosity without losing semantic content.

**Impact/Effort:** Low effort (straightforward tree traversal + merge), high impact (massive context reduction on verbose pages)

---

### 3. `browser_snapshot` Optional `selector` Scoping Parameter

**Issue:** Agent cannot scope snapshot to a specific region (e.g., main job details section), forcing retrieval of the entire page tree and filtering downstream.

**Proposed Implementation:** Add optional `selector` parameter to `onSnapshot` schema. If provided, call `DOM.describeNode` on the element matching the selector first, then limit accessibility tree retrieval to that subtree.

**Impact/Effort:** Low effort (extend parameter, add scope check), high impact (major context savings on large pages)

---

### 4. `file_upload` CDP Frame Targeting

**Issue:** `file_upload` cannot reach file input elements nested inside iframes. Many ATS platforms (Atlassian, others) iframe-wrap content like iCIMS. The tool's use of `Runtime.evaluate` + `DOM.describeNode` + `DOM.setFileInputFiles` operates on the main document only. CDP supports frame targeting but the tool doesn't expose it.

**Proposed Implementation:** Extend `file_upload` schema to accept either a `selector` (main document, current behavior) or a `frameSelector` parameter identifying the iframe. Use CDP's frame discovery (`Page.getFrameTree`) to locate the frame, then route `setFileInputFiles` to that frame's context.

**Impact/Effort:** High effort (frame discovery + routing logic), medium impact (solves iframe-wrapped form issue, not common but critical when encountered)

---

### 5. Lightweight Tab Recovery

**Issue:** When a tab stops responding to CDP calls (Runtime.evaluate timeout after 50s), the only recovery path is full disconnect/reconnect cycle. No lightweight way to force-reattach or kill-and-recreate a single tab without tearing down session.

**Proposed Implementation:** Add `browser_tabs action='force_reattach'` (attempts to reattach debugger to current tab) or `action='force_recreate'` (close and open new tab, reattach). This avoids session-level reconnect.

**Impact/Effort:** Low effort (tab manipulation, already exposed via `browser_tabs`), medium impact (reduces session recovery time in hung-tab scenarios)

---

## Not-a-Bugs

### 1. Experimental Toggle Collision (`secure_eval` ↔ `mouse_humanization`)

**Status:** Needs empirical reverification by the reporting agent.

**Finding:** handlers.ts lines 354-410 iterate per-feature and toggle each individually (line 380: `await experimentRegistry.toggle(key, value)` per key). The handler does not bulk-replace the experiments object, and there is no shared boolean backing multiple features. The special handling for `mouse_humanization` (lines 381-393) is independent session initialization logic, not a shared state toggle.

**Hypothesis:** The agent may have queried the handler after a separate prior toggle, observing both disabled, or may have sent a partial payload that was processed correctly but the response indicated both were off due to prior state.

**Recommendation:** Empirically reverify by calling `experimental_features` to read current state, then toggle one feature with `experimental_features {secure_eval: false}`, re-read, and confirm only `secure_eval` changed.

---

### 2. `secure_eval` Scoping onto Internal Tool Code

**Status:** Confirmed NOT a bug.

**Finding:** The scoping is correct. Internal tools (`fill_form`, `select_custom`, `file_upload`) call `ctx.eval()` (tools.ts:102-118) which routes directly to CDP's `Runtime.evaluate` and **bypasses the secure_eval validator entirely**. Only user-facing `browser_evaluate` (misc.ts:53-66) applies the static analysis.

**Initial Misunderstanding:** Earlier diagnosis suggested `fill_form` was being blocked by `secure_eval`, but the architecture shows internal tool code is not gated by the validator. This needs clarification on the actual root cause of `fill_form` silent failure on React controlled inputs (see **Open Questions** below).

---

## Open Questions / Unresolved

### 1. Why `browser_fill_form` Fails to Trigger React State Despite Internal Use of Descriptor Method

**Status:** Mid-investigation, explicit handoff to primary maintainer.

**Context:** 
- `fill_form` internally uses `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(...)` at forms.ts:67
- `secure_eval` does NOT gate internal tool code (confirmed, see Not-a-Bugs #2)
- Yet agent reports `fill_form` fails to trigger React synthetic onChange on controlled inputs
- Agent's manual workaround (disabling `secure_eval` + calling the same pattern via `browser_evaluate`) works

**Hypothesis to Investigate:**
- Is there an extension-side Layer 2 membrane (experimental/secure-eval/membrane.ts) that ALSO blocks descriptor methods, beyond server-side `secure_eval`?
- Is forms.ts:67 actually being called, or is there a code path bypassing it?
- Is the issue actually that the descriptor-based setter works, but React's event system doesn't recognize the manual setter call as a user input (vs. synthetic dispatch)?

**Recommendation:** Primary maintainer should trace a real `fill_form` call on a React controlled input with extension debugger to confirm the code path and whether the state mutation actually occurs. This will clarify whether the fix is in the form tool itself, the extension's event dispatch, or React integration.

---

## Priority Summary

**Immediate (P1 fixes, unblocks agent):**
1. Fix `browser_evaluate` function form return serialization (P1 bug)
2. Whitelist React state-setter patterns in `secure_eval` blocklist OR document disabling it for ATS tasks (P1 bug, gates primary workflow)
3. Clarify root cause of `fill_form` React state mutation failure and provide fix or workaround guidance

**Next iteration (P2 + high-impact features):**
4. Add post-action validation to `fill_form` / `select_custom` (P2 bug)
5. Implement `select_custom` fiber walk fallback (P2 bug + feature, high-impact)
6. Implement InlineTextBox coalescing + selector scoping for `browser_snapshot` (features, low effort, high impact)

**Lower priority (medium-effort features):**
7. Frame targeting for `file_upload` (medium effort, moderate impact)
8. Lightweight tab recovery (low effort, moderate impact)

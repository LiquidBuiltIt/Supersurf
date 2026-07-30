"use strict";
/**
 * Managed-profile registration page HTML (served at /register/:name).
 *
 * @module profiles/registration-page
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.registrationHtml = registrationHtml;
/** Escape text for safe interpolation into HTML text / attributes. */
function escapeHtml(value) {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
/**
 * Build the registration page. Posts `register-profile` to the extension,
 * then reveals a success state. The tab is left open for the user/agent.
 */
function registrationHtml(profileName) {
    const safe = escapeHtml(profileName);
    const safeJs = profileName.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Profile ready — ${safe}</title>
  <style>
    :root {
      --ink: #15202b;
      --muted: #5a6a78;
      --surface: #eef3f6;
      --panel: #f7fafb;
      --line: #c5d0d8;
      --accent: #0b6e63;
      --accent-soft: #d5efe9;
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      min-height: 100%;
      background:
        radial-gradient(1200px 600px at 10% -10%, #d9e8e4 0%, transparent 55%),
        radial-gradient(900px 500px at 100% 0%, #dce6f0 0%, transparent 50%),
        var(--surface);
      color: var(--ink);
      font-family: "Avenir Next", "Segoe UI", system-ui, sans-serif;
    }
    body {
      display: grid;
      place-items: center;
      padding: 2.5rem 1.25rem;
    }
    .shell {
      width: min(28rem, 100%);
      padding: 2rem 1.75rem 1.75rem;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 2px;
      box-shadow: 0 18px 40px rgba(21, 32, 43, 0.06);
    }
    .mark {
      width: 2.75rem;
      height: 2.75rem;
      border-radius: 999px;
      display: grid;
      place-items: center;
      margin-bottom: 1.25rem;
      background: var(--accent-soft);
      color: var(--accent);
    }
    .mark svg { width: 1.35rem; height: 1.35rem; }
    h1 {
      margin: 0 0 0.4rem;
      font-size: 1.55rem;
      font-weight: 650;
      letter-spacing: -0.02em;
      line-height: 1.2;
    }
    .profile {
      margin: 0 0 1rem;
      font-size: 0.95rem;
      color: var(--muted);
    }
    .profile strong {
      color: var(--ink);
      font-weight: 650;
      font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
      font-size: 0.9rem;
    }
    p {
      margin: 0;
      color: var(--muted);
      font-size: 0.95rem;
      line-height: 1.55;
    }
    .pending h1 { color: var(--muted); font-size: 1.2rem; font-weight: 550; }
    .pending .mark {
      background: transparent;
      border: 1px solid var(--line);
      color: var(--muted);
      animation: pulse 1.1s ease-in-out infinite;
    }
    .ready { display: none; }
    .ready .mark {
      animation: pop 280ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
    }
    body.is-ready .pending { display: none; }
    body.is-ready .ready { display: block; }
    @keyframes pulse {
      0%, 100% { opacity: 0.55; }
      50% { opacity: 1; }
    }
    @keyframes pop {
      from { transform: scale(0.86); opacity: 0; }
      to { transform: scale(1); opacity: 1; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <section class="pending" aria-live="polite">
      <div class="mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="8" />
        </svg>
      </div>
      <h1>Registering profile…</h1>
      <p class="profile">Binding <strong>${safe}</strong> to this browser.</p>
    </section>
    <section class="ready" aria-live="polite">
      <div class="mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
          <path d="M6.5 12.5 10.2 16.2 17.5 8.5" />
        </svg>
      </div>
      <h1>Profile ready</h1>
      <p class="profile">Registered as <strong>${safe}</strong>.</p>
      <p>You can keep this tab open or close it manually. SuperSurf will stay connected either way.</p>
    </section>
  </main>
  <script>
    window.postMessage({ __supersurf: true, action: 'register-profile', profile: '${safeJs}' }, '*');
    document.body.classList.add('is-ready');
    document.title = 'Profile ready — ${safeJs}';
  </script>
</body>
</html>`;
}
//# sourceMappingURL=registration-page.js.map
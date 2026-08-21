/**
 * Last-resort HTML shown when the server itself fails before React can render
 * (module-init crash, h3-swallowed 500). Must stay dependency-free — inline
 * styles only, no app imports — so it can never fail for the same reason the
 * app just did. Branded to match the label so a visitor sees a styled page,
 * not a raw "Internal Server Error".
 */
export function renderErrorPage(reference?: string): string {
  const safeReference = (reference ?? "").replace(/[^A-Z0-9-]/gi, "").slice(0, 64);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Hybrid AI Records — we'll be right back</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <style>
      :root { color-scheme: light; }
      * { box-sizing: border-box; }
      body {
        margin: 0; min-height: 100vh; min-height: 100dvh; padding: 1.5rem;
        display: grid; place-items: center;
        font: 15px/1.6 "Inter", system-ui, -apple-system, sans-serif;
        color: #0f172a;
        background-color: #f8fafc;
        background-image:
          radial-gradient(ellipse 78% 58% at 10% 6%, rgba(225, 29, 72, 0.12), transparent 58%),
          radial-gradient(ellipse 72% 56% at 90% 94%, rgba(37, 99, 235, 0.12), transparent 56%),
          radial-gradient(ellipse 58% 48% at 50% 42%, rgba(255, 255, 255, 0.9), transparent 68%),
          linear-gradient(180deg, #f8fafc 0%, #f1f5f9 52%, #f8fafc 100%);
      }
      .card {
        max-width: 34rem; width: 100%; text-align: center;
        padding: 2.5rem 2rem;
        border: 1px solid rgba(255, 255, 255, 0.6);
        border-left: 3px solid #e11d48;
        border-radius: 1rem;
        background: rgba(255, 255, 255, 0.85);
        backdrop-filter: blur(16px);
        box-shadow: 0 18px 40px -24px rgb(15 23 42 / 0.14);
      }
      .eyebrow {
        font-size: 0.7rem; letter-spacing: 0.22em; text-transform: uppercase;
        color: #e11d48; margin: 0 0 0.75rem; font-weight: 600;
      }
      h1 { font-size: 1.5rem; line-height: 1.25; margin: 0 0 0.75rem; letter-spacing: -0.01em; }
      p { color: #64748b; margin: 0 auto 1.75rem; max-width: 30rem; }
      .actions { display: flex; gap: 0.6rem; justify-content: center; flex-wrap: wrap; }
      a, button {
        padding: 0.65rem 1.25rem; border-radius: 0.5rem; font: inherit; font-weight: 600;
        cursor: pointer; text-decoration: none; border: 1px solid transparent;
      }
      .primary { background: #e11d48; color: #fff; }
      .primary:hover { background: #be123c; }
      .secondary { background: transparent; color: #0f172a; border-color: rgb(226 232 240); }
      .secondary:hover { border-color: #2563eb; }
      .foot { margin: 1.75rem 0 0; font-size: 0.78rem; color: #64748b; }
      .foot a { padding: 0; border: 0; color: #2563eb; text-decoration: underline; font-weight: 500; }
    </style>
  </head>
  <body>
    <main class="card" role="alert">
      <p class="eyebrow">Hybrid AI Records</p>
      <h1>We hit a snag loading this page</h1>
      <p>The studio's still running — this one request just didn't make it through. Try again, or head back to the front page.</p>
      <div class="actions">
        <button class="primary" onclick="location.reload()">Try again</button>
        <a class="secondary" href="/">Go home</a>
      </div>
      <p class="foot">Error reference <strong id="ref" style="font-family:ui-monospace,monospace;color:#0f172a">${safeReference || "&mdash;"}</strong><br />Still stuck? Email <a id="support" href="mailto:info@hybrid-ai-records.com">info@hybrid-ai-records.com</a></p>
    </main>
    <script>
      (function () {
        var ref = ${JSON.stringify(safeReference)};
        if (!ref) {
          var p = location.pathname, h = 0;
          for (var i = 0; i < p.length; i++) h = (h * 31 + p.charCodeAt(i)) >>> 0;
          ref = (Date.now().toString(36) + "-" + h.toString(36)).toUpperCase();
          document.getElementById("ref").textContent = ref;
        }
        document.getElementById("support").href =

          "mailto:info@hybrid-ai-records.com?subject=" +
          encodeURIComponent("Site error " + ref) +
          "&body=" +
          encodeURIComponent("Reference: " + ref + "\\nURL: " + location.href + "\\n\\nWhat I was doing:\\n");
      })();
    </script>

  </body>
</html>`;
}

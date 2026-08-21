# Pre-Flight Production Audit — Hybrid AI Records

Audit only: code, database, and logs were inspected; nothing was changed. Below is what passed, what needs fixing, and the proposed fix order.

## What already passes

- **Responsiveness**: Automated pass across `/`, `/portal`, `/engine`, `/artists`, `/tokens`, `/start`, `/privacy`, `/licensing` at 390x844 (phone) and 1366x768 (Chromebook). No horizontal overflow on any page — page width matched viewport width everywhere. The only elements extending past the edge are decorative background/light layers that are clipped intentionally. Wide admin tables all sit inside horizontal scroll wrappers.
- **Console**: Zero console errors captured on either viewport across all eight pages.
- **Crash safety baseline**: The router has a global error fallback plus root-level error and not-found components, so a render crash shows a branded recovery screen, not a blank page.
- **Backend security scan**: Clean — no exposed data or missing-policy findings.
- **Engine input validation (server)**: Track generation is auth-gated and Zod-validated (prompt 3–6000 chars, title ≤120, style/lyrics ≤6000, enum-locked model and audio format).
- **Crawler hygiene**: `robots.txt` blocks `/admin/`, `/dev/`, `/api/`, `/auth`, receipts, order status, and checkout return.

## Findings to fix before publishing

### Critical

1. **`/dev/*` pages are publicly reachable in production.** `dev.translations`, `dev.background-report`, `dev.sync-badge`, `dev.sync-badge-lab`, and `dev.sync-history` have no auth gate and no dev-only guard. `robots.txt` only discourages crawlers — anyone with the URL can open them, and the translations page calls backend functions. Fix: gate these routes behind the authenticated admin layout, or make them return not-found when not running in development.

2. **No timeout on outbound engine/API calls.** No server-side file uses `AbortSignal.timeout` or an abort controller. If the music engine or an external provider hangs, the server function hangs with it until the platform kills it, and the studio UI stays in "rendering" with no error. Fix: add an explicit timeout (e.g. 30–60s) plus a typed timeout error to every outbound `fetch` in the server modules.

### Warning

3. **Advanced generation controls are only range-checked in the browser.** BPM, audio influence, weirdness, and style influence are clamped client-side, then folded into the prompt text that is sent to the server. A crafted request can inject arbitrary directive text through those values. Fix: pass the control values as discrete numeric fields, validate them server-side with the same min/max bounds, and build the directive string on the server.

4. **Lyrics/style fields lack a matching frontend limit.** The server caps lyrics and style at 6000 characters, but the UI does not enforce or display that ceiling, so long pastes fail late with a raw validation error. Fix: enforce the same limit in the editor with a visible character counter.

5. **Route-level error boundaries are missing on the highest-traffic pages.** `engine`, `artists`, `tokens`, `account`, `account.ledger`, `account.downloads`, `checkout.return`, `order-status`, `start.*`, and all admin pages rely on the global fallback. A failure on one of these drops the user out of page context instead of showing an in-page retry. Fix: add a shared error component to these routes so failures render a scoped retry panel.

6. **Silent catch blocks on data loads.** Several loaders (`ArtistTokenStore`, `account.ledger`, `account.downloads`, artist popularity counts) swallow errors with an empty `catch`. A backend outage shows an empty list that looks like "you own nothing" rather than "we could not load this". Fix: track an error state and render a retry message.

7. **Three server functions have no input validator**: `fx-rates.functions.ts`, `pricing-access-check.functions.ts`, `pricing-access-monitor.functions.ts`. Fix: add explicit Zod validators, even where the input is currently empty.

### Info

8. **Database linter**: one table has row-level security on with no policies (`pricing_settings` — deliberate, service-role only; harmless but worth confirming) and one extension is installed in the `public` schema. Neither blocks launch.

9. **Leftover console logging** in `apiframe.server.ts`, `engine-log.server.ts`, and `StudioEngineTest.tsx`. Low risk, but review the engine ones so request payloads are not logged in production.

10. **Full-height layouts use `min-h-screen`** in ~20 route files. On mobile browsers with dynamic toolbars this can leave a gap or add a hidden scroll. Switching to `min-h-dvh` is a one-line-per-file polish item.

## Suggested fix order

1. Gate `/dev/*` routes (critical, minutes).
2. Add outbound API timeouts and surface a clear "engine timed out" error (critical).
3. Move engine control validation server-side (warning, security-relevant).
4. Add route error boundaries and replace silent catches with retry states.
5. Add the three missing input validators and the lyrics character counter.
6. Cleanup pass: console logs, `min-h-dvh`.

Approve this and I will work through the list in that order.

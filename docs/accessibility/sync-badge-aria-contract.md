# SyncBadge accessibility contract

Normative ARIA contract for `src/components/radio/SyncBadge.tsx` (the sync status
chip, its Retry button, and its tooltip).

**Status: binding.** Every MUST below is enforced by an automated test. If you
change the component so a MUST no longer holds, the build fails — that is the
point. Do not "fix" a failure by loosening the assertion; either keep the
behaviour or change this document first, in the same pull request, with a
rationale.

Terminology follows RFC 2119 (MUST / MUST NOT / SHOULD).

---

## 1. Phases

The badge renders one of five phases. Everything else in this document is keyed
to them.

| Phase | Condition | Visible chip text |
| --- | --- | --- |
| `idle` | no `resolveState`, `syncState !== "loading"`, no conflict | `Synced` |
| `loading` | `syncState === "loading"` | `Syncing…` |
| `resolving` | `resolveState.phase === "resolving"` | `Resolving…` |
| `resolved` | `resolveState.phase === "resolved"` | `Resolved` / `Resolved {n}` |
| `error` | `resolveState.phase === "error"` | `Sync Failed` + Retry |

`conflictNotice` is a variant of `idle` (`Newer Mix Restored`), not a sixth phase.

---

## 2. The status chip

### 2.1 Role and live region

- The chip MUST expose `role="status"` in every non-error phase, and
  `role="alert"` in the `error` phase.
- `aria-live` MUST be `polite` for `role="status"` and `assertive` for
  `role="alert"`. The pairing is redundant with the implicit role semantics on
  purpose: some AT/browser combinations do not derive the implicit live setting
  when the node is already in the DOM and only its text changes.
- `aria-atomic="true"` MUST be set. Phase copy is a whole sentence; without it
  AT reads only the changed text node and the announcement loses its subject.
- The chip element MUST persist across phase changes. Unmounting and remounting
  a live region suppresses the announcement in several screen readers, and it
  drops keyboard focus.

### 2.2 Accessible name

- The chip MUST have a non-empty accessible name supplied by `aria-label`. In
  the non-error phases its value is exactly `syncAnnouncement(...)`. In the
  `error` phase it is `Sync failed. {reason}`, so the reason is spoken with the
  alert rather than requiring the user to hunt for it.
- The visible chip text (`Synced`, `Resolving…`, the relative "4m ago" stamp) is
  shorthand and MUST be `aria-hidden="true"`. It is not a usable announcement on
  its own.
- `syncAnnouncement` MUST remain a pure exported function so it can be asserted
  without rendering.

### 2.3 Busy state

- `aria-busy="true"` MUST be present while, and only while, the badge is
  in-flight (`loading` or `resolving`).
- `aria-busy` MUST be absent — not `"false"` — otherwise. An explicit `false`
  is legal ARIA but the tests assert absence so that a stale attribute cannot
  linger unnoticed after a phase transition.
- The spinner MUST be `aria-hidden="true"`; `aria-busy` is the machine-readable
  signal. Under `prefers-reduced-motion` the spinner is swapped for a static
  `In Progress` marker, which MUST also be `aria-hidden="true"` — the reduced
  motion path MUST NOT change any announced text.

### 2.4 Focus

- The chip MUST be keyboard focusable (`tabindex="0"`). It is the tooltip
  trigger; a mouse-only tooltip is not acceptable.
- The chip MUST show a visible focus indicator via `focus-visible:ring-2` with a
  ring offset against the surface. Removing the ring, or replacing it with an
  outline that fails contrast against the badge background, is a regression.

---

## 3. The tooltip

### 3.1 No `aria-expanded`

- The chip MUST NOT carry `aria-expanded`, in any phase, open or closed.

A tooltip is neither a disclosure nor a popup widget. Per the ARIA APG the
trigger is *described by* the tooltip, not *expanded by* it, so `aria-expanded`
on the trigger is incorrect and misreports the widget type. The open/closed
signal for tests is Radix's `data-state` attribute, not ARIA.

### 3.2 Single announced source

- The chip MUST reference a stable description node via `aria-describedby`, and
  the referenced `id` MUST resolve to exactly one element that is present in the
  DOM in every phase, whether the tooltip is open or closed.

  The tooltip content only exists while open. Pointing `aria-describedby` at the
  popper produces a dangling reference — and therefore no description at all —
  whenever the tooltip is closed, which is most of the time.

- The painted tooltip content MUST be `aria-hidden="true"`. The chip already
  carries the same sentence through `aria-describedby`; leaving the popper in
  the a11y tree makes the description announce twice.
- Exactly one node with `role="tooltip"` MUST exist while the tooltip is open
  (Radix's visually-hidden copy). Two is a duplicate-announcement bug.
- Description copy MUST come from the exported pure function `syncTooltipText`.

### 3.3 Triggers and dismissal

- The tooltip MUST open on both pointer hover and keyboard focus of the chip.
- <kbd>Escape</kbd> MUST dismiss the tooltip, and focus MUST remain on the
  element that had it. Escape dismisses the tooltip only; it MUST NOT return
  focus to `<body>`.
- Opening the tooltip MUST NOT shift layout: zero CLS, and no movement of
  sibling bounding boxes. The tooltip is portalled and positioned, never
  inserted into flow.

---

## 4. The Retry button (error phase only)

- Retry MUST be a real `<button type="button">`. It MUST NOT be a `div`, `span`
  or link with a click handler.
- Retry MUST be a sibling of the focusable chip, never a descendant. Nesting a
  button inside `role="alert"` with `tabindex="0"` is a `nested-interactive`
  failure. The two sit in a presentational cluster (`role="group"`,
  `tabindex="-1"`) so the pill still looks like one control.
- Its accessible name MUST be exactly `Retry timestamp sync` when idle and
  `Retrying timestamp sync` while in flight. The name MUST change with state —
  a static name leaves a screen-reader user unable to tell the retry started.
- The icon MUST be `aria-hidden="true"`; the name comes from `aria-label`.
- Retry MUST be reachable by <kbd>Tab</kbd> from the chip, and
  <kbd>Shift</kbd>+<kbd>Tab</kbd> MUST return to that same badge's chip.
- Both <kbd>Enter</kbd> and <kbd>Space</kbd> MUST activate it (free with a real
  `<button>`; this is why the element type is normative).
- Retry MUST carry `aria-describedby` pointing at the failure-reason node, so
  focusing the action reads *why* it is being offered.
- While retrying, Retry MUST also be an assertive live region (`aria-live="assertive"`,
  `aria-atomic="true"`). The name change is how AT learns the retry started; because
  Retry is a sibling of the alert (not nested in it), that name change would otherwise
  never be spoken. Idle Retry MUST NOT be a live region.

### 4.1 Busy state MUST use `aria-disabled`, never `disabled`

While retrying, the button MUST set `aria-disabled="true"` and `aria-busy="true"`,
and MUST NOT set the native `disabled` attribute.

A native `disabled` makes the browser blur the button the instant a retry
starts, dumping keyboard focus on `<body>` mid-interaction — which is exactly
when a keyboard user is most likely to be pressing it repeatedly. `aria-disabled`
keeps the element focusable; the click handler early-returns instead. This is a
deliberate deviation from the usual "prefer native disabled" advice and MUST NOT
be reverted for consistency.

### 4.2 Busy styling MUST NOT rely on reduced opacity

The retrying state is indicated with a dashed border, not dimmed text. Reducing
opacity on the label drops it below the WCAG AA 4.5:1 threshold against the
badge background. Any future busy styling MUST keep the label at full opacity.

---

## 5. Colour and contrast

- All badge colours MUST come from the semantic `--status-*` tokens in
  `src/styles.css`. Raw crimson brand values fail AA on these surfaces.
- Chip label, Retry label and the focus ring MUST each meet WCAG AA (4.5:1 for
  text, 3:1 for the focus indicator) in **both** light and dark themes, in every
  phase, including the retrying state.
- State MUST NOT be conveyed by colour alone. Every phase pairs its colour with
  a distinct icon and distinct text.

---

## 6. What enforces this

| Area | Enforced by |
| --- | --- |
| Shared attribute assertions | `e2e/helpers/sync-badge-aria.ts` |
| Roles, names, live regions | `src/test/radio-sync-badge-at.test.tsx`, `e2e/sync-badge-sr.spec.ts` |
| Retry semantics and focus | `src/test/radio-sync-badge-retry.test.tsx`, `e2e/sync-badge-rapid.spec.ts` |
| Tooltip semantics and dismissal | `src/test/sync-badge-tooltip.test.tsx`, `e2e/sync-badge-pointer.spec.ts`, `e2e/sync-badge-touch.mobile.spec.ts` |
| Keyboard journeys | `e2e/sync-badge-keyboard.spec.ts`, `e2e/sync-badge-keyboard.mobile.spec.ts` |
| axe, per phase and per transition | `src/test/sync-badge-axe.test.tsx`, `e2e/sync-badge-axe.spec.ts`, `e2e/sync-badge-axe-transitions.spec.ts`, `e2e/sync-badge-axe.mobile.spec.ts` |
| Contrast and focus rings | `e2e/sync-badge-contrast.spec.ts` |
| Layout stability | `e2e/sync-badge-layout-shift.spec.ts` |
| Tooltip anchoring / no obscured controls | `e2e/sync-badge-tooltip-anchor.mobile.spec.ts` |
| Reduced-motion tooltip (inert animation, no drift) | `e2e/sync-badge-reduced-motion.spec.ts` |
| Visual baselines (incl. iOS Safari) | `e2e/sync-badge-visual.spec.ts`, `e2e/sync-badge-visual.mobile.spec.ts`, `e2e/sync-badge-lab.spec.ts` |

Interactive harnesses: `/dev/sync-badge` (phases, live retry churn) and
`/dev/sync-badge-lab` (theme x reduced-motion x tooltip matrix). Both gate on
`data-hydrated="true"` — tooltips do not respond to input before React attaches
its listeners, and a pre-hydration event is swallowed with no follow-up to
recover from.

---

## 7. Changing this contract

1. Change the document and the component in the same pull request.
2. State which MUST is being relaxed and why the affected users are not harmed.
3. Update the enforcing test to assert the new behaviour — do not delete it, and
   do not widen a matcher until it stops failing.
4. Re-run `npm run test:e2e:a11y` and the unit a11y tests.

Deleting or skipping an assertion is not a resolution.

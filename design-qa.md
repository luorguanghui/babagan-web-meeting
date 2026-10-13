# Babagan frontend verification

## Result

final result: passed

No actionable P0/P1/P2 findings remain in the scoped frontend review. This is an implementation of the approved visual direction and subsequent user edits, not a pixel-identical copy of the generated concepts. Live media acceptance is deliberately outside this verification.

## Visual truth and evidence

- Source: `../babagan_concepts/Babagan-revised-receiver.png`, `Babagan-revised-settings.png`, `Babagan-revised-host.png` (each 1487×1058 pixels).
- Branding: `../babagan_concepts/Babagan-logo-01.png` icon only; `Babagan-logo-03.png` wordmark only. The people pictogram is not used.
- Actual cloud Chromium screenshots: `../babagan-qa/receiver-desktop-zh.png`, `settings-desktop-zh.png`, `host-desktop-zh.png`, `create-desktop-zh.png` at 1488×1056 CSS/pixels, 1× density.
- Mobile evidence: `receiver-mobile-zh.png`, `volumes-mobile-zh.png`, `settings-mobile-zh.png`, `lobby-mobile-zh.png` at 390×844; `idle-mobile-320-zh.png` at 320×640. Screenshots contain the app viewport, not device chrome.
- Full-view combined comparison: `../babagan-qa/design-comparison-final.png`. Reference and implementation were rendered together at 744×528 per panel; the sub-0.2% source-size normalization is immaterial to these findings.
- Focused settings typography/control and logo comparison: `../babagan-qa/design-comparison-details-final.png`. The small rendered icon is enlarged for silhouette inspection, not judged for enlarged screenshot sharpness.
- Earlier comparison evidence: `design-comparison.png` and `design-comparison-details.png`.
- Delivery bundle maps the screenshot filenames above into `screenshots/` and includes source references in `references/`.

The shared-screen image and participant names are fictional QA content. The screen video is a poster-only fixture, so its content/aspect ratio intentionally differs from the illustrative slides in the concepts. Production does not import that poster or the QA entry.

## Required fidelity surfaces

- **Typography:** System sans-serif stack with Chinese fallbacks, dark readable headings, 14px settings fields, compact labels and clear hierarchy. Original descriptive option labels and accessible names remain. Native selects can ellipsize long selected quality labels; the complete option is exposed when opened. The rounded olive wordmark uses the selected artwork, rather than an approximate installed font.
- **Spacing/layout:** Warm-white canvas, 96px desktop rail, generous stage, right settings/participant panels and mobile sheets. Stage remains aspect-ratio-contained instead of cropping real shared content. Desktop panels shrink the workspace on wide screens and overlay it at narrower widths. Mobile controls fit 320px; drawers scroll independently.
- **Colors/tokens:** Canvas `#faf9f6`, text `#202726`, olive accent `#617a50`, subtle `#e3e4de` borders. Muted/disabled/share/error states remain distinguishable. Visible keyboard-focus rings are retained.
- **Assets:** Selected abstract B in icon-only rail; selected rounded olive name in create/lobby header. A low-opacity hole in the first extraction was corrected. Both assets are transparent raster-backed SVGs, not resolution-independent path artwork; normal-size clarity is good. No concept-board raster is rendered as app UI.
- **Copy/content:** Existing English/Chinese messages, real controls, conditions and provider availability remain authoritative. QA locale is Chinese only inside its disposable fixture; production language inference/storage is unchanged. Latest user edits supersede mock content: one bottom-bar Volume entry on every screen size, and one member avatar per management row.

## Comparison history and fixes

1. **P1 no-notice stage geometry:** empty notices could move the size-contained stage to an auto-height grid row. Fixed with explicit workspace grid row 3. Actual no-notice desktop stage measured 549px at 1180×757; final screenshots show full-height stage.
2. **P2 unified roster microphone semantics:** a generic labelled span did not expose its status as a named semantic object. Added `role="img"`; regression failed before and passed after the fix.
3. **P2 settings alignment:** unequal help text stretched neighbouring select rows. Added start alignment; final focused screenshot shows aligned 44px selectors.
4. **P2 redundant volume entries, updated user requirement:** both old mobile buttons opened the same panel. Replaced actual-room entries with one Volume/音量 button at all widths. Independent call/share sliders are inside the panel, with shared volume conditional on receiving a share. Final desktop/mobile screenshots and regression tests cover this.
5. **P2 B-mark opacity defect:** earlier extracted icon had an unwanted low-opacity hole in its lower lobe. Replaced with closer source extraction, verified zero enclosed low-alpha holes at thresholds 64/128/200, and inspected final focused comparison.
6. **Motion enhancement:** restrained entry and interaction motion added and observed in the running browser. A follow-up completed scoped closing transitions using presentation-only presence, without document-level snapshots or media remounts.

## Interaction and accessibility verification

- Desktop and mobile: one closed volume entry; independent keyboard-adjusted call/shared values (95/90) and 100/100 initial values.
- Idle state: only call slider; no false shared slider.
- Settings drawer: background inert/hidden from accessibility tree; Escape restores Settings focus. Mobile More → Audio/devices → Back → Escape restores More focus.
- Host mock API: revoke current share enables eligible rows; grant another member updates the sharing row and disables competing grants. One roster, distinct status/action labels, separate End control.
- Authorization/default/media regression suite also covers host-session guards, manual bitrate protection, muted join, persistence and existing media callbacks.
- Runtime motion: 180ms popover entry/140ms exit, 220ms drawer entry/160ms exit, 180ms menu/backdrop entry; easing `cubic-bezier(.22,1,.36,1)`. Button press feedback is 90ms. `motion-runtime.json` records real transition start/end events for opening and closing; stage attached once and detached zero times across panel cycles.
- Closing immediately disables accessibility/pointer interaction and restores focus/background access. The noninteractive node remains for 180ms (popover) or 200ms (drawer/modal), covering its visual exit plus 40ms paint allowance. Reopening cancels stale cleanup. `prefers-reduced-motion` disables transitions/animations and removes the closing node immediately. Native browser select menus are not custom animated. OS-level reduced-motion emulation was not exercised in this browser.
- Console inspection found cloud browser-extension metadata errors. Hot-module replacement briefly produced duplicate-root warnings in the QA entry; a disposal cleanup and fresh reload resolved that fixture-only warning. The poster-only video has no playable source by design.

## Automated verification

On the final product code and assets:

- `pnpm test`: 64 files, 892 tests passed.
- `pnpm lint`: passed.
- `pnpm typecheck`: passed.
- `pnpm build`: passed; Vite reports the existing large JavaScript chunk warning (about 1.04MB, 290KB gzip).
- `git diff --check`: passed.
- The first earlier root run had one exact-millisecond reconnect test flake (29999 vs 30000); isolated and subsequent full runs passed. No reconnect behavior/test was changed.

## Residual scope and follow-up polish

- No live microphone/camera/screen-capture, real meeting, production provider, deployment or acoustic separation acceptance was run. Separate audio routing is established by source inspection and isolated assertions, not audible testing.
- Branding can later be supplied as original vector paths for smaller payloads. Current assets preserve the chosen appearance but are raster-backed.
- Exit presence tests cover Escape, outside close, rapid replacement/reopen, immediate focus/background unlock, reduced-motion changes and unmount cleanup. The drawer width is retained through exit to avoid a 30rem-to-26rem snap.
- The developer QA fixture is excluded from the ordinary Vite production build. It must remain a development-only entry.

## Implementation checklist

- [x] Warm-white rail/stage/panels, responsive create/lobby.
- [x] Unified member-management rows and separate End action.
- [x] One bottom-bar volume entry with independent conditional sliders.
- [x] Original defaults, stored-setting compatibility and permission guards.
- [x] Selected mark/wordmark, corrected opacity defect.
- [x] Restrained motion and reduced-motion CSS.
- [x] Isolated tests/build, visual comparisons and cloud-browser interaction QA.
- [x] Reviewable patch and source/evidence bundle; feature-branch publication authorized separately, with no merge or deployment.

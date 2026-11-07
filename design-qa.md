# Babagan meeting redesign — Sunny companions

Date: 2026-11-08 (Asia/Hong_Kong)

final result: passed

## Visual target and scope

- Selected visual truth: `docs/acceptance/meeting-sunny-2026-11-08/selected-reference.png`, the third displayed Product Design concept.
- User amendment after seeing the implementation: “移动端这底部排版不合理pc端的也是”. The final footer therefore deliberately replaces the mock's detached circular chevrons: four equal primary actions on phones, compact split controls on desktop, and phone audio/share settings inside the existing More menu.
- Existing application components and real capture/media/permissions remain in use. No prototype replaces the product runtime.
- The generated landscape is only a synthetic QA media source under `apps/web/qa/assets/`. It is never substituted for a user's shared screen and is not an entry in the production build.

## Evidence and normalization

- Final implementation: `http://127.0.0.1:4183/qa/preview.html?scene=receiver&design=sunny`.
- Source dimensions: 1487 × 1058. Final desktop capture: 1487 × 1058 CSS and screenshot pixels, density 1; no resampling, crop or device frame.
- Final full-view comparison: selected reference and `docs/acceptance/meeting-sunny-2026-11-08/desktop.jpg` were opened together in the same comparison input. Earlier 1488 × 1056 captures were used during iteration only; the one/two-pixel difference was not treated as a typography defect.
- Focused review: header identity/metadata, member rows and bottom control groups inspected in the full-resolution paired inputs. Their text and icons are readable at that resolution. Browser geometry additionally checked all primary hit targets and the error-message/tool-row boundary. No post-processed image crop is used as evidence.
- `mobile.jpg`: 390 × 844, Chinese, four-action footer. `mobile-english.jpg`: 320 × 640, English. `mobile-error.jpg`: 320 × 640, denied fullscreen.
- `landscape.jpg`: 844 × 390, four-action footer. `fullscreen.jpg`: 844 × 390, isolated browser-shaped fullscreen state. `idle.jpg`: 1280 × 720 waiting state.
- All captures use the real MeetingRoomPage with mocked network, device and media boundaries. No real meeting or phone was accessed.

## Findings and comparison history

1. **Resolved P2 — desktop type hierarchy too small.** Initial header/participant labels were visually weaker than the selected image. Large desktop now uses a 34px title, 20px metadata/navigation and 21px names. Phone sizes remain compact. Verified in final desktop evidence.
2. **Resolved P2 — footer grouping and alignment.** The user identified detached arrow buttons and uneven spacing on both platforms. The former dock overrides were removed from the theme and replaced with one dedicated dock stylesheet. Phones expose four equal columns; desktop arrows share the microphone/share boundary. Final measured widths: four × 88px at 390px, four × 70.5px at 320px, and four × 125.5px at 844px landscape. Primary hit regions are 66px tall on phones; inline desktop arrows remain at least 44px wide. No horizontal overflow.
3. **Resolved P2 — hidden mobile leave icon / oval icons.** Legacy span rules affected the new wrappers. Specific final dock rules restore icons and labels and fix their dimensions. Verified in final phone captures.
4. **Resolved P2 — visible and accessible navigation labels differed.** Connection info's accessible name now includes the visible label and the existing WebRTC data description, in both languages.
5. **Resolved P2 — display failure message covered viewing controls.** Normal-view errors now occupy a separate flow row below the tools. At 320px, the message starts at the tools' bottom; PiP and fullscreen remain clickable. Fullscreen-only exit remains independently positioned.
6. **Resolved P2 — hidden settings arrows broke keyboard handoff.** On phones More opens the first usable setting, Escape returns to More, and changing volume or receiving a room update does not steal focus. Opening/switching focus is separate from callback/listener refresh. A regression test first reproduced the focus steal and then passed after the fix.
7. **Resolved P2 — short desktop footer and decorations consumed space.** Compact windows use the shorter footer; the nonessential brand note hides at low heights. Empty-stage radius/background now follow the bounded waiting surface. Verified in final idle and landscape captures.
8. **Resolved P2 — fullscreen tools remained visible when the QA fullscreen target moved outside the meeting ancestor.** The component's `[hidden]` rule now owns this invariant. Verified entry, exit and return focus; media remains `object-fit: contain`.

## Required fidelity surfaces

- **Typography:** existing system Chinese/Latin font stack retained, readable weights and hierarchy, no new external font fetch. Large-screen emphasis now matches the selected direction. Compact footer labels fit in Chinese and English.
- **Spacing/layout:** large complete shared frame, right member list and persistent bottom actions remain. Responsive roster scrolling does not hide the footer. The revised footer follows the user's later direction rather than the superseded mock detail.
- **Colors/tokens:** warm white, clear orange, neutral text and semantic red/green. Orange fullscreen uses dark text for legibility instead of the mock's low-contrast white. No gradients, animated decorations or video filters were added.
- **Image quality:** existing Sigrika brand assets retained, with a restrained desktop-only note. The QA slide is a real generated raster. The rounded media frame has an inset so source corners are not clipped; fullscreen remains unpadded. No decorative artwork is recreated with CSS/SVG approximations.
- **Copy/content:** real source dimensions are shown instead of hardcoded “60 FPS”. The host marker is shown only for a confirmed local host. Microphone enabled state is not misrepresented as active speaking. Existing host permission/takeover behavior is preserved, so the QA host's share control may be available where the concept was disabled. Elapsed time is live.

## Interaction and regression verification

- Browser: microphone toggle and participant-state update; audio output selection; separate call/shared volume; 1080p60 selection; advanced codec/transport/10 Mbps settings; More-to-audio settings; keyboard Escape/focus return; volume updates without focus theft; fullscreen entry/exit; denied fullscreen; desktop/portrait/landscape layouts; English narrow labels; waiting state.
- Primary browser viewport checks: 1487×1058, 1280×720, 390×844, 320×640, 844×390. No horizontal overflow in checked states; every final phone primary control is wider than 44px.
- Browser console: no errors/warnings in the final normal preview.
- Full Web suite before final footer refinement: 78 files / 903 tests passed. Final footer/focus change: complete controls + room suites, 80 tests passed, including new mobile/reduced-motion/focus-update cases. Final translated labels also passed 61 focused tests. Typecheck, changed-source lint and production build passed.
- Physical Android system PiP/fullscreen and real multi-party media load were not re-run for this presentation change. No native capture, codec, rate-control, API or SFU logic was changed.

## Implementation checklist

- [x] Preserve actual product behavior and media nodes.
- [x] Match selected visual system with the user's amended footer layout.
- [x] Verify desktop, phone, short-screen and failure states.
- [x] Complete keyboard/focus and regression checks.
- [x] Retain a local isolated preview and saved evidence.

## Follow-up polish

No remaining P0/P1/P2. Platform font rasterization and varying participant-name lengths can differ from the generated mock; these are expected product conditions, not placeholder content.

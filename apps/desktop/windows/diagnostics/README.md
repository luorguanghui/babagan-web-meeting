# Real Windows update acceptance

This separate diagnostic compiles the production `ClientUpdater`, `ReleaseVerifier`, download code and version store, with only a copied `Package.Version` fixed to the baseline version. Production source is not modified. It uses the real pinned `https://meet.babagan.cloud/downloads/clients/windows/stable.json` feed and unchanged artifact allowlist. No local feed override or diagnostic API is added to the application.

Prepare the diagnostic without making network requests or installing anything:

```powershell
./apps/desktop/windows/diagnostics/build-update-integration.ps1
```

Prepare an actual baseline installer while source version is `0.1.0`, using `-Sequence 1`. Run that installer with `--verify-package` into a fresh directory under this repository's `output`, with a separate cache. This creates an isolated installed version containing `runtime.json`; a raw build payload without runtime configuration is insufficient. Keep this baseline directory when building the later `0.1.1` / sequence `2` release.

Only after the parent has published and verified the real signed `0.1.1` / sequence `2` feed and immutable `client.zip`, run:

```powershell
./apps/desktop/windows/diagnostics/build-update-integration.ps1 `
  -Run `
  -BaselinePayload '<absolute output baseline-install/versions/0.1.0-xxxxxxxx>' `
  -TestRoot '<absolute output/fresh-update-acceptance-root>' `
  -TargetVersion '0.1.1' -TargetSequence 2
```

The diagnostic refuses an existing test root, paths outside this workspace's `output`, and a baseline with the wrong receipt. It clones the baseline into its own version directory and never modifies the ordinary user installation, registry, shortcuts or browser profile.

Assertions use the actual production updater:

1. Fetch and verify the public RSA-signed feed; require the exact expected newer release.
2. With host activity busy, `Check` returns `available`, never enters `downloading`, creates no artifact/stage, and leaves the baseline pointer unchanged.
3. With activity idle, `Check` downloads the real server artifact, verifies SHA-256/size, checks its embedded version and sequence, runs the real candidate helper smoke test, verifies its reported executable version, and activates the new current pointer while retaining the preceding directory.
4. Record the downloaded artifact hash and both phases in `<test-root>/result.json`.

The candidate smoke starts and stops only the native helper; it does not request any screen frames or open the meeting window. Full GUI startup health remains explicitly pending for the normal bootstrap on its next launch. This test proves automatic download and version activation, not an uninterrupted running-process hot swap.

The production version consistency regression tests reject mismatched ZIP receipt versions/sequences, a mismatched or absent executable version, a nested `ready:true` marker hiding failure, and a smoke report claiming capture started. Feed and artifact tampering remain covered by the existing signature/hash tests.

# Babagan Windows desktop client

The client uses a native WinForms window with Microsoft WebView2. The meeting UI loads from `https://meet.babagan.cloud`, while the existing authenticated loopback HTTP capture transport continues to use Node.js and FFmpeg DXGI. The ordinary website and the separate Edge dependency installer remain available.

Build from the repository root with PowerShell 7:

```powershell
./scripts/build-desktop-client.ps1 -Sequence 1
```

The build pins and verifies the WebView2 SDK NuGet archive and embeds the repository's **public** update key. It requires the existing workspace Node dependencies and the Windows .NET Framework compiler; it does not require a .NET SDK or install a global runtime. The private release key is never packaged.

Outputs under `output/desktop-client/`:

- `BabaganClientSetup-0.1.0.exe`: current-user installer, with the client payload embedded.
- `client.zip`: immutable update payload, without Node/FFmpeg or mutable WebView profile data.
- `release.json`: artifact hashes, sizes, source commit, dirty flag, and release sequence.

The installer reuses compatible Node 24, FFmpeg with `ddagrab dup_frames`, and an existing Evergreen WebView2 Runtime. It also searches the previous Edge helper installation for reusable dependencies. Missing dependencies are downloaded only from pinned Babagan HTTPS URLs. `runtime-artifacts.json` identifies the unchanged, Microsoft-signed WebView2 installer that the server must mirror.

Installation uses `%LOCALAPPDATA%/Babagan/DesktopClient`. The root `Babagan.exe` is a stable bootstrap; versioned application files live beneath `versions/`, and `current.json` is replaced atomically. The profile and runtime files live outside version directories. The preceding version is retained. An owned child must initialize WebView2 and the helper within 35 seconds before the bootstrap accepts a pending version; otherwise it restores the preceding version while retaining the highest sequence, preventing retries of the failed release.

The signed feed is `/downloads/clients/windows/stable.json`. The verifier checks RSASSA-PKCS1-v1_5/SHA-256 over exact decoded payload bytes, the pinned key ID, product/platform/channel/protocol, strictly versioned artifact URL, size, and SHA-256. It rejects lower/repeated sequences. A signature or network error leaves the installed application usable. Windows Authenticode signing is independent of this release signature; these builds are not automatically OS-trusted.

Only a small manifest check is allowed during a meeting. Large downloads and version activation wait until both `meeting.state.joined` and the helper's authoritative `captureActive` are false. Entering a meeting cancels an in-progress payload download. Activation takes effect at next launch, without a forced restart or webpage reload.

`DesktopHelper` reads capability-bearing JSONL stdout privately and never persists it. Only `client.info`, `meeting.state`, and `update.check` are exposed to the trusted top-level meeting origin. External HTTPS navigation is opened in the system browser. Camera and microphone requests use an explicit native permission prompt.

Version 0.1.2 opens the dedicated `/client` meeting workspace, with the app version in the document URL to avoid reusing an old marketing-page cache entry. The private native capture fragment is preserved for the existing connection initialization and is never written to a diagnostic log. Ordinary browser visitors still see the public homepage; native navigation does not show installer promotions.

Build runs 37 signature, origin, traversal, activity, sequence, executable-version, startup URL, and rollback assertions. For an installation smoke test without shortcuts, browser UI, or desktop capture:

```powershell
./output/desktop-client/BabaganClientSetup-0.1.2.exe --verify-package <isolated-test-root> <download-cache>
```

This checks dependency reuse and starts/stops the actual helper without requesting frames. Performance acceptance must additionally run the existing synthetic 1080p60 pipeline in WebView2, including background/minimized windows and DXGI recovery; a successful build or smoke test does not establish a framerate claim.

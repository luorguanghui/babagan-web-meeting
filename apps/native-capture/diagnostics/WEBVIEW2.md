# WebView2 synthetic media diagnostics

This harness is a separate local test executable. It never changes the production client's origin allowlist and cannot navigate outside the single fixture at `http://127.0.0.1:5188/apps/native-capture/diagnostics/browser-pipeline.html`. The helper capability is passed over an owned stdin/IPC pipe, not a command-line argument or log. Each run creates its own WebView2 profile beneath `output/webview2-validation/`.

Run from the repository root after building `@meeting/native-capture` and the Windows client (the latter prepares the pinned WebView2 SDK):

```powershell
$env:BABAGAN_TEST_FFMPEG = '<trusted FFmpeg executable with ddagrab support>'
python apps/native-capture/diagnostics/make-pan-source.py
node apps/native-capture/diagnostics/pan-source-baseline.mjs output/native-pan-source/pan-source.png
node apps/native-capture/diagnostics/webview-pipeline.mjs --pan-source=output/native-pan-source/pan-source.png --seconds=90 --bitrate=10000000
node apps/native-capture/diagnostics/webview-pipeline.mjs --pan-source=output/native-pan-source/pan-source.png --seconds=90 --bitrate=10000000 --no-snapshots
# Optional longer stability check, when bitrate/quality drift remains unresolved:
node apps/native-capture/diagnostics/webview-pipeline.mjs --pan-source=output/native-pan-source/pan-source.png --seconds=300 --bitrate=10000000 --no-snapshots
```

The 4096×2304 source chart is created once from deterministic graphics and font rendering. FFmpeg caches the source image, then generates a distinct 1920×1080 viewport at 120 Hz. The unchanged production selector selects actual 60 Hz samples; it does not synthesize constant-rate duplicates. The phases are:

- 0–30 seconds: horizontal motion, 1200 pixels/second.
- 30–60 seconds: diagonal motion, 1680 horizontal and 960 vertical pixels/second.
- 60–90 seconds: scroll-like vertical motion, 2160 pixels/second.
- Every 15-second cycle switches crop position and horizontal orientation at 12 seconds and switches back at the cycle boundary. Crop wrap-around adds further hard scene changes.

For runs longer than 90 seconds, these motion categories repeat every 90 seconds. A 300-second run therefore compares the same horizontal-motion category at the beginning and end, with two additional horizontal intervals in between. The summary includes first/middle/last 30-second segments, repeated horizontal intervals, actual and target bitrate ranges, and QP. The first five connection-startup seconds are excluded from summary metrics.

The source control runs the same chart/crop/I420/60 Hz selector without realtime pacing or the browser and measures its maximum throughput over 600 selected frames. A separate 60-frame `framemd5` pass verifies distinct complete output images. This distinguishes a CPU-limited generator from an encoding or transport limitation.

The browser path is the existing authenticated loopback HTTP transport, frame worker/pacer, production screen-share controller, production P2P sender, real RTP encoder, and real browser receiver. WebView2 uses the same media/background flags as the Windows client. Window phases are foreground (0–20s), behind an owned test window (20–40s), minimized (40–60s), and foreground restored (60–90s).

Each run saves raw one-second WebRTC and pacing samples, errors, dimensions, codec, bitrate, QP, packet loss, and Stop outcome. `summarize-webview.mjs <samples.json>` produces aggregate and phase summaries. Snapshot runs also save actual receiver video PNGs at 20, 50 and 80 seconds; synchronous PNG extraction can disturb the pipeline, so the separate `--no-snapshots` run is the performance control. A minimized HTML video element may retain its last rendered image even while the receiver decodes; use foreground snapshots for visual quality conclusions.

An earlier reference mode remains available with `--steps` instead of `--pan-source`; it uses generated FFmpeg `testsrc2` and black frames. Neither mode requests desktop, window, camera, microphone or game capture. These are local synthetic tests, not evidence of a real desktop workload or a remote network connection. Short-term receive FPS above 60 can reflect jitter-buffer catch-up rather than extra source content.

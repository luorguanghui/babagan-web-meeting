"""Create a deterministic, high-detail chart for synthetic 1080p pan diagnostics.

Only generated pixels and bundled Windows fonts are used. No screen capture,
network, photographs, or personal content is read. Run from the repository root:
    python apps/native-capture/diagnostics/make-pan-source.py
"""
from hashlib import sha256
from pathlib import Path
import json
import math
import random

from PIL import Image, ImageDraw, ImageFont

WIDTH, HEIGHT = 4096, 2304
ROOT = Path(__file__).resolve().parents[3]
OUTPUT = ROOT / "output" / "native-pan-source" / "pan-source.png"
FONT_ROOT = Path("C:/Windows/Fonts")
RNG = random.Random(842711)


def font(size, bold=False, mono=False):
    name = ("consolab.ttf" if bold else "consola.ttf") if mono else ("segoeuib.ttf" if bold else "segoeui.ttf")
    return ImageFont.truetype(str(FONT_ROOT / name), size)


image = Image.new("RGB", (WIDTH, HEIGHT), "#e8edf4")
draw = ImageDraw.Draw(image)
f13, f16, f18, f22, f30 = font(13), font(16), font(18), font(22, True), font(30, True)
mono = font(16, mono=True)
colors = ["#d95632", "#177e89", "#8062af", "#2e61a3", "#b67513", "#9c4363"]


def text(x, y, value, fill="#233047", face=f16):
    draw.text((x, y), value, font=face, fill=fill, stroke_width=0)


def box(x, y, w, h, fill, outline=None):
    draw.rectangle((x, y, x + w - 1, y + h - 1), fill=fill, outline=outline)


def panel(x, y, index, w=996, h=738):
    accent = colors[index % len(colors)]
    box(x, y, w, h, "#ffffff", "#a5afbd")
    box(x, y, w, 52, accent)
    text(x + 18, y + 9, f"SYNTHETIC VIEW {index + 1:02d} / GENERATED CONTENT", "white", f22)
    text(x + w - 170, y + 63, f"X {x:04d}  Y {y:04d}", accent, mono)
    for offset in range(0, w, 32):
        box(x + offset, y + h - 12, 16, 8, accent)
    return accent


def table(x, y, index):
    accent = panel(x, y, index)
    text(x + 20, y + 63, "LIVE DATA WORKSPACE  /  36 ROWS", accent, f22)
    left, top = x + 18, y + 107
    widths = [48, 202, 116, 112, 116, 112, 112, 140]
    labels = ["ROW", "MODULE / ITEM", "STATUS", "COUNT", "RATIO", "LATENCY", "DELTA", "REFERENCE"]
    for row in range(32):
        yy = top + row * 18
        box(left, yy, sum(widths), 18, "#dce9f2" if row == 0 else ("#f0f6fb" if row % 2 else "#ffffff"))
        values = labels if row == 0 else [f"{row:02d}", f"viewport_{index}_{row:03d}", ["READY", "ACTIVE", "SYNC", "PASS"][row % 4], f"{row * 183 + index:06d}", f"{95 + row / 100:.2f}%", f"{4.25 + row / 7:.3f} ms", f"+{row * 7:04d}", f"T-{index:02X}-{row * 1237:06X}"]
        xx = left
        for width, value in zip(widths, values):
            draw.line((xx, yy, xx, yy + 18), fill="#b3c0cf", width=1)
            text(xx + 4, yy + 1, value, "#10243b" if row == 0 else "#253954", f13)
            xx += width
        draw.line((left, yy + 17, left + sum(widths), yy + 17), fill="#d4dde7", width=1)


def code(x, y, index):
    accent = panel(x, y, index)
    text(x + 20, y + 63, "PIPELINE SOURCE  /  FIXED TEST FILE", accent, f22)
    box(x + 17, y + 108, 962, 604, "#132338")
    lines = [
        "export async function renderViewport(frame, state) {",
        "  const { width, height, timestamp, sequence } = frame;",
        "  if (width !== 1920 || height !== 1080) throw Error('size');",
        "  const velocity = { x: 1100, y: 730 }; // pixels / second",
        "  for (const layer of state.visibleLayers) {",
        "    const bounds = project(layer.position, state.camera);",
        "    await queue.submit({ layer, bounds, sequence });",
        "    counters.changedPixels += inspectEdges(frame, bounds);",
        "  }",
        "  return { ready: true, sequence, timestamp, dropped: 0 };",
        "}",
        "// Small text, punctuation, sharp diagonals and color transitions.",
        "const styles = ['table-grid', 'code-window', 'metrics', 'text'];",
        "const policy = Object.freeze({ bitrate: 10000000, fps: 60 });",
        "assert(samples.every(sample => sample.width === 1920));",
        "console.log('SYNTHETIC CONTENT ONLY / NO PRIVATE DATA');",
    ]
    for row in range(30):
        value = lines[(row + index) % len(lines)]
        text(x + 28, y + 117 + row * 19, f"{row + 1 + index * 40:03d}", "#7f96b5", mono)
        text(x + 79, y + 117 + row * 19, value, ["#d5e8f7", "#e8bd7b", "#83d5cc", "#c9b4f4"][row % 4], mono)


def document(x, y, index):
    accent = panel(x, y, index)
    text(x + 20, y + 64, "SCROLL DOCUMENT / TYPOGRAPHY & EDGE DETAIL", accent, f22)
    paragraphs = [
        "Every frame in this scene is generated from an owned, fixed test chart.",
        "Fast diagonal movement moves fine text across the entire video viewport.",
        "ABCDEFGHIJKLMNOPQRSTUVWXYZ  abcdefghijklmnopqrstuvwxyz  0123456789",
        "Measure captured, encoded and decoded frames separately at full resolution.",
        "The 10 Mbps target is a transport budget; source frame cadence stays visible.",
        "! @ # $ % ^ & * ( ) [ ] { } < > / \\ | ; : , . ? + = - _  0O 1Il 5S 8B",
    ]
    for col in range(2):
        xx = x + 22 + col * 486
        for row in range(27):
            yy = y + 112 + row * 21
            if row % 7 == 0:
                box(xx, yy - 1, 464, 20, "#fff0da" if col else "#e4f2f5")
            value = paragraphs[(row + col + index) % len(paragraphs)]
            text(xx + 4, yy, value[:64], "#162739", f13)
        for line in range(14):
            draw.line((xx + line * 6, y + 690, xx + 80 + line * 6, y + 617), fill=accent, width=1)


def charts(x, y, index):
    accent = panel(x, y, index)
    text(x + 20, y + 63, "METRIC DASHBOARD / FINE GRID & CHROMA", accent, f22)
    for chart in range(4):
        cx = x + 22 + (chart % 2) * 483
        cy = y + 112 + (chart // 2) * 292
        box(cx, cy, 458, 267, "#f9fcff", "#8c9bac")
        for gx in range(0, 458, 8):
            draw.line((cx + gx, cy, cx + gx, cy + 266), fill="#c1cdd9" if gx % 40 == 0 else "#e5ebf0", width=1)
        for gy in range(0, 267, 8):
            draw.line((cx, cy + gy, cx + 457, cy + gy), fill="#c1cdd9" if gy % 40 == 0 else "#e5ebf0", width=1)
        for line in range(4):
            points = [(cx + px, cy + 130 + int(73 * math.sin(px / (13 + line * 8) + index) + 18 * math.sin(px / 3.7 + line))) for px in range(458)]
            draw.line(points, fill=colors[(index + chart + line) % len(colors)], width=2)
        text(cx + 8, cy + 7, f"STREAM {index}.{chart} / 1920 x 1080 / 60 FPS", "#25314b", f16)
        for cell in range(22):
            color = colors[(cell + index + chart) % len(colors)]
            box(cx + 8 + cell * 20, cy + 226, 15, 27 - cell % 4 * 5, color)


renderers = [table, code, document, charts]
for row in range(3):
    for column in range(4):
        number = row * 4 + column
        renderers[(column + row) % len(renderers)](16 + column * 1024, 14 + row * 768, number)

# Native-resolution registration strips make translation and scene cuts visible.
for y in range(HEIGHT):
    color = colors[(y // 32) % len(colors)]
    draw.line((0, y, 7, y), fill=color)
for x in range(WIDTH):
    draw.line((x, 0, x, 7), fill=colors[(x // 32) % len(colors)])

OUTPUT.parent.mkdir(parents=True, exist_ok=True)
image.save(OUTPUT, format="PNG", compress_level=6)
data = OUTPUT.read_bytes()
print(json.dumps({"path": str(OUTPUT), "width": WIDTH, "height": HEIGHT, "bytes": len(data), "sha256": sha256(data).hexdigest(), "content": "deterministic generated text, table, code and grid only"}))

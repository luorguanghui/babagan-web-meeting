# Babagan Windows app icon

Built-in image_gen created `babagan-master.png` from the existing `apps/web/public/brand/babagan-icon.png` identity reference. The palette follows the website: olive #617A50 / #506842, warm ivory #FAF9F6. No existing website brand asset was replaced.

Prompt: Create one production-ready Windows desktop application icon for Babagan, keeping the distinctive rounded open screen outline, separated curved upper-right segment, and lower-right leaf recognizable. Use a warm ivory rounded-square tile with the olive symbol large and optically centered, approximately 68–72% of the tile. Crisp flat vector-like geometry, substantial strokes, balanced spacing, subtle sage edge, no text or heavy shadow. Front-facing square; transparent outside the tile; readable at 16–48 pixels.

`babagan.ico` contains 16, 20, 24, 32, 40, 48, 64, 128 and 256 px frames. Small frames use Windows 32-bit BGRA + alpha mask; 256 px uses PNG. `scripts/native-icon-builder.cs` only scales and encodes the approved image. The 256 px PNG counterpart is `apps/web/public/brand/babagan-desktop.png`.

Compile the icon builder on Windows with the .NET Framework compiler and System.Drawing.dll. Pass master PNG, ICO destination, website PNG destination, and preview-sheet destination as arguments. The installer build embeds the ICO using `/win32icon`; launcher windows and tray extract the icon from their executable.

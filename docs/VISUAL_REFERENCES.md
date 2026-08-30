# Visual references

The large Quad Cortex skin is based on official Neural DSP reference material current on 2026-08-30. These sources are design references only; the application does not bundle their photography, screenshots, logos, fonts, or extracted image assets.

## Hardware

- [Quad Cortex product page](https://neuraldsp.com/quad-cortex) — graphite anodized-aluminum finish, stainless rotary footswitch construction, screen glass/bezel treatment, and physical product photography.
- [Official Quad Cortex manual](https://neuraldsp.com/manual/quad-cortex) — 29 × 19.5 cm top-panel drawing and exact placement of Master Volume, power, screen, navigation, A–H, Bank, Mode, Tempo, and Tuner labels.
- [Near-top-down retail photograph](https://www.tonefestguitargallery.com/products/neural-dsp-quad-cortex) — direct visual comparison for chassis color, rear connector silhouettes, actuator depth, label offsets, and screen-to-enclosure proportions.

The CSS surface uses normalized landmarks traced from Neural DSP's official top-panel SVG. Its panel outline is treated as 1096 × 718 units; the screen spans x 252.8–844.2 and y 78.1–411.9, and the five control columns are centered at approximately 5.9%, 27.9%, 50%, 72.1%, and 94.1%. It is an orthographic recreation of the top panel only; rear connectors and side-wall perspective are intentionally excluded.

## CorOS Grid

The manual’s current CorOS 4.1 screenshots define the screen treatment:

- black display canvas fitted to the official top-panel screen opening;
- large preset bank/slot and name at upper left;
- undo, active Scene, save, contextual menu, and Mode at upper right;
- four routing rows with thin light signal paths, with the upper rows populated and lower rows left visually empty;
- compact rounded device blocks with colored outlines and white category glyphs;
- input/output and add-row pills on the left and right rails;
- a dark eight-item Scene dropdown opened from the Scene indicator.

The Windows hardware renderer follows the current `QC 1A Brit 2203` manual image for its default demo: four rows with eight internal device slots, `In 1` / add / `Prev. Row` / add rails on the left, and `Row 3` / add / `Multi Out` / add rails on the right. It recreates the layout with interactive HTML and original SVG glyphs; neither the manual screenshot nor top-panel SVG is shipped with the application.

Device glyphs in the application are original inline SVG approximations keyed by semantic device category. Product and trademark labels remain isolated presentation tokens so they can be replaced if distribution requirements change.

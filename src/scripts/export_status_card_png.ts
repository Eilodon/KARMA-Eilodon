/**
 * Re-exports docs/media/readme-status-card.png from the hand-authored SVG of the same name —
 * so editing the SVG (e.g. updating the test-count line) and forgetting to regenerate the PNG
 * doesn't leave README.md's embedded image silently stale (it embeds the PNG, not the SVG).
 *
 * @resvg/resvg-js chosen over a headless-browser screenshot: the SVG uses only generic OS font
 * stacks (no @font-face), so a browser render wouldn't be any more "correct" than resvg's
 * fontdb — it would just pick whatever fonts happen to be installed on that machine instead.
 * Rendered at 2x the SVG's viewBox for a retina-sharp PNG.
 *
 *   pnpm card:png
 */
import { readFileSync, writeFileSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";

const SVG_PATH = "docs/media/readme-status-card.svg";
const PNG_PATH = "docs/media/readme-status-card.png";
const SCALE = 2;

function main(): void {
  const svg = readFileSync(SVG_PATH, "utf8");
  const resvg = new Resvg(svg, { fitTo: { mode: "zoom", value: SCALE } });
  const rendered = resvg.render();
  writeFileSync(PNG_PATH, rendered.asPng());
  console.log(`[card-png] wrote ${PNG_PATH} (${rendered.width}x${rendered.height}, from ${SVG_PATH})`);
}

main();

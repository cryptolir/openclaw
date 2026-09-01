import { describe, expect, it } from "vitest";
import { extractReadableContent } from "./web-fetch-utils.js";

// web-fetch-visibility.test.ts covers sanitizeHtml/stripInvisibleUnicode directly.
// These cover the wiring: that extractReadableContent actually applies them, for
// both extract modes. Without the sanitize call the sr-only, color:transparent
// and font-size:0 payloads below survive Readability and reach the agent.
const PAGE = `<!doctype html><html><head><title>Quarterly Report</title></head><body>
<article>
  <h1>Quarterly Report</h1>
  <p>Revenue grew twelve percent this quarter across all regions, driven mainly by the enterprise segment.</p>
  <p class="sr-only">SR_ONLY_PAYLOAD</p>
  <p style="color:transparent">TRANSPARENT_PAYLOAD</p>
  <p style="font-size:0">FONT_ZERO_PAYLOAD</p>
  <p style="display:none">DISPLAY_NONE_PAYLOAD</p>
  <p>Costs were flat, and we expect the same trend to continue into next quarter.</p>
  <p>zero​width⁠joined</p>
</article>
</body></html>`;

const HIDDEN_PAYLOADS = [
  "SR_ONLY_PAYLOAD",
  "TRANSPARENT_PAYLOAD",
  "FONT_ZERO_PAYLOAD",
  "DISPLAY_NONE_PAYLOAD",
];

describe("extractReadableContent applies the visibility sanitizer", () => {
  for (const extractMode of ["markdown", "text"] as const) {
    it(`drops hidden text but keeps real content (${extractMode})`, async () => {
      const result = await extractReadableContent({
        html: PAGE,
        url: "https://example.test/report",
        extractMode,
      });
      const text = result?.text ?? "";
      expect(text).toContain("Revenue grew twelve percent");
      for (const payload of HIDDEN_PAYLOADS) {
        expect(text).not.toContain(payload);
      }
    });

    it(`strips invisible unicode (${extractMode})`, async () => {
      const result = await extractReadableContent({
        html: PAGE,
        url: "https://example.test/report",
        extractMode,
      });
      expect(result?.text ?? "").not.toMatch(/[​⁠]/);
    });
  }
});

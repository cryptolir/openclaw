import { describe, expect, it } from "vitest";
import { cleanSchemaForGemini } from "./clean-for-gemini.js";

describe("cleanSchemaForGemini — required pruning", () => {
  // Reproduces the reported 400: an array item marks a property required that
  // its own `properties` never defines. Gemini rejects the whole request
  // ("...items.required[0]: property is not defined"); lenient providers ignore it.
  it("drops a nested `required` name that isn't in `properties`", () => {
    const schema = {
      type: "object",
      properties: {
        issue_fields: {
          type: "array",
          items: {
            type: "object",
            properties: { summary: { type: "string" } },
            required: ["summary", "priority"], // `priority` is undefined
          },
        },
      },
    };

    const cleaned = cleanSchemaForGemini(schema) as {
      properties: { issue_fields: { items: { required: string[] } } };
    };
    expect(cleaned.properties.issue_fields.items.required).toEqual(["summary"]);
  });

  it("removes `required` entirely when nothing remains", () => {
    const cleaned = cleanSchemaForGemini({
      type: "object",
      properties: { a: { type: "string" } },
      required: ["ghost"],
    }) as { required?: string[] };
    expect("required" in cleaned).toBe(false);
  });

  it("keeps a fully-valid `required` untouched", () => {
    const cleaned = cleanSchemaForGemini({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      required: ["a", "b"],
    }) as { required?: string[] };
    expect(cleaned.required).toEqual(["a", "b"]);
  });
});

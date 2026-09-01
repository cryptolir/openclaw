import { describe, expect, it } from "vitest";
import { removePathValue, setPathValue } from "./form-utils.js";

// Config paths come from the form UI. A path segment naming a prototype key
// must not be walked or written, or every object in the page inherits it.
describe("config form path walkers reject prototype keys", () => {
  const FORBIDDEN = ["__proto__", "constructor", "prototype"];

  for (const key of FORBIDDEN) {
    it(`setPathValue ignores a path through ${key}`, () => {
      const target: Record<string, unknown> = {};
      setPathValue(target, [key, "polluted"], "yes");
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(target, key)).toBe(false);
    });

    it(`setPathValue ignores ${key} deeper in the path`, () => {
      const target: Record<string, unknown> = { a: {} };
      setPathValue(target, ["a", key, "polluted"], "yes");
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it(`removePathValue ignores a path through ${key}`, () => {
      const target: Record<string, unknown> = { a: { b: 1 } };
      removePathValue(target, [key, "toString"]);
      expect(typeof Object.prototype.toString).toBe("function");
    });
  }

  it("still writes and removes ordinary paths", () => {
    const target: Record<string, unknown> = {};
    setPathValue(target, ["gateway", "port"], 8080);
    expect(target).toEqual({ gateway: { port: 8080 } });
    removePathValue(target, ["gateway", "port"]);
    expect(target).toEqual({ gateway: {} });
  });
});

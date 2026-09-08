import { describe, expect, it } from "vitest";
import {
  describeRawErrorReply,
  isRawApiErrorPayload,
  parseApiErrorInfo,
} from "./pi-embedded-helpers.js";

// OB-54: a provider that refuses INSIDE a 200-shaped reply. Measured 2026-09-07
// and 2026-09-08 on projectmanager: the ChatGPT/Codex backend answered
// {"detail":"The 'gpt-5.4-mini' model is not supported when using Codex with a
// ChatGPT account."} as the assistant text, stopReason "stop", and Venice was
// never called.
const CODEX_REFUSAL =
  '{"detail":"The \'gpt-5.4-mini\' model is not supported when using Codex with a ChatGPT account."}';
const CODEX = "openai-codex";

describe("describeRawErrorReply (OB-54)", () => {
  it("recognises the Codex plan refusal — the provider's own envelope — and returns its message", () => {
    expect(isRawApiErrorPayload(CODEX_REFUSAL, CODEX)).toBe(true);
    expect(parseApiErrorInfo(CODEX_REFUSAL, CODEX)?.message).toBe(
      "The 'gpt-5.4-mini' model is not supported when using Codex with a ChatGPT account.",
    );
    expect(describeRawErrorReply([CODEX_REFUSAL], CODEX)).toBe(
      "The 'gpt-5.4-mini' model is not supported when using Codex with a ChatGPT account.",
    );
  });

  it("the bare envelope is provider-scoped — the same body from another provider is an answer (Codex #159 r2)", () => {
    expect(describeRawErrorReply([CODEX_REFUSAL])).toBeNull();
    expect(describeRawErrorReply([CODEX_REFUSAL], "openai")).toBeNull();
    expect(describeRawErrorReply([CODEX_REFUSAL], "venice")).toBeNull();
    // and wording is never the signal: a refusal-sounding answer from a
    // non-Codex provider, or an answer that merely uses the field name, stays an answer
    expect(
      describeRawErrorReply(['{"detail":"This feature is not supported"}'], "venice"),
    ).toBeNull();
    expect(describeRawErrorReply(['{"error":"validation failed"}'], CODEX)).toBeNull();
    expect(describeRawErrorReply(['{"detail":"the requested explanation"}'], "venice")).toBeNull();
  });

  it("concrete error metadata is an independent signal for any provider", () => {
    expect(describeRawErrorReply(['{"detail":"Rate limit exceeded","status":429}'], "venice")).toBe(
      "Rate limit exceeded",
    );
    expect(
      describeRawErrorReply(['{"error":"model_not_available","code":"model_not_available"}']),
    ).toBe("model_not_available");
    expect(describeRawErrorReply(['{"error":"nope","status_code":403}'])).toBe("nope");
    // metadata with non-error-ish keys is still an answer
    expect(describeRawErrorReply(['{"error":"x","status":500,"answer":42}'])).toBeNull();
  });

  it("the pre-existing envelope shapes are unchanged", () => {
    expect(
      describeRawErrorReply(['{"error":{"message":"quota exceeded","type":"insufficient_quota"}}']),
    ).toBe("quota exceeded");
    expect(describeRawErrorReply(['{"type":"error","request_id":"req_1"}'])).toBe(
      '{"type":"error","request_id":"req_1"}',
    );
  });

  it("prose, arrays, empties and ordinary JSON are never refusals", () => {
    for (const p of [undefined, CODEX]) {
      expect(describeRawErrorReply(["I cannot help with that."], p)).toBeNull();
      expect(describeRawErrorReply(['{"result":"ok"}'], p)).toBeNull();
      expect(describeRawErrorReply(['{"answer":42,"detail":"not supported"}'], p)).toBeNull();
      expect(describeRawErrorReply(['{"detail":""}'], p)).toBeNull();
      expect(describeRawErrorReply(['{"detail": 42}'], p)).toBeNull();
      expect(describeRawErrorReply(["[1,2,3]"], p)).toBeNull();
      expect(describeRawErrorReply([], p)).toBeNull();
      expect(describeRawErrorReply([""], p)).toBeNull();
    }
  });

  it("only the LAST assistant text decides — an early error followed by a real answer is an answer", () => {
    expect(
      describeRawErrorReply([CODEX_REFUSAL, "Here is the summary you asked for."], CODEX),
    ).toBeNull();
    expect(describeRawErrorReply(["Working on it…", CODEX_REFUSAL], CODEX)).not.toBeNull();
  });
});

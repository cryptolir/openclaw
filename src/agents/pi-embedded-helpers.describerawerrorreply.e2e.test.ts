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

describe("describeRawErrorReply (OB-54)", () => {
  it("recognises the Codex plan refusal and returns its message", () => {
    expect(isRawApiErrorPayload(CODEX_REFUSAL)).toBe(true);
    expect(parseApiErrorInfo(CODEX_REFUSAL)?.message).toBe(
      "The 'gpt-5.4-mini' model is not supported when using Codex with a ChatGPT account.",
    );
    expect(describeRawErrorReply([CODEX_REFUSAL])).toBe(
      "The 'gpt-5.4-mini' model is not supported when using Codex with a ChatGPT account.",
    );
  });

  it("recognises other bare refusal bodies and the pre-existing object shapes", () => {
    expect(describeRawErrorReply(['{"error":"model_not_available"}'])).toBe("model_not_available");
    expect(describeRawErrorReply(['{"detail":"Rate limit exceeded","status":429}'])).toBe(
      "Rate limit exceeded",
    );
    expect(
      describeRawErrorReply(['{"error":{"message":"quota exceeded","type":"insufficient_quota"}}']),
    ).toBe("quota exceeded");
    expect(describeRawErrorReply(['{"type":"error","request_id":"req_1"}'])).toBe(
      '{"type":"error","request_id":"req_1"}',
    );
  });

  it("needs an independent signal — a field named detail/error alone is not a refusal (Codex #159 r1)", () => {
    // a prompt that asked for exactly this JSON shape gets its answer back
    expect(describeRawErrorReply(['{"detail":"the requested explanation"}'])).toBeNull();
    expect(describeRawErrorReply(['{"error":"the requested label"}'])).toBeNull();
    expect(describeRawErrorReply(['{"detail":"Paris is the capital of France."}'])).toBeNull();
    // a structured answer that carries other keys is never a refusal
    expect(describeRawErrorReply(['{"answer":42,"detail":"not supported"}'])).toBeNull();
    expect(describeRawErrorReply(['{"result":"ok"}'])).toBeNull();
    // and prose, arrays, empties never are
    expect(describeRawErrorReply(["I cannot help with that."])).toBeNull();
    expect(describeRawErrorReply(['{"detail":""}'])).toBeNull();
    expect(describeRawErrorReply(['{"detail": 42}'])).toBeNull();
    expect(describeRawErrorReply(["[1,2,3]"])).toBeNull();
    expect(describeRawErrorReply([])).toBeNull();
    expect(describeRawErrorReply([""])).toBeNull();
  });

  it("only the LAST assistant text decides — an early error followed by a real answer is an answer", () => {
    expect(describeRawErrorReply([CODEX_REFUSAL, "Here is the summary you asked for."])).toBeNull();
    expect(describeRawErrorReply(["Working on it…", CODEX_REFUSAL])).not.toBeNull();
  });
});

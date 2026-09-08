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

  it('recognises a bare {"error":"…"} string body and the existing object shapes', () => {
    expect(describeRawErrorReply(['{"error":"model_not_available"}'])).toBe("model_not_available");
    expect(
      describeRawErrorReply(['{"error":{"message":"quota exceeded","type":"insufficient_quota"}}']),
    ).toBe("quota exceeded");
    expect(describeRawErrorReply(['{"type":"error","request_id":"req_1"}'])).toBe(
      '{"type":"error","request_id":"req_1"}',
    );
  });

  it("is keyed on the shape — prose, ordinary JSON answers and JSON with other keys are not refusals", () => {
    expect(describeRawErrorReply(["I cannot help with that."])).toBeNull();
    // a structured ANSWER that happens to carry a `detail` key is still an answer
    expect(describeRawErrorReply(['{"answer":42,"detail":"the meaning"}'])).toBeNull();
    expect(describeRawErrorReply(['{"detail":"x","status":403}'])).toBe("x");
    expect(describeRawErrorReply(['{"result":"ok"}'])).toBeNull();
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

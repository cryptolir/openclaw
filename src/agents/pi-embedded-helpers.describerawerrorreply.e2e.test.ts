import { describe, expect, it } from "vitest";
import {
  describeRawErrorReply,
  failoverReasonFromStatus,
  isRawApiErrorPayload,
  looksLikeErrorPayloadStart,
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
const REFUSAL_MESSAGE =
  "The 'gpt-5.4-mini' model is not supported when using Codex with a ChatGPT account.";

describe("describeRawErrorReply (OB-54)", () => {
  it("recognises the Codex plan refusal — the provider's own envelope — and returns its message", () => {
    expect(isRawApiErrorPayload(CODEX_REFUSAL, CODEX)).toBe(true);
    expect(parseApiErrorInfo(CODEX_REFUSAL, CODEX)?.message).toBe(REFUSAL_MESSAGE);
    expect(describeRawErrorReply([CODEX_REFUSAL], CODEX)).toEqual({ message: REFUSAL_MESSAGE });
  });

  it("the bare envelope is provider-scoped — the same body from another provider is an answer (Codex #159 r2)", () => {
    expect(describeRawErrorReply([CODEX_REFUSAL])).toBeNull();
    expect(describeRawErrorReply([CODEX_REFUSAL], "openai")).toBeNull();
    expect(describeRawErrorReply([CODEX_REFUSAL], "venice")).toBeNull();
    expect(
      describeRawErrorReply(['{"detail":"This feature is not supported"}'], "venice"),
    ).toBeNull();
    expect(describeRawErrorReply(['{"error":"validation failed"}'], CODEX)).toBeNull();
    expect(describeRawErrorReply(['{"detail":"the requested explanation"}'], "venice")).toBeNull();
  });

  it("only ERROR-valued status metadata is an independent signal — and it is carried out (Codex #159 r3)", () => {
    expect(
      describeRawErrorReply(['{"detail":"Rate limit exceeded","status":429}'], "venice"),
    ).toEqual({
      message: "Rate limit exceeded",
      status: 429,
    });
    expect(describeRawErrorReply(['{"detail":"Please retry later","status":429}'])).toEqual({
      message: "Please retry later",
      status: 429,
    });
    expect(describeRawErrorReply(['{"error":"nope","status_code":"403"}'])).toEqual({
      message: "nope",
      status: 403,
    });
    // a leading HTTP code is stripped for the guard and carried as the status (#159 r4)
    expect(describeRawErrorReply(['429 {"detail":"Please retry later"}'], "venice")).toEqual({
      message: "Please retry later",
      status: 429,
    });
    // a 2xx status, or a bare code, is NOT an error signal
    expect(describeRawErrorReply(['{"detail":"healthy","status":200}'])).toBeNull();
    expect(describeRawErrorReply(['{"error":"ok","code":"OK"}'])).toBeNull();
    expect(
      describeRawErrorReply(['{"error":"model_not_available","code":"model_not_available"}']),
    ).toBeNull();
    // metadata with non-error-ish keys is still an answer
    expect(describeRawErrorReply(['{"error":"x","status":500,"answer":42}'])).toBeNull();
  });

  it("the pre-existing envelope shapes are unchanged", () => {
    expect(
      describeRawErrorReply(['{"error":{"message":"quota exceeded","type":"insufficient_quota"}}'])
        ?.message,
    ).toBe("quota exceeded");
    expect(describeRawErrorReply(['{"type":"error","request_id":"req_1"}'])?.message).toBe(
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

describe("looksLikeErrorPayloadStart (the streaming hold)", () => {
  it("looks through the wrappers and prefixes the parser strips", () => {
    expect(looksLikeErrorPayloadStart('{"detail":"x')).toBe(true);
    expect(looksLikeErrorPayloadStart("  {")).toBe(true);
    expect(looksLikeErrorPayloadStart('<final>{"detail":"x"}</final>')).toBe(true);
    expect(looksLikeErrorPayloadStart('<final>{"det')).toBe(true);
    expect(looksLikeErrorPayloadStart('Error: {"detail":"x"}')).toBe(true);
    expect(looksLikeErrorPayloadStart('API error: {"error":')).toBe(true);
    expect(looksLikeErrorPayloadStart('429 {"detail":"slow down"}')).toBe(true);
  });
  it("holds while the text could still become an error prefix (#159 r4)", () => {
    for (const partial of [
      "E",
      "Err",
      "Error",
      "Error:",
      "Error: ",
      "API err",
      "429",
      "42",
      "<fin",
      "<final>",
    ]) {
      expect(looksLikeErrorPayloadStart(partial), partial).toBe(true);
    }
  });
  it("lets prose stream — including prose that starts like a prefix once it is ruled out", () => {
    expect(looksLikeErrorPayloadStart("Sure — here is the plan:")).toBe(false);
    expect(looksLikeErrorPayloadStart("Error: the file was not found")).toBe(false);
    expect(looksLikeErrorPayloadStart("Errors happen")).toBe(false);
    expect(looksLikeErrorPayloadStart("4291 units")).toBe(false);
    expect(looksLikeErrorPayloadStart("")).toBe(false);
    expect(looksLikeErrorPayloadStart("[1,2]")).toBe(false);
  });
});

describe("failoverReasonFromStatus", () => {
  it("maps the statuses the profile-rotation path acts on", () => {
    expect(failoverReasonFromStatus(401)).toBe("auth");
    expect(failoverReasonFromStatus(403)).toBe("auth");
    expect(failoverReasonFromStatus(402)).toBe("billing");
    expect(failoverReasonFromStatus(429)).toBe("rate_limit");
    expect(failoverReasonFromStatus(408)).toBe("timeout");
    expect(failoverReasonFromStatus(503)).toBe("timeout");
    expect(failoverReasonFromStatus(404)).toBeNull();
    expect(failoverReasonFromStatus(200)).toBeNull();
    expect(failoverReasonFromStatus(undefined)).toBeNull();
  });
});

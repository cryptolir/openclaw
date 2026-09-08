import { describe, expect, it, vi } from "vitest";
import {
  createSubscribedSessionHarness,
  emitAssistantTextDelta,
  emitAssistantTextEnd,
  emitMessageStartAndEndForAssistantText,
} from "./pi-embedded-subscribe.e2e-harness.js";

// OB-54 (Codex #159 r1–r3): a provider refusal inside a 200-shaped reply must
// be judged on the COMPLETE message and never reach the channel — not as a
// whole, not as streamed fragments, not via the message_end path, and not when
// wrapped in <final> or prefixed like "Error: ".
const CODEX_REFUSAL =
  '{"detail":"The \'gpt-5.4-mini\' model is not supported when using Codex with a ChatGPT account and this sentence is long enough to be split across several block chunks."}';

function harness(opts?: {
  provider?: string;
  chunking?: boolean;
  breakAt?: "text_end" | "message_end";
}) {
  const onBlockReply = vi.fn();
  const onPartialReply = vi.fn();
  const { emit, subscription } = createSubscribedSessionHarness({
    runId: "run",
    onBlockReply,
    onPartialReply,
    blockReplyBreak: opts?.breakAt ?? "text_end",
    blockReplyChunking:
      opts?.chunking === false
        ? undefined
        : { minChars: 5, maxChars: 40, breakPreference: "newline" },
    provider: opts?.provider ?? "openai-codex",
  });
  return { emit, subscription, onBlockReply, onPartialReply };
}

function streamThenEnd(emit: (evt: unknown) => void, text: string) {
  for (let i = 0; i < text.length; i += 17) {
    emitAssistantTextDelta({ emit, delta: text.slice(i, i + 17) });
  }
  emitAssistantTextEnd({ emit, content: text });
  emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
}

describe("subscribeEmbeddedPiSession — provider error reply (OB-54)", () => {
  it("a refusal streamed in fragments longer than the chunk size never reaches onBlockReply", () => {
    const { emit, subscription, onBlockReply, onPartialReply } = harness();
    streamThenEnd(emit, CODEX_REFUSAL);
    expect(onBlockReply).not.toHaveBeenCalled();
    expect(onPartialReply).not.toHaveBeenCalled();
    expect(subscription.getRawErrorReply()?.message).toMatch(/not supported when using Codex/);
    // kept ONCE, whole, for the runner to fail over on
    expect(subscription.assistantTexts).toEqual([CODEX_REFUSAL]);
  });

  it("a refusal wrapped in <final> or prefixed with Error: is held and suppressed too (#159 r3)", () => {
    for (const wrapped of [`<final>${CODEX_REFUSAL}</final>`, `Error: ${CODEX_REFUSAL}`]) {
      const { emit, subscription, onBlockReply, onPartialReply } = harness();
      streamThenEnd(emit, wrapped);
      expect(onBlockReply, wrapped.slice(0, 12)).not.toHaveBeenCalled();
      expect(onPartialReply, wrapped.slice(0, 12)).not.toHaveBeenCalled();
      expect(subscription.getRawErrorReply()?.message).toMatch(/not supported/);
    }
  });

  it("the message_end delivery path (no deltas) is gated too", () => {
    const { emit, subscription, onBlockReply } = harness({
      breakAt: "message_end",
      chunking: false,
    });
    emitMessageStartAndEndForAssistantText({ emit, text: CODEX_REFUSAL });
    expect(onBlockReply).not.toHaveBeenCalled();
    expect(subscription.getRawErrorReply()?.message).toMatch(/not supported/);
  });

  it("a legitimate JSON answer is held while streaming and delivered whole at message_end", () => {
    const answer =
      '{"answer":42,"why":"because the question asked for exactly this JSON shape, verbatim"}';
    const { emit, subscription, onBlockReply } = harness();
    for (let i = 0; i < answer.length; i += 17) {
      emitAssistantTextDelta({ emit, delta: answer.slice(i, i + 17) });
    }
    // nothing while streaming — a JSON-shaped reply can only be judged complete
    expect(onBlockReply).not.toHaveBeenCalled();
    emitAssistantTextEnd({ emit, content: answer });
    emit({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: answer }] },
    });
    expect(onBlockReply).toHaveBeenCalled();
    // the chunker trims chunk edges — compare the delivered content, not the whitespace
    const delivered = onBlockReply.mock.calls
      .map((c) => (c[0] as { text?: string }).text ?? "")
      .join("");
    expect(delivered.replace(/\s+/g, "")).toBe(answer.replace(/\s+/g, ""));
    expect(subscription.getRawErrorReply()).toBeUndefined();
  });

  it("the same bare body from a non-Codex provider is an answer and is delivered", () => {
    const { emit, subscription, onBlockReply } = harness({
      provider: "venice",
      breakAt: "message_end",
      chunking: false,
    });
    emitMessageStartAndEndForAssistantText({
      emit,
      text: '{"detail":"the requested explanation"}',
    });
    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(subscription.getRawErrorReply()).toBeUndefined();
  });

  it("a status-carrying refusal from any provider exposes its status for profile rotation", () => {
    const { emit, subscription, onBlockReply } = harness({
      provider: "venice",
      breakAt: "message_end",
      chunking: false,
    });
    emitMessageStartAndEndForAssistantText({
      emit,
      text: '{"detail":"Please retry later","status":429}',
    });
    expect(onBlockReply).not.toHaveBeenCalled();
    expect(subscription.getRawErrorReply()).toEqual({ message: "Please retry later", status: 429 });
  });

  it("a refusal whose prefix arrives in a separate delta never leaks the prefix (#159 r4)", () => {
    for (const [head, rest] of [
      ["Error", `: ${CODEX_REFUSAL}`],
      ["429", ` ${CODEX_REFUSAL}`],
      ["<fin", `al>${CODEX_REFUSAL}</final>`],
    ] as const) {
      const { emit, subscription, onBlockReply, onPartialReply } = harness();
      emitAssistantTextDelta({ emit, delta: head });
      expect(onPartialReply, head).not.toHaveBeenCalled();
      expect(onBlockReply, head).not.toHaveBeenCalled();
      for (let i = 0; i < rest.length; i += 17) {
        emitAssistantTextDelta({ emit, delta: rest.slice(i, i + 17) });
      }
      const full = head + rest;
      emitAssistantTextEnd({ emit, content: full });
      emit({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: full }] },
      });
      expect(onBlockReply, head).not.toHaveBeenCalled();
      expect(onPartialReply, head).not.toHaveBeenCalled();
      expect(subscription.getRawErrorReply()?.message, head).toMatch(/not supported/);
    }
  });

  it("an intermediate refusal in a tool loop does not outlive a later normal message (#159 r4)", () => {
    const { emit, subscription, onBlockReply } = harness({
      breakAt: "message_end",
      chunking: false,
    });
    emitMessageStartAndEndForAssistantText({ emit, text: CODEX_REFUSAL });
    expect(subscription.getRawErrorReply()?.message).toMatch(/not supported/);
    emitMessageStartAndEndForAssistantText({ emit, text: "Done — the file was updated." });
    expect(subscription.getRawErrorReply()).toBeUndefined();
    expect(onBlockReply).toHaveBeenCalledTimes(1);
  });

  it("prose still streams chunk by chunk — including prose that starts with Error:", () => {
    const { emit, onBlockReply } = harness();
    emitAssistantTextDelta({
      emit,
      delta: "Error: the file was not found\nSecond line\nThird line\n",
    });
    expect(onBlockReply.mock.calls.length).toBeGreaterThan(0);
  });
});

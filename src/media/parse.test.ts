import { describe, expect, it } from "vitest";
import { splitMediaFromOutput } from "./parse.js";

describe("splitMediaFromOutput", () => {
  it("detects audio_as_voice tag and strips it", () => {
    const result = splitMediaFromOutput("Hello [[audio_as_voice]] world");
    expect(result.audioAsVoice).toBe(true);
    expect(result.text).toBe("Hello world");
  });

  it("accepts absolute media paths", () => {
    const result = splitMediaFromOutput("MEDIA:/Users/pete/My File.png");
    expect(result.mediaUrls).toEqual(["/Users/pete/My File.png"]);
    expect(result.text).toBe("");
  });

  it("accepts quoted absolute media paths", () => {
    const result = splitMediaFromOutput('MEDIA:"/Users/pete/My File.png"');
    expect(result.mediaUrls).toEqual(["/Users/pete/My File.png"]);
    expect(result.text).toBe("");
  });

  it("rejects traversal and home-dir paths and strips them from output", () => {
    const traversalCases = [
      "MEDIA:../../../etc/passwd",
      "MEDIA:../../.env",
      "MEDIA:~/.ssh/id_rsa",
      "MEDIA:~/Pictures/My File.png",
      "MEDIA:./foo/../../../etc/shadow",
    ];
    for (const input of traversalCases) {
      const result = splitMediaFromOutput(input);
      expect(result.mediaUrls, `should reject media: ${input}`).toBeUndefined();
      expect(result.text, `should strip from text: ${input}`).toBe("");
    }
  });

  it("does not accept a bare .. as media", () => {
    // Not recognized as a path at all (no separator), so it stays in the text
    // rather than being stripped -- but it must never become a media URL.
    const result = splitMediaFromOutput("MEDIA:..");
    expect(result.mediaUrls).toBeUndefined();
  });

  it("captures safe relative media paths", () => {
    const result = splitMediaFromOutput("MEDIA:./screenshots/image.png");
    expect(result.mediaUrls).toEqual(["./screenshots/image.png"]);
    expect(result.text).toBe("");
  });

  it("accepts sandbox-relative media paths", () => {
    const result = splitMediaFromOutput("MEDIA:media/inbound/image.png");
    expect(result.mediaUrls).toEqual(["media/inbound/image.png"]);
    expect(result.text).toBe("");
  });

  it("keeps audio_as_voice detection stable across calls", () => {
    const input = "Hello [[audio_as_voice]]";
    const first = splitMediaFromOutput(input);
    const second = splitMediaFromOutput(input);
    expect(first.audioAsVoice).toBe(true);
    expect(second.audioAsVoice).toBe(true);
  });

  it("keeps MEDIA mentions in prose", () => {
    const input = "The MEDIA: tag fails to deliver";
    const result = splitMediaFromOutput(input);
    expect(result.mediaUrls).toBeUndefined();
    expect(result.text).toBe(input);
  });

  it("parses MEDIA tags with leading whitespace", () => {
    const result = splitMediaFromOutput("  MEDIA:./screenshot.png");
    expect(result.mediaUrls).toEqual(["./screenshot.png"]);
    expect(result.text).toBe("");
  });

  it("accepts Windows-style paths", () => {
    const result = splitMediaFromOutput("MEDIA:C:\\Users\\pete\\Pictures\\snap.png");
    expect(result.mediaUrls).toEqual(["C:\\Users\\pete\\Pictures\\snap.png"]);
    expect(result.text).toBe("");
  });

  it("accepts TTS temp file paths", () => {
    const result = splitMediaFromOutput("MEDIA:/tmp/tts-fAJy8C/voice-1770246885083.opus");
    expect(result.mediaUrls).toEqual(["/tmp/tts-fAJy8C/voice-1770246885083.opus"]);
    expect(result.text).toBe("");
  });

  it("accepts bare filenames with extensions", () => {
    const result = splitMediaFromOutput("MEDIA:image.png");
    expect(result.mediaUrls).toEqual(["image.png"]);
    expect(result.text).toBe("");
  });

  it("rejects bare words without file extensions", () => {
    const result = splitMediaFromOutput("MEDIA:screenshot");
    expect(result.mediaUrls).toBeUndefined();
  });
});

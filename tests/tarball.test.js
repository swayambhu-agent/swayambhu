import { describe, it, expect } from "vitest";
import { buildTar, packAndEncode } from "../lib/tarball.js";

describe("buildTar", () => {
  it("produces a valid tar with file data", () => {
    const tar = buildTar([
      { name: "hello.txt", content: "hello world" },
    ]);
    expect(tar).toBeInstanceOf(Uint8Array);
    // Minimum: 512 header + 512 data block (padded) + 1024 end = 2048
    expect(tar.length).toBeGreaterThanOrEqual(2048);
    // First file name should be in the header
    const header = new TextDecoder().decode(tar.slice(0, 100));
    expect(header).toContain("hello.txt");
  });

  it("handles multiple files", () => {
    const tar = buildTar([
      { name: "a.txt", content: "aaa" },
      { name: "b/c.json", content: '{"key":"value"}' },
    ]);
    const text = new TextDecoder().decode(tar.slice(0, 1536));
    expect(text).toContain("a.txt");
    expect(text).toContain("b/c.json");
  });

  it("produces valid tar for empty files array", () => {
    const tar = buildTar([]);
    // Just the end-of-archive marker
    expect(tar.length).toBe(1024);
    // Should be all zeros
    expect(tar.every(b => b === 0)).toBe(true);
  });

  it("includes ustar magic in headers", () => {
    const tar = buildTar([{ name: "test.txt", content: "x" }]);
    // ustar magic at offset 257
    const magic = new TextDecoder().decode(tar.slice(257, 262));
    expect(magic).toBe("ustar");
  });

  it("stores long paths using the ustar prefix field", () => {
    const name = "review_note/userspace_review/x_liveprobe_1775906260280/d1/000/parked-external-block-reopened-without-transition.json";
    const tar = buildTar([{ name, content: '{"ok":true}' }]);
    const basename = new TextDecoder().decode(tar.slice(0, 100)).replace(/\0.*$/, "");
    const prefix = new TextDecoder().decode(tar.slice(345, 500)).replace(/\0.*$/, "");
    expect(`${prefix}/${basename}`).toBe(name);
    expect(basename).toBe("parked-external-block-reopened-without-transition.json");
    expect(prefix).toBe("review_note/userspace_review/x_liveprobe_1775906260280/d1/000");
  });

  it("throws when a path cannot fit in ustar name fields", () => {
    const longBasename = "x".repeat(101);
    expect(() => buildTar([{ name: longBasename, content: "x" }])).toThrow("tar entry path too long");
  });
});

describe("packAndEncode", () => {
  it("produces a base64 string", async () => {
    const b64 = await packAndEncode([
      { name: "data.json", content: '{"test":true}' },
    ]);
    expect(typeof b64).toBe("string");
    // Should be valid base64
    expect(() => atob(b64)).not.toThrow();
    // Should be smaller than raw tar (gzip compression)
    const raw = buildTar([{ name: "data.json", content: '{"test":true}' }]);
    expect(b64.length).toBeLessThan(raw.length * 2); // base64 is ~1.33x, but gzip should compress
  });

  it("handles empty files", async () => {
    const b64 = await packAndEncode([]);
    expect(typeof b64).toBe("string");
    expect(() => atob(b64)).not.toThrow();
  });
});

import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatBytes, guessKind, loadCatalog } from "../src/catalog.js";
import { ensureDemoFiles } from "../src/demo-files.js";

const dir = () => {
  const d = mkdtempSync(join(tmpdir(), "cat-"));
  writeFileSync(join(d, "beat.wav"), "RIFF....");
  return d;
};
const one = (f: Record<string, unknown>) => ({ creator: "Studio", currency: "EUR", files: [{ slug: "beat", title: "Beat", emoji: "🎧", price: 5, file: "beat.wav", preview: "A beat", ...f }] });

describe("paywall.json", () => {
  it("loads the sample with its generated files and hashes them", () => {
    const d = mkdtempSync(join(tmpdir(), "cat-"));
    ensureDemoFiles(d);
    const c = loadCatalog(JSON.parse(readFileSync("paywall.example.json", "utf8")), d);
    expect(c.files.map((f) => [f.slug, f.kind])).toEqual([["night-drive", "beat"], ["film-presets", "presets"], ["zine-1", "pdf"]]);
    expect(c.files[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(c.files[0]?.size).toBeGreaterThan(1000);
  });

  it.each([
    [{ file: "../etc/passwd" }, /plain file name/],
    [{ file: "/etc/passwd" }, /plain file name/],
    [{ file: "sub/beat.wav" }, /plain file name/],
    [{ file: "missing.wav" }, /not found/],
    [{ slug: "Bad Slug" }, /slug/],
    [{ title: "get it at evil.com" }, /title/],
    [{ preview: "<script>" }, /preview/],
    [{ emoji: "x" }, /emoji/],
    [{ price: 0 }, /price/],
    [{ kind: "exe" }, /kind/],
  ])("refuses %j", (f, err) => {
    expect(() => loadCatalog(one(f), dir())).toThrow(err);
  });

  it("refuses a symlink that points outside FILES_DIR", () => {
    const d = dir();
    const outside = mkdtempSync(join(tmpdir(), "out-"));
    writeFileSync(join(outside, "secret.txt"), "nope");
    symlinkSync(join(outside, "secret.txt"), join(d, "link.wav"));
    expect(() => loadCatalog(one({ file: "link.wav" }), d)).toThrow(/inside FILES_DIR/);
    mkdirSync(join(d, "folder"));
    expect(() => loadCatalog(one({ file: "folder" }), d)).toThrow(/regular file/);
  });

  it("guesses kinds and formats sizes", () => {
    expect(["a.wav", "b.pdf", "c.zip", "d.xmp", "e.bin"].map(guessKind)).toEqual(["beat", "pdf", "zip", "presets", "file"]);
    expect([500, 2048, 5 * 1024 ** 2].map(formatBytes)).toEqual(["500 B", "2.0 KB", "5.0 MB"]);
  });

  it("makes real sample files: ZIP, WAV and PDF magic bytes", () => {
    const d = mkdtempSync(join(tmpdir(), "demo-"));
    ensureDemoFiles(d);
    expect(readFileSync(join(d, "film-presets.zip")).subarray(0, 4).toString("hex")).toBe("504b0304");
    expect(readFileSync(join(d, "night-drive-beat.wav")).subarray(0, 4).toString()).toBe("RIFF");
    expect(readFileSync(join(d, "zine-issue-1.pdf")).subarray(0, 5).toString()).toBe("%PDF-");
  });
});

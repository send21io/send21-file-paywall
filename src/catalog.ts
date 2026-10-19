import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, resolve, sep } from "node:path";
import { isFiat, parseTotal } from "./currencies.js";
import { cleanText, isEmoji } from "./sanitize.js";
import type { Catalog, FileItem, FileKind } from "./types.js";

// paywall.json: who sells, in which currency, and the files.
//   { "creator": "...", "currency": "EUR",
//     "files": [{ "slug", "title", "emoji", "price", "file", "preview", "kind"?, "tags"? }] }
// "file" is a plain file name inside FILES_DIR (never a path), checked here once.

const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,99}$/;
const KINDS: Record<FileKind, string> = { zip: "🗜️ ZIP", pdf: "📄 PDF", presets: "🎛️ presets", beat: "🎧 beat", file: "📦 file" };
export const kindLabel = (k: FileKind) => KINDS[k];

export function guessKind(file: string): FileKind {
  const ext = file.toLowerCase().split(".").pop() ?? "";
  if (ext === "pdf") return "pdf";
  if (["wav", "mp3", "flac", "aiff", "ogg"].includes(ext)) return "beat";
  if (["xmp", "lrtemplate", "cube", "fxp", "vstpreset"].includes(ext)) return "presets";
  if (["zip", "7z", "rar"].includes(ext)) return "zip";
  return "file";
}

export function loadCatalog(raw: unknown, filesDir: string): Catalog {
  const fail = (msg: string): never => {
    throw new Error(`paywall.json: ${msg}`);
  };
  const c = (raw ?? {}) as { creator?: unknown; currency?: unknown; files?: unknown };
  const creator = cleanText(c.creator, 40) ?? fail("creator: plain text, max 40");
  const currency = String(c.currency ?? "").toUpperCase();
  if (!isFiat(currency)) fail(`currency "${String(c.currency)}" is not supported`);
  if (!Array.isArray(c.files) || !c.files.length) fail("list at least one file");
  const dir = realpathSync(filesDir);
  const files = (c.files as Record<string, unknown>[]).map((f, i): FileItem => {
    const slug = String(f.slug ?? "");
    if (!SLUG.test(slug)) fail(`file ${i + 1}: slug a-z, 0-9 and dashes, max 40`);
    const title = cleanText(f.title, 60) ?? fail(`${slug}: title plain text, max 60`);
    const emoji = isEmoji(f.emoji) ? f.emoji : fail(`${slug}: emoji must be one emoji`);
    const price = parseTotal(f.price, currency, 10_000);
    if (!price.ok) fail(`${slug}: price ${price.error}`);
    const name = String(f.file ?? "");
    if (!FILE_NAME.test(name) || basename(name) !== name || name.includes("..")) fail(`${slug}: file must be a plain file name inside FILES_DIR`);
    let path: string;
    try {
      path = realpathSync(resolve(dir, name));
    } catch {
      return fail(`${slug}: ${name} not found in ${filesDir}`);
    }
    if (!path.startsWith(dir + sep) || !statSync(path).isFile()) fail(`${slug}: ${name} must be a regular file inside FILES_DIR`);
    const preview = cleanText(f.preview, 160) ?? fail(`${slug}: preview plain text, max 160, no links`);
    const kind = (f.kind !== undefined ? String(f.kind) : guessKind(name)) as FileKind;
    if (!(kind in KINDS)) fail(`${slug}: kind is one of ${Object.keys(KINDS).join(", ")}`);
    const tags = Array.isArray(f.tags) ? f.tags.slice(0, 4).map((t) => cleanText(t, 20) ?? fail(`${slug}: tags plain text, max 20`)) : [];
    const bytes = readFileSync(path);
    return { slug, title, emoji, kind, price: (price as { amount: number }).amount, file: name, preview, tags, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
  if (new Set(files.map((f) => f.slug)).size !== files.length) fail("a slug is listed twice");
  return { creator, currency, files };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

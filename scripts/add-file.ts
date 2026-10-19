// npm run file:add -- <path> --title "Night drive beat" --price 7 [--emoji 🎧] [--slug night-drive] [--preview "..."] [--tags "WAV,92 BPM"]
// Copies the file into FILES_DIR (private, never public/) and adds it to paywall.json.
import "dotenv/config";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { guessKind, loadCatalog } from "../src/catalog.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { title: { type: "string" }, price: { type: "string" }, emoji: { type: "string" }, slug: { type: "string" }, preview: { type: "string" }, tags: { type: "string" }, creator: { type: "string" }, currency: { type: "string" } },
});
const src = positionals[0];
if (!src || !existsSync(src) || !values.title || !values.price) throw new Error('usage: npm run file:add -- <path> --title "..." --price 7');

const filesDir = process.env.FILES_DIR?.trim() || "./files";
const paywallFile = process.env.PAYWALL_FILE?.trim() || "./paywall.json";
mkdirSync(filesDir, { recursive: true, mode: 0o700 });
const name = basename(src).replace(/[^A-Za-z0-9._ -]/g, "_");
const kind = guessKind(name);
const emoji = values.emoji ?? { beat: "🎧", pdf: "📄", presets: "🎛️", zip: "🗜️", file: "📦" }[kind];
const slug = values.slug ?? values.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

const current = existsSync(paywallFile)
  ? (JSON.parse(readFileSync(paywallFile, "utf8")) as { creator: string; currency: string; files: Record<string, unknown>[] })
  : { creator: values.creator ?? "my studio", currency: values.currency ?? "EUR", files: [] };
if (current.files.some((f) => f.slug === slug)) throw new Error(`slug ${slug} already exists`);
copyFileSync(src, join(filesDir, name));
chmodSync(join(filesDir, name), 0o600);
const next = {
  ...current,
  files: [...current.files, { slug, title: values.title, emoji, price: Number(values.price), file: name, preview: values.preview ?? values.title, kind, tags: values.tags ? values.tags.split(",").map((t) => t.trim()) : [] }],
};
loadCatalog(next, filesDir); // same checks as the server: fails before writing
writeFileSync(paywallFile, `${JSON.stringify(next, null, 2)}\n`);
console.log(`✅ ${emoji} ${values.title} → /f/${slug}`);

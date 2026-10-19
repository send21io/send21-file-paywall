import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Mock mode: three tiny sample files, made on the fly, so the paywall has
// something real to sell and download. No binaries in the repo.

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b: Buffer) => {
  let c = 0xffffffff;
  for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** A valid ZIP with stored (uncompressed) entries. */
export function zip(entries: [string, string][]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const data = Buffer.from(text);
    const n = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(n.length, 28);
    cen.writeUInt32LE(offset, 42);
    parts.push(local, n, data);
    central.push(cen, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

/** Two seconds of a soft 220 Hz tone, 8 kHz mono WAV. */
export function wav(seconds = 2): Buffer {
  const rate = 8000;
  const n = rate * seconds;
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * 3000 * Math.min(1, (n - i) / 800)), 44 + i * 2);
  return b;
}

/** A one-page PDF with one line of text. */
export function pdf(text: string): Buffer {
  const stream = `BT /F1 24 Tf 72 720 Td (${text.replace(/[()\\]/g, "")}) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** Write the sample files used by paywall.example.json, if they are not there yet. */
export function ensureDemoFiles(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const files: [string, () => Buffer][] = [
    ["night-drive-beat.wav", () => wav()],
    ["film-presets.zip", () => zip([["README.txt", "12 film-look presets (demo)\n"], ...Array.from({ length: 12 }, (_, i) => [`preset-${String(i + 1).padStart(2, "0")}.xmp`, `<x:xmpmeta><!-- demo preset ${i + 1} --></x:xmpmeta>\n`] as [string, string])])],
    ["zine-issue-1.pdf", () => pdf("Thanks for buying zine #1 (demo)")],
  ];
  for (const [name, make] of files) if (!existsSync(join(dir, name))) writeFileSync(join(dir, name), make(), { mode: 0o600 });
}

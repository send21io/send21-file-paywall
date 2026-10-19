import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPaywall } from "../src/app.js";
import { mintToken } from "../src/tokens.js";
import { confirmedFor, deliver, listen, testConfig, world } from "./helpers.js";

type W = Awaited<ReturnType<typeof world>>;
const paidPurchase = async (w: W, slug = "night-drive") => {
  const b = await w.buy(slug);
  await deliver(w.url, confirmedFor(b.purchase()));
  return b;
};
const tokenUrl = async (w: W, page: string) => {
  const r = await w.post(`${page}/download`);
  expect(r.status).toBe(303);
  return new URL(r.headers.get("location")!, w.url).pathname;
};

describe("⬇️ downloads: short-lived, single-use, signed", () => {
  it("only after ✅ paid: the purchase page unlocks and the bytes match the file", async () => {
    const w = await world();
    const b = await w.buy();
    expect((await w.post(`${b.page}/download`)).status).toBe(403);
    await deliver(w.url, confirmedFor(b.purchase()));
    const html = await (await w.get(b.page)).text();
    expect(html).toContain("⬇️ Download night-drive-beat.wav");
    expect(html).toContain("5 left");
    const dl = await tokenUrl(w, b.page);
    expect(dl).toMatch(/^\/dl\/dl1\./);
    const r = await w.get(dl);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-disposition")).toContain('attachment; filename="night-drive-beat.wav"');
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(Buffer.from(await r.arrayBuffer()).equals(readFileSync(join(w.cfg.filesDir, "night-drive-beat.wav")))).toBe(true);
    expect(b.purchase().downloads).toBe(1);
    await w.close();
  });

  it("works once: the second use is 🔁 410", async () => {
    const w = await world();
    const b = await paidPurchase(w);
    const dl = await tokenUrl(w, b.page);
    expect((await w.get(dl)).status).toBe(200);
    const again = await w.get(dl);
    expect(again.status).toBe(410);
    expect(await again.text()).toContain("This link was already used");
    await w.close();
  });

  it("expires: ⌛ 410 after DOWNLOAD_TTL_SECONDS", async () => {
    const w = await world();
    const b = await paidPurchase(w);
    const dl = await tokenUrl(w, b.page);
    w.clock.now += 301_000;
    const r = await w.get(dl);
    expect(r.status).toBe(410);
    expect(await r.text()).toContain("This download link expired");
    await w.close();
  });

  it("a forged, edited or other-purchase token gets 🤷 404", async () => {
    const w = await world();
    const a = await paidPurchase(w);
    const b = await paidPurchase(w);
    const dl = await tokenUrl(w, a.page);
    const swapped = dl.replace(`dl1.${a.id}.`, `dl1.${b.id}.`);
    expect((await w.get(swapped)).status).toBe(404);
    expect((await w.get(dl.replace(/\.\d{10}\./, (m) => `.${Number(m.slice(1, -1)) + 999}.`))).status).toBe(404);
    // Correctly signed, but with a secret that is not this server's.
    const forged = mintToken("x".repeat(40), { purchaseId: a.id, slug: "night-drive", sha256: w.paywall.file("night-drive")!.sha256 }, 300).token;
    expect((await w.get(`/dl/${forged}`)).status).toBe(404);
    // Correctly signed with the right secret, but never issued (no jti in the store).
    const unissued = mintToken(w.cfg.downloadSecret, { purchaseId: a.id, slug: "night-drive", sha256: w.paywall.file("night-drive")!.sha256 }, 300).token;
    expect((await w.get(`/dl/${unissued}`)).status).toBe(404);
    expect((await w.get("/dl/../../files/night-drive-beat.wav")).status).toBe(404);
    expect((await w.get(dl)).status).toBe(200); // the real one still works
    await w.close();
  });

  it("the file is never reachable as a static path", async () => {
    const w = await world();
    for (const p of ["/night-drive-beat.wav", "/files/night-drive-beat.wav", "/public/../files/night-drive-beat.wav", "/paywall.example.json"]) expect((await w.get(p)).status).toBe(404);
    await w.close();
  });

  it("limits tokens per purchase", async () => {
    const w = await world({ DOWNLOAD_LIMIT: "2" });
    const b = await paidPurchase(w);
    await tokenUrl(w, b.page);
    await tokenUrl(w, b.page);
    const r = await w.post(`${b.page}/download`);
    expect(r.status).toBe(429);
    expect(await r.text()).toContain("download limit reached");
    await w.close();
  });

  it("a replaced file voids old tokens (bound to its sha256)", async () => {
    const cfg = testConfig();
    const w1 = buildPaywall(cfg);
    const s1 = await listen(w1.app);
    w1.mockPay!.selfUrl = s1.url;
    const r = await fetch(`${s1.url}/f/zine-1/buy`, { method: "POST", redirect: "manual" });
    const page = r.headers.get("location")!;
    const id = page.split("/")[2]!;
    await deliver(s1.url, confirmedFor(w1.store.get(id)!));
    const t = w1.paywall.issueToken(id);
    expect(t.ok).toBe(true);
    await s1.close();
    writeFileSync(join(cfg.filesDir, "zine-issue-1.pdf"), "%PDF-1.4 new edition");
    const w2 = buildPaywall({ ...testConfig({ FILES_DIR: cfg.filesDir }), downloadSecret: cfg.downloadSecret }, { store: w1.store });
    expect(w2.paywall.redeem((t as { token: string }).token)).toMatchObject({ ok: false, error: "invalid" });
  });
});

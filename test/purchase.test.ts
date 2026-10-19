import { describe, expect, it, vi } from "vitest";
import { Send21Error } from "../src/send21.js";
import { world } from "./helpers.js";

describe("🔓 unlock: ONE fiat pay link per purchase", () => {
  it("shows the 🔒 card with price and coins", async () => {
    const w = await world();
    const html = await (await w.get("/f/night-drive")).text();
    expect(html).toContain("Night drive beat");
    expect(html).toContain("€7.00");
    expect(html).toContain("🔒");
    expect(html).toContain("⚡ BTC · Lightning");
    expect(html).toContain("🔵 USDC · Solana");
    expect((await w.get("/f/nope")).status).toBe(404);
    await w.close();
  });

  it("creates the link with the documented fields, orderId file-<id> = Idempotency-Key", async () => {
    const w = await world();
    const spy = vi.spyOn(w.mockSend21!, "createPaymentRequest");
    const { page, purchase } = await w.buy();
    const p = purchase();
    expect(page).toMatch(/^\/p\/[a-z0-9]{12}\/[A-Za-z0-9_-]{43}$/);
    expect(p.orderId).toBe(`file-${p.id}`);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]).toEqual([
      {
        fiatCurrency: "EUR",
        fiatAmount: 7,
        orderId: p.orderId,
        memo: "🔒 Night drive beat · Night Owl Studio",
        options: w.cfg.options,
        expiryHours: 1,
        declineNote: "No download. Start a new purchase whenever you like.",
        reuseOpenForOrder: true,
      },
      p.orderId,
    ]);
    expect(p.receiptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(p)).not.toContain(page.split("/")[3]!); // the receipt key itself is never stored
    await w.close();
  });

  it("the purchase page shows 💳 Pay + QR and needs the right receipt key", async () => {
    const w = await world();
    const { page, purchase } = await w.buy();
    const html = await (await w.get(page)).text();
    expect(html).toContain(`href="${purchase().payUrl}"`);
    expect(html).toContain('target="_blank" rel="noopener noreferrer"');
    expect(html).toContain("data:image/svg+xml;base64,");
    expect(html).toContain('data-status="open"');
    expect((await w.get(page.slice(0, -1) + (page.endsWith("A") ? "B" : "A"))).status).toBe(404);
    expect((await w.get(page.replace(/\/p\/[a-z0-9]{12}/, "/p/aaaaaaaaaaaa"))).status).toBe(404);
    expect(await (await w.get(`${page}/status`)).json()).toEqual({ status: "open" });
    expect((await w.get(page)).headers.get("cache-control")).toBe("no-store");
    await w.close();
  });

  it("send21 refuses: a plain error, nothing kept", async () => {
    const w = await world();
    vi.spyOn(w.mockSend21!, "createPaymentRequest").mockRejectedValue(new Send21Error("bad", 402));
    const r = await w.post("/f/night-drive/buy");
    expect(r.status).toBe(502);
    expect(await r.text()).toContain("fees to settle first");
    expect(w.store.purchases()).toHaveLength(0);
    await w.close();
  });

  it("rate-limits unlocks per IP", async () => {
    const w = await world();
    const codes = [];
    for (let i = 0; i < 11; i++) codes.push((await w.post("/f/zine-1/buy")).status);
    expect(codes.slice(0, 10).every((c) => c === 303)).toBe(true);
    expect(codes[10]).toBe(429);
    await w.close();
  });

  it("marks forgotten open links expired", async () => {
    const w = await world();
    const { purchase } = await w.buy();
    w.clock.now += 2 * 3600_000;
    expect(w.sweep().map((p) => p.status)).toEqual(["expired"]);
    expect(purchase().status).toBe("expired");
    await w.close();
  });
});

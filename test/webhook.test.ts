import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { checkPaymentAgainstPurchase } from "../src/paywall.js";
import { Store } from "../src/store.js";
import { confirmedFor, deliver, world } from "./helpers.js";

type W = Awaited<ReturnType<typeof world>>;
const ev = (event: string, p: Parameters<typeof confirmedFor>[0], data: Record<string, unknown> = {}) => ({ event, data: { ...confirmedFor(p).data, status: "Seen", ...data } });
const bought = async (w: W) => (await w.buy()).purchase();

describe("send21 webhook: verify, dedupe, then apply", () => {
  it("401 for a bad or stale signature, 400 for bad JSON, nothing stored", async () => {
    const w = await world();
    const p = await bought(w);
    expect((await deliver(w.url, confirmedFor(p), { secret: "wrong" })).status).toBe(401);
    expect((await deliver(w.url, confirmedFor(p), { t: Math.floor(Date.now() / 1000) - 301 })).status).toBe(401);
    expect((await deliver(w.url, confirmedFor(p), { t: Math.floor(Date.now() / 1000) + 301 })).status).toBe(401);
    expect((await deliver(w.url, null, { raw: "{nope" })).status).toBe(400);
    expect(w.store.get(p.id)?.status).toBe("open");
    await w.close();
  });

  it("✅ paid once; the same delivery or the same body under a new id is a duplicate", async () => {
    const w = await world();
    const p = await bought(w);
    const raw = JSON.stringify(confirmedFor(p));
    const id = crypto.randomUUID();
    expect(await (await deliver(w.url, null, { raw, deliveryId: id })).json()).toEqual({ ok: true, outcome: "paid" });
    expect(await (await deliver(w.url, null, { raw, deliveryId: id })).json()).toEqual({ ok: true, duplicate: true });
    expect(await (await deliver(w.url, null, { raw })).json()).toEqual({ ok: true, duplicate: true });
    expect(await (await deliver(w.url, confirmedFor(p))).json()).toEqual({ ok: true, outcome: "already_paid" });
    await w.close();
  });

  it("remembers deliveries across a restart (file store)", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "pw-")), "d.json");
    const a = await world({ DATA_FILE: file });
    const p = await bought(a);
    const raw = JSON.stringify(confirmedFor(p));
    const id = crypto.randomUUID();
    await deliver(a.url, null, { raw, deliveryId: id });
    await a.close();
    const b = await world({ DATA_FILE: file, FILES_DIR: a.cfg.filesDir });
    expect(b.store.get(p.id)?.status).toBe("paid");
    expect(await (await deliver(b.url, null, { raw, deliveryId: id })).json()).toEqual({ ok: true, duplicate: true });
    await b.close();
  });

  it("500 when the store cannot write: nothing half-applied, the retry works", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "pw-")), "d.json");
    const w = await world({ DATA_FILE: file });
    const p = await bought(w);
    const raw = JSON.stringify(confirmedFor(p));
    const id = crypto.randomUUID();
    const spy = vi.spyOn(w.store as unknown as { persist: () => void }, "persist").mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    expect((await deliver(w.url, null, { raw, deliveryId: id })).status).toBe(500);
    expect(w.store.get(p.id)?.status).toBe("open");
    spy.mockRestore();
    expect(await (await deliver(w.url, null, { raw, deliveryId: id })).json()).toEqual({ ok: true, outcome: "paid" });
    await w.close();
  });

  it("ignores other integrations' orderIds and test events", async () => {
    const w = await world();
    const p = await bought(w);
    expect(await (await deliver(w.url, confirmedFor(p, { orderId: "tg-abcdefghij" }))).json()).toEqual({ ok: true, outcome: "unknown_purchase" });
    expect(await (await deliver(w.url, confirmedFor(p, { orderId: "file-zzzzzzzzzzzz" }))).json()).toEqual({ ok: true, outcome: "unknown_purchase" });
    expect(await (await deliver(w.url, { event: "test", data: {} })).json()).toEqual({ ok: true, outcome: "test" });
    expect(await (await deliver(w.url, ev("draft.created", p))).json()).toEqual({ ok: true, outcome: "ignored" });
    await w.close();
  });
});

describe("exact amount, asset and orderId, or no download", () => {
  it.each([
    [{ fiatAmount: 6.99 }, /amount/],
    [{ fiatCurrency: "USD" }, /fiat/],
    [{ sentCurrency: "USDT", network: "Solana" }, /not offered/],
    [{ sentCurrency: "USDC", network: "Base" }, /not offered/],
    [{ status: "Seen" }, /status/],
    [{ txId: "" }, /txId/],
    [{ amountSats: 0 }, /amountSats/],
  ])("%j → 🚩 flagged for the seller, download stays locked", async (over, why) => {
    const w = await world();
    const { page, purchase } = await w.buy();
    expect(checkPaymentAgainstPurchase(confirmedFor(purchase(), over).data, purchase()).join()).toMatch(why);
    expect(await (await deliver(w.url, confirmedFor(purchase(), over))).json()).toEqual({ ok: true, outcome: "flagged" });
    expect((await w.post(`${page}/download`)).status).toBe(403);
    expect(await (await w.get(page)).text()).toContain("the seller is reviewing this payment");
    await w.close();
  });

  it("a different pay link id is not this purchase at all", async () => {
    const w = await world();
    const p = await bought(w);
    expect(await (await deliver(w.url, confirmedFor(p, { paymentRequestId: "pr-other" }))).json()).toEqual({ ok: true, outcome: "unknown_purchase" });
    await w.close();
  });

  it("Lightning counts as BTC on Mainnet, coin names match case-insensitively", async () => {
    const w = await world();
    const p = await bought(w);
    expect(checkPaymentAgainstPurchase(confirmedFor(p, { sentCurrency: "BTC", network: "Mainnet", amountSats: 11_000 }).data, p)).toEqual([]);
    await w.close();
  });
});

describe("state machine", () => {
  const run = async (events: [string, Record<string, unknown>?][]) => {
    const w = await world();
    const p = await bought(w);
    const outcomes: string[] = [];
    for (const [e, data] of events) outcomes.push((await (await deliver(w.url, e === "draft.confirmed" ? confirmedFor(p, data) : ev(e, p, data))).json()).outcome);
    return { w, p, outcomes, status: w.store.get(p.id)!.status };
  };
  it("👀 seen → ✅ paid", async () => {
    const r = await run([["draft.seen"], ["draft.confirmed"]]);
    expect(r.outcomes).toEqual(["seen", "paid"]);
    await r.w.close();
  });
  it("⚠️ different amount → 👍 accepted → ✅ paid (marked as different)", async () => {
    const r = await run([["draft.amount_mismatch", { receivedAmountSats: 6_650_000 }], ["draft.mismatch_accepted"], ["draft.confirmed", { receivedAmountSats: 6_650_000 }]]);
    expect(r.outcomes).toEqual(["review", "accepted", "paid"]);
    expect(r.w.store.get(r.p.id)?.paid?.differentAmount).toBe(true);
    await r.w.close();
  });
  it("⚠️ different amount → ↩️ declined: no download", async () => {
    const r = await run([["draft.amount_mismatch"], ["draft.mismatch_rejected"]]);
    expect(r.outcomes).toEqual(["review", "declined"]);
    await r.w.close();
  });
  it("expired undecided with money in → 🚩 unresolved for the seller", async () => {
    const r = await run([["draft.amount_mismatch"], ["draft.expired", { reviewState: "unresolved" }]]);
    expect(r.outcomes).toEqual(["review", "unresolved"]);
    await r.w.close();
  });
  it("⌛ expired, then a late exact payment still unlocks (marked late)", async () => {
    const r = await run([["payment_request.expired"], ["draft.confirmed"]]);
    expect(r.outcomes).toEqual(["expired", "paid"]);
    expect(r.w.store.get(r.p.id)?.paid?.late).toBe(true);
    await r.w.close();
  });
  it("paid is final", async () => {
    const r = await run([["draft.confirmed"], ["draft.mismatch_rejected"], ["draft.expired"], ["payment_request.expired"]]);
    expect(r.outcomes).toEqual(["paid", "unchanged", "unchanged", "unchanged"]);
    await r.w.close();
  });
});

describe("Store.remember", () => {
  it("drops entries older than 30 days", () => {
    const d = { version: 1 as const, purchases: {}, deliveries: { old: 0 }, events: { k0: 0 } };
    expect(Store.remember(d, "new", "k", 31 * 24 * 3600_000)).toBe(true);
    expect(Object.keys(d.deliveries)).toEqual(["new"]);
    expect(Store.remember(d, "x", "k", 31 * 24 * 3600_000)).toBe(false);
  });
});

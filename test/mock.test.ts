import { describe, expect, it } from "vitest";
import { world } from "./helpers.js";

async function setup() {
  const w = await world();
  const { page, purchase } = await w.buy();
  const token = /\/mock\/pay\/([^/?#]+)/.exec(purchase().payUrl!)![1]!;
  const act = (a: string) => w.post(`/mock/pay/${token}/${a}`, { coin: "1" });
  return { w, page, purchase, token, act };
}

describe("🧪 mock pay page", () => {
  it("one coin picker and every action", async () => {
    const { w, token } = await setup();
    const html = await (await w.get(`/mock/pay/${token}`)).text();
    expect(html.match(/<select/g)).toHaveLength(1);
    for (const a of ["paid", "seen", "short", "accept", "decline", "wrong", "expire"]) expect(html).toContain(`/mock/pay/${token}/${a}`);
    await w.close();
  });

  it("⚠️ short → 👍 accept unlocks, short → ↩️ decline does not", async () => {
    const one = await setup();
    await one.act("short");
    expect(one.purchase().status).toBe("review");
    const r = await one.act("accept");
    expect(await r.text()).toContain("draft.mismatch_accepted → draft.confirmed");
    expect(one.purchase().status).toBe("paid");
    await one.w.close();

    const two = await setup();
    await two.act("short");
    await two.act("decline");
    expect(two.purchase().status).toBe("declined");
    await two.w.close();
  });

  it("an unknown action is a 404, not an expiry", async () => {
    const { w, act, purchase } = await setup();
    expect((await act("nope")).status).toBe(404);
    expect(purchase().status).toBe("open");
    await w.close();
  });
});

describe("pages", () => {
  it("token errors offer a way back, pages have no favicon 404", async () => {
    const w = await world();
    const html = await (await w.get("/dl/nope")).text();
    expect(html).toContain('href="/"');
    expect(html).toContain('rel="icon"');
    await w.close();
  });
});

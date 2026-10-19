import { describe, expect, it } from "vitest";
import { confirmedFor, deliver, SELLER, world } from "./helpers.js";

type W = Awaited<ReturnType<typeof world>>;
const login = async (w: W) => {
  const r = await w.post("/seller/login", { token: SELLER });
  expect(r.status).toBe(303);
  return r.headers.get("set-cookie")!.split(";")[0]!;
};

describe("🔐 seller view", () => {
  it("needs the token; the session cookie is HttpOnly, SameSite=Strict, /seller only", async () => {
    const w = await world();
    expect(await (await w.get("/seller")).text()).toContain('name="token"');
    expect((await w.post("/seller/login", { token: "wrong" })).status).toBe(401);
    const r = await w.post("/seller/login", { token: SELLER });
    const set = r.headers.get("set-cookie")!;
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/SameSite=Strict/);
    expect(set).toMatch(/Path=\/seller/);
    const cookie = set.split(";")[0]!;
    expect(await (await w.get("/seller", { headers: { cookie } })).text()).toContain("🧾 Purchases");
    expect(await (await w.get("/seller", { headers: { cookie: cookie.replace(/.$/, (c) => (c === "A" ? "B" : "A")) } })).text()).toContain('name="token"');
    await w.close();
  });

  it("lists sales and 🚩 purchases to review; 🔓 grant unlocks a flagged one", async () => {
    const w = await world();
    const ok = await w.buy();
    await deliver(w.url, confirmedFor(ok.purchase()));
    const bad = await w.buy("zine-1");
    await deliver(w.url, confirmedFor(bad.purchase(), { fiatAmount: 3 }));
    const cookie = await login(w);
    const html = await (await w.get("/seller", { headers: { cookie } })).text();
    expect(html).toContain("€7.00</b><span>💰 paid");
    expect(html).toContain("🚩 Review");
    expect(html).toContain("amount 3 != 4");
    expect((await w.post(`${bad.page}/download`)).status).toBe(403);
    // Cross-site POSTs are refused even with the cookie.
    expect((await w.post(`/seller/grant/${bad.id}`, {}, { cookie, origin: "https://evil.example" })).status).toBe(403);
    expect((await w.post(`/seller/grant/${bad.id}`, {}, { cookie, "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await w.post(`/seller/grant/${bad.id}`)).status).toBe(403);
    expect((await w.post(`/seller/grant/${bad.id}`, {}, { cookie })).status).toBe(303);
    expect(bad.purchase().status).toBe("granted");
    expect((await w.post(`${bad.page}/download`)).status).toBe(303);
    expect((await w.post(`/seller/grant/${ok.id}`, {}, { cookie })).status).toBe(409); // paid ones need no grant
    await w.close();
  });

  it("mock mode: one-click /seller/demo", async () => {
    const w = await world();
    const r = await w.get("/seller/demo");
    expect(r.status).toBe(303);
    expect(r.headers.get("set-cookie")).toMatch(/s21_seller=/);
    await w.close();
  });
});

describe("🧪 mock pay page → signed webhook", () => {
  const act = async (w: W, page: string, action: string) => {
    const html = await (await w.get(page)).text();
    const pay = new URL(/href="([^"]*\/mock\/pay\/[^"]+)"/.exec(html)![1]!).pathname;
    expect(await (await w.get(pay)).text()).toContain("🧪 mock send21");
    const r = await w.post(`${pay}/${action}`, { coin: "1" });
    expect(await r.text()).toContain("📨 sent");
  };
  it("✅ pay unlocks", async () => {
    const w = await world();
    const b = await w.buy();
    await act(w, b.page, "paid");
    expect(b.purchase().status).toBe("paid");
    await w.close();
  });
  it("🚩 a wrong coin is flagged, ⚠️ short goes to review, ⌛ expire expires", async () => {
    const w = await world();
    const [a, b, c] = [await w.buy(), await w.buy(), await w.buy()];
    await act(w, a.page, "wrong");
    await act(w, b.page, "short");
    await act(w, c.page, "expire");
    expect([a, b, c].map((x) => x.purchase().status)).toEqual(["flagged", "review", "expired"]);
    expect(await (await w.get(c.page)).text()).toContain("🔁 Start again");
    await w.close();
  });
  it("sets strict security headers", async () => {
    const w = await world();
    const r = await w.get("/f/night-drive");
    expect(r.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(r.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await (await w.get("/healthz")).json()).toEqual({ ok: true, send21: "mock" });
    await w.close();
  });
});

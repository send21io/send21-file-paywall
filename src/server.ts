import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express, type Request, type Response } from "express";
import QRCode from "qrcode";
import type { Paywall } from "./paywall.js";
import { errorPage, filePage, indexPage, mockPayPage, purchasePage, sellerLogin, sellerPage, tokenErrorPage } from "./pages.js";
import { friendlyError, type createMockClient } from "./send21.js";
import { Store } from "./store.js";
import { receiptOk } from "./tokens.js";
import { signV2, verifySignatureV2 } from "./verify.js";

export interface AppDeps {
  paywall: Paywall;
  /** The send21 webhook signing secret. */
  secret: string;
  filesDir: string;
  sellerToken: string;
  publicUrl: string;
  log?: (line: string) => void;
  /** Mock send21: /mock/pay/<token> simulates payments with signed deliveries. */
  mockSend21?: { client: ReturnType<typeof createMockClient>; selfUrl: string };
  trustProxy?: boolean;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(HERE, HERE.includes(`${sep}dist${sep}`) ? "../../public" : "../public");
const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const PURCHASE = /^[a-z0-9]{12}$/;

/** Token bucket per IP and route: `burst` requests, refilled at one per `everyMs`. */
export function rateLimit(burst: number, everyMs: number, mock: boolean) {
  const buckets = new Map<string, { tokens: number; at: number }>();
  return (req: Request, res: Response, next: () => void) => {
    const key = req.ip ?? "?";
    const now = Date.now();
    const b = buckets.get(key) ?? { tokens: burst, at: now };
    b.tokens = Math.min(burst, b.tokens + (now - b.at) / everyMs);
    b.at = now;
    if (b.tokens < 1) {
      res.set("Retry-After", String(Math.ceil(everyMs / 1000))).status(429).type("html").send(errorPage("🐢 slow down, try again in a minute", mock));
      return;
    }
    b.tokens -= 1;
    buckets.set(key, b);
    if (buckets.size > 10_000) buckets.clear();
    next();
  };
}

export function createApp(deps: AppDeps): Express {
  const { paywall, secret, filesDir, sellerToken, publicUrl, log = console.log, mockSend21, trustProxy = false } = deps;
  const mock = !!mockSend21;
  const { catalog, store } = paywall;
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", trustProxy);
  app.use((_req, res, next) => {
    res.set({ "Content-Security-Policy": CSP, "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY" });
    next();
  });
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, send21: mock ? "mock" : "live" });
  });

  // ---------- send21 webhook: raw bytes, the signature covers the exact body ----------
  app.post("/webhooks/send21", express.raw({ type: () => true, limit: "64kb" }), (req, res) => {
    const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const deliveryId = req.get("x-send21-delivery");
    // 1. Signature V2 + 300 s window. Nothing is stored for a request that fails.
    if (!verifySignatureV2(raw, req.get("x-send21-signature-v2"), deliveryId, secret)) {
      res.status(401).json({ error: "invalid signature" });
      return;
    }
    let body: { event?: unknown; data?: unknown };
    try {
      body = JSON.parse(raw.toString("utf8"));
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("not an object");
    } catch {
      res.status(400).json({ error: "invalid json" });
      return;
    }
    // 2 + 3. Dedupe (delivery id + body hash) and apply the change in ONE write.
    const eventKey = createHash("sha256").update(raw).digest("hex");
    let applied: ReturnType<Paywall["applyEvent"]> | null;
    try {
      applied = store.transaction((d) => (Store.remember(d, deliveryId as string, eventKey) ? paywall.applyEvent(d, body) : null));
    } catch (err) {
      log(`webhook: store write failed, send21 will retry: ${(err as Error).message}`);
      res.status(500).json({ error: "try again" });
      return;
    }
    if (applied === null) {
      res.status(200).json({ ok: true, duplicate: true });
      return;
    }
    log(`webhook ${String(body.event)} ${deliveryId}: ${applied.outcome}`);
    res.status(200).json({ ok: true, outcome: applied.outcome });
  });

  // ---------- buyer pages ----------
  const noStore = (res: Response) => res.set("Cache-Control", "no-store");
  app.get("/", (_req, res) => {
    res.type("html").send(indexPage(catalog, mock));
  });
  app.get("/f/:slug", (req, res) => {
    const f = paywall.file(String(req.params.slug));
    if (!f) {
      res.status(404).type("html").send(errorPage("🤷 not for sale", mock));
      return;
    }
    res.type("html").send(filePage(catalog, f, paywall.cfg.options, mock));
  });
  app.post("/f/:slug/buy", rateLimit(10, 60_000, mock), async (req, res) => {
    const f = paywall.file(String(req.params.slug));
    if (!f) {
      res.status(404).type("html").send(errorPage("🤷 not for sale", mock));
      return;
    }
    try {
      const r = await paywall.buy(f.slug);
      if (!r.ok) {
        res.status(r.status ?? 400).type("html").send(errorPage(r.error, mock));
        return;
      }
      // The receipt key lives only in this URL (and the buyer's bookmark).
      res.redirect(303, `/p/${r.purchase.id}/${r.receipt}`);
    } catch (err) {
      log(`pay link failed: ${(err as Error).message}`);
      res.status(502).type("html").send(filePage(catalog, f, paywall.cfg.options, mock, friendlyError(err)));
    }
  });

  /** The purchase for /p/:id/:receipt, or a 404 that says nothing about which part was wrong. */
  const purchaseOf = (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    const p = PURCHASE.test(id) ? store.get(id) : undefined;
    if (!p || !receiptOk(String(req.params.receipt ?? ""), p.receiptHash)) {
      noStore(res).status(404).type("html").send(errorPage("🤷 unknown purchase", mock));
      return null;
    }
    return p;
  };

  const renderPurchase = async (req: Request, res: Response, error?: string, status = 200) => {
    const p = purchaseOf(req, res);
    if (!p) return;
    const f = paywall.file(p.slug)!;
    const payHref = p.payUrl;
    const qr = payHref && ["open", "seen"].includes(p.status) ? `data:image/svg+xml;base64,${Buffer.from(await QRCode.toString(payHref, { type: "svg", margin: 1, color: { dark: "#121317", light: "#ffffff" } })).toString("base64")}` : null;
    noStore(res)
      .status(status)
      .type("html")
      .send(purchasePage(catalog, f, p, { base: `/p/${p.id}/${String(req.params.receipt)}`, qr, mock, payHref, left: Math.max(0, paywall.cfg.downloadLimit - Object.keys(p.tokens).length), ttlSeconds: paywall.cfg.downloadTtlSeconds, ...(error ? { error } : {}) }));
  };
  app.get("/p/:id/:receipt", (req, res) => renderPurchase(req, res));
  app.get("/p/:id/:receipt/status", (req, res) => {
    const p = purchaseOf(req, res);
    if (p) noStore(res).json({ status: p.status });
  });
  // ⬇️ POST only: a token never sits in a page, so link previews cannot burn it.
  app.post("/p/:id/:receipt/download", rateLimit(20, 60_000, mock), async (req, res) => {
    const p = purchaseOf(req, res);
    if (!p) return;
    const t = paywall.issueToken(p.id);
    if (!t.ok) {
      await renderPurchase(req, res, t.error, t.status ?? 400);
      return;
    }
    noStore(res).redirect(303, `/dl/${t.token}`);
  });

  // ---------- the file itself: only here, only with a valid, unused token ----------
  app.get("/dl/:token", (req, res) => {
    noStore(res);
    const r = paywall.redeem(String(req.params.token));
    if (!r.ok) {
      const kind = r.error as "invalid" | "expired" | "used" | "locked";
      res.status(r.status ?? 404).type("html").send(tokenErrorPage(kind, mock));
      return;
    }
    const path = resolve(filesDir, r.item.file);
    log(`download ${r.purchase.orderId} ${r.item.file}`);
    res.set({
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${r.item.file.replace(/[^A-Za-z0-9._-]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(r.item.file)}`,
      "Content-Length": String(r.item.size),
    });
    createReadStream(path)
      .on("error", (err) => {
        log(`download failed: ${err.message}`);
        res.destroy();
      })
      .pipe(res);
  });

  // ---------- seller ----------
  mountSeller(app, { paywall, sellerToken, publicUrl, mock });

  if (mockSend21) mountMockPay(app, secret, mockSend21);
  app.use(express.static(PUBLIC_DIR, { index: false }));
  return app;
}

// ---------- seller view: one token, a signed session cookie ----------

const COOKIE = "s21_seller";
const SESSION_MS = 12 * 3600_000;

function mountSeller(app: Express, o: { paywall: Paywall; sellerToken: string; publicUrl: string; mock: boolean }): void {
  const { paywall, sellerToken, publicUrl, mock } = o;
  const key = createHmac("sha256", sellerToken).update("seller-session").digest();
  const session = (exp: number) => `${exp}.${createHmac("sha256", key).update(String(exp)).digest("base64url")}`;
  const secure = publicUrl.startsWith("https://");
  const setSession = (res: Response) =>
    res.cookie(COOKIE, session(Date.now() + SESSION_MS), { httpOnly: true, sameSite: "strict", secure, path: "/seller", maxAge: SESSION_MS });
  const authed = (req: Request) => {
    const raw = /(?:^|;\s*)s21_seller=([^;]+)/.exec(req.get("cookie") ?? "")?.[1] ?? "";
    const [exp] = raw.split(".");
    if (!exp || !/^\d{13}$/.test(exp) || Number(exp) < Date.now()) return false;
    const a = Buffer.from(raw);
    const b = Buffer.from(session(Number(exp)));
    return a.length === b.length && timingSafeEqual(a, b);
  };
  /** Seller POSTs must come from this site (SameSite=Strict + Origin/Fetch metadata). */
  const sameSite = (req: Request) => {
    const site = req.get("sec-fetch-site");
    if (site && site !== "same-origin" && site !== "none") return false;
    const origin = req.get("origin");
    return !origin || origin === new URL(publicUrl).origin || origin === `${req.protocol}://${req.get("host")}`;
  };
  const tokenOk = (t: unknown) => {
    const a = createHmac("sha256", key).update(String(t ?? "")).digest();
    const b = createHmac("sha256", key).update(sellerToken).digest();
    return timingSafeEqual(a, b);
  };
  const form = express.urlencoded({ extended: false, limit: "1kb" });

  app.get("/seller", (req, res) => {
    res.set("Cache-Control", "no-store").type("html").send(authed(req) ? sellerPage(paywall.catalog, paywall.store.purchases(), mock) : sellerLogin(mock));
  });
  app.post("/seller/login", rateLimit(5, 60_000, mock), form, (req, res) => {
    if (!sameSite(req) || !tokenOk((req.body as { token?: unknown })?.token)) {
      res.status(401).type("html").send(sellerLogin(mock, "🙅 wrong token"));
      return;
    }
    setSession(res).redirect(303, "/seller");
  });
  if (mock) {
    // Mock only: one click into the seller view (the token is random per start).
    app.get("/seller/demo", (_req, res) => {
      setSession(res).redirect(303, "/seller");
    });
  }
  app.post("/seller/grant/:id", form, (req, res) => {
    if (!authed(req) || !sameSite(req)) {
      res.status(403).type("html").send(sellerLogin(mock, "🔐 log in again"));
      return;
    }
    const r = paywall.grant(String(req.params.id));
    if (!r.ok) {
      res.status(r.status ?? 400).type("html").send(errorPage(r.error, mock));
      return;
    }
    res.redirect(303, "/seller");
  });
}

// ---------- mock send21: a tiny local "pay page" that sends signed deliveries ----------

function mountMockPay(app: Express, secret: string, mock: NonNullable<AppDeps["mockSend21"]>): void {
  const { client } = mock;
  app.get("/mock/pay/:token", (req, res) => {
    const entry = client.requests.get(String(req.params.token));
    if (!entry) {
      res.status(404).type("html").send(errorPage("🤷 unknown pay link", true));
      return;
    }
    res.type("html").send(mockPayPage(entry.body, String(req.params.token)));
  });

  app.post("/mock/pay/:token/:action", express.urlencoded({ extended: false, limit: "1kb" }), async (req, res) => {
    const entry = client.requests.get(String(req.params.token));
    if (!entry) {
      res.status(404).type("html").send(errorPage("🤷 unknown pay link", true));
      return;
    }
    const body = mockEvent(entry, Number((req.body as { coin?: string })?.coin ?? 0), String(req.params.action));
    const raw = JSON.stringify(body);
    const deliveryId = randomUUID();
    const r = await fetch(`${mock.selfUrl}/webhooks/send21`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-send21-event": body.event, "x-send21-delivery": deliveryId, "x-send21-signature-v2": signV2(raw, deliveryId, Math.floor(Date.now() / 1000), secret) },
      body: raw,
    });
    res.type("html").send(mockPayPage(entry.body, String(req.params.token)).replace("<p class=\"small\">↩️", `<p class="pill">${r.ok ? "📨 sent" : "❌"} ${body.event}</p><p class="small">↩️`));
  });
}

type MockEntry = NonNullable<ReturnType<ReturnType<typeof createMockClient>["requests"]["get"]>>;

/** A webhook body shaped like send21's (docs/webhooks "Payload"), for one simulated action. */
export function mockEvent(entry: MockEntry, coin: number, action: string) {
  const option = entry.body.options[coin] ?? entry.body.options[0]!;
  const units = option.currency === "Btc" ? 1e8 : option.currency === "Sol" || option.currency === "Eth" ? 1e9 : 1e6;
  const price = option.currency === "Btc" ? 60000 : option.currency === "Eth" ? 3000 : option.currency === "Sol" ? 150 : 1;
  const amountSats = Math.max(1, Math.round((entry.body.fiatAmount / price) * units));
  const base = {
    draftId: randomUUID(),
    paymentRequestId: entry.response.id,
    orderId: entry.body.orderId,
    sentCurrency: option.currency.toUpperCase(),
    network: option.network,
    fiatCurrency: entry.body.fiatCurrency,
    fiatAmount: entry.body.fiatAmount,
    amountSats,
    sentAmount: (amountSats / units).toFixed(Math.log10(units)),
    occurredAt: new Date().toISOString(),
  };
  const confirmed = { event: "draft.confirmed", data: { ...base, status: "Confirmed", txId: `mock-${randomUUID()}`, confirmations: 1 } };
  switch (action) {
    case "paid":
      return confirmed;
    case "wrong": // a confirmed payment in a coin this purchase never offered: must be 🚩, never unlocked
      return { ...confirmed, data: { ...confirmed.data, sentCurrency: "ETH", network: "Arbitrum" } };
    case "seen":
      return { event: "draft.seen", data: { ...base, status: "Seen", txId: `mock-${randomUUID()}`, confirmations: 0 } };
    case "short":
      return { event: "draft.amount_mismatch", data: { ...base, status: "AwaitingPayment", reviewState: "pending", receivedAmountSats: Math.round(amountSats * 0.95) } };
    default:
      return { event: "payment_request.expired", data: { paymentRequestId: entry.response.id, orderId: entry.body.orderId, opened: true, quoteRequested: false } };
  }
}

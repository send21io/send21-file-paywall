import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Express } from "express";
import { buildPaywall } from "../src/app.js";
import { loadConfig, type Config } from "../src/config.js";
import { signV2 } from "../src/verify.js";

export const SECRET = "whsec_test_only_not_a_real_secret";
export const SOL = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
export const SELLER = "seller-token-for-tests-only-0123456789";

/** Mock send21, sample catalog and files in a temp dir, in-memory store. */
export function testConfig(env: Record<string, string> = {}): Config {
  const dir = mkdtempSync(join(tmpdir(), "paywall-"));
  return {
    ...loadConfig({ PAYWALL_FILE: "paywall.example.json", FILES_DIR: join(dir, "files"), DATA_FILE: ":memory:", PAY_LIGHTNING: "studio@wallet.example", PAY_OPTIONS: `usdc-sol:${SOL}`, SELLER_TOKEN: SELLER, ...env }),
    webhookSecret: SECRET,
  };
}

export async function listen(app: Express): Promise<{ url: string; close: () => Promise<void> }> {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** The whole paywall on a random port, with a clock tests can move. */
export async function world(env: Record<string, string> = {}) {
  const logs: string[] = [];
  const clock = { now: Date.now() };
  const cfg = testConfig(env);
  const w = buildPaywall(cfg, { log: (l) => logs.push(l), now: () => new Date(clock.now) });
  const server = await listen(w.app);
  if (w.mockPay) w.mockPay.selfUrl = server.url;
  const get = (path: string, init: RequestInit = {}) => fetch(`${server.url}${path}`, { redirect: "manual", ...init });
  const post = (path: string, body: Record<string, string> = {}, headers: Record<string, string> = {}) =>
    fetch(`${server.url}${path}`, { method: "POST", redirect: "manual", body: new URLSearchParams(body), headers });
  /** 🔓 Unlock: returns the purchase page path and the stored purchase. */
  const buy = async (slug = "night-drive") => {
    const r = await post(`/f/${slug}/buy`);
    const page = new URL(r.headers.get("location")!, server.url).pathname;
    const id = page.split("/")[2]!;
    return { page, id, purchase: () => w.store.get(id)! };
  };
  return { ...w, ...server, cfg, logs, clock, get, post, buy };
}

/** draft.confirmed exactly matching a purchase. Shape from docs/webhooks "Payload". */
export function confirmedFor(p: { orderId: string; paymentRequestId: string | null; price: number; currency: string }, over: Record<string, unknown> = {}) {
  return {
    event: "draft.confirmed",
    data: {
      draftId: crypto.randomUUID(),
      status: "Confirmed",
      txId: "5hRk-sig",
      confirmations: 1,
      sentCurrency: "USDC",
      network: "Solana",
      amountSats: Math.round(p.price * 1e6),
      sentAmount: p.price.toFixed(6),
      fiatCurrency: p.currency,
      fiatAmount: p.price,
      paymentRequestId: p.paymentRequestId ?? undefined,
      orderId: p.orderId,
      occurredAt: new Date().toISOString(),
      ...over,
    },
  };
}

export function deliver(url: string, body: unknown, { deliveryId = crypto.randomUUID(), t = Math.floor(Date.now() / 1000), secret = SECRET, raw }: { deliveryId?: string; t?: number; secret?: string; raw?: string } = {}) {
  const payload = raw ?? JSON.stringify(body);
  return fetch(`${url}/webhooks/send21`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-send21-delivery": deliveryId, "x-send21-signature-v2": signV2(payload, deliveryId, t, secret) },
    body: payload,
  });
}

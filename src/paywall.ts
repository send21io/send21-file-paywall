import { randomBytes } from "node:crypto";
import { toMinor } from "./currencies.js";
import type { Send21Client } from "./send21.js";
import type { Store, StoreData } from "./store.js";
import { hashReceipt, mintToken, newReceipt, parseToken, signatureOk } from "./tokens.js";
import { DOWNLOADABLE, type Catalog, type FileItem, type PayOption, type Purchase, type PurchaseStatus } from "./types.js";

// The paywall, without HTTP: purchases, webhooks and download tokens.

export interface PaywallConfig {
  options: PayOption[];
  expiryHours: number;
  shortfallPercent: number;
  downloadSecret: string;
  downloadTtlSeconds: number;
  /** Download tokens one purchase can get in total. */
  downloadLimit: number;
}

export const ORDER_ID = /^file-([a-z0-9]{12})$/;
const GRACE_MS = 15 * 60_000;
const newId = () => {
  const abc = "abcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from(randomBytes(12), (b) => abc[b % 36]).join("");
};

export type Result<T> = ({ ok: true } & T) | { ok: false; error: string; status?: number };

export class Paywall {
  constructor(
    readonly catalog: Catalog,
    readonly store: Store,
    private readonly send21: Send21Client,
    readonly cfg: PaywallConfig,
    private readonly now: () => Date = () => new Date(),
  ) {}

  file = (slug: string): FileItem | undefined => this.catalog.files.find((f) => f.slug === slug);

  /**
   * 💳 Unlock: a new purchase with its own receipt key, then ONE pay link for it.
   * orderId file-<id> is also the Idempotency-Key, so a retry returns the same link.
   */
  async buy(slug: string): Promise<Result<{ purchase: Purchase; receipt: string }>> {
    const item = this.file(slug);
    if (!item) return { ok: false, error: "🤷 not for sale", status: 404 };
    const receipt = newReceipt();
    const nowIso = this.now().toISOString();
    const id = newId();
    const purchase: Purchase = {
      id,
      orderId: `file-${id}`,
      slug: item.slug,
      title: item.title,
      price: item.price,
      currency: this.catalog.currency,
      options: this.cfg.options,
      receiptHash: hashReceipt(receipt),
      status: "open",
      paymentRequestId: null,
      payUrl: null,
      expiresAt: new Date(this.now().getTime() + this.cfg.expiryHours * 3600_000).toISOString(),
      tokens: {},
      downloads: 0,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    this.store.transaction((d) => {
      d.purchases[id] = purchase;
    });
    const pr = await this.ensurePayLink(purchase);
    return pr.ok ? { ok: true, purchase: pr.purchase, receipt } : pr;
  }

  async ensurePayLink(p: Purchase): Promise<Result<{ purchase: Purchase }>> {
    if (p.payUrl) return { ok: true, purchase: p };
    try {
      const pr = await this.send21.createPaymentRequest(
        {
          fiatCurrency: p.currency,
          fiatAmount: p.price,
          orderId: p.orderId,
          memo: `🔒 ${p.title} · ${this.catalog.creator}`.slice(0, 140),
          options: p.options,
          expiryHours: this.cfg.expiryHours,
          declineNote: "No download. Start a new purchase whenever you like.",
          reuseOpenForOrder: true,
          ...(this.cfg.shortfallPercent > 0 ? { shortfallPolicy: { absorbUpToPercent: this.cfg.shortfallPercent, absorbedBy: "receiver" as const } } : {}),
        },
        p.orderId,
      );
      const payUrl = this.send21.payUrl(pr.payPath);
      return { ok: true, purchase: this.patch(p.id, { paymentRequestId: pr.id, payUrl, expiresAt: pr.expiresAt ?? p.expiresAt }) };
    } catch (err) {
      this.store.transaction((d) => {
        delete d.purchases[p.id]; // never had a link: nothing to keep
      });
      throw err;
    }
  }

  private patch(id: string, patch: Partial<Purchase>): Purchase {
    return this.store.transaction((d) => {
      d.purchases[id] = { ...d.purchases[id]!, ...patch, updatedAt: this.now().toISOString() };
      return d.purchases[id]!;
    });
  }

  /** Mark open links expired when the webhook never came. */
  sweep(d: StoreData, now = this.now()): Purchase[] {
    const out: Purchase[] = [];
    for (const p of Object.values(d.purchases)) {
      if (["open", "seen"].includes(p.status) && p.expiresAt && Date.parse(p.expiresAt) + GRACE_MS < now.getTime()) {
        d.purchases[p.id] = { ...p, status: "expired", updatedAt: now.toISOString() };
        out.push(d.purchases[p.id]!);
      }
    }
    return out;
  }

  // ---------- downloads ----------

  /** ⬇️ A fresh single-use token for a paid purchase. */
  issueToken(id: string): Result<{ token: string; exp: number; left: number }> {
    return this.store.transaction((d) => {
      const p = d.purchases[id];
      const item = p && this.file(p.slug);
      if (!p || !item) return { ok: false, error: "🤷 unknown purchase", status: 404 };
      if (!DOWNLOADABLE.includes(p.status)) return { ok: false, error: "🔒 not unlocked", status: 403 };
      const issued = Object.keys(p.tokens).length;
      if (issued >= this.cfg.downloadLimit) return { ok: false, error: `✋ download limit reached (${this.cfg.downloadLimit}). Ask the seller.`, status: 429 };
      const t = mintToken(this.cfg.downloadSecret, { purchaseId: p.id, slug: item.slug, sha256: item.sha256 }, this.cfg.downloadTtlSeconds, this.now().getTime());
      // Every issued token counts toward the limit, used or not.
      d.purchases[id] = { ...p, tokens: { ...p.tokens, [t.jti]: { exp: t.exp } }, updatedAt: this.now().toISOString() };
      return { ok: true, token: t.token, exp: t.exp, left: this.cfg.downloadLimit - issued - 1 };
    });
  }

  /**
   * Check a token and burn it, in one write, BEFORE any byte is sent.
   * Order: shape → signature → purchase unlocked → expiry → not used yet.
   */
  redeem(token: string): Result<{ purchase: Purchase; item: FileItem }> | { ok: false; error: "invalid" | "expired" | "used" | "locked"; status: number } {
    const t = parseToken(token);
    const p = t && this.store.get(t.purchaseId);
    const item = p && this.file(p.slug);
    if (!t || !p || !item || !signatureOk(this.cfg.downloadSecret, token, { purchaseId: p.id, slug: item.slug, sha256: item.sha256 })) return { ok: false, error: "invalid", status: 404 };
    if (!DOWNLOADABLE.includes(p.status)) return { ok: false, error: "locked", status: 403 };
    if (t.exp * 1000 <= this.now().getTime()) return { ok: false, error: "expired", status: 410 };
    return this.store.transaction((d) => {
      const cur = d.purchases[p.id]!;
      const rec = cur.tokens[t.jti];
      if (!rec) return { ok: false as const, error: "invalid" as const, status: 404 };
      if (rec.usedAt) return { ok: false as const, error: "used" as const, status: 410 };
      d.purchases[p.id] = { ...cur, tokens: { ...cur.tokens, [t.jti]: { ...rec, usedAt: this.now().toISOString() } }, downloads: cur.downloads + 1, updatedAt: this.now().toISOString() };
      return { ok: true as const, purchase: d.purchases[p.id]!, item };
    });
  }

  /** 🔓 The seller reviewed a flagged or unresolved purchase and unlocks it by hand. */
  grant(id: string): Result<{ purchase: Purchase }> {
    return this.store.transaction((d) => {
      const p = d.purchases[id];
      if (!p) return { ok: false, error: "unknown purchase", status: 404 };
      if (!["flagged", "unresolved"].includes(p.status)) return { ok: false, error: `cannot grant a ${p.status} purchase`, status: 409 };
      d.purchases[id] = { ...p, status: "granted", updatedAt: this.now().toISOString() };
      return { ok: true, purchase: d.purchases[id]! };
    });
  }

  // ---------- webhooks ----------

  /** Apply one verified, de-duplicated event. Call inside store.transaction() with Store.remember(). */
  applyEvent(d: StoreData, body: { event?: unknown; data?: unknown }): { outcome: Outcome; purchase?: Purchase } {
    const event = typeof body.event === "string" ? body.event : "";
    if (event === "test") return { outcome: "test" };
    const data = (body.data && typeof body.data === "object" ? body.data : {}) as DraftEventData;
    const m = typeof data.orderId === "string" ? ORDER_ID.exec(data.orderId) : null;
    if (data.orderId && !m) return { outcome: "unknown_purchase" }; // another integration on the same account
    const p = m ? d.purchases[m[1]!] : Object.values(d.purchases).find((x) => !!data.paymentRequestId && x.paymentRequestId === data.paymentRequestId);
    if (!p || !p.paymentRequestId || (data.paymentRequestId && data.paymentRequestId !== p.paymentRequestId)) return { outcome: "unknown_purchase" };
    const nowIso = this.now().toISOString();
    const set = (status: PurchaseStatus, extra: Partial<Purchase> = {}) => {
      d.purchases[p.id] = { ...p, ...extra, status, updatedAt: nowIso };
      return { outcome: status, purchase: d.purchases[p.id] };
    };
    const is = (...s: PurchaseStatus[]) => s.includes(p.status);
    const same = { outcome: "unchanged" as const, purchase: p };

    switch (event) {
      case "draft.confirmed": {
        if (is("paid", "granted")) return { outcome: "already_paid", purchase: p };
        const problems = checkPaymentAgainstPurchase(data, p);
        if (problems.length) return set("flagged", { problems });
        return set("paid", {
          problems: undefined,
          paid: {
            currency: String(data.sentCurrency),
            network: String(data.network),
            amount: data.receivedAmount ?? data.sentAmount ?? null,
            txId: String(data.txId),
            differentAmount: data.receivedAmountSats !== undefined && data.receivedAmountSats !== data.amountSats,
            late: is("expired", "declined"),
            at: nowIso,
          },
        });
      }
      case "draft.seen":
        return is("open") ? set("seen") : same;
      case "draft.amount_mismatch":
        return is("open", "seen", "expired") ? set("review", { problems: ["a different amount arrived: accept or decline it on send21"] }) : same;
      case "draft.mismatch_accepted":
        return is("paid", "granted", "declined") ? same : set("accepted");
      case "draft.mismatch_rejected":
        return is("paid", "granted") ? same : set("declined");
      case "draft.mismatch_unresolved":
        return is("open", "seen", "review", "expired") ? set("unresolved") : same;
      case "draft.expired":
        if (data.reviewState === "unresolved") return is("open", "seen", "review", "expired") ? set("unresolved") : same;
        return is("open", "seen") ? set("expired") : same;
      case "payment_request.expired":
        return is("open", "seen") ? set("expired") : same;
      default:
        return { outcome: "ignored", purchase: p }; // draft.created, draft.cancelled, draft.mismatch_reminder
    }
  }
}

export type Outcome = "test" | "ignored" | "unknown_purchase" | "unchanged" | "already_paid" | PurchaseStatus;

/** Fields of a draft webhook payload the paywall reads (docs/webhooks "Payload"). */
export interface DraftEventData {
  status?: string;
  txId?: string;
  sentCurrency?: string;
  network?: string;
  amountSats?: number;
  sentAmount?: string;
  receivedAmountSats?: number;
  receivedAmount?: string;
  fiatCurrency?: string;
  fiatAmount?: number;
  paymentRequestId?: string;
  orderId?: string;
  reviewState?: string;
}

const eq = (a: unknown, b: unknown) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
const isPosInt = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n > 0;

/** A draft.confirmed must be exactly this purchase. Empty = OK. */
export function checkPaymentAgainstPurchase(data: DraftEventData, p: Purchase): string[] {
  const problems: string[] = [];
  if (data.orderId !== p.orderId) problems.push(`orderId ${data.orderId} != ${p.orderId}`);
  if (!p.paymentRequestId || data.paymentRequestId !== p.paymentRequestId) problems.push(`pay link ${data.paymentRequestId} != ${p.paymentRequestId}`);
  if (data.status !== "Confirmed") problems.push(`status ${data.status} != Confirmed`);
  if (!data.txId) problems.push("no txId");
  if (!eq(data.fiatCurrency, p.currency)) problems.push(`fiat ${data.fiatCurrency} != ${p.currency}`);
  if (typeof data.fiatAmount !== "number" || toMinor(data.fiatAmount, p.currency) !== toMinor(p.price, p.currency)) problems.push(`amount ${data.fiatAmount} != ${p.price}`);
  if (!isPosInt(data.amountSats)) problems.push("no amountSats");
  if (data.receivedAmountSats !== undefined && !isPosInt(data.receivedAmountSats)) problems.push("bad receivedAmountSats");
  // sentCurrency is upper case in payloads ("USDC"), options use API enums ("Usdc").
  if (!p.options.some((o) => eq(o.currency, data.sentCurrency) && eq(o.network, data.network))) problems.push(`asset ${data.sentCurrency} on ${data.network} was not offered`);
  return problems;
}

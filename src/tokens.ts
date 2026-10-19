import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Download tokens: short-lived, single use, bound to one purchase and one file.
//
//   dl1.<purchase id>.<jti>.<exp>.<sig>
//   sig = base64url(HMAC-SHA256(DOWNLOAD_SECRET, "dl1|<purchase id>|<jti>|<exp>|<slug>|<file sha256>"))
//
// The signature stops forged or edited tokens without touching the store; the
// jti in the store makes each token work once; exp makes it short-lived. A
// replaced file (new sha256) voids every token issued for the old one.

const TOKEN = /^dl1\.([a-z0-9]{12})\.([A-Za-z0-9_-]{22})\.(\d{10})\.([A-Za-z0-9_-]{43})$/;

export interface TokenBinding {
  purchaseId: string;
  slug: string;
  sha256: string;
}

const sign = (secret: string, b: TokenBinding, jti: string, exp: number) =>
  createHmac("sha256", secret).update(`dl1|${b.purchaseId}|${jti}|${exp}|${b.slug}|${b.sha256}`).digest("base64url");

export function mintToken(secret: string, b: TokenBinding, ttlSeconds: number, now = Date.now()): { token: string; jti: string; exp: number } {
  const jti = randomBytes(16).toString("base64url");
  const exp = Math.floor(now / 1000) + ttlSeconds;
  return { token: `dl1.${b.purchaseId}.${jti}.${exp}.${sign(secret, b, jti, exp)}`, jti, exp };
}

export const parseToken = (token: string) => {
  const m = TOKEN.exec(token);
  return m ? { purchaseId: m[1]!, jti: m[2]!, exp: Number(m[3]), sig: m[4]! } : null;
};

/** Signature only (constant time). Expiry and single use are checked by the caller, against the store. */
export function signatureOk(secret: string, token: string, b: TokenBinding): boolean {
  const t = parseToken(token);
  if (!t || t.purchaseId !== b.purchaseId) return false;
  const want = Buffer.from(sign(secret, b, t.jti, t.exp));
  const got = Buffer.from(t.sig);
  return want.length === got.length && timingSafeEqual(want, got);
}

/** The buyer's receipt key: 256 random bits, only its hash is stored. */
export const newReceipt = () => randomBytes(32).toString("base64url");
export const hashReceipt = (r: string) => createHash("sha256").update(r).digest("hex");
export function receiptOk(r: string, hash: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(r)) return false;
  const a = Buffer.from(hashReceipt(r), "hex");
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

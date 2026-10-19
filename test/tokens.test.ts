import { describe, expect, it } from "vitest";
import { hashReceipt, mintToken, newReceipt, parseToken, receiptOk, signatureOk } from "../src/tokens.js";

const S = "download-secret-for-tests-0123456789abcdef";
const b = { purchaseId: "abcdefghij12", slug: "night-drive", sha256: "a".repeat(64) };

describe("download tokens", () => {
  it("are signed, bound to the purchase and the file, and unguessable", () => {
    const { token, jti, exp } = mintToken(S, b, 300, 1_800_000_000_000);
    expect(token).toMatch(/^dl1\.abcdefghij12\.[A-Za-z0-9_-]{22}\.1800000300\.[A-Za-z0-9_-]{43}$/);
    expect(parseToken(token)).toMatchObject({ purchaseId: b.purchaseId, jti, exp });
    expect(signatureOk(S, token, b)).toBe(true);
    expect(signatureOk("another-secret-0123456789abcdef0123456789", token, b)).toBe(false);
    expect(signatureOk(S, token, { ...b, slug: "zine-1" })).toBe(false);
    expect(signatureOk(S, token, { ...b, sha256: "b".repeat(64) })).toBe(false);
    expect(signatureOk(S, token, { ...b, purchaseId: "zzzzzzzzzzzz" })).toBe(false);
    expect(mintToken(S, b, 300).jti).not.toBe(mintToken(S, b, 300).jti);
  });

  it("refuses an edited expiry or a mangled token", () => {
    const { token } = mintToken(S, b, 300, 1_800_000_000_000);
    expect(signatureOk(S, token.replace(".1800000300.", ".1900000300."), b)).toBe(false);
    expect(signatureOk(S, `${token}x`, b)).toBe(false);
    expect(parseToken("dl1.../../etc")).toBeNull();
  });

  it("receipt keys: 256 bits, only the hash is stored", () => {
    const r = newReceipt();
    expect(r).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(receiptOk(r, hashReceipt(r))).toBe(true);
    expect(receiptOk(newReceipt(), hashReceipt(r))).toBe(false);
    expect(receiptOk("short", hashReceipt(r))).toBe(false);
  });
});

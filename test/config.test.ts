import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, parseOptions } from "../src/config.js";
import { COINS } from "../src/currencies.js";
import { SOL } from "./helpers.js";

const EVM = "0x52908400098527886E0F7030069857D2E4169EE7";
const base = () => ({ PAYWALL_FILE: "paywall.example.json", FILES_DIR: join(mkdtempSync(join(tmpdir(), "cfg-")), "files") });
const live = { SEND21_API_KEY: "s21_x", SEND21_WEBHOOK_SECRET: "whsec", PAY_OPTIONS: `usdc-sol:${SOL}` };

describe("coins", () => {
  it("USDT only on Solana and Ethereum; no USDT or BTC on Base", () => {
    const pairs = COINS.map((c) => `${c.currency}/${c.network}`);
    for (const bad of ["Usdt/Tron", "Usdt/Arbitrum", "Usdt/Polygon", "Usdt/Base", "Btc/Base"]) expect(pairs).not.toContain(bad);
    expect(COINS.filter((c) => c.currency === "Usdt").map((c) => c.network).sort()).toEqual(["Ethereum", "Solana"]);
    expect(() => parseOptions("", `usdt-base:${EVM}`)).toThrow(/unknown coin/);
    expect(() => parseOptions("", `usdt-tron:${EVM}`)).toThrow(/unknown coin/);
    expect(() => parseOptions("", `btc-base:${EVM}`)).toThrow(/unknown coin/);
    expect(parseOptions("me@wallet.example", "")).toEqual([{ currency: "Btc", network: "Mainnet", address: "me@wallet.example", method: "Lightning" }]);
  });
});

describe("config", () => {
  it("needs no keys in mock mode and makes the sample files", () => {
    const c = loadConfig(base());
    expect(c.mock).toBe(true);
    expect(c.catalog.files).toHaveLength(3);
    expect(c.downloadSecret).toHaveLength(64);
    expect(c.sellerToken.length).toBeGreaterThanOrEqual(24);
    expect(c.downloadTtlSeconds).toBe(300);
  });

  it("with a real key: secrets, own files and own addresses are required", () => {
    const b = base();
    expect(() => loadConfig({ ...b, SEND21_API_KEY: "s21_x" })).toThrow(/SEND21_WEBHOOK_SECRET/);
    expect(() => loadConfig({ ...b, ...live })).toThrow(/paywall.json with your own files/);
    expect(() => loadConfig({ ...b, SEND21_API_KEY: "nope" })).toThrow(/s21_/);
    expect(() => loadConfig({ ...b, DOWNLOAD_SECRET: "short" })).toThrow(/32 characters/);
    expect(() => loadConfig({ ...b, SELLER_TOKEN: "short" })).toThrow(/24 characters/);
    expect(() => loadConfig({ ...b, DOWNLOAD_TTL_SECONDS: "5" })).toThrow(/DOWNLOAD_TTL_SECONDS/);
  });
});

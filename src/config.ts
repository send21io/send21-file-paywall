import "dotenv/config";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { loadCatalog } from "./catalog.js";
import { checkAddress, coinById } from "./currencies.js";
import { ensureDemoFiles } from "./demo-files.js";
import type { Catalog, PayOption } from "./types.js";

export interface Config {
  /** null = mock send21: pay links open the local /mock/pay page. */
  send21ApiKey: string | null;
  send21ApiBase: string;
  webhookSecret: string;
  /** Signs download tokens. Not the webhook secret. */
  downloadSecret: string;
  /** Opens /seller. */
  sellerToken: string;
  port: number;
  publicUrl: string;
  trustProxy: boolean;
  filesDir: string;
  catalog: Catalog;
  options: PayOption[];
  expiryHours: number;
  shortfallPercent: number;
  downloadTtlSeconds: number;
  downloadLimit: number;
  dataFile: string;
  mock: boolean;
}

const num = (v: string | undefined, def: number, min: number, max: number, name: string): number => {
  const n = v === undefined || v === "" ? def : Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return n;
};

/**
 * PAY_LIGHTNING=name@your-wallet.com and PAY_OPTIONS=usdc-sol:<address>,eth-base:<address>
 * (coin ids from src/currencies.ts). Your own addresses only.
 */
export function parseOptions(lightning: string | undefined, list: string | undefined): PayOption[] {
  const entries: [string, string][] = [];
  if (lightning?.trim()) entries.push(["btc-ln", lightning.trim()]);
  for (const part of (list ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const i = part.indexOf(":");
    if (i < 1) throw new Error(`PAY_OPTIONS: "${part}" should be coin:address`);
    entries.push([part.slice(0, i), part.slice(i + 1)]);
  }
  const options: PayOption[] = [];
  for (const [id, raw] of entries) {
    const coin = coinById(id);
    if (!coin) throw new Error(`PAY_OPTIONS: unknown coin "${id}"`);
    if (options.some((o) => o.currency === coin.currency && o.network === coin.network && o.method === coin.method)) throw new Error(`PAY_OPTIONS: ${id} twice`);
    const address = checkAddress(coin, raw);
    if (!address.ok) throw new Error(`PAY_OPTIONS ${id}: ${address.error}`);
    options.push({ currency: coin.currency, network: coin.network, address: address.address, ...(coin.method ? { method: coin.method } : {}) });
  }
  return options;
}

// Sample receiving options for mock mode only. Never sent to send21.
const MOCK_LIGHTNING = "studio@wallet.example";
const MOCK_OPTIONS = "usdc-sol:7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU,usdt-sol:7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU,eurc-base:0x52908400098527886E0F7030069857D2E4169EE7";

const secretOf = (v: string | undefined, name: string, mock: boolean): string => {
  const s = v?.trim();
  if (s) {
    if (s.length < 32) throw new Error(`${name}: at least 32 characters (openssl rand -hex 32)`);
    return s;
  }
  if (!mock) throw new Error(`${name} is missing (openssl rand -hex 32)`);
  return randomBytes(32).toString("hex");
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiKey = env.SEND21_API_KEY?.trim() || null;
  const mock = !apiKey;
  if (apiKey && !apiKey.startsWith("s21_")) throw new Error("SEND21_API_KEY should start with s21_");
  const secret = env.SEND21_WEBHOOK_SECRET?.trim();
  if (!mock && !secret) throw new Error("SEND21_WEBHOOK_SECRET is missing (npm run webhook:register)");
  const port = num(env.PORT, 3000, 1, 65535, "PORT");
  const publicUrl = (env.PUBLIC_URL?.trim() || `http://localhost:${port}`).replace(/\/$/, "");

  const filesDir = env.FILES_DIR?.trim() || "./files";
  // No paywall.json yet: the sample catalog with generated sample files.
  const paywallFile = env.PAYWALL_FILE?.trim() || (existsSync("./paywall.json") ? "./paywall.json" : "./paywall.example.json");
  if (paywallFile.endsWith("paywall.example.json")) {
    if (!mock) throw new Error("create paywall.json with your own files (npm run file:add)");
    ensureDemoFiles(filesDir);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(paywallFile, "utf8"));
  } catch (err) {
    throw new Error(`${paywallFile}: ${(err as Error).message}`);
  }
  if (!existsSync(filesDir)) throw new Error(`FILES_DIR ${filesDir} does not exist`);
  const catalog = loadCatalog(raw, filesDir);

  const configured = parseOptions(env.PAY_LIGHTNING, env.PAY_OPTIONS);
  const options = configured.length ? configured : mock ? parseOptions(MOCK_LIGHTNING, MOCK_OPTIONS) : [];
  if (!options.length) throw new Error("Set PAY_LIGHTNING and/or PAY_OPTIONS to your own receiving addresses");

  const sellerToken = env.SELLER_TOKEN?.trim() || (mock ? randomBytes(18).toString("base64url") : "");
  if (sellerToken.length < 24) throw new Error("SELLER_TOKEN: at least 24 characters (openssl rand -base64 24)");

  return {
    send21ApiKey: apiKey,
    send21ApiBase: env.SEND21_API_BASE?.trim() || "https://send21.io",
    webhookSecret: secret || randomBytes(32).toString("hex"),
    downloadSecret: secretOf(env.DOWNLOAD_SECRET, "DOWNLOAD_SECRET", mock),
    sellerToken,
    port,
    publicUrl,
    trustProxy: env.TRUST_PROXY === "1",
    filesDir,
    catalog,
    options,
    expiryHours: Math.round(num(env.PAY_EXPIRY_HOURS, 1, 1, 72, "PAY_EXPIRY_HOURS")),
    shortfallPercent: num(env.SHORTFALL_PERCENT, 0, 0, 10, "SHORTFALL_PERCENT"),
    downloadTtlSeconds: Math.round(num(env.DOWNLOAD_TTL_SECONDS, 300, 30, 3600, "DOWNLOAD_TTL_SECONDS")),
    downloadLimit: Math.round(num(env.DOWNLOAD_LIMIT, 5, 1, 50, "DOWNLOAD_LIMIT")),
    dataFile: env.DATA_FILE?.trim() || "./data/paywall.json",
    mock,
  };
}

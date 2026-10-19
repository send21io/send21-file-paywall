/** One pay-link option: a coin the seller accepts and their own receiving address. */
export interface PayOption {
  currency: string;
  network: string;
  address: string;
  method?: string;
}

export type FileKind = "zip" | "pdf" | "presets" | "beat" | "file";

export interface FileItem {
  /** URL name: /f/<slug> */
  slug: string;
  title: string;
  emoji: string;
  kind: FileKind;
  /** Fiat price in the paywall currency. */
  price: number;
  /** File name inside FILES_DIR. Never served from public/. */
  file: string;
  /** What the 🔒 card says about it. */
  preview: string;
  /** Short tags shown as chips, e.g. "12 presets", "WAV". */
  tags: string[];
  /** Filled at load time from the file itself. */
  size: number;
  sha256: string;
}

export interface Catalog {
  creator: string;
  currency: string;
  files: FileItem[];
}

export type PurchaseStatus =
  | "open" // 💳 pay link created
  | "seen" // 👀 payment on its way
  | "review" // ⚠️ a different amount arrived, the seller decides on send21
  | "accepted" // 👍 accepted, waiting for draft.confirmed
  | "paid" // ✅ download unlocked
  | "declined" // ↩️ different amount declined
  | "unresolved" // ⚠️ expired undecided, money arrived: seller reviews
  | "expired" // ⌛
  | "flagged" // 🚩 confirmed but it does not match: seller reviews, no download
  | "granted"; // 🔓 the seller reviewed it and unlocked it by hand

/** The only statuses that can get a download token. */
export const DOWNLOADABLE: readonly PurchaseStatus[] = ["paid", "granted"];

export interface DownloadToken {
  exp: number;
  usedAt?: string;
}

export interface Purchase {
  /** Random 12 × [a-z0-9]. orderId on send21 is file-<id>, also the Idempotency-Key. */
  id: string;
  orderId: string;
  slug: string;
  title: string;
  price: number;
  currency: string;
  options: PayOption[];
  /** sha256 of the buyer's receipt key. The key itself is only in the buyer's link. */
  receiptHash: string;
  status: PurchaseStatus;
  paymentRequestId: string | null;
  payUrl: string | null;
  expiresAt: string | null;
  paid?: { currency: string; network: string; amount: string | null; txId: string; differentAmount: boolean; late: boolean; at: string };
  problems?: string[];
  /** jti -> token state. Single use: usedAt is set before the first byte is sent. */
  tokens: Record<string, DownloadToken>;
  downloads: number;
  createdAt: string;
  updatedAt: string;
}

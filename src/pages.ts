import { formatBytes, kindLabel } from "./catalog.js";
import { coinFor, formatFiat } from "./currencies.js";
import type { Catalog, FileItem, PayOption, Purchase } from "./types.js";

// Server-rendered pages. Every dynamic value goes through esc(). No inline
// script or style (CSP 'self'): the only script is /purchase.js.

export const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function layout(title: string, body: string, opts: { script?: string; mock?: boolean; wide?: boolean } = {}): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="robots" content="noindex"><meta name="theme-color" content="#0f1013"><link rel="icon" href="data:,"><link rel="stylesheet" href="/paywall.css">${opts.script ? `<script src="${esc(opts.script)}" defer></script>` : ""}</head>
<body><main class="wrap${opts.wide ? " wide" : ""}">${body}</main>
<footer class="foot">${opts.mock ? "🧪 mock mode · no real money · " : ""}🔒 non-custodial · paid with <a href="https://send21.io">send21</a></footer></body></html>`;
}

const chips = (options: PayOption[]) =>
  `<ul class="coins">${[...new Map(options.map((o) => { const c = coinFor(o.currency, o.network, o.method); return [c?.id ?? o.currency, c] as const; })).values()]
    .map((c) => (c ? `<li>${c.emoji} ${esc(c.label)}</li>` : ""))
    .join("")}</ul>`;

const fileTile = (f: FileItem, locked: boolean) =>
  `<div class="tile ${f.kind}"><span class="big">${esc(f.emoji)}</span>${locked ? '<span class="lock" aria-label="locked">🔒</span>' : '<span class="lock open" aria-label="unlocked">🔓</span>'}</div>`;

const meta = (f: FileItem) => `<p class="meta">${esc(kindLabel(f.kind))} · ${esc(formatBytes(f.size))}</p>${f.tags.length ? `<ul class="tags">${f.tags.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}`;

export function indexPage(c: Catalog, mock: boolean): string {
  return layout(
    c.creator,
    `<header class="hero"><p class="kicker">🛍️ files by</p><h1>${esc(c.creator)}</h1><p class="sub">🔓 pay once with crypto · ⬇️ download right away · no account</p></header>
${c.files.length ? `<ul class="grid">${c.files.map((f) => `<li><a class="mini" href="/f/${esc(f.slug)}">${fileTile(f, true)}<b>${esc(f.title)}</b><span class="p">${esc(formatFiat(f.price, c.currency))}</span></a></li>`).join("")}</ul>` : '<article class="card center"><p class="huge">📭</p><p>no files yet</p><p class="small">add one with <code>npm run file:add</code></p></article>'}`,
    { mock, wide: true },
  );
}

export function filePage(c: Catalog, f: FileItem, options: PayOption[], mock: boolean, error?: string): string {
  return layout(
    `${f.title} · ${c.creator}`,
    `<article class="card">
${fileTile(f, true)}
<p class="kicker">${esc(c.creator)}</p>
<h1>${esc(f.title)}</h1>
${meta(f)}
<p class="preview">${esc(f.preview)}</p>
<p class="price">${esc(formatFiat(f.price, c.currency))}</p>
${error ? `<p class="err" role="alert">${esc(error)}</p>` : ""}
<form method="post" action="/f/${esc(f.slug)}/buy"><button class="cta">🔓 Unlock · ${esc(formatFiat(f.price, c.currency))}</button></form>
${chips(options)}
<p class="small">👛 no account · pay from your own wallet · ⬇️ instant download</p>
</article>`,
    { mock },
  );
}

const STATUS: Record<string, [string, string]> = {
  open: ["⏳", "waiting for your payment"],
  seen: ["👀", "payment on its way"],
  review: ["⚠️", "a different amount arrived · the seller is checking"],
  accepted: ["👍", "accepted · waiting for confirmation"],
  paid: ["✅", "paid · unlocked"],
  granted: ["✅", "unlocked by the seller"],
  declined: ["↩️", "declined · no download"],
  unresolved: ["🚩", "the seller is reviewing this payment"],
  expired: ["⌛", "this pay link expired"],
  flagged: ["🚩", "the seller is reviewing this payment"],
};

export function purchasePage(c: Catalog, f: FileItem, p: Purchase, o: { base: string; qr: string | null; mock: boolean; left: number; ttlSeconds: number; payHref: string | null; error?: string }): string {
  const [icon, text] = STATUS[p.status] ?? ["•", p.status];
  const pill = `<p class="pill s-${esc(p.status)}" data-status="${esc(p.status)}" id="status">${icon} ${esc(text)}</p>`;
  const head = `${fileTile(f, !["paid", "granted"].includes(p.status))}<h1>${esc(f.title)}</h1><p class="price">${esc(formatFiat(p.price, p.currency))}</p>${pill}`;
  let body: string;
  if (["paid", "granted"].includes(p.status)) {
    body = `${meta(f)}
${o.error ? `<p class="err" role="alert">${esc(o.error)}</p>` : ""}
<form method="post" action="${esc(o.base)}/download"><button class="cta"${o.left > 0 ? "" : " disabled"}>⬇️ Download ${esc(f.file)}</button></form>
<p class="small">🔑 each download link works once, for ${o.ttlSeconds < 120 ? `${o.ttlSeconds} s` : `${Math.round(o.ttlSeconds / 60)} min`} · ${o.left} left</p>
<p class="small">🔖 bookmark this page to download again later</p>`;
  } else if (["open", "seen", "review", "accepted"].includes(p.status) && o.payHref) {
    body = `${o.qr ? `<img class="qr" src="${o.qr}" alt="QR code of the pay link" width="220" height="220">` : ""}
<a class="cta" href="${esc(o.payHref)}" target="_blank" rel="noopener noreferrer">💳 Pay ${esc(formatFiat(p.price, p.currency))}</a>
${chips(p.options)}
<p class="small">🔖 keep this page open: it unlocks by itself once the payment confirms</p>`;
  } else if (["flagged", "unresolved"].includes(p.status)) {
    body = `<p class="small">🔍 Something about this payment did not match the order. The seller checks it by hand. No download until then.</p>`;
  } else {
    body = `<a class="cta ghost" href="/f/${esc(f.slug)}">🔁 Start again</a>`;
  }
  return layout(`${f.title} · purchase`, `<article class="card" data-purchase>${head}${body}</article>`, { script: "/purchase.js", mock: o.mock });
}

const TOKEN_ERR = {
  expired: ["⌛", "This download link expired", "Links work for a few minutes only."],
  used: ["🔁", "This link was already used", "Each link works once."],
  locked: ["🔒", "Not unlocked", "This purchase has no download (yet)."],
  invalid: ["🤷", "Unknown download link", "It may be mistyped or made up."],
} as const;

export function tokenErrorPage(kind: keyof typeof TOKEN_ERR, mock: boolean): string {
  const [icon, title, why] = TOKEN_ERR[kind];
  return layout(title, `<article class="card center"><p class="huge">${icon}</p><h1>${esc(title)}</h1><p class="small">${esc(why)}</p><p class="small">🔖 Open your purchase page again for a fresh link.</p><a class="cta ghost" href="/">🛍️ browse files</a></article>`, { mock });
}

export function errorPage(msg: string, mock: boolean): string {
  return layout("oops", `<article class="card center"><p class="huge">😵</p><p>${esc(msg)}</p><a class="cta ghost" href="/">↩️ back</a></article>`, { mock });
}

// ---------- seller ----------

export function sellerLogin(mock: boolean, error?: string): string {
  return layout("seller", `<article class="card center"><p class="huge">🔐</p><h1>Seller</h1>${error ? `<p class="err">${esc(error)}</p>` : ""}
<form method="post" action="/seller/login" class="stack"><input type="password" name="token" placeholder="SELLER_TOKEN" aria-label="seller token" autocomplete="current-password" required><button class="cta">Open</button></form></article>`, { mock });
}

const ICON: Record<string, string> = { open: "💳", seen: "👀", review: "⚠️", accepted: "👍", paid: "✅", granted: "🔓", declined: "↩️", unresolved: "🚩", expired: "⌛", flagged: "🚩" };

export function sellerPage(c: Catalog, purchases: Purchase[], mock: boolean): string {
  const paid = purchases.filter((p) => p.status === "paid" || p.status === "granted");
  const revenue = paid.reduce((n, p) => n + Math.round(p.price * 100), 0) / 100;
  const review = purchases.filter((p) => ["flagged", "unresolved", "review"].includes(p.status));
  const rows = [...purchases].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50);
  const coin = (p: Purchase) => (p.paid ? (coinFor(p.paid.currency, p.paid.network)?.label ?? `${p.paid.currency} · ${p.paid.network}`) : "");
  return layout(
    "seller",
    `<header class="hero left"><p class="kicker">🔐 seller</p><h1>${esc(c.creator)}</h1></header>
<ul class="stats"><li><b>${esc(formatFiat(revenue, c.currency))}</b><span>💰 paid</span></li><li><b>${paid.length}</b><span>🛍️ sales</span></li><li><b>${purchases.reduce((n, p) => n + p.downloads, 0)}</b><span>⬇️ downloads</span></li><li class="${review.length ? "warn" : ""}"><b>${review.length}</b><span>🚩 to review</span></li></ul>
${review.length ? `<h2>🚩 Review</h2><ul class="list">${review.map((p) => `<li class="row flag"><div><b>${ICON[p.status]} ${esc(p.title)}</b> · ${esc(formatFiat(p.price, p.currency))} · <code>${esc(p.orderId)}</code><ul class="problems">${(p.problems ?? []).map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>${["flagged", "unresolved"].includes(p.status) ? `<form method="post" action="/seller/grant/${esc(p.id)}"><button class="mini-btn">🔓 grant</button></form>` : `<span class="small">decide on send21</span>`}</li>`).join("")}</ul>` : ""}
<h2>🧾 Purchases</h2>
<ul class="list">${rows.length ? rows.map((p) => `<li class="row"><span class="ic">${ICON[p.status] ?? "•"}</span><div><b>${esc(p.title)}</b><span class="small"> · ${esc(formatFiat(p.price, p.currency))}${p.paid ? ` · ${esc(coin(p))}` : ""} · ${esc(p.status)}${p.downloads ? ` · ⬇️ ${p.downloads}` : ""}</span></div><time>${esc(p.createdAt.slice(11, 16))} UTC</time></li>`).join("") : '<li class="row small">no purchases yet</li>'}</ul>
<h2>📦 Files</h2>
<ul class="list">${c.files.map((f) => `<li class="row"><span class="ic">${esc(f.emoji)}</span><div><a href="/f/${esc(f.slug)}"><b>${esc(f.title)}</b></a><span class="small"> · ${esc(formatFiat(f.price, c.currency))} · ${esc(formatBytes(f.size))}</span></div></li>`).join("")}</ul>`,
    { mock },
  );
}

// ---------- mock send21 pay page ----------

export function mockPayPage(entry: { fiatAmount: number; fiatCurrency: string; memo: string; options: PayOption[] }, token: string, sent?: { ok: boolean; events: string }): string {
  const t = esc(token);
  const coins = entry.options.map((o, i) => `<option value="${i}">${esc(`${o.currency.toUpperCase()} · ${o.method ?? o.network}`)}</option>`).join("");
  const actions = [["paid", "✅ pay"], ["seen", "👀 start paying"], ["short", "⚠️ pay 5% short"], ["accept", "👍 accept the short pay"], ["decline", "↩️ decline the short pay"], ["wrong", "🚩 pay a wrong coin"], ["expire", "⌛ let it expire"]];
  return layout(
    "mock pay · send21",
    `<article class="card center"><p class="pill">🧪 mock send21 · no real money</p><p class="price">${esc(formatFiat(entry.fiatAmount, entry.fiatCurrency))}</p><p class="small">${esc(entry.memo)}</p>
${sent ? `<p class="pill ${sent.ok ? "ok" : "bad"}" role="status">${sent.ok ? "📨 sent" : "❌ refused"} <code>${esc(sent.events)}</code></p>` : ""}
<form method="post" action="/mock/pay/${t}/paid" class="mockform"><label for="coin">🪙 pay with</label><select id="coin" name="coin">${coins}</select>
<div class="acts">${actions.map(([a, l]) => `<button formaction="/mock/pay/${t}/${a}"${a === "paid" ? ' class="main"' : ""}>${l}</button>`).join("")}</div></form>
<p class="small">Each button sends a signed webhook, like send21 would. 👍 / ↩️ are what the send21 account owner does with a short pay. ↩️ Then go back to the purchase tab: it updates by itself.</p></article>`,
    { mock: true },
  );
}

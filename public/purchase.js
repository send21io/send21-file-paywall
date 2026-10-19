// Purchase page: check the status every few seconds and reload when it changes
// (👀 seen, ✅ paid ...). No data from the server is written into the page here.
(() => {
  const el = document.getElementById("status");
  if (!el) return;
  const now = el.dataset.status;
  if (["paid", "granted", "declined", "expired", "flagged"].includes(now)) return;
  const url = location.pathname.replace(/\/$/, "") + "/status";
  setInterval(async () => {
    try {
      const r = await fetch(url, { cache: "no-store" });
      if (r.ok && (await r.json()).status !== now) location.reload();
    } catch {
      /* offline: try again */
    }
  }, 2500);
})();

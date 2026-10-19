import { buildPaywall } from "./app.js";
import { loadConfig } from "./config.js";

const cfg = loadConfig();
const { app, sweep } = buildPaywall(cfg);

app.listen(cfg.port, cfg.mock ? "127.0.0.1" : "0.0.0.0", () => {
  console.log(`🔒 file paywall ${cfg.publicUrl}/  ·  🪝 /webhooks/send21  ·  🔐 ${cfg.publicUrl}/seller`);
  if (cfg.mock) {
    console.log("🧪 MOCK send21: no send21 calls, pay links open a local simulator. Sample files in", cfg.filesDir);
    console.log(`🧪 seller view in one click: ${cfg.publicUrl}/seller/demo`);
  }
  setInterval(sweep, 60_000).unref();
  sweep();
});

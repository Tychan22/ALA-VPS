#!/usr/bin/env node
/**
 * ALA VPS — Local test script
 *
 * Usage:
 *   node test.js open         → fires fake entry signal (MGC1!)
 *   node test.js partial      → fires fake TP1 partial (Telegram only)
 *   node test.js win          → fires fake TP close (logs + Telegram)
 *   node test.js loss         → fires fake SL close (logs + Telegram)
 *   node test.js be           → fires fake BE close after partial (logs + Telegram)
 *   node test.js sequence     → open → partial → win in order
 *
 * Options:
 *   BASE_URL=https://... node test.js open
 */

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const SECRET   = process.env.WEBHOOK_SECRET || "";

const headers = {
  "Content-Type": "application/json",
  ...(SECRET ? { "X-ALA-Secret": SECRET } : {}),
};

const fakeOpen = {
  symbol:    "MGC1!",
  interval:  "5",
  action:    "entry",
  type:      "LONG",
  setup:     "SRR",
  session:   "LONDON",
  entry:     "3285.50",
  sl:        "3280.00",
  tp:        "3310.00",
  tp1:       "3295.00",
  rr:        "4.45",
  cts:       "3",
  risk:      "300",
  timestamp: Date.now().toString(),
};

const fakePartial = {
  symbol:         "MGC1!",
  action:         "partial",
  type:           "LONG",
  setup:          "SRR",
  entry:          "3285.50",
  tp1:            "3295.00",
  tp:             "3310.00",
  partial_cts:    "1",
  partial_profit: "95.00",
  timestamp:      Date.now().toString(),
};

const fakeWin = {
  symbol:    "MGC1!",
  action:    "tp",
  type:      "LONG",
  setup:     "SRR",
  entry:     "3285.50",
  exit:      "3310.00",
  tp1_exit:  "3295.00",
  cts:       "3",
  pnl:       "595.00",
  rr:        "4.45",
  risk:      "300",
  timestamp: Date.now().toString(),
};

const fakeLoss = {
  symbol:    "MGC1!",
  action:    "sl",
  type:      "LONG",
  setup:     "SRR",
  entry:     "3285.50",
  exit:      "3280.00",
  pnl:       "-300",
  risk:      "300",
  timestamp: Date.now().toString(),
};

const fakeBE = {
  symbol:    "MGC1!",
  action:    "be",
  type:      "LONG",
  setup:     "SRR",
  entry:     "3285.50",
  exit:      "3285.50",
  tp1_exit:  "3295.00",
  cts:       "3",
  pnl:       "95.00",
  risk:      "300",
  timestamp: Date.now().toString(),
};

async function post(path, body) {
  const res  = await fetch(`${BASE_URL}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const json = await res.json();
  console.log(`\n[${path}] ${res.status}`);
  console.log(JSON.stringify(json, null, 2));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const cmd = process.argv[2] || "open";

(async () => {
  if (cmd === "open")     await post("/signal", fakeOpen);
  if (cmd === "partial")  await post("/signal", fakePartial);
  if (cmd === "win")      await post("/signal", fakeWin);
  if (cmd === "loss")     await post("/signal", fakeLoss);
  if (cmd === "be")       await post("/signal", fakeBE);
  if (cmd === "sequence") {
    await post("/signal", fakeOpen);
    console.log("\n⏳ waiting 3s...");
    await sleep(3000);
    await post("/signal", fakePartial);
    console.log("\n⏳ waiting 3s...");
    await sleep(3000);
    await post("/signal", fakeWin);
  }
})();

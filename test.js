#!/usr/bin/env node
/**
 * ALA VPS — Local test script (updated for the Range Detection indicator)
 *
 * Usage:
 *   node test.js range     → fires fake "range detected" ping (Telegram + live feed only, never logged)
 *   node test.js open      → fires fake LongEntry signal (MGC1!)
 *   node test.js win       → fires fake TP close (logs + Telegram)
 *   node test.js loss      → fires fake SL close (logs + Telegram)
 *   node test.js eod       → fires fake EOD flatten close (logs as WIN/LOSS by pnl sign + Telegram)
 *   node test.js sequence  → range → open → win in order
 *   node test.js random    → random open + close (win/loss/eod)
 *
 * NOTE: this indicator has no partial/BE logic (no TP1, no breakeven) — those
 * handlers still exist server-side (dormant, harmless) but nothing here fires
 * them, since the live Pine script never sends "partial" or "be" actions.
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

const fakeRange = {
  action:    "range_detected",
  symbol:    "MGC1!",
  high:      "4155.80",
  low:       "4140.80",
  timestamp: Date.now().toString(),
};

const fakeOpen = {
  action:    "LongEntry",
  symbol:    "MGC1!",
  type:      "RANGE_BREAKOUT",
  entry:     "4155.80",
  sl:        "4150.30",
  tp:        "4166.80",
  cts:       "4",
  risk:      "200",
  timestamp: Date.now().toString(),
};

const fakeWin = {
  action:    "tp",
  symbol:    "MGC1!",
  type:      "LONG",
  entry:     "4155.80",
  exit:      "4166.80",
  pnl:       "440.00",
  cts:       "4",
  timestamp: Date.now().toString(),
};

const fakeLoss = {
  action:    "sl",
  symbol:    "MGC1!",
  type:      "LONG",
  entry:     "4155.80",
  exit:      "4150.30",
  pnl:       "-220.00",
  cts:       "4",
  timestamp: Date.now().toString(),
};

const fakeEodWin = {
  action:    "eod_rollover",
  symbol:    "MGC1!",
  type:      "LONG",
  entry:     "4155.80",
  exit:      "4160.10",
  pnl:       "172.00",
  cts:       "4",
  timestamp: Date.now().toString(),
};

const fakeEodLoss = {
  action:    "eod_rollover",
  symbol:    "MGC1!",
  type:      "SHORT",
  entry:     "4155.80",
  exit:      "4158.20",
  pnl:       "-96.00",
  cts:       "4",
  timestamp: Date.now().toString(),
};

async function post(path, body) {
  const res  = await fetch(`${BASE_URL}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const json = await res.json();
  console.log(`\n[${path}] ${res.status}`);
  console.log(JSON.stringify(json, null, 2));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function randomTrade() {
  const types    = ["LONG", "SHORT"];
  const closeTypes = ["tp", "sl", "eod_rollover"];
  const type     = types[Math.floor(Math.random() * types.length)];
  const closeAction = closeTypes[Math.floor(Math.random() * closeTypes.length)];
  const entry    = +(4140 + Math.random() * 30).toFixed(2);
  const isLong   = type === "LONG";
  const sl       = +(isLong ? entry - (3 + Math.random() * 8) : entry + (3 + Math.random() * 8)).toFixed(2);
  const risk     = Math.abs(entry - sl);
  const tp       = +(isLong ? entry + risk * 2 : entry - risk * 2).toFixed(2);
  const cts      = Math.max(1, Math.ceil(Math.random() * 5));

  let exit, pnl;
  if (closeAction === "tp") {
    exit = tp;
    pnl  = +(Math.abs(tp - entry) * cts * 10).toFixed(2);
  } else if (closeAction === "sl") {
    exit = sl;
    pnl  = -(+(Math.abs(entry - sl) * cts * 10).toFixed(2));
  } else {
    // eod — random price somewhere, could be ahead or behind
    const drift = (Math.random() - 0.4) * risk * 2;
    exit = +(entry + (isLong ? drift : -drift)).toFixed(2);
    pnl  = +((isLong ? exit - entry : entry - exit) * cts * 10).toFixed(2);
  }

  return {
    open:  { action: isLong ? "LongEntry" : "ShortEntry", symbol: "MGC1!", type: isLong ? "RANGE_BREAKOUT" : "RANGE_BREAKDOWN", entry: String(entry), sl: String(sl), tp: String(tp), cts: String(cts), risk: "200", timestamp: String(Date.now()) },
    close: { action: closeAction, symbol: "MGC1!", type, entry: String(entry), exit: String(exit), pnl: String(pnl), cts: String(cts), timestamp: String(Date.now() + 300000) },
  };
}

const cmd = process.argv[2] || "open";

(async () => {
  if (cmd === "range")  await post("/signal", fakeRange);
  if (cmd === "open")   await post("/signal", fakeOpen);
  if (cmd === "win")    await post("/signal", fakeWin);
  if (cmd === "loss")   await post("/signal", fakeLoss);
  if (cmd === "eod")    await post("/signal", Math.random() > 0.5 ? fakeEodWin : fakeEodLoss);
  if (cmd === "sequence") {
    await post("/signal", fakeRange);
    console.log("\n⏳ waiting 2s...");
    await sleep(2000);
    await post("/signal", fakeOpen);
    console.log("\n⏳ waiting 3s...");
    await sleep(3000);
    await post("/signal", fakeWin);
  }
  if (cmd === "random") {
    const { open, close } = randomTrade();
    console.log("\n🎲 Type:", open.type, "| Close reason:", close.action.toUpperCase(), "| PnL:", close.pnl);
    await post("/signal", open);
    console.log("\n⏳ waiting 4s...");
    await sleep(4000);
    await post("/signal", close);
  }
})();

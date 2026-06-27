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

function randomTrade() {
  const setups   = ["BO","SRR","SFP","BD"];
  const sessions = ["ASIA","LONDON","NY"];
  const types    = ["LONG","SHORT"];
  const results  = ["tp","sl","be"];
  const setup    = setups[Math.floor(Math.random()*setups.length)];
  const session  = sessions[Math.floor(Math.random()*sessions.length)];
  const type     = types[Math.floor(Math.random()*types.length)];
  const result   = results[Math.floor(Math.random()*results.length)];
  const entry    = +(3280+Math.random()*30).toFixed(2);
  const sl       = +(entry-(2+Math.random()*8)).toFixed(2);
  const tp       = +(entry+(15+Math.random()*30)).toFixed(2);
  const tp1      = +(entry+(tp-entry)*0.4).toFixed(2);
  const cts      = Math.ceil(Math.random()*4);
  const rr       = ((tp-entry)/(entry-sl)).toFixed(2);
  const pnl      = result==="tp" ? +(100+Math.random()*600).toFixed(0)
                 : result==="be" ? +(50+Math.random()*150).toFixed(0)
                 : -300;
  return {
    open:  { symbol:"MGC1!", action:"entry", type, setup, session, entry:String(entry), sl:String(sl), tp:String(tp), tp1:String(tp1), rr, cts:String(cts), risk:"300", timestamp:String(Date.now()) },
    close: { symbol:"MGC1!", action:result,  type, setup, entry:String(entry), exit:String(result==="tp"?tp:result==="be"?entry:sl), tp1_exit:result!=="sl"?String(tp1):"", cts:String(cts), pnl:String(pnl), rr, risk:"300", timestamp:String(Date.now()+300000) },
  };
}

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
  if (cmd === "random") {
    const { open, close } = randomTrade();
    console.log("\n🎲 Setup:", open.setup, "| Session:", open.session, "| Type:", open.type, "| Result:", close.action.toUpperCase());
    await post("/signal", open);
    console.log("\n⏳ waiting 4s...");
    await sleep(4000);
    await post("/signal", close);
  }
})();

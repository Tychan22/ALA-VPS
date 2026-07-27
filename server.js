require("dotenv").config();
const express  = require("express");
const axios    = require("axios");
const fs       = require("fs");
const path     = require("path");
const FormData = require("form-data");

const app  = express();
app.use(express.json());
app.use(require("cors")());

const PORT               = process.env.PORT || 3000;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const CHART_IMG_KEY      = process.env.CHART_IMG_KEY;
const WEBHOOK_SECRET     = process.env.WEBHOOK_SECRET;

// ─── FILE STORAGE ─────────────────────────────────────────────────────────────
const DATA_DIR      = process.env.DATA_DIR || path.join(__dirname);
const TRADES_FILE   = path.join(DATA_DIR, "trades.json");
const EVENTS_FILE   = path.join(DATA_DIR, "events.json");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const SCREENS_DIR   = path.join(DATA_DIR, "screenshots");
const MAX_EVENTS    = 200;

if (!fs.existsSync(SCREENS_DIR)) fs.mkdirSync(SCREENS_DIR, { recursive: true });

function readTrades() {
  try {
    if (!fs.existsSync(TRADES_FILE)) return [];
    return JSON.parse(fs.readFileSync(TRADES_FILE, "utf8"));
  } catch { return []; }
}

function writeTrades(trades) {
  fs.writeFileSync(TRADES_FILE, JSON.stringify(trades, null, 2));
}

// ─── MINI EVENT LOG — lightweight scrolling feed, separate from trades.json.
// Range detections show up here but never in trades.json (Telegram-only,
// per design). Entries and closes appear in BOTH: here for the live feed,
// and in trades.json for the full trade record.
function readEvents() {
  try {
    if (!fs.existsSync(EVENTS_FILE)) return [];
    return JSON.parse(fs.readFileSync(EVENTS_FILE, "utf8"));
  } catch { return []; }
}

function writeEvents(events) {
  fs.writeFileSync(EVENTS_FILE, JSON.stringify(events, null, 2));
}

function pushEvent(type, message) {
  const events = readEvents();
  events.push({ type, message, ts: Date.now() });
  while (events.length > MAX_EVENTS) events.shift();
  writeEvents(events);
}

// ─── SETTINGS — autotrading toggle + LuneFi webhook config, VPS-persisted so
// it stays in sync across browsers/devices, not just localStorage.
function readSettings() {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return { luneWebhook: "", luneStrategyId: "", autotrading: false };
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
  } catch { return { luneWebhook: "", luneStrategyId: "", autotrading: false }; }
}

function writeSettings(settings) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

function getTradingDate() {
  const now     = new Date();
  const estStr  = now.toLocaleString("en-US", { timeZone: "America/New_York" });
  const estDate = new Date(estStr);
  const estHour = estDate.getHours();
  const estDay  = estDate.getDay();

  if (estDay === 0) {
    estDate.setDate(estDate.getDate() + 1);
  } else if (estHour >= 16) {
    estDate.setDate(estDate.getDate() + 1);
  }

  const y = estDate.getFullYear();
  const m = String(estDate.getMonth() + 1).padStart(2, "0");
  const d = String(estDate.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// ─── PENDING OPEN TRADES ──────────────────────────────────────────────────────
const pending = {};

// ─── CHART-IMG ────────────────────────────────────────────────────────────────
function getChartSymbol(symbol) {
  if (symbol.includes("BTC")) return "COINBASE:BTCUSD";
  if (symbol.includes("MGC")) return "COMEX_MINI:MGC1!";
  return "OANDA:XAUUSD";
}

function getChartLayout(symbol) {
  return symbol.includes("BTC") ? "73EEecm3" : "elAti8iP";
}

function getChartInterval(symbol) {
  return symbol.includes("BTC") ? "3m" : "5m";
}

async function getChartBuffer(symbol = "MGC1!") {
  if (!CHART_IMG_KEY) return null;
  try {
    const res = await axios.post(
      "https://api.chart-img.com/v2/tradingview/layout-chart/" + getChartLayout(symbol),
      { symbol: getChartSymbol(symbol), interval: getChartInterval(symbol) },
      { headers: { "x-api-key": CHART_IMG_KEY, "content-type": "application/json" }, responseType: "arraybuffer" }
    );
    return Buffer.from(res.data);
  } catch (err) {
    console.error("[CHART-IMG] Failed:", err.message);
    return null;
  }
}

function saveScreenshot(buffer, label) {
  const fname = `${label}_${Date.now()}.png`;
  fs.writeFileSync(path.join(SCREENS_DIR, fname), buffer);
  return `/screenshots/${fname}`;
}

// ─── TELEGRAM ─────────────────────────────────────────────────────────────────
async function sendTelegram(text) {
  await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "HTML",
  });
}

async function sendTelegramPhoto(caption, buffer) {
  const form = new FormData();
  form.append("chat_id", TELEGRAM_CHAT_ID);
  form.append("caption", caption);
  form.append("parse_mode", "HTML");
  form.append("photo", buffer, { filename: "chart.png", contentType: "image/png" });
  await axios.post(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`,
    form, { headers: form.getHeaders() }
  );
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function fmtPnl(val) {
  const n = parseFloat(val);
  return isNaN(n) ? "—" : `${n >= 0 ? "+" : "-"}$${Math.abs(n).toFixed(2)}`;
}

function fmtCts(n) {
  const c = parseInt(n);
  return isNaN(c) ? "?" : `${c} ct${c !== 1 ? "s" : ""}`;
}

function authCheck(req, res) {
  if (!WEBHOOK_SECRET) return true;
  if (req.headers["x-ala-secret"] !== WEBHOOK_SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

// ─── OPEN HANDLER ─────────────────────────────────────────────────────────────
async function handleOpen(req, res) {
  const {
    symbol = "MGC1!", interval = "5",
    entry, sl, tp, tp1,
    timestamp, risk,
    rr: payloadRR, action, type, direction,
    cts,
  } = req.body;

  // Direction MUST come from action/direction, not `type` — the new Pine script
  // repurposes `type` for RANGE_BREAKOUT/RANGE_BREAKDOWN, which is NOT a direction.
  const dir = direction
    || (action && /short/i.test(action) ? "SHORT" : null)
    || (action && /long/i.test(action)  ? "LONG"  : null)
    || (type === "LONG" || type === "SHORT" ? type : "LONG");

  console.log("[OPEN]", req.body);

  const tsNum  = parseInt(timestamp);
  const tsDate = timestamp ? (tsNum > 1e12 ? new Date(tsNum) : new Date(timestamp)) : new Date();
  const time   = tsDate.toLocaleString("en-US", { timeZone: "America/New_York", hour12: false });

  const rr = payloadRR && payloadRR !== "NaN"
    ? parseFloat(payloadRR).toFixed(2)
    : (entry && sl && tp
        ? (Math.abs(parseFloat(tp) - parseFloat(entry)) / Math.abs(parseFloat(entry) - parseFloat(sl))).toFixed(2)
        : "—");

  const emoji = dir === "SHORT" ? "🔴" : "🟢";
  const lines = [
    `${emoji} <b>ALA SIGNAL — ${dir} ${symbol}</b>`,
    ``,
    cts ? `📦 Size:     ${fmtCts(cts)}` : null,
    ``,
    `📍 Entry:    ${entry ?? "—"}`,
    `🛑 SL:       ${sl ?? "—"}`,
    tp1 ? `🎯 TP1:      ${tp1}` : null,
    `🎯 TP:       ${tp ?? "—"}`,
    `📐 R:R:      1:${rr}`,
    ``,
    `🕒 Time:     ${time} EST`,
  ].filter(Boolean);

  try {
    pending[symbol] = {
      symbol, entry, sl, tp, tp1,
      date:    getTradingDate(),
      ts:      Date.now(),
      imgOpen: null,
      risk:    risk || null,
      rr,
      direction: dir,
      cts: cts || null,
    };

    res.json({ ok: true, action: "open", symbol });
    pushEvent("entry", `${dir} Detected. Pinged Telegram`);

    const chartBuffer = await getChartBuffer(symbol);
    let imgOpen = null;
    if (chartBuffer) {
      imgOpen = saveScreenshot(chartBuffer, `open_${symbol}`);
      await sendTelegramPhoto(lines.join("\n"), chartBuffer);
    } else {
      await sendTelegram(lines.join("\n"));
    }
    if (pending[symbol]) pending[symbol].imgOpen = imgOpen;
    console.log(`[OPEN] Pending stored for ${symbol}, imgOpen: ${imgOpen}`);
  } catch (err) {
    console.error("[OPEN] Error:", err.message);
  }
}

// ─── CLOSE HANDLER (WIN or LOSS; FLATTEN gets reclassified below) ────────────
async function handleClose(req, res, resultIn) {
  const {
    symbol = "MGC1!", entry, exit, tp, sl,
    timestamp, action,
    rr: payloadRR, pnl: payloadPnl,
    type, cts, tp1_exit,
  } = req.body;

  const pnl = payloadPnl !== undefined ? parseFloat(payloadPnl) : null;

  // FLATTEN (EOD rollover) isn't its own stat category — a flatten that's
  // ahead is a win, one that's behind is a loss, same as any other close.
  // We keep the ORIGINAL reason ("eod_rollover") separately for context so
  // Telegram/the popup can still say how it closed, without needing every
  // dashboard chart to special-case a third result type.
  const isEodFlatten = resultIn === "FLATTEN";
  const result = isEodFlatten ? (pnl !== null && pnl < 0 ? "LOSS" : "WIN") : resultIn;

  console.log(`[CLOSE/${resultIn}${isEodFlatten ? " -> " + result : ""}]`, req.body);

  const tsNum  = parseInt(timestamp);
  const tsDate = timestamp ? (tsNum > 1e12 ? new Date(tsNum) : new Date(timestamp)) : new Date();
  const time   = tsDate.toLocaleString("en-US", { timeZone: "America/New_York", hour12: false });

  const pen        = pending[symbol] || {};
  const tradeEntry = (entry && entry !== "NaN") ? entry : pen.entry;
  const tradeSL    = (sl    && sl    !== "NaN") ? sl    : pen.sl;
  const tradeTP    = (tp    && tp    !== "NaN") ? tp    : pen.tp;
  const tradeDir   = pen.direction
    || (action && /short/i.test(action) ? "SHORT" : null)
    || (action && /long/i.test(action)  ? "LONG"  : null)
    || (type === "LONG" || type === "SHORT" ? type : "LONG");
  const tradeCts   = cts       || pen.cts    || null;
  const exitPrice  = exit || (result === "WIN" ? tradeTP : tradeSL) || "—";

  const rr = payloadRR && payloadRR !== "NaN"
    ? parseFloat(payloadRR).toFixed(2)
    : (tradeEntry && tradeSL && tradeTP
        ? (Math.abs(parseFloat(tradeTP) - parseFloat(tradeEntry)) / Math.abs(parseFloat(tradeEntry) - parseFloat(tradeSL))).toFixed(2)
        : null);

  // Build Telegram message
  let msgLines;
  const emoji = isEodFlatten ? "🔔" : (result === "WIN" ? "✅" : "❌");
  const closeLabel = isEodFlatten ? `EOD FLATTEN (${result})` : result;

  if (result === "WIN" && tp1_exit) {
    // Partial happened — show full breakdown
    const totalCts   = parseInt(tradeCts) || 1;
    const partialCts = Math.floor(totalCts / 2);
    const remainCts  = totalCts - partialCts;
    msgLines = [
      `${emoji} <b>ALA CLOSED — ${closeLabel} ${symbol}</b>`,
      ``,
      `📍 Entry:    ${tradeEntry ?? "—"}`,
      `📤 TP1:      ${fmtCts(partialCts)} @ ${tp1_exit}`,
      `🚪 TP2:      ${fmtCts(remainCts)} @ ${exitPrice}`,
      `💰 PnL:      ${fmtPnl(pnl)}`,
      ``,
      `🕒 Time:     ${time} EST`,
    ];
  } else {
    msgLines = [
      `${emoji} <b>ALA CLOSED — ${closeLabel} ${symbol}</b>`,
      ``,
      `📍 Entry:    ${tradeEntry ?? "—"}`,
      `🚪 Exit:     ${exitPrice}`,
      `💰 PnL:      ${fmtPnl(pnl)}`,
      ``,
      `🕒 Time:     ${time} EST`,
    ];
  }

  try {
    const chartBuffer = await getChartBuffer(symbol);
    let imgClose = null;
    if (chartBuffer) {
      imgClose = saveScreenshot(chartBuffer, `close_${symbol}`);
      await sendTelegramPhoto(msgLines.join("\n"), chartBuffer);
    } else {
      await sendTelegram(msgLines.join("\n"));
    }

    const openTrade = pending[symbol] || null;
    const imgOpen   = openTrade ? openTrade.imgOpen : null;
    if (pending[symbol]) delete pending[symbol];

    const trade = {
      symbol,
      date:      pen.date || getTradingDate(),
      entry:     tradeEntry,
      sl:        tradeSL,
      tp:        tradeTP,
      exit:      exitPrice,
      result,
      exitReason: isEodFlatten ? "eod_rollover" : (result === "WIN" ? "tp" : "sl"),
      rr,
      pnl,
      imgOpen,
      imgClose,
      risk:      pen.risk || null,
      direction: tradeDir,
      ts:        pen.ts || Date.now(),
      tsClose:   Date.now(),
      orphan:    !openTrade,
    };

    const trades = readTrades();
    trades.push(trade);
    writeTrades(trades);

    res.json({ ok: true, action: result.toLowerCase(), symbol });
    pushEvent("close", `Trade Complete. ${result} logged in Ala Logs`);
    console.log(`[CLOSE] ${result} logged. pnl: ${pnl}`);
  } catch (err) {
    console.error("[CLOSE] Error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
}

// ─── PARTIAL HANDLER — Telegram only, no log ──────────────────────────────────
async function handlePartial(req, res) {
  const {
    symbol = "MGC1!", entry, tp1, tp,
    partial_cts, partial_profit,
    timestamp,
  } = req.body;

  console.log("[PARTIAL]", req.body);

  const tsDate = timestamp
    ? (parseInt(timestamp) > 1e12 ? new Date(parseInt(timestamp)) : new Date(timestamp))
    : new Date();
  const time = tsDate.toLocaleString("en-US", { timeZone: "America/New_York", hour12: false });

  const pen        = pending[symbol] || {};
  const totalCts   = parseInt(pen.cts) || 0;
  const pCts       = parseInt(partial_cts) || Math.floor(totalCts / 2);
  const remainCts  = totalCts - pCts || "?";

  const msg = [
    `⚡ <b>ALA PARTIAL — TP1 HIT ${symbol}</b>`,
    ``,
    `📤 Exited:   ${fmtCts(pCts)} @ ${tp1 ?? "—"}  (${fmtPnl(partial_profit)})`,
    `📦 Riding:   ${fmtCts(remainCts)} → ${tp ?? "—"}`,
    `🔒 SL moved to BE`,
    ``,
    `🕒 Time:     ${time} EST`,
  ].join("\n");

  try {
    if (pending[symbol]) {
      pending[symbol].sl     = entry;
      pending[symbol].tp1Hit = true;
    }
    res.json({ ok: true, action: "partial", symbol });
    await sendTelegram(msg);
  } catch (err) {
    console.error("[PARTIAL] Error:", err.message);
  }
}

// ─── BE HANDLER — stopped at BE after partial, logs as PARTIAL ────────────────
async function handleBE(req, res) {
  const {
    symbol = "MGC1!", entry, exit, tp, sl,
    timestamp, pnl: payloadPnl, action,
    cts, tp1_exit, type,
  } = req.body;

  console.log("[BE]", req.body);

  // Resolve pending FIRST — pen must exist before msg is built
  const openTrade  = pending[symbol] || null;
  const pen        = openTrade || {};
  const tradeEntry = (entry && entry !== "NaN") ? entry : pen.entry;
  const tradeSL    = (sl    && sl    !== "NaN") ? sl    : pen.sl;
  const tradeTP    = (tp    && tp    !== "NaN") ? tp    : pen.tp;
  const tradeCts   = cts       || pen.cts    || null;
  const tradeDir   = pen.direction
    || (action && /short/i.test(action) ? "SHORT" : null)
    || (action && /long/i.test(action)  ? "LONG"  : null)
    || (type === "LONG" || type === "SHORT" ? type : "LONG");
  const pnl        = payloadPnl !== undefined ? parseFloat(payloadPnl) : null;
  const totalCts   = parseInt(tradeCts) || 1;
  const partialCts = Math.floor(totalCts / 2);
  const remainCts  = totalCts - partialCts;

  const tsDate = timestamp
    ? (parseInt(timestamp) > 1e12 ? new Date(parseInt(timestamp)) : new Date(timestamp))
    : new Date();
  const time = tsDate.toLocaleString("en-US", { timeZone: "America/New_York", hour12: false });

  const msg = [
    `⚪ <b>ALA CLOSED — BE ${symbol}</b>`,
    ``,
    `📍 Entry:    ${tradeEntry ?? "—"}`,
    `📤 TP1:      ${fmtCts(partialCts)} @ ${tp1_exit ?? "—"}`,
    `🚪 2nd half: ${fmtCts(remainCts)} stopped at BE`,
    `💰 PnL:      ${fmtPnl(pnl)}`,
    ``,
    `🕒 Time:     ${time} EST`,
  ].join("\n");

  try {
    const chartBuffer = await getChartBuffer(symbol);
    let imgClose = null;
    if (chartBuffer) {
      imgClose = saveScreenshot(chartBuffer, `close_${symbol}`);
      await sendTelegramPhoto(msg, chartBuffer);
    } else {
      await sendTelegram(msg);
    }

    if (pending[symbol]) delete pending[symbol];

    const trade = {
      symbol,
      date:      pen.date || getTradingDate(),
      entry:     tradeEntry,
      sl:        tradeSL,
      tp:        tradeTP,
      exit:      exit || tradeEntry,
      result:    "PARTIAL",
      rr:        null,
      pnl,
      imgOpen:   pen.imgOpen || null,
      imgClose,
      risk:      pen.risk || null,
      direction: tradeDir,
      ts:        pen.ts || Date.now(),
      tsClose:   Date.now(),
      orphan:    !openTrade,
    };

    const trades = readTrades();
    trades.push(trade);
    writeTrades(trades);

    res.json({ ok: true, action: "be", symbol });
    console.log(`[BE] PARTIAL logged. pnl: ${pnl}`);
  } catch (err) {
    console.error("[BE] Error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
}

// ─── RANGE DETECTED — Telegram only, NEVER logged to trades.json ─────────────
async function handleRangeDetected(req, res) {
  const { symbol = "MGC1!", high, low, timestamp } = req.body;

  console.log("[RANGE_DETECTED]", req.body);

  const tsDate = timestamp
    ? (parseInt(timestamp) > 1e12 ? new Date(parseInt(timestamp)) : new Date(timestamp))
    : new Date();
  const time = tsDate.toLocaleString("en-US", { timeZone: "America/New_York", hour12: false });

  const msg = [
    `📐 <b>ALA RANGE DETECTED — ${symbol}</b>`,
    ``,
    `🔼 High:     ${high ?? "—"}`,
    `🔽 Low:      ${low ?? "—"}`,
    ``,
    `🕒 Time:     ${time} EST`,
  ].join("\n");

  try {
    res.json({ ok: true, action: "range_detected", symbol });
    pushEvent("range_detected", `Range Detected. Pinged Telegram`);

    const chartBuffer = await getChartBuffer(symbol);
    if (chartBuffer) {
      await sendTelegramPhoto(msg, chartBuffer);
    } else {
      await sendTelegram(msg);
    }
  } catch (err) {
    console.error("[RANGE_DETECTED] Error:", err.message);
  }
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "ALA VPS online", version: "3.0.0" }));
app.use("/screenshots", express.static(SCREENS_DIR));
app.use(express.static(path.join(__dirname, "public")));

// Unified webhook — routes on string action from Pine
app.post("/signal", async (req, res) => {
  if (!authCheck(req, res)) return;
  const action = req.body.action;
  console.log("[/signal] action:", action, "body:", JSON.stringify(req.body));
  if (action === "tp")      return handleClose(req, res, "WIN");
  if (action === "sl")      return handleClose(req, res, "LOSS");
  if (action === "eod_rollover") return handleClose(req, res, "FLATTEN");
  if (action === "be")      return handleBE(req, res);
  if (action === "partial") return handlePartial(req, res);
  if (action === "range_detected") return handleRangeDetected(req, res);
  return handleOpen(req, res); // "entry" or anything unrecognized
});

// Legacy routes
app.post("/signal/open",  async (req, res) => { if (!authCheck(req, res)) return; return handleOpen(req, res); });
app.post("/signal/close", async (req, res) => { if (!authCheck(req, res)) return; return handleClose(req, res, "WIN"); });

app.get("/trades", (req, res) => res.json(readTrades()));
app.get("/events", (req, res) => res.json(readEvents()));

app.get("/settings", (req, res) => res.json(readSettings()));
app.post("/settings", (req, res) => {
  const { luneWebhook, luneStrategyId, autotrading } = req.body;
  const current = readSettings();
  const updated = {
    luneWebhook:    luneWebhook    !== undefined ? luneWebhook    : current.luneWebhook,
    luneStrategyId: luneStrategyId !== undefined ? luneStrategyId : current.luneStrategyId,
    autotrading:    autotrading    !== undefined ? autotrading    : current.autotrading,
  };
  writeSettings(updated);

  // Log to live feed only when a value actually changed — not on every save click
  const last4 = (s) => (s && s.length >= 4) ? s.slice(-4) : (s || "????");
  if (autotrading !== undefined && autotrading !== current.autotrading) {
    pushEvent("settings", `AutoTrading ${autotrading ? "ON" : "OFF"}`);
  }
  if (luneWebhook !== undefined && luneWebhook !== current.luneWebhook && luneWebhook) {
    pushEvent("settings", `LUNEFI WEBHOOK set "LUNEFI/${last4(luneWebhook)}"`);
  }
  if (luneStrategyId !== undefined && luneStrategyId !== current.luneStrategyId && luneStrategyId) {
    pushEvent("settings", `LUNEFI Strategy ID set "ST_****${last4(luneStrategyId)}"`);
  }

  res.json({ ok: true, settings: updated });
});

app.post("/log", (req, res) => {
  const trade  = { ...req.body, ts: req.body.ts || Date.now() };
  const trades = readTrades();
  trades.push(trade);
  writeTrades(trades);
  res.json({ ok: true, total: trades.length });
});

app.delete("/trades/:index", (req, res) => {
  const i = parseInt(req.params.index);
  const trades = readTrades();
  if (isNaN(i) || i < 0 || i >= trades.length) {
    return res.status(404).json({ ok: false, error: "Trade not found" });
  }
  trades.splice(i, 1);
  writeTrades(trades);
  res.json({ ok: true, total: trades.length });
});

app.listen(PORT, () => console.log(`✅ ALA VPS listening on port ${PORT}`));

require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const CHART_IMG_KEY      = process.env.CHART_IMG_KEY;
const WEBHOOK_SECRET     = process.env.WEBHOOK_SECRET;

async function sendTelegram(text, imageUrl = null) {
  const base = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
  if (imageUrl) {
    await axios.post(`${base}/sendPhoto`, {
      chat_id: TELEGRAM_CHAT_ID,
      photo: imageUrl,
      caption: text,
      parse_mode: "HTML",
    });
  } else {
    await axios.post(`${base}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: "HTML",
    });
  }
}

async function getChartImage(symbol = "OANDA:XAUUSD", interval = "5") {
  try {
    const res = await axios.post("https://api.chart-img.com/v2/tradingview/layout-chart/elAti8iP",
      { symbol: "OANDA:XAUUSD", interval: interval + "m" },
      { headers: { "x-api-key": CHART_IMG_KEY, "content-type": "application/json" }, responseType: "arraybuffer" }
    );
    return Buffer.from(res.data);
  } catch (err) {
    console.error("[CHART-IMG] Failed:", err.message);
    return null;
  }
}

async function sendTelegramPhoto(caption, imageBuffer) {
  const FormData = require("form-data");
  const form = new FormData();
  form.append("chat_id", TELEGRAM_CHAT_ID);
  form.append("caption", caption);
  form.append("parse_mode", "HTML");
  form.append("photo", imageBuffer, { filename: "chart.png", contentType: "image/png" });
  await axios.post(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`,
    form,
    { headers: form.getHeaders() }
  );
}

function fmtPnl(val) {
  const n = parseFloat(val);
  return isNaN(n) ? "—" : `${n >= 0 ? "+" : ""}$${n.toFixed(2)}`;
}

function authCheck(req, res) {
  if (!WEBHOOK_SECRET) return true;
  const incoming = req.headers["x-ala-secret"];
  if (incoming !== WEBHOOK_SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

// ─── HANDLERS ──────────────────────────────────────────────────────────────

async function handleOpen(req, res) {
  const { symbol = "XAUUSD", interval = "5", entry, sl, tp, timestamp } = req.body;
  console.log("[OPEN]", req.body);

  const time = timestamp
    ? new Date(timestamp).toLocaleString("en-US", { timeZone: "America/New_York", hour12: false })
    : new Date().toLocaleString("en-US", { timeZone: "America/New_York", hour12: false });

  const rr = entry && sl && tp
    ? (Math.abs(parseFloat(tp) - parseFloat(entry)) / Math.abs(parseFloat(entry) - parseFloat(sl))).toFixed(2)
    : "—";

  const msg = [
    `🟢 <b>ALA SIGNAL — LONG ${symbol}</b>`,
    ``,
    `📍 <b>Entry:</b>  ${entry ?? "—"}`,
    `🛑 <b>SL:</b>     ${sl ?? "—"}`,
    `🎯 <b>TP:</b>     ${tp ?? "—"}`,
    `📐 <b>R:R:</b>    1:${rr}`,
    ``,
    `⏱  <b>Time:</b>  ${time} EST`,
  ].join("\n");

  try {
    const chartBuffer = CHART_IMG_KEY ? await getChartImage(`OANDA:${symbol}`, interval) : null;
    if (chartBuffer) {
      await sendTelegramPhoto(msg, chartBuffer);
    } else {
      await sendTelegram(msg);
    }
    res.json({ ok: true, action: "open", symbol });
  } catch (err) {
    console.error("[OPEN] Error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
}

async function handleClose(req, res, code) {
  const { symbol = "XAUUSD", entry, exit, tp, sl, timestamp } = req.body;
  const isWin = code === 2;
  console.log("[CLOSE]", req.body);

  const time = timestamp
    ? new Date(timestamp).toLocaleString("en-US", { timeZone: "America/New_York", hour12: false })
    : new Date().toLocaleString("en-US", { timeZone: "America/New_York", hour12: false });

  const exitPrice = exit ?? (isWin ? tp : sl) ?? "—";
  const pnlRaw = entry && exitPrice ? parseFloat(exitPrice) - parseFloat(entry) : null;
  const pnlStr = pnlRaw !== null ? fmtPnl(pnlRaw) : "—";
  const emoji  = isWin ? "✅" : "❌";
  const result = isWin ? "WIN" : "LOSS";

  const msg = [
    `${emoji} <b>ALA CLOSED — ${result} ${symbol}</b>`,
    ``,
    `📍 <b>Entry:</b>  ${entry ?? "—"}`,
    `🚪 <b>Exit:</b>   ${exitPrice}`,
    `💰 <b>PnL:</b>    ${pnlStr} pts`,
    ``,
    `🕒 <b>Time:</b>   ${time} EST`,
  ].join("\n");

  try {
    await sendTelegram(msg);
    res.json({ ok: true, action: "close", result, symbol });
  } catch (err) {
    console.error("[CLOSE] Error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
}

// ─── ROUTES ────────────────────────────────────────────────────────────────

app.get("/", (req, res) => {
  res.json({ status: "ALA VPS online", version: "1.1.0" });
});

// Single unified webhook — TradingView sends everything here
// action codes: 1 = open, 2 = close TP (WIN), 3 = close SL (LOSS)
app.post("/signal", async (req, res) => {
  if (!authCheck(req, res)) return;
  const code = parseInt(req.body.action);
  if (code === 1)           return handleOpen(req, res);
  if (code === 2 || code === 3) return handleClose(req, res, code);
  return res.status(400).json({ ok: false, error: `Unknown action: ${req.body.action}` });
});

// Legacy endpoints (for manual test.js usage)
app.post("/signal/open",  async (req, res) => { if (!authCheck(req, res)) return; return handleOpen(req, res); });
app.post("/signal/close", async (req, res) => { if (!authCheck(req, res)) return; return handleClose(req, res, 2); });

app.listen(PORT, () => {
  console.log(`✅ ALA VPS listening on port ${PORT}`);
});

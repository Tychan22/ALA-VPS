require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ─── Config ────────────────────────────────────────────────────────────────
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const CHART_IMG_KEY      = process.env.CHART_IMG_KEY;
const WEBHOOK_SECRET     = process.env.WEBHOOK_SECRET; // optional auth header

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Send a Telegram message, optionally with a chart image attached.
 * If imageUrl is provided, sends as photo caption; otherwise sends as text.
 */
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

/**
 * Request a chart screenshot from CHART-IMG.
 * Returns the hosted image URL string, or null on failure.
 *
 * Docs: https://chart-img.com/docs
 * Free tier: symbol + interval are enough; layout is optional.
 */
async function getChartImage(symbol = "OANDA:XAUUSD", interval = "5") {
  try {
    const res = await axios.get("https://api.chart-img.com/v1/tradingview/advanced-chart", {
      params: {
        key: CHART_IMG_KEY,
        symbol,
        interval,
        width: 800,
        height: 500,
        theme: "dark",
      },
      responseType: "arraybuffer",
    });

    // CHART-IMG returns raw image bytes — upload to Telegram as buffer
    // We'll send it as a multipart upload instead of a URL
    return Buffer.from(res.data);
  } catch (err) {
    console.error("[CHART-IMG] Failed:", err.message);
    return null;
  }
}

/**
 * Send Telegram photo from a Buffer (for CHART-IMG binary response).
 */
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

/** Format a USD number with + sign for PnL */
function fmtPnl(val) {
  const n = parseFloat(val);
  return isNaN(n) ? "—" : `${n >= 0 ? "+" : ""}$${n.toFixed(2)}`;
}

/** Optional: validate webhook secret header */
function authCheck(req, res) {
  if (!WEBHOOK_SECRET) return true; // not configured, skip
  const incoming = req.headers["x-ala-secret"];
  if (incoming !== WEBHOOK_SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

// ─── Routes ────────────────────────────────────────────────────────────────

app.get("/", (req, res) => {
  res.json({ status: "ALA VPS online", version: "1.0.0" });
});

/**
 * POST /signal/open
 *
 * Expected TradingView alert JSON payload:
 * {
 *   "symbol":    "XAUUSD",
 *   "interval":  "5",
 *   "entry":     "2345.50",
 *   "sl":        "2340.00",
 *   "tp":        "2356.00",
 *   "session":   "London",
 *   "timestamp": "2024-01-15T06:32:00Z"   // optional
 * }
 */
app.post("/signal/open", async (req, res) => {
  if (!authCheck(req, res)) return;

  const { symbol = "XAUUSD", interval = "5", entry, sl, tp, session, timestamp } = req.body;
  console.log("[/signal/open]", req.body);

  // Build message
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
    `🕐 <b>Session:</b> ${session ?? "—"}`,
    `⏱  <b>Time:</b>   ${time} EST`,
  ].join("\n");

  try {
    // Fetch chart screenshot
    const chartBuffer = CHART_IMG_KEY ? await getChartImage(`OANDA:${symbol}`, interval) : null;

    if (chartBuffer) {
      await sendTelegramPhoto(msg, chartBuffer);
    } else {
      await sendTelegram(msg);
    }

    res.json({ ok: true, action: "open", symbol });
  } catch (err) {
    console.error("[/signal/open] Error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /signal/close
 *
 * Expected payload:
 * {
 *   "symbol":    "XAUUSD",
 *   "entry":     "2345.50",
 *   "exit":      "2356.00",
 *   "pnl":       "+210.00",
 *   "result":    "WIN",          // WIN | LOSS | BE
 *   "session":   "London",
 *   "duration":  "14m",          // optional
 *   "timestamp": "2024-01-15T06:46:00Z"
 * }
 */
app.post("/signal/close", async (req, res) => {
  if (!authCheck(req, res)) return;

  const { symbol = "XAUUSD", entry, exit, pnl, result, session, duration, timestamp } = req.body;
  console.log("[/signal/close]", req.body);

  const time = timestamp
    ? new Date(timestamp).toLocaleString("en-US", { timeZone: "America/New_York", hour12: false })
    : new Date().toLocaleString("en-US", { timeZone: "America/New_York", hour12: false });

  const emoji = result === "WIN" ? "✅" : result === "LOSS" ? "❌" : "⚪";
  const pnlFormatted = pnl ? fmtPnl(pnl) : "—";

  const msg = [
    `${emoji} <b>ALA CLOSED — ${result ?? "CLOSED"} ${symbol}</b>`,
    ``,
    `📍 <b>Entry:</b>    ${entry ?? "—"}`,
    `🚪 <b>Exit:</b>     ${exit ?? "—"}`,
    `💰 <b>PnL:</b>      ${pnlFormatted}`,
    ``,
    `🕐 <b>Session:</b>  ${session ?? "—"}`,
    `⏱  <b>Duration:</b> ${duration ?? "—"}`,
    `🕒 <b>Closed:</b>   ${time} EST`,
  ].join("\n");

  try {
    await sendTelegram(msg);
    res.json({ ok: true, action: "close", symbol, result });
  } catch (err) {
    console.error("[/signal/close] Error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Start ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ ALA VPS listening on port ${PORT}`);
});

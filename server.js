const http = require("http");

const PORT = 3000;

let botStatus = "stopped";
let balance = 1000;
let paperPosition = 0;
let paperEntryPrice = 0;
let autoTradeRunning = false;

let settings = {
  mode: "low-risk",
  capital: 1000
};
let priceHistory = [];
let cachedBTCPrice = null;
let cachedPriceTime = 0;
const PRICE_CACHE_MS = 300000;

async function getBTCPrice() {
  const now = Date.now();

  if (
    cachedBTCPrice !== null &&
    now - cachedPriceTime < PRICE_CACHE_MS
  ) {
    return cachedBTCPrice;
  }

  try {
    const response = await fetch(
      "https://min-api.cryptocompare.com/data/price?fsym=BTC&tsyms=USD"
    );

    if (!response.ok) {
      throw new Error(`CryptoCompare HTTP ${response.status}`);
    }

    const data = await response.json();

    if (!data.USD) {
      throw new Error("Invalid BTC price data");
    }

    cachedBTCPrice = data.USD;
    cachedPriceTime = now;

    console.log("CryptoCompare BTC price:", cachedBTCPrice);

    return cachedBTCPrice;

  } catch (error) {
    if (cachedBTCPrice !== null) {
      console.log("Using cached BTC price:", cachedBTCPrice);
      return cachedBTCPrice;
    }

    throw error;
  }
}
async function runAutoTradeCycle() {
  if (autoTradeRunning) return;

  autoTradeRunning = true;

  try {
    if (botStatus !== "active") {
      return;
    }

    const response = await fetch(
      "http://localhost:3000/analysis"
    );

    const analysis = await response.json();

    const price = analysis.price;

    if (paperPosition > 0) {
      const changePercent =
        ((price - paperEntryPrice) / paperEntryPrice) * 100;

      if (changePercent >= 2 || changePercent <= -1) {
        const sellValue = paperPosition * price;
        const profit =
          sellValue - (paperPosition * paperEntryPrice);

        balance += sellValue;

        console.log(
          `PAPER SELL: ${paperPosition.toFixed(8)} BTC at ${price} | P/L: ${profit.toFixed(2)} USDT`
        );

        paperPosition = 0;
        paperEntryPrice = 0;
      }

      return;
    }

    if (analysis.signal === "CHECK_BUY") {
      const tradeCapital = Math.min(100, balance);

      if (tradeCapital > 0) {
        paperPosition = tradeCapital / price;
        paperEntryPrice = price;
        balance -= tradeCapital;

        console.log(
          `PAPER BUY: ${paperPosition.toFixed(8)} BTC at ${price}`
        );
      }
    }
  } catch (error) {
    console.log("Auto trade cycle error:", error.message);
  } finally {
    autoTradeRunning = false;
  }
}

const server = http.createServer(async (req, res) => {

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  res.writeHead(200, {
    "Content-Type": "application/json"
  });

  if (req.method === "OPTIONS") {
    res.end();
    return;
  }

  if (req.url === "/status") {
    res.end(JSON.stringify({
      bot: botStatus,
      balance: balance,
      settings: settings
    }));
    return;
  }

  if (req.url === "/start") {
    botStatus = "active";

    res.end(JSON.stringify({
      message: "Bot started",
      bot: botStatus
    }));
    return;
  }

  if (req.url === "/stop") {
    botStatus = "stopped";

    res.end(JSON.stringify({
      message: "Bot stopped",
      bot: botStatus
    }));
    return;
  }

  if (req.url === "/settings") {
    res.end(JSON.stringify(settings));
    return;
  }

  if (req.url === "/price") {
  try {
    const price = await getBTCPrice();

    res.end(JSON.stringify({
      symbol: "BTC/USDT",
      price: price
    }));

  } catch (error) {
    console.log("PRICE ERROR:", error);

    res.end(JSON.stringify({
      error: "Could not fetch BTC price"
    }));
  }

  return;
}
    if (req.url === "/analysis") {
  try {
    const price = await getBTCPrice();
    priceHistory.push(price);

    if (priceHistory.length > 10) {
      priceHistory.shift();
    }

    let signal = "WAIT";
    let risk = "LOW";
    let confidence = 60;
    let trend = "NEUTRAL";

    if (priceHistory.length >= 2) {
      const firstPrice = priceHistory[0];

      const changePercent =
        ((price - firstPrice) / firstPrice) * 100;

      if (changePercent > 0.30) {
        trend = "UP";

        confidence = Math.min(
          85,
          Math.round(65 + changePercent * 10)
        );

        signal = confidence >= 70 ? "CHECK_BUY" : "WAIT";

      } else if (changePercent < -0.15) {
        trend = "DOWN";
        signal = "WAIT";
        confidence = 70;

      } else {
        trend = "NEUTRAL";
        signal = "WAIT";
        confidence = 60;
      }
    }

    res.end(JSON.stringify({
      symbol: "BTC/USDT",
      price: price,
      signal: signal,
      risk: risk,
      confidence: confidence,
      trend: trend,
      samples: priceHistory.length
    }));

  } catch (error) {
    console.log("Analysis error:", error.message);

    res.end(JSON.stringify({
      error: "Could not analyze BTC",
      message: "Temporary price service error"
    }));
  }

  return;
}
  if (req.url === "/paper-buy") {
    if (paperPosition > 0) {
      res.end(JSON.stringify({
        ok: false,
        message: "Paper position already open",
        balance: balance,
        position: paperPosition,
        entryPrice: paperEntryPrice
      }));
      return;
    }

    const price = await getBTCPrice();
    const tradeCapital = Math.min(100, balance);
    paperPosition = tradeCapital / price;
    paperEntryPrice = price;
    balance -= tradeCapital;

    res.end(JSON.stringify({
      ok: true,
      action: "BUY",
      price: price,
      position: paperPosition,
      entryPrice: paperEntryPrice,
      balance: balance
    }));
    return;
  }

  if (req.url === "/paper-sell") {
    if (paperPosition <= 0) {
      res.end(JSON.stringify({
        ok: false,
        message: "No paper position open",
        balance: balance
      }));
      return;
    }

    const response = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd"
    );

    const data = await response.json();
    const price = data.bitcoin.usd;

    const sellValue = paperPosition * price;
    const profit = sellValue - (paperPosition * paperEntryPrice);

    balance += sellValue;

    res.end(JSON.stringify({
      ok: true,
      action: "SELL",
      price: price,
      sellValue: Number(sellValue.toFixed(2)),
      profit: Number(profit.toFixed(2)),
      balance: Number(balance.toFixed(2))
    }));

    paperPosition = 0;
    paperEntryPrice = 0;

    return;
  }

 if (req.url === "/paper-status") {
  try {
    const response = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd"
    );

    const data = await response.json();
    const price = data.bitcoin.usd;

    let profit = 0;

    if (paperPosition > 0) {
      profit = (paperPosition * price) -
               (paperPosition * paperEntryPrice);
    }

    res.end(JSON.stringify({
      balance: balance,
      position: paperPosition,
      entryPrice: paperEntryPrice,
      currentPrice: price,
      profit: profit
    }));

  } catch (error) {
    res.end(JSON.stringify({
      balance: balance,
      position: paperPosition,
      entryPrice: paperEntryPrice,
      currentPrice: null,
      profit: null,
      error: "Could not fetch BTC price"
    }));
  }

  return;
}
  res.end(JSON.stringify({
    project: "AI-Trader Mini App",
    status: "Backend is running"
  }));

});

setInterval(() => {
  runAutoTradeCycle();
}, 15000);

server.listen(PORT, () => {
  console.log(`AI-Trader Backend running on port ${PORT}`);
});

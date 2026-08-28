const http = require("http");
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});
async function testDatabase() {
  try {
    const result = await pool.query("SELECT NOW()");
    console.log("DATABASE OK:", result.rows[0]);
  } catch (error) {
    console.log("DATABASE ERROR:", error.message);
  }
}
testDatabase();
const PORT = 3000;

let botStatus = "stopped";

// =========================
// Paper Trading
// =========================
let balance = 1000;
let paperPosition = 0;
let paperEntryPrice = 0;


// =========================
// Wallet Ledger
// =========================
let wallet = {
  currency: "USDT",
  balance: 0,
  availableBalance: 0,
  lockedBalance: 0
};

let walletTransactions = [];

// =========================
// Bot / Analysis
// =========================
let autoTradeRunning = false;

let settings = {
  mode: "low-risk",
  capital: 1000
};

let priceHistory = [];

let cachedBTCPrice = null;
let cachedPriceTime = 0;
const PRICE_CACHE_MS = 300000;

// =========================
// BTC Price
// =========================
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
      "https://api.coinpaprika.com/v1/tickers/btc-bitcoin"
    );

    if (!response.ok) {
      throw new Error(`CoinPaprika HTTP ${response.status}`);
    }

    const data = await response.json();
    const price = data?.quotes?.USD?.price;

    if (typeof price !== "number") {
      throw new Error("Invalid BTC price data");
    }

    cachedBTCPrice = price;
    cachedPriceTime = now;

    console.log("CoinPaprika BTC price:", cachedBTCPrice);

    return cachedBTCPrice;

  } catch (error) {
    if (cachedBTCPrice !== null) {
      console.log(
        "Using cached BTC price:",
        cachedBTCPrice
      );

      return cachedBTCPrice;
    }

    throw error;
  }
}

// =========================
// Auto Paper Trading
// =========================
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

    if (analysis.error || !analysis.price) {
      return;
    }

    const price = Number(analysis.price);

    // Existing paper position
    if (paperPosition > 0) {
      const changePercent =
        ((price - paperEntryPrice) /
          paperEntryPrice) * 100;

      if (
        changePercent >= 2 ||
        changePercent <= -1
      ) {
        const sellValue =
          paperPosition * price;

        const profit =
          sellValue -
          (paperPosition * paperEntryPrice);

        balance += sellValue;

        console.log(
          `PAPER SELL: ${paperPosition.toFixed(8)} BTC at ${price} | P/L: ${profit.toFixed(2)} USDT`
        );

        paperPosition = 0;
        paperEntryPrice = 0;
      }

      return;
    }

    // New paper buy
    if (analysis.signal === "CHECK_BUY") {
      const tradeCapital =
        Math.min(100, balance);

      if (tradeCapital > 0) {
        paperPosition =
          tradeCapital / price;

        paperEntryPrice = price;
        balance -= tradeCapital;

        console.log(
          `PAPER BUY: ${paperPosition.toFixed(8)} BTC at ${price}`
        );
      }
    }

  } catch (error) {
    console.log(
      "Auto trade cycle error:",
      error.message
    );

  } finally {
    autoTradeRunning = false;
  }
}

// =========================
// HTTP Server
// =========================

const server = http.createServer(
  async (req, res) => {

    res.setHeader(
      "Access-Control-Allow-Origin",
      "*"
    );

    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, OPTIONS"
    );

    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type"
    );

    res.writeHead(200, {
      "Content-Type": "application/json"
    });

    if (req.method === "OPTIONS") {
      res.end();
      return;
    }

    // =========================
    // STATUS
    // =========================
    if (req.url === "/status") {
      res.end(JSON.stringify({
        bot: botStatus,
        balance: balance,
        settings: settings
      }));

      return;
    }

    // =========================
    // START
    // =========================
    if (req.url === "/start") {
      botStatus = "active";

      res.end(JSON.stringify({
        message: "Bot started",
        bot: botStatus
      }));

      return;
    }

    // =========================
    // STOP
    // =========================
    if (req.url === "/stop") {
      botStatus = "stopped";

      res.end(JSON.stringify({
        message: "Bot stopped",
        bot: botStatus
      }));

      return;
    }

    // =========================
    // SETTINGS
    // =========================
    if (req.url === "/settings") {
      res.end(JSON.stringify(settings));
      return;
    }

    // =========================
    // BTC PRICE
    // =========================
    if (req.url === "/price") {
      try {
        const price =
          await getBTCPrice();

        res.end(JSON.stringify({
          symbol: "BTC/USDT",
          price: price
        }));

      } catch (error) {
        console.log(
          "PRICE ERROR:",
          error.message
        );

        res.end(JSON.stringify({
          error: "Could not fetch BTC price"
        }));
      }

      return;
    }

    // =========================
    // AI ANALYSIS
    // =========================
    if (req.url === "/analysis") {
      try {
        const price =
          await getBTCPrice();

        priceHistory.push(price);

        if (priceHistory.length > 10) {
          priceHistory.shift();
        }

        let signal = "WAIT";
        let risk = "LOW";
        let confidence = 60;
        let trend = "NEUTRAL";

        if (priceHistory.length >= 2) {

          const firstPrice =
            priceHistory[0];

          const changePercent =
            ((price - firstPrice) /
              firstPrice) * 100;

          if (changePercent > 0.30) {

            trend = "UP";

            confidence =
              Math.min(
                85,
                Math.round(
                  65 +
                  changePercent * 10
                )
              );

            signal =
              confidence >= 70
                ? "CHECK_BUY"
                : "WAIT";

          } else if (
            changePercent < -0.15
          ) {

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

        console.log(
          "Analysis error:",
          error.message
        );

        res.end(JSON.stringify({
          error: "Could not analyze BTC",
          message:
            "Temporary price service error"
        }));
      }

      return;
    }

    // =========================
    // WALLET STATUS
    // =========================
    if (req.url === "/wallet-status") {

  try {
    const result = await pool.query(`
      SELECT
        w.balance,
        w.locked_balance,
        w.currency
      FROM wallets w
      JOIN users u ON u.id = w.user_id
      WHERE u.telegram_id = $1
      LIMIT 1
    `, [999999999]);

    if (result.rows.length === 0) {
      res.end(JSON.stringify({
        ok: false,
        message: "Wallet not found"
      }));
      return;
    }

    const row = result.rows[0];
    const balance = Number(row.balance);
    const lockedBalance = Number(row.locked_balance);
    const availableBalance = balance - lockedBalance;

    res.end(JSON.stringify({
      ok: true,
      balance: Number(balance.toFixed(2)),
      availableBalance: Number(availableBalance.toFixed(2)),
      lockedBalance: Number(lockedBalance.toFixed(2)),
      currency: row.currency
    }));

  } catch (error) {
    console.log("WALLET STATUS DATABASE ERROR:", error.message);

    res.end(JSON.stringify({
      ok: false,
      message: "Database error"
    }));
  }

  return;
}

    // =========================
    // WALLET DEPOSIT - TEST
    // =========================
    if (req.url === "/wallet-deposit") {

  const amount = 100;

  try {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const walletResult = await client.query(`
        SELECT
          w.id,
          w.balance,
          w.locked_balance,
          w.currency
        FROM wallets w
        JOIN users u ON u.id = w.user_id
        WHERE u.telegram_id = $1
        FOR UPDATE
      `, [999999999]);

      if (walletResult.rows.length === 0) {
        await client.query("ROLLBACK");

        res.end(JSON.stringify({
          ok: false,
          message: "Wallet not found"
        }));

        return;
      }

      const row = walletResult.rows[0];
      const oldBalance = Number(row.balance);
      const newBalance = oldBalance + amount;

      await client.query(`
        UPDATE wallets
        SET balance = $1,
            updated_at = NOW()
        WHERE id = $2
      `, [newBalance, row.id]);

      await client.query(`
        INSERT INTO wallet_transactions
          (user_id, type, amount, currency, status, description)
        SELECT
          u.id, 'DEPOSIT', $1, $2, 'COMPLETED', 'Test deposit'
        FROM users u
        WHERE u.telegram_id = $3
      `, [amount, row.currency, 999999999]);

      await client.query("COMMIT");

      const lockedBalance = Number(row.locked_balance);

      res.end(JSON.stringify({
        ok: true,
        action: "DEPOSIT",
        amount: amount,
        balance: Number(newBalance.toFixed(2)),
        availableBalance: Number(
          (newBalance - lockedBalance).toFixed(2)
        ),
        lockedBalance: Number(lockedBalance.toFixed(2)),
        currency: row.currency
      }));

    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

  } catch (error) {
    console.log("WALLET DEPOSIT DATABASE ERROR:", error.message);

    res.end(JSON.stringify({
      ok: false,
      message: "Database error"
    }));
  }

  return;
}

    // =========================
    // WALLET WITHDRAW - TEST
    // =========================
    if (req.url === "/wallet-withdraw") {

  const amount = 20;

  if (amount > wallet.availableBalance) {

    res.end(JSON.stringify({
      ok: false,
      message: "Insufficient available wallet balance",
      balance: Number(wallet.balance.toFixed(2)),
      availableBalance: Number(wallet.availableBalance.toFixed(2)),
      lockedBalance: Number(wallet.lockedBalance.toFixed(2)),
      currency: wallet.currency
    }));

    return;
  }

  wallet.availableBalance -= amount;
  wallet.lockedBalance += amount;

  walletTransactions.push({
    id: Date.now(),
    type: "WITHDRAW",
    amount: amount,
    currency: wallet.currency,
    status: "PENDING",
    timestamp: new Date().toISOString()
  });

  res.end(JSON.stringify({
    ok: true,
    action: "WITHDRAW",
    amount: amount,
    balance: Number(wallet.balance.toFixed(2)),
    availableBalance: Number(wallet.availableBalance.toFixed(2)),
    lockedBalance: Number(wallet.lockedBalance.toFixed(2)),
    status: "PENDING",
    currency: wallet.currency
  }));

  return;
}

    // =========================
    // WALLET TRANSACTIONS
    // =========================
    if (req.url === "/wallet-transactions") {

      try {
        const result = await pool.query(`
          SELECT
            wt.id,
            wt.type,
            wt.amount,
            wt.currency,
            wt.status,
            wt.description,
            wt.created_at
          FROM wallet_transactions wt
          JOIN users u ON u.id = wt.user_id
          WHERE u.telegram_id = $1
          ORDER BY wt.created_at DESC
        `, [999999999]);

        res.end(JSON.stringify({
          ok: true,
          currency: "USDT",
          transactions: result.rows
        }));

      } catch (error) {
        console.log(
          "WALLET TRANSACTIONS DATABASE ERROR:",
          error.message
        );

        res.end(JSON.stringify({
          ok: false,
          message: "Database error",
          transactions: []
        }));
      }

      return;
    }

// =========================
// WALLET CONFIRM WITHDRAW
// =========================
// =========================
// WALLET CONFIRM WITHDRAW
// =========================
const confirmUrl = new URL(
  req.url,
  "http://localhost"
);

if (confirmUrl.pathname === "/wallet-confirm-withdraw") {

  const transactionId =
    Number(confirmUrl.searchParams.get("id"));

  if (!transactionId) {

    res.end(JSON.stringify({
      ok: false,
      message: "Transaction id is required",
      currency: wallet.currency
    }));

    return;
  }

  const pendingTransaction =
    walletTransactions.find(
      tx =>
        tx.id === transactionId &&
        tx.type === "WITHDRAW" &&
        tx.status === "PENDING"
    );

  if (!pendingTransaction) {

    res.end(JSON.stringify({
      ok: false,
      message: "Pending withdrawal not found",
      transactionId: transactionId,
      balance:
        Number(wallet.balance.toFixed(2)),
      availableBalance:
        Number(wallet.availableBalance.toFixed(2)),
      lockedBalance:
        Number(wallet.lockedBalance.toFixed(2)),
      currency: wallet.currency
    }));

    return;
  }

  const amount =
    Number(pendingTransaction.amount);

  if (amount > wallet.lockedBalance) {

    res.end(JSON.stringify({
      ok: false,
      message: "Locked balance is insufficient",
      transactionId: transactionId,
      balance:
        Number(wallet.balance.toFixed(2)),
      availableBalance:
        Number(wallet.availableBalance.toFixed(2)),
      lockedBalance:
        Number(wallet.lockedBalance.toFixed(2)),
      currency: wallet.currency
    }));

    return;
  }

  wallet.balance -= amount;
  wallet.lockedBalance -= amount;

  pendingTransaction.status =
    "COMPLETED";

  pendingTransaction.confirmedAt =
    new Date().toISOString();

  res.end(JSON.stringify({
    ok: true,
    action: "WITHDRAW_CONFIRMED",
    transactionId: transactionId,
    amount: amount,
    balance:
      Number(wallet.balance.toFixed(2)),
    availableBalance:
      Number(wallet.availableBalance.toFixed(2)),
    lockedBalance:
      Number(wallet.lockedBalance.toFixed(2)),
    status:
      pendingTransaction.status,
    currency: wallet.currency
  }));

  return;
}

    // =========================
    // PAPER BUY
    // =========================
    if (req.url === "/paper-buy") {

      if (paperPosition > 0) {

        res.end(JSON.stringify({
          ok: false,
          message:
            "Paper position already open",

          balance: balance,
          position: paperPosition,
          entryPrice:
            paperEntryPrice
        }));

        return;
      }

      try {

        const price =
          await getBTCPrice();

        const tradeCapital =
          Math.min(100, balance);

        if (tradeCapital <= 0) {

          res.end(JSON.stringify({
            ok: false,
            message:
              "Insufficient paper balance",
            balance: balance
          }));

          return;
        }

        paperPosition =
          tradeCapital / price;

        paperEntryPrice = price;

        balance -= tradeCapital;

        res.end(JSON.stringify({
          ok: true,
          action: "BUY",
          price: price,
          position: paperPosition,
          entryPrice:
            paperEntryPrice,
          balance: balance
        }));

      } catch (error) {

        res.end(JSON.stringify({
          ok: false,
          message:
            "Could not fetch BTC price"
        }));
      }

      return;
    }

    // =========================
    // PAPER SELL
    // =========================
    if (req.url === "/paper-sell") {

      if (paperPosition <= 0) {

        res.end(JSON.stringify({
          ok: false,
          message:
            "No paper position open",
          balance: balance
        }));

        return;
      }

      try {

        const price =
          await getBTCPrice();

        const sellValue =
          paperPosition * price;

        const profit =
          sellValue -
          (
            paperPosition *
            paperEntryPrice
          );

        balance += sellValue;

        res.end(JSON.stringify({
          ok: true,
          action: "SELL",
          price: price,

          sellValue:
            Number(
              sellValue.toFixed(2)
            ),

          profit:
            Number(
              profit.toFixed(2)
            ),

          balance:
            Number(
              balance.toFixed(2)
            )
        }));

        paperPosition = 0;
        paperEntryPrice = 0;

      } catch (error) {

        res.end(JSON.stringify({
          ok: false,
          message:
            "Could not fetch BTC price"
        }));
      }

      return;
    }

    // =========================
    // PAPER STATUS
    // =========================
    if (req.url === "/paper-status") {

      try {

        const price =
          await getBTCPrice();

        let profit = 0;

        if (
          paperPosition > 0 &&
          paperEntryPrice > 0
        ) {

          profit =
            (
              paperPosition * price
            ) -
            (
              paperPosition *
              paperEntryPrice
            );
        }

        res.end(JSON.stringify({

          balance:
            Number(
              balance.toFixed(2)
            ),

          position:
            paperPosition,

          entryPrice:
            paperEntryPrice,

          currentPrice:
            price,

          profit:
            Number(
              profit.toFixed(2)
            )
        }));

      } catch (error) {

        res.end(JSON.stringify({

          balance:
            Number(
              balance.toFixed(2)
            ),

          position:
            paperPosition,

          entryPrice:
            paperEntryPrice,

          currentPrice: null,

          profit: null,

          error:
            "Could not fetch BTC price"
        }));
      }

      return;
    }

    // =========================
    // DEFAULT
    // =========================
    res.end(JSON.stringify({
      project:
        "AI-Trader Mini App",

      status:
        "Backend is running"
    }));
  }
);

// =========================
// Auto Trade Cycle
// =========================
setInterval(() => {
  runAutoTradeCycle();
}, 15000);

// =========================
// Start Server
// =========================
server.listen(
  PORT,
  () => {
    console.log(
      `AI-Trader Backend running on port ${PORT}`
    );
  }
);

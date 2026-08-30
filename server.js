const http = require("http");
const BOT_TOKEN = process.env.BOT_TOKEN;
const crypto = require("crypto");
const { Pool } = require("pg");
const { TronWeb } = require("tronweb");


function validateTelegramInitData(initData) {
  if (!BOT_TOKEN || !initData) return null;

  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");

    if (!hash) return null;

    params.delete("hash");

    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");

    const secretKey = crypto
      .createHmac("sha256", "WebAppData")
      .update(BOT_TOKEN)
      .digest();

    const calculatedHash = crypto
      .createHmac("sha256", secretKey)
      .update(dataCheckString)
      .digest("hex");

    if (calculatedHash !== hash) return null;

    const user = params.get("user");
    if (!user) return null;

    const telegramUser = JSON.parse(user);
    console.log("TELEGRAM AUTH OK ID:", telegramUser.id);
    return telegramUser;

  } catch (error) {
    console.log("TELEGRAM AUTH ERROR:", error.message);
    return null;
  }
}


function getTelegramUserFromRequest(req) {
  const initData = req.headers["x-telegram-init-data"];

  if (!initData) return null;

  return validateTelegramInitData(initData);
}


async function getOrCreateTelegramWallet(telegramUser) {
  if (!telegramUser || !telegramUser.id) {
    return null;
  }

  const telegramId = String(telegramUser.id);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const userResult = await client.query(`
      INSERT INTO users (telegram_id)
      VALUES ($1)
      ON CONFLICT (telegram_id)
      DO UPDATE SET telegram_id = EXCLUDED.telegram_id
      RETURNING id, telegram_id
    `, [telegramId]);

    const user = userResult.rows[0];

    const walletResult = await client.query(`
      INSERT INTO wallets (user_id, balance, locked_balance, currency)
      VALUES ($1, 0, 0, 'USDT')
      ON CONFLICT (user_id)
      DO UPDATE SET user_id = EXCLUDED.user_id
      RETURNING id, user_id, balance, locked_balance, currency
    `, [user.id]);

    await client.query("COMMIT");

    return {
      user,
      wallet: walletResult.rows[0]
    };

  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

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

async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        telegram_id BIGINT UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS wallets (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        balance NUMERIC(20,8) NOT NULL DEFAULT 0,
        locked_balance NUMERIC(20,8) NOT NULL DEFAULT 0,
        currency VARCHAR(10) NOT NULL DEFAULT 'USDT',
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id)
      );

      ALTER TABLE wallets
      ADD COLUMN IF NOT EXISTS tron_address TEXT;

      ALTER TABLE wallets
      ADD COLUMN IF NOT EXISTS tron_network VARCHAR(20) DEFAULT 'TRC20';

      ALTER TABLE wallets
      ADD COLUMN IF NOT EXISTS deposit_enabled BOOLEAN DEFAULT FALSE;

      CREATE TABLE IF NOT EXISTS wallet_transactions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        type VARCHAR(20) NOT NULL,
        amount NUMERIC(20,8) NOT NULL,
        currency VARCHAR(10) NOT NULL DEFAULT 'USDT',
        status VARCHAR(20) NOT NULL,
        description TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS trades (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        symbol VARCHAR(20) NOT NULL DEFAULT 'BTC/USDT',
        side VARCHAR(10) NOT NULL,
        price NUMERIC(20,8) NOT NULL,
        quantity NUMERIC(20,8) NOT NULL,
        amount NUMERIC(20,8) NOT NULL,
        profit NUMERIC(20,8) DEFAULT 0,
        status VARCHAR(20) NOT NULL DEFAULT 'OPEN',
        created_at TIMESTAMP DEFAULT NOW(),
        closed_at TIMESTAMP
      );

      INSERT INTO users (telegram_id)
      VALUES (999999999)
      ON CONFLICT (telegram_id) DO NOTHING;

      INSERT INTO wallets (user_id, balance, locked_balance, currency)
      SELECT id, 0, 0, 'USDT'
      FROM users
      WHERE telegram_id = 999999999
      ON CONFLICT (user_id) DO NOTHING;
    `);

    console.log("DATABASE TABLES OK");
  } catch (error) {
    console.log("DATABASE INIT ERROR:", error);
  }
}

initDatabase();
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
      "Content-Type, X-Telegram-Init-Data"
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
      console.log("WALLET STATUS REQUEST RECEIVED");

  const telegramUser = getTelegramUserFromRequest(req);

  if (!telegramUser) {
    res.end(JSON.stringify({
      ok: false,
      message: "Telegram authentication required"
    }));
    return;
  }

  try {
    const walletData =
      await getOrCreateTelegramWallet(telegramUser);

    if (!walletData) {
      res.end(JSON.stringify({
        ok: false,
        message: "Telegram user not found"
      }));
      return;
    }

    const row = walletData.wallet;


    
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
    // =========================
    // WALLET TRON ADDRESS
    // =========================
    if (req.url === "/wallet-tron-address") {
      const telegramUser = getTelegramUserFromRequest(req);

      if (!telegramUser) {
        res.end(JSON.stringify({
          ok: false,
          message: "Telegram authentication required"
        }));
        return;
      }

      try {
        const result = await getOrCreateTelegramWallet(telegramUser);
        const wallet = result.wallet;

        if (wallet.tron_address) {
          res.end(JSON.stringify({
            ok: true,
            network: wallet.tron_network || "TRC20",
            address: wallet.tron_address,
            testOnly: true
          }));
          return;
        }

        const account = TronWeb.createRandom();

        const updated = await pool.query(
          `UPDATE wallets
           SET tron_address = $1,
               tron_network = 'TRC20',
               deposit_enabled = true,
               updated_at = NOW()
           WHERE id = $2
           RETURNING tron_address, tron_network, deposit_enabled`,
          [account.address, wallet.id]
        );

        res.end(JSON.stringify({
          ok: true,
          network: updated.rows[0].tron_network,
          address: updated.rows[0].tron_address,
          testOnly: true
        }));

      } catch (error) {
        console.log("TRON ADDRESS ERROR:", error.message);

        res.end(JSON.stringify({
          ok: false,
          message: "Could not create or save TRON address"
        }));
      }

      return;
    }

    // WALLET DEPOSIT - TEST
    // =========================
    const depositUrl = new URL(req.url, "http://localhost");
    if (depositUrl.pathname === "/wallet-deposit") {

  const amount = Number(depositUrl.searchParams.get("amount"));

  if (Number.isFinite(amount) === false || amount <= 0) {
    res.end(JSON.stringify({ok:false,message:"Invalid deposit amount"}));
    return;
  }

  try {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const telegramUser = getTelegramUserFromRequest(req);

      if (!telegramUser) {
        await client.query("ROLLBACK");

        res.end(JSON.stringify({
          ok: false,
          message: "Telegram authentication required"
        }));

        return;
      }

      const walletData =
        await getOrCreateTelegramWallet(telegramUser);

      if (!walletData) {
        await client.query("ROLLBACK");

        res.end(JSON.stringify({
          ok: false,
          message: "Telegram wallet could not be created"
        }));

        return;
      }

      const walletResult = await client.query(`
        SELECT
          w.id,
          w.balance,
          w.locked_balance,
          w.currency
        FROM wallets w
        WHERE w.user_id = $1
        FOR UPDATE
      `, [walletData.user.id]);

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
    const withdrawUrl = new URL(req.url, "http://localhost");

    if (withdrawUrl.pathname === "/wallet-withdraw") {

  const amount = Number(withdrawUrl.searchParams.get("amount"));
  
  if (!Number.isFinite(amount) || amount <= 0) {
    res.end(JSON.stringify({
      ok: false,
      message: "Invalid withdrawal amount"
    }));
    return;
  }

  try {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const telegramUser = getTelegramUserFromRequest(req);

      if (!telegramUser) {
        await client.query("ROLLBACK");

        res.end(JSON.stringify({
          ok: false,
          message: "Telegram authentication required"
        }));

        return;
      }

      const walletData =
        await getOrCreateTelegramWallet(telegramUser);

      if (!walletData) {
        await client.query("ROLLBACK");

        res.end(JSON.stringify({
          ok: false,
          message: "Telegram wallet could not be created"
        }));

        return;
      }

      const walletResult = await client.query(`
        SELECT
          w.id,
          w.user_id,
          w.balance,
          w.locked_balance,
          w.currency
        FROM wallets w
        WHERE w.user_id = $1
        FOR UPDATE
      `, [walletData.user.id]);

      if (walletResult.rows.length === 0) {
        await client.query("ROLLBACK");

        res.end(JSON.stringify({
          ok: false,
          message: "Wallet not found"
        }));

        return;
      }

      const row = walletResult.rows[0];
      const balance = Number(row.balance);
      const lockedBalance = Number(row.locked_balance);
      const availableBalance = balance - lockedBalance;

      if (amount > availableBalance) {
        await client.query("ROLLBACK");

        res.end(JSON.stringify({
          ok: false,
          message: "Insufficient available wallet balance",
          balance: Number(balance.toFixed(2)),
          availableBalance: Number(availableBalance.toFixed(2)),
          lockedBalance: Number(lockedBalance.toFixed(2)),
          currency: row.currency
        }));

        return;
      }

      const newLockedBalance = lockedBalance + amount;

      await client.query(`
        UPDATE wallets
        SET locked_balance = $1,
            updated_at = NOW()
        WHERE id = $2
      `, [newLockedBalance, row.id]);

      const transactionResult = await client.query(`
        INSERT INTO wallet_transactions
          (user_id, type, amount, currency, status, description)
        VALUES
          ($1, 'WITHDRAW', $2, $3, 'PENDING', 'Test withdrawal')
        RETURNING id, created_at
      `, [
        row.user_id,
        amount,
        row.currency
      ]);

      await client.query("COMMIT");

      res.end(JSON.stringify({
        ok: true,
        action: "WITHDRAW",
        transactionId: transactionResult.rows[0].id,
        amount: amount,
        balance: Number(balance.toFixed(2)),
        availableBalance: Number(
          (balance - newLockedBalance).toFixed(2)
        ),
        lockedBalance: Number(newLockedBalance.toFixed(2)),
        status: "PENDING",
        currency: row.currency
      }));

    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

  } catch (error) {
    console.log(
      "WALLET WITHDRAW DATABASE ERROR:",
      error.message
    );

    res.end(JSON.stringify({
      ok: false,
      message: "Database error"
    }));
  }

  return;
}

    // =========================
    // WALLET TRANSACTIONS
    // =========================
    if (req.url === "/wallet-transactions") {

      try {

        const telegramUser = getTelegramUserFromRequest(req);

        if (!telegramUser) {
          res.end(JSON.stringify({
            ok: false,
            message: "Telegram authentication required",
            transactions: []
          }));
          return;
        }

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
        `, [String(telegramUser.id)]);

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
      message: "Transaction id is required"
    }));
    return;
  }

  try {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const telegramUser = getTelegramUserFromRequest(req);

      if (!telegramUser) {
        await client.query("ROLLBACK");

        res.end(JSON.stringify({
          ok: false,
          message: "Telegram authentication required"
        }));

        return;
      }

      const walletData =
        await getOrCreateTelegramWallet(telegramUser);

      if (!walletData) {
        await client.query("ROLLBACK");

        res.end(JSON.stringify({
          ok: false,
          message: "Telegram wallet could not be created"
        }));

        return;
      }

      const transactionResult = await client.query(`
        SELECT
          wt.id,
          wt.user_id,
          wt.amount,
          wt.currency,
          wt.status
        FROM wallet_transactions wt
        WHERE wt.id = $1
          AND wt.user_id = $2
          AND wt.type = 'WITHDRAW'
          AND wt.status = 'PENDING'
        FOR UPDATE
      `, [transactionId, walletData.user.id]);

      if (transactionResult.rows.length === 0) {
        await client.query("ROLLBACK");

        res.end(JSON.stringify({
          ok: false,
          message: "Pending withdrawal not found",
          transactionId: transactionId
        }));

        return;
      }

      const transaction =
        transactionResult.rows[0];

      const amount =
        Number(transaction.amount);

      const walletResult = await client.query(`
        SELECT
          id,
          balance,
          locked_balance,
          currency
        FROM wallets
        WHERE user_id = $1
        FOR UPDATE
      `, [transaction.user_id]);

      if (walletResult.rows.length === 0) {
        await client.query("ROLLBACK");

        res.end(JSON.stringify({
          ok: false,
          message: "Wallet not found",
          transactionId: transactionId
        }));

        return;
      }

      const walletRow =
        walletResult.rows[0];

      const balance =
        Number(walletRow.balance);

      const lockedBalance =
        Number(walletRow.locked_balance);

      if (amount > lockedBalance) {
        await client.query("ROLLBACK");

        res.end(JSON.stringify({
          ok: false,
          message: "Locked balance is insufficient",
          transactionId: transactionId,
          balance: Number(balance.toFixed(2)),
          availableBalance:
            Number(
              (balance - lockedBalance).toFixed(2)
            ),
          lockedBalance:
            Number(lockedBalance.toFixed(2)),
          currency: walletRow.currency
        }));

        return;
      }

      const newBalance =
        balance - amount;

      const newLockedBalance =
        lockedBalance - amount;

      await client.query(`
        UPDATE wallets
        SET balance = $1,
            locked_balance = $2,
            updated_at = NOW()
        WHERE id = $3
      `, [
        newBalance,
        newLockedBalance,
        walletRow.id
      ]);

      await client.query(`
        UPDATE wallet_transactions
        SET status = 'COMPLETED'
        WHERE id = $1
      `, [transactionId]);

      await client.query("COMMIT");

      res.end(JSON.stringify({
        ok: true,
        action: "WITHDRAW_CONFIRMED",
        transactionId: transactionId,
        amount: amount,
        balance:
          Number(newBalance.toFixed(2)),
        availableBalance:
          Number(
            (newBalance - newLockedBalance).toFixed(2)
          ),
        lockedBalance:
          Number(newLockedBalance.toFixed(2)),
        status: "COMPLETED",
        currency: walletRow.currency
      }));

    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

  } catch (error) {
    console.log(
      "WALLET CONFIRM WITHDRAW DATABASE ERROR:",
      error.message
    );

    res.end(JSON.stringify({
      ok: false,
      message: "Database error"
    }));
  }

  return;
}

    // =========================
    // TRADE BUY
    // =========================
    if (req.url.startsWith("/trade-buy")) {

      const tradeUrl = new URL(
        req.url,
        `http://${req.headers.host || "localhost"}`
      );

      const amount = Number(
        tradeUrl.searchParams.get("amount")
      );

      if (!Number.isFinite(amount) || amount <= 0) {
        res.end(JSON.stringify({
          ok: false,
          message: "Invalid trade amount"
        }));
        return;
      }

      const telegramUser =
        getTelegramUserFromRequest(req);

      if (!telegramUser) {
        res.end(JSON.stringify({
          ok: false,
          message: "Telegram authentication required"
        }));
        return;
      }

      let client;

      try {

        // Find/create the Telegram user BEFORE
        // opening the trade transaction.
        const telegramId =
          String(telegramUser.id);

        client = await pool.connect();

        const userResult =
          await client.query(`
            INSERT INTO users (telegram_id)
            VALUES ($1)
            ON CONFLICT (telegram_id)
            DO UPDATE SET telegram_id = EXCLUDED.telegram_id
            RETURNING id, telegram_id
          `, [telegramId]);

        const user =
          userResult.rows[0];

        // Ensure wallet exists.
        await client.query(`
          INSERT INTO wallets
            (user_id, balance, locked_balance, currency)
          VALUES
            ($1, 0, 0, 'USDT')
          ON CONFLICT (user_id)
          DO NOTHING
        `, [user.id]);

        await client.query("BEGIN");

        // Lock this user's wallet for the entire trade.
        const walletResult =
          await client.query(`
            SELECT
              id,
              user_id,
              balance,
              locked_balance,
              currency
            FROM wallets
            WHERE user_id = $1
            FOR UPDATE
          `, [user.id]);

        if (walletResult.rows.length === 0) {
          await client.query("ROLLBACK");

          res.end(JSON.stringify({
            ok: false,
            message: "Wallet not found"
          }));

          return;
        }

        const wallet =
          walletResult.rows[0];

        const balance =
          Number(wallet.balance);

        const lockedBalance =
          Number(wallet.locked_balance);

        const availableBalance =
          balance - lockedBalance;

        if (amount > availableBalance) {
          await client.query("ROLLBACK");

          res.end(JSON.stringify({
            ok: false,
            message: "Insufficient available wallet balance",
            balance:
              Number(balance.toFixed(2)),
            availableBalance:
              Number(availableBalance.toFixed(2)),
            lockedBalance:
              Number(lockedBalance.toFixed(2)),
            currency:
              wallet.currency
          }));

          return;
        }

        const price =
          await getBTCPrice();

        if (
          !Number.isFinite(price) ||
          price <= 0
        ) {
          await client.query("ROLLBACK");

          res.end(JSON.stringify({
            ok: false,
            message: "Invalid BTC price"
          }));

          return;
        }

        const quantity =
          amount / price;

        const newLockedBalance =
          lockedBalance + amount;

        await client.query(`
          UPDATE wallets
          SET
            locked_balance = $1,
            updated_at = NOW()
          WHERE id = $2
        `, [
          newLockedBalance,
          wallet.id
        ]);

        const tradeResult =
          await client.query(`
            INSERT INTO trades
              (
                user_id,
                symbol,
                side,
                price,
                quantity,
                amount,
                profit,
                status
              )
            VALUES
              (
                $1,
                'BTC/USDT',
                'BUY',
                $2,
                $3,
                $4,
                0,
                'OPEN'
              )
            RETURNING
              id,
              symbol,
              side,
              price,
              quantity,
              amount,
              profit,
              status,
              created_at
          `, [
            wallet.user_id,
            price,
            quantity,
            amount
          ]);

        await client.query(`
          INSERT INTO wallet_transactions
            (
              user_id,
              type,
              amount,
              currency,
              status,
              description
            )
          VALUES
            (
              $1,
              'TRADE_BUY',
              $2,
              $3,
              'COMPLETED',
              'BTC/USDT trade buy'
            )
        `, [
          wallet.user_id,
          amount,
          wallet.currency
        ]);

        await client.query("COMMIT");

        res.end(JSON.stringify({
          ok: true,
          action: "BUY",
          trade:
            tradeResult.rows[0],
          balance:
            Number(balance.toFixed(2)),
          availableBalance:
            Number(
              (balance - newLockedBalance)
                .toFixed(2)
            ),
          lockedBalance:
            Number(
              newLockedBalance.toFixed(2)
            ),
          currency:
            wallet.currency
        }));

      } catch (error) {

        if (client) {
          try {
            await client.query("ROLLBACK");
          } catch (_) {}
        }

        console.log(
          "TRADE BUY DATABASE ERROR:",
          error.message
        );

        res.end(JSON.stringify({
          ok: false,
          message: "Trade buy database error"
        }));

      } finally {

        if (client) {
          client.release();
        }
      }

      return;
    }

    // =========================
    // TRADE SELL
    // =========================
    if (req.url.startsWith("/trade-sell")) {

      const telegramUser =
        getTelegramUserFromRequest(req);

      if (!telegramUser) {
        res.end(JSON.stringify({
          ok: false,
          message: "Telegram authentication required"
        }));
        return;
      }

      let client;

      try {

        client = await pool.connect();

        const telegramId =
          String(telegramUser.id);

        const userResult =
          await client.query(`
            SELECT id
            FROM users
            WHERE telegram_id = $1
          `, [telegramId]);

        if (userResult.rows.length === 0) {
          res.end(JSON.stringify({
            ok: false,
            message: "Telegram user not found"
          }));
          return;
        }

        const userId =
          userResult.rows[0].id;

        await client.query("BEGIN");

        const tradeResult =
          await client.query(`
            SELECT
              id,
              user_id,
              symbol,
              side,
              price,
              quantity,
              amount,
              profit,
              status
            FROM trades
            WHERE user_id = $1
              AND side = 'BUY'
              AND status = 'OPEN'
            ORDER BY id DESC
            LIMIT 1
            FOR UPDATE
          `, [userId]);

        if (tradeResult.rows.length === 0) {

          await client.query("ROLLBACK");

          res.end(JSON.stringify({
            ok: false,
            message: "No open trade found"
          }));

          return;
        }

        const trade =
          tradeResult.rows[0];

        const sellPrice =
          await getBTCPrice();

        if (
          !Number.isFinite(sellPrice) ||
          sellPrice <= 0
        ) {
          await client.query("ROLLBACK");

          res.end(JSON.stringify({
            ok: false,
            message: "Invalid BTC price"
          }));

          return;
        }

        const quantity =
          Number(trade.quantity);

        const buyAmount =
          Number(trade.amount);

        const sellValue =
          quantity * sellPrice;

        const profit =
          sellValue - buyAmount;

        const walletResult =
          await client.query(`
            SELECT
              id,
              balance,
              locked_balance,
              currency
            FROM wallets
            WHERE user_id = $1
            FOR UPDATE
          `, [userId]);

        if (walletResult.rows.length === 0) {

          await client.query("ROLLBACK");

          res.end(JSON.stringify({
            ok: false,
            message: "Wallet not found"
          }));

          return;
        }

        const wallet =
          walletResult.rows[0];

        const balance =
          Number(wallet.balance);

        const lockedBalance =
          Number(wallet.locked_balance);

        const newLockedBalance =
          Math.max(
            0,
            lockedBalance - buyAmount
          );

        const newBalance =
          balance + sellValue;

        await client.query(`
          UPDATE wallets
          SET balance = $1,
              locked_balance = $2,
              updated_at = NOW()
          WHERE id = $3
        `, [
          newBalance,
          newLockedBalance,
          wallet.id
        ]);

        const closedTradeResult =
          await client.query(`
            UPDATE trades
            SET profit = $1,
                status = 'CLOSED',
                closed_at = NOW()
            WHERE id = $2
            RETURNING
              id,
              symbol,
              side,
              price,
              quantity,
              amount,
              profit,
              status,
              created_at,
              closed_at
          `, [
            profit,
            trade.id
          ]);

        await client.query(`
          INSERT INTO wallet_transactions
            (
              user_id,
              type,
              amount,
              currency,
              status,
              description
            )
          VALUES
            (
              $1,
              'TRADE_SELL',
              $2,
              $3,
              'COMPLETED',
              'BTC/USDT trade sell'
            )
        `, [
          userId,
          sellValue,
          wallet.currency
        ]);

        await client.query("COMMIT");

        res.end(JSON.stringify({
          ok: true,
          action: "SELL",
          trade:
            closedTradeResult.rows[0],
          sellPrice:
            Number(sellPrice.toFixed(8)),
          sellValue:
            Number(sellValue.toFixed(2)),
          profit:
            Number(profit.toFixed(2)),
          balance:
            Number(newBalance.toFixed(2)),
          availableBalance:
            Number(
              (newBalance - newLockedBalance)
                .toFixed(2)
            ),
          lockedBalance:
            Number(newLockedBalance.toFixed(2)),
          currency:
            wallet.currency
        }));

      } catch (error) {

        if (client) {
          try {
            await client.query("ROLLBACK");
          } catch (_) {}
        }

        console.log(
          "TRADE SELL DATABASE ERROR:",
          error.message
        );

        res.end(JSON.stringify({
          ok: false,
          message: "Trade sell database error"
        }));

      } finally {

        if (client) {
          client.release();
        }
      }

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

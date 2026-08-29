const TelegramBot = require("node-telegram-bot-api");

const TOKEN = process.env.BOT_TOKEN;

const bot = new TelegramBot(TOKEN, {
  polling: true
});

const menu = {
  reply_markup: {
    keyboard: [
      ["🤖 وضعیت ربات", "💰 موجودی"],
      ["📊 تحلیل بازار", "⚙️ تنظیمات"],
      ["🚀 ورود به Mini App"]
    ],
    resize_keyboard: true
  }
};

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "🤖 به AI-Trader خوش آمدید!",
    menu
  );
});

bot.on("message", (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (text === "🤖 وضعیت ربات") {
    bot.sendMessage(chatId, "🟢 ربات فعال است");
  }

  if (text === "💰 موجودی") {
    bot.sendMessage(chatId, "💰 موجودی آزمایشی: 1000 USDT");
  }

  if (text === "📊 تحلیل بازار") {
    bot.sendMessage(chatId, "📊 تحلیل بازار در حال آماده‌سازی است");
  }

  if (text === "⚙️ تنظیمات") {
    bot.sendMessage(chatId, "⚙️ تنظیمات AI-Trader");
  }

  if (text === "🚀 ورود به Mini App") {
    bot.sendMessage(
      chatId,
      "برای ورود به AI-Trader روی دکمه زیر بزن:",
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🚀 باز کردن AI-Trader",
                web_app: {
                  url: "https://majid276890000.github.io/ai-trader-miniapp/"
                }
              }
            ]
          ]
        }
      }
    );
  }
});

console.log("Telegram Bot is running...");

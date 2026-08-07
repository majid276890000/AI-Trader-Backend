require("dotenv").config();

const TelegramBot = require("node-telegram-bot-api");

const TOKEN = process.env.BOT_TOKEN;

const bot = new TelegramBot(TOKEN, {
  polling: true
});

bot.on("message", (msg) => {
  const chatId = msg.chat.id;

  bot.sendMessage(
    chatId,
    "🤖 AI-Trader فعال است\nBackend متصل شد."
  );
});

console.log("Telegram Bot is running...");

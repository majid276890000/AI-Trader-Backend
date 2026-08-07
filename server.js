const http = require("http");

const PORT = 3000;

let botStatus = "stopped";
let balance = 1000;

let settings = {
  mode: "low-risk",
  capital: 1000
};

const server = http.createServer((req, res) => {

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Content-Type", "application/json");

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

  res.end(JSON.stringify({
    project: "AI-Trader Mini App",
    status: "Backend is running"
  }));

});

server.listen(PORT, () => {
  console.log(`AI-Trader Backend running on port ${PORT}`);
});

const http = require("http");

const PORT = 3000;

let botStatus = "stopped";
let balance = 1000;

const server = http.createServer((req, res) => {

  res.writeHead(200, {
    "Content-Type": "application/json"
  });

  if (req.url === "/status") {
    res.end(JSON.stringify({
      bot: botStatus,
      balance: balance
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

  res.end(JSON.stringify({
    project: "AI-Trader Mini App",
    status: "Backend is running"
  }));

});

server.listen(PORT, () => {
  console.log(`AI-Trader Backend running on port ${PORT}`);
});

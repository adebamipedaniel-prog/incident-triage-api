require("dotenv").config();

const { createApp } = require("./app");
const { createDatabase } = require("./database");

const port = Number(process.env.PORT || 3000);
const apiKey = process.env.API_KEY;

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}
if (!apiKey || apiKey.length < 32) {
  throw new Error("Set API_KEY to a random secret of at least 32 characters");
}

const db = createDatabase();
const app = createApp({ db, apiKey });
const server = app.listen(port, () => {
  console.log(`Incident API listening on port ${port}`);
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

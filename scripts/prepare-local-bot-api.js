const fs = require("fs");
const path = require("path");

const token = String(process.env.BOT_TOKEN || "").trim();
const base = String(process.env.BOT_API_BASE_URL || "").trim().replace(/\/$/, "");
const dataDir = path.resolve(process.env.DATA_DIR || "./data");
const marker = path.join(dataDir, ".local-bot-api-ready");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(15000)
  });

  const text = await response.text();
  let data = null;

  try {
    data = JSON.parse(text);
  } catch {}

  return { response, data };
}

(async () => {
  if (!base) {
    console.log("Local Bot API disabled; using Telegram cloud.");
    return;
  }

  if (!token) {
    throw new Error("BOT_TOKEN is required.");
  }

  fs.mkdirSync(dataDir, { recursive: true });

  if (!fs.existsSync(marker)) {
    try {
      const { data } = await requestJson(
        `https://api.telegram.org/bot${token}/logOut`,
        { method: "POST" }
      );

      if (data?.ok) {
        console.log("Telegram cloud Bot API logout completed.");
      } else {
        console.log("Telegram cloud logout was not confirmed; checking local API.");
      }
    } catch {
      console.log("Telegram cloud logout request failed; checking local API.");
    }
  }

  let localOk = false;

  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      const { data } = await requestJson(
        `${base}/bot${token}/getMe`,
        { method: "GET" }
      );

      if (data?.ok) {
        localOk = true;
        break;
      }
    } catch {}

    if (attempt < 30) {
      await sleep(2000);
    }
  }

  if (!localOk) {
    throw new Error("Local Telegram Bot API is not ready.");
  }

  fs.writeFileSync(marker, new Date().toISOString(), "utf8");
  console.log("Local Telegram Bot API ready.");
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

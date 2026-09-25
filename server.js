require("dotenv").config();

const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { Readable } = require("stream");

const { loadConfig, publicSource } = require("./lib/store");
const xtream = require("./lib/xtream");
const { createTelegramService } = require("./lib/telegram");

const PORT = Number(process.env.PORT || 3000);
const BOT_TOKEN = String(process.env.BOT_TOKEN || "");
const DEV_ALLOW_NO_TELEGRAM = process.env.DEV_ALLOW_NO_TELEGRAM === "1";

if (!BOT_TOKEN) {
  throw new Error("BOT_TOKEN is required");
}

const telegram = createTelegramService();
const app = express();
const deliveryJobs = new Set();

function queueDeliveryJob(key, task) {
  if (deliveryJobs.has(key)) return false;

  deliveryJobs.add(key);

  Promise.resolve()
    .then(task)
    .catch((error) => {
      console.error("delivery job failed:", error.message);
    })
    .finally(() => {
      deliveryJobs.delete(key);
    });

  return true;
}

app.use(express.json({ limit: "256kb" }));
app.use(express.static(path.join(__dirname, "public")));

function verifyTelegramInitData(initData, allowDev = false) {
  if (!initData) {
    if (allowDev && DEV_ALLOW_NO_TELEGRAM) {
      return { id: 0, first_name: "Development" };
    }
    throw new Error("Open Streamora from Telegram.");
  }

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) throw new Error("Telegram hash is missing.");

  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(BOT_TOKEN)
    .digest();

  const calculated = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  const a = Buffer.from(calculated, "hex");
  const b = Buffer.from(hash, "hex");

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error("Invalid Telegram signature.");
  }

  const authDate = Number(params.get("auth_date") || 0);
  if (authDate && Math.abs(Date.now() / 1000 - authDate) > 86400) {
    throw new Error("Telegram session expired. Reopen the Mini App.");
  }

  const rawUser = params.get("user");
  if (!rawUser) throw new Error("Telegram user is missing.");

  return JSON.parse(rawUser);
}

function telegramUser(req, allowDev = true) {
  return verifyTelegramInitData(
    String(req.headers["x-telegram-init-data"] || ""),
    allowDev
  );
}

function getSourceOrThrow(sourceId) {
  const config = loadConfig();
  const source = config.sources.find(
    (item) => item.id === sourceId && item.active !== false
  );

  if (!source) throw new Error("المصدر غير موجود أو متوقف.");
  return source;
}

function verifyMediaProxyToken(payload, signature) {
  const expected = crypto
    .createHmac("sha256", BOT_TOKEN)
    .update(payload)
    .digest("base64url");

  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature || ""));

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error("Invalid media signature.");
  }

  const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));

  if (!data.x || Number(data.x) < Math.floor(Date.now() / 1000)) {
    throw new Error("Media link expired.");
  }

  return data;
}

function inferredContentType(ext) {
  const map = {
    mp4: "video/mp4",
    m4v: "video/mp4",
    mov: "video/quicktime",
    webm: "video/webm",
    mkv: "video/x-matroska",
    avi: "video/x-msvideo",
    ts: "video/mp2t",
    m3u8: "application/vnd.apple.mpegurl"
  };
  return map[String(ext || "").toLowerCase()] || "application/octet-stream";
}

async function resolveUpstreamMediaUrl(source, tokenData) {
  if (tokenData.t === "movie") {
    try {
      const raw = await xtream.getVodInfo(source, tokenData.i);
      const direct =
        raw?.movie_data?.direct_source ||
        raw?.info?.direct_source ||
        raw?.info?.stream_url ||
        raw?.info?.video_url;

      if (typeof direct === "string" && /^https?:\/\//i.test(direct)) {
        return direct;
      }
    } catch {}

    return xtream.movieUrl(source, tokenData.i, tokenData.e);
  }

  if (tokenData.t === "series") {
    if (tokenData.r && tokenData.n) {
      try {
        const raw = await xtream.getSeriesInfo(source, tokenData.r);
        const episodes = raw?.episodes || {};
        const list = episodes[tokenData.n] || episodes[Number(tokenData.n)] || [];
        const episode = Array.isArray(list)
          ? list.find((item) => String(item.id) === String(tokenData.i))
          : null;

        const direct =
          episode?.direct_source ||
          episode?.info?.direct_source ||
          episode?.info?.stream_url ||
          episode?.info?.video_url;

        if (typeof direct === "string" && /^https?:\/\//i.test(direct)) {
          return direct;
        }
      } catch {}
    }

    return xtream.episodeUrl(source, tokenData.i, tokenData.e);
  }

  throw new Error("Unsupported media type.");
}

function moviePreview(item, source) {
  return {
    type: "movie",
    sourceId: source.id,
    sourceName: source.name,
    id: String(item.stream_id ?? ""),
    name: item.name || "بدون اسم",
    poster: item.stream_icon || null,
    year: item.year || null,
    rating: item.rating || item.rating_5based || null,
    categoryId: item.category_id || null,
    extension: item.container_extension || null
  };
}

function seriesPreview(item, source) {
  return {
    type: "series",
    sourceId: source.id,
    sourceName: source.name,
    id: String(item.series_id ?? ""),
    name: item.name || "بدون اسم",
    poster: item.cover || item.stream_icon || null,
    year: item.year || null,
    rating: item.rating || null,
    categoryId: item.category_id || null
  };
}

function cleanObject(value, source) {
  if (typeof value === "string") {
    const password = String(source?.password || "");
    const username = String(source?.username || "");

    if (
      (password && value.includes(password)) ||
      /[?&](username|password)=/i.test(value) ||
      (username && password && value.includes(`/${username}/${password}/`))
    ) {
      return null;
    }

    return value;
  }

  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => cleanObject(item, source));

  const output = {};
  const blockedKeys = new Set([
    "username",
    "password",
    "user",
    "pass",
    "direct_source",
    "stream_url",
    "video_url",
    "play_url"
  ]);

  for (const [key, item] of Object.entries(value)) {
    if (blockedKeys.has(key.toLowerCase())) continue;
    output[key] = cleanObject(item, source);
  }

  return output;
}

app.get("/health", (req, res) => {
  const config = loadConfig();
  res.json({
    ok: true,
    name: config.brand.name || "Streamora",
    sources: config.sources.filter((s) => s.active !== false).length,
    storageChannelConfigured: Boolean(config.storageChannelId)
  });
});

app.get("/api/bootstrap", (req, res) => {
  try {
    const user = telegramUser(req, true);
    const config = loadConfig();

    res.json({
      ok: true,
      user,
      brand: config.brand,
      sources: config.sources
        .filter((s) => s.active !== false)
        .map(publicSource)
    });
  } catch (error) {
    res.status(401).json({ ok: false, error: error.message });
  }
});

app.get("/api/home", async (req, res) => {
  try {
    telegramUser(req, true);

    const requestedType = req.query.type === "series" ? "series" : "movie";
    const config = loadConfig();
    const sources = config.sources.filter((s) => s.active !== false);

    const jobs = sources.map(async (source) => {
      const items = requestedType === "movie"
        ? await xtream.getVodStreams(source)
        : await xtream.getSeries(source);

      return items
        .slice(0, 28)
        .map((item) =>
          requestedType === "movie"
            ? moviePreview(item, source)
            : seriesPreview(item, source)
        );
    });

    const settled = await Promise.allSettled(jobs);
    const results = settled
      .filter((r) => r.status === "fulfilled")
      .flatMap((r) => r.value)
      .slice(0, 80);

    res.json({ ok: true, type: requestedType, results });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/search", async (req, res) => {
  try {
    telegramUser(req, true);

    const query = String(req.query.q || "").trim().toLowerCase();
    const type = req.query.type === "series" ? "series" : "movie";

    if (query.length < 2) {
      return res.status(400).json({ ok: false, error: "اكتب حرفين على الأقل." });
    }

    const config = loadConfig();
    const sources = config.sources.filter((s) => s.active !== false);

    const jobs = sources.map(async (source) => {
      const items = type === "movie"
        ? await xtream.getVodStreams(source)
        : await xtream.getSeries(source);

      return items
        .filter((item) =>
          String(item.name || "").toLowerCase().includes(query)
        )
        .slice(0, 25)
        .map((item) =>
          type === "movie"
            ? moviePreview(item, source)
            : seriesPreview(item, source)
        );
    });

    const settled = await Promise.allSettled(jobs);
    const results = settled
      .filter((r) => r.status === "fulfilled")
      .flatMap((r) => r.value)
      .slice(0, 60);

    res.json({ ok: true, results });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/details/movie/:sourceId/:id", async (req, res) => {
  try {
    telegramUser(req, true);
    const source = getSourceOrThrow(req.params.sourceId);
    const data = await xtream.getVodInfo(source, req.params.id);

    res.json({
      ok: true,
      source: publicSource(source),
      data: cleanObject(data, source)
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/details/series/:sourceId/:id", async (req, res) => {
  try {
    telegramUser(req, true);
    const source = getSourceOrThrow(req.params.sourceId);
    const data = await xtream.getSeriesInfo(source, req.params.id);

    res.json({
      ok: true,
      source: publicSource(source),
      data: cleanObject(data, source)
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});


app.all("/media/:payload/:signature/:filename", async (req, res) => {
  try {
    if (!["GET", "HEAD"].includes(req.method)) {
      return res.sendStatus(405);
    }

    const tokenData = verifyMediaProxyToken(
      String(req.params.payload || ""),
      String(req.params.signature || "")
    );

    const source = getSourceOrThrow(String(tokenData.s || ""));
    const upstreamUrl = await resolveUpstreamMediaUrl(source, tokenData);

    const headers = {
      "user-agent": "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      accept: "*/*"
    };

    if (req.headers.range) {
      headers.range = req.headers.range;
    }

    const upstream = await fetch(upstreamUrl, {
      method: req.method === "HEAD" ? "HEAD" : "GET",
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(120000)
    });

    if (!upstream.ok && upstream.status !== 206) {
      console.error(
        "media proxy upstream failed",
        JSON.stringify({
          sourceId: source.id,
          mediaType: tokenData.t,
          mediaId: tokenData.i,
          status: upstream.status,
          contentType: upstream.headers.get("content-type")
        })
      );
      return res.sendStatus(502);
    }

    const upstreamType = String(upstream.headers.get("content-type") || "");
    const contentType =
      upstreamType.startsWith("video/") ||
      upstreamType.includes("octet-stream") ||
      upstreamType.includes("mpegurl")
        ? upstreamType
        : inferredContentType(tokenData.e);

    res.status(upstream.status === 206 ? 206 : 200);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `inline; filename="stream.${xtream.safeExt(tokenData.e)}"`);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Accept-Ranges", upstream.headers.get("accept-ranges") || "bytes");

    for (const name of ["content-length", "content-range", "etag", "last-modified"]) {
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name, value);
    }

    if (req.method === "HEAD") {
      return res.end();
    }

    if (!upstream.body) {
      return res.sendStatus(502);
    }

    Readable.fromWeb(upstream.body).pipe(res);
  } catch (error) {
    console.error("media proxy error:", error.message);
    if (!res.headersSent) {
      res.status(403).end();
    } else {
      res.end();
    }
  }
});

app.post("/api/send", async (req, res) => {
  try {
    const user = telegramUser(req, false);
    const body = req.body || {};
    const source = getSourceOrThrow(String(body.sourceId || ""));

    if (body.type === "movie") {
      const movieId = String(body.id || "");
      if (!movieId) throw new Error("Movie ID missing.");

      const raw = await xtream.getVodInfo(source, movieId);
      const info = raw?.info || {};
      const movie = raw?.movie_data || {};

      const title =
        movie.name ||
        info.name ||
        info.title ||
        String(body.title || "Movie");

      const extension =
        movie.container_extension ||
        info.container_extension ||
        "mp4";

      const jobKey = `${user.id}:${source.id}:movie:${movieId}`;
      const queued = queueDeliveryJob(jobKey, () =>
        telegram.deliverAuthorizedMedia({
          chatId: user.id,
          source,
          mediaType: "movie",
          mediaId: movieId,
          extension,
          title
        })
      );

      return res.json({
        ok: true,
        queued,
        alreadyQueued: !queued
      });
    }

    if (body.type === "series") {
      const seriesId = String(body.id || "");
      const season = String(body.season || "");
      const episodeId = String(body.episodeId || "");

      if (!seriesId || !season || !episodeId) {
        throw new Error("Series/season/episode data missing.");
      }

      const raw = await xtream.getSeriesInfo(source, seriesId);
      const episodes = raw?.episodes || {};
      const list = episodes[season] || episodes[Number(season)] || [];

      const episode = Array.isArray(list)
        ? list.find((item) => String(item.id) === episodeId)
        : null;

      if (!episode) throw new Error("الحلقة غير موجودة.");

      const info = episode.info || {};
      const title =
        episode.title ||
        info.name ||
        info.title ||
        `Episode ${episode.episode_num || ""}`;

      const extension =
        episode.container_extension ||
        info.container_extension ||
        "mp4";

      const jobKey = `${user.id}:${source.id}:series:${episodeId}`;
      const queued = queueDeliveryJob(jobKey, () =>
        telegram.deliverAuthorizedMedia({
          chatId: user.id,
          source,
          mediaType: "series",
          mediaId: episodeId,
          extension,
          title,
          seriesId,
          season
        })
      );

      return res.json({
        ok: true,
        queued,
        alreadyQueued: !queued
      });
    }

    throw new Error("Unsupported media type.");
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Streamora running on port ${PORT}`);
});
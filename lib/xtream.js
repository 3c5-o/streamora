function normalizeBaseUrl(value) {
  const url = new URL(value);
  return `${url.protocol}//${url.host}`;
}

async function requestJson(url, timeoutMs = 25000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "Streamora/0.1",
        accept: "application/json,text/plain,*/*"
      }
    });

    if (!response.ok) {
      throw new Error(`Xtream HTTP ${response.status}`);
    }

    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("Xtream response is not valid JSON");
    }
  } finally {
    clearTimeout(timer);
  }
}

function apiUrl(source, action, params = {}) {
  const url = new URL("/player_api.php", source.baseUrl);
  url.searchParams.set("username", source.username);
  url.searchParams.set("password", source.password);
  if (action) url.searchParams.set("action", action);

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  });

  return url.toString();
}

async function testSource(source) {
  const data = await requestJson(apiUrl(source));
  const info = data?.user_info || {};
  return {
    ok: String(info.auth) === "1",
    status: info.status || null,
    activeConnections: info.active_cons || null,
    maxConnections: info.max_connections || null
  };
}

async function getVodCategories(source) {
  const data = await requestJson(apiUrl(source, "get_vod_categories"));
  return Array.isArray(data) ? data : [];
}

async function getSeriesCategories(source) {
  const data = await requestJson(apiUrl(source, "get_series_categories"));
  return Array.isArray(data) ? data : [];
}

async function getVodStreams(source, categoryId) {
  const data = await requestJson(
    apiUrl(source, "get_vod_streams", categoryId ? { category_id: categoryId } : {})
  );
  return Array.isArray(data) ? data : [];
}

async function getSeries(source, categoryId) {
  const data = await requestJson(
    apiUrl(source, "get_series", categoryId ? { category_id: categoryId } : {})
  );
  return Array.isArray(data) ? data : [];
}

async function getVodInfo(source, vodId) {
  return requestJson(apiUrl(source, "get_vod_info", { vod_id: vodId }));
}

async function getSeriesInfo(source, seriesId) {
  return requestJson(apiUrl(source, "get_series_info", { series_id: seriesId }));
}

function safeExt(value, fallback = "mp4") {
  const ext = String(value || fallback).toLowerCase().replace(/^\./, "");
  return /^[a-z0-9]{2,6}$/.test(ext) ? ext : fallback;
}

function movieUrl(source, streamId, extension) {
  const ext = safeExt(extension);
  const user = encodeURIComponent(source.username);
  const pass = encodeURIComponent(source.password);
  return `${source.baseUrl}/movie/${user}/${pass}/${streamId}.${ext}`;
}

function episodeUrl(source, episodeId, extension) {
  const ext = safeExt(extension);
  const user = encodeURIComponent(source.username);
  const pass = encodeURIComponent(source.password);
  return `${source.baseUrl}/series/${user}/${pass}/${episodeId}.${ext}`;
}

module.exports = {
  normalizeBaseUrl,
  testSource,
  getVodCategories,
  getSeriesCategories,
  getVodStreams,
  getSeries,
  getVodInfo,
  getSeriesInfo,
  movieUrl,
  episodeUrl,
  safeExt
};

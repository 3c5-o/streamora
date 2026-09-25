const tg = window.Telegram?.WebApp || null;

if (tg) {
  tg.ready();
  tg.expand();
  try {
    tg.setHeaderColor("#0b0d12");
    tg.setBackgroundColor("#0b0d12");
  } catch {}
}

const initData = tg?.initData || "";
const state = {
  type: "movie",
  bootstrap: null,
  currentItem: null,
  currentSeries: null
};

const $ = (selector) => document.querySelector(selector);
const grid = $("#grid");
const statusBox = $("#status");
const sectionTitle = $("#sectionTitle");
const sectionSub = $("#sectionSub");
const modal = $("#modal");
const details = $("#details");
const toast = $("#toast");

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function api(url, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("x-telegram-init-data", initData);

  if (options.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(url, { ...options, headers });
  const data = await response.json().catch(() => ({
    ok: false,
    error: "Invalid server response"
  }));

  if (!response.ok || data.ok === false) {
    throw new Error(data.error || "Request failed");
  }

  return data;
}

function showStatus(message) {
  statusBox.textContent = message;
  statusBox.classList.remove("hidden");
  grid.classList.add("hidden");
}

function hideStatus() {
  statusBox.classList.add("hidden");
  grid.classList.remove("hidden");
}

function showToast(message, timeout = 2800) {
  toast.textContent = message;
  toast.classList.remove("hidden");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.add("hidden"), timeout);
}

function posterMarkup(item) {
  const poster = item.poster
    ? `<img src="${escapeHtml(item.poster)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
    : `<div class="poster-placeholder">${escapeHtml(item.name)}</div>`;

  return `
    <div class="poster-wrap">
      ${poster}
      <span class="source-badge">${escapeHtml(item.sourceName || "")}</span>
    </div>
  `;
}

function renderCards(items) {
  grid.innerHTML = "";

  if (!items.length) {
    showStatus("ماكو محتوى متوفر حالياً.");
    return;
  }

  hideStatus();

  for (const item of items) {
    const button = document.createElement("button");
    button.className = "media-card";
    button.type = "button";
    button.innerHTML = `
      ${posterMarkup(item)}
      <div class="card-title">${escapeHtml(item.name)}</div>
      <div class="card-meta">${escapeHtml(item.year || item.rating || "")}</div>
    `;
    button.addEventListener("click", () => openDetails(item));
    grid.appendChild(button);
  }
}

function setType(type, reload = true) {
  state.type = type;

  document.querySelectorAll(".type-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.type === type);
  });

  sectionTitle.textContent = type === "movie" ? "الأفلام" : "المسلسلات";
  sectionSub.textContent = "اختر المحتوى ليتم إرساله إلى محادثتك في Telegram";

  if (reload) loadHome();
}

async function loadBootstrap() {
  try {
    const data = await api("/api/bootstrap");
    state.bootstrap = data;
    $("#brandName").textContent = data.brand?.name || "Streamora";

    if (!data.sources?.length) {
      showStatus("ماكو مصدر Xtream مفعّل حالياً. أضفه من إعدادات البوت.");
      return false;
    }

    return true;
  } catch (error) {
    showStatus(error.message);
    return false;
  }
}

async function loadHome() {
  showStatus("جاري تحميل المحتوى...");

  try {
    const data = await api(`/api/home?type=${state.type}`);
    renderCards(data.results || []);
  } catch (error) {
    showStatus(error.message);
  }
}

async function search() {
  const query = $("#searchInput").value.trim();

  if (query.length < 2) {
    $("#searchInput").focus();
    showToast("اكتب حرفين على الأقل.");
    return;
  }

  sectionTitle.textContent = `نتائج: ${query}`;
  sectionSub.textContent = state.type === "movie" ? "بحث الأفلام" : "بحث المسلسلات";
  showStatus("جاري البحث...");

  try {
    const data = await api(
      `/api/search?type=${state.type}&q=${encodeURIComponent(query)}`
    );
    renderCards(data.results || []);
  } catch (error) {
    showStatus(error.message);
  }
}

function openModal() {
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
}

function closeModal() {
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
}

function movieDetailsMarkup(item, raw) {
  const info = raw.info || {};
  const movie = raw.movie_data || {};
  const poster = info.movie_image || info.cover_big || movie.stream_icon || item.poster || "";
  const title = movie.name || info.name || info.title || item.name;
  const plot = info.plot || info.description || "";
  const meta = [
    info.releasedate || info.year || movie.year,
    info.genre,
    info.duration,
    info.rating ? `تقييم ${info.rating}` : ""
  ].filter(Boolean).join(" • ");

  return `
    <div class="detail-hero">
      ${poster ? `<img class="detail-poster" src="${escapeHtml(poster)}" alt="" referrerpolicy="no-referrer">` : '<div class="detail-poster"></div>'}
      <div class="detail-info">
        <h2>${escapeHtml(title)}</h2>
        <p>${escapeHtml(meta)}</p>
        <p>${escapeHtml(item.sourceName)}</p>
      </div>
    </div>
    ${plot ? `<p class="plot">${escapeHtml(plot)}</p>` : ""}
    <button id="sendMovieBtn" class="primary-btn">إرسال إلى Telegram</button>
  `;
}

function seriesHeaderMarkup(item, raw) {
  const info = raw.info || {};
  const poster = info.cover || info.cover_big || item.poster || "";
  const title = info.name || item.name;
  const plot = info.plot || "";
  const meta = [
    info.releaseDate || info.release_date || info.year,
    info.genre,
    info.rating ? `تقييم ${info.rating}` : ""
  ].filter(Boolean).join(" • ");

  return `
    <div class="detail-hero">
      ${poster ? `<img class="detail-poster" src="${escapeHtml(poster)}" alt="" referrerpolicy="no-referrer">` : '<div class="detail-poster"></div>'}
      <div class="detail-info">
        <h2>${escapeHtml(title)}</h2>
        <p>${escapeHtml(meta)}</p>
        <p>${escapeHtml(item.sourceName)}</p>
      </div>
    </div>
    ${plot ? `<p class="plot">${escapeHtml(plot)}</p>` : ""}
    <div id="seasonTabs" class="season-tabs"></div>
    <div id="episodeList" class="episode-list"></div>
  `;
}

function seasonSort(a, b) {
  const x = Number(a);
  const y = Number(b);
  if (Number.isFinite(x) && Number.isFinite(y)) return x - y;
  return String(a).localeCompare(String(b));
}

function renderSeason(seriesItem, raw, seasonKey) {
  const episodesMap = raw.episodes || {};
  const tabs = $("#seasonTabs");
  const list = $("#episodeList");

  tabs.innerHTML = "";
  list.innerHTML = "";

  const seasons = Object.keys(episodesMap).sort(seasonSort);

  for (const season of seasons) {
    const btn = document.createElement("button");
    btn.className = "season-tab" + (String(season) === String(seasonKey) ? " active" : "");
    btn.textContent = `الموسم ${season}`;
    btn.addEventListener("click", () => renderSeason(seriesItem, raw, season));
    tabs.appendChild(btn);
  }

  const episodes = Array.isArray(episodesMap[seasonKey]) ? episodesMap[seasonKey] : [];

  for (const episode of episodes) {
    const row = document.createElement("div");
    row.className = "episode-row";

    const episodeTitle =
      episode.title ||
      episode.info?.name ||
      episode.info?.title ||
      `الحلقة ${episode.episode_num || ""}`;

    row.innerHTML = `
      <div>
        <strong>${escapeHtml(episodeTitle)}</strong>
        <span>الحلقة ${escapeHtml(episode.episode_num || "")}</span>
      </div>
    `;

    const send = document.createElement("button");
    send.className = "episode-btn";
    send.textContent = "إرسال";
    send.addEventListener("click", () =>
      sendEpisode(seriesItem, seasonKey, episode)
    );

    row.appendChild(send);
    list.appendChild(row);
  }

  if (!episodes.length) {
    list.innerHTML = '<div class="status">ماكو حلقات بهذا الموسم.</div>';
  }
}

async function openDetails(item) {
  state.currentItem = item;
  details.innerHTML = '<div class="status">جاري تحميل التفاصيل...</div>';
  openModal();

  try {
    const data = await api(
      `/api/details/${item.type}/${encodeURIComponent(item.sourceId)}/${encodeURIComponent(item.id)}`
    );

    if (item.type === "movie") {
      details.innerHTML = movieDetailsMarkup(item, data.data || {});
      $("#sendMovieBtn").addEventListener("click", () => sendMovie(item));
      return;
    }

    const raw = data.data || {};
    state.currentSeries = raw;
    details.innerHTML = seriesHeaderMarkup(item, raw);

    const seasons = Object.keys(raw.episodes || {}).sort(seasonSort);
    if (seasons.length) {
      renderSeason(item, raw, seasons[0]);
    } else {
      $("#episodeList").innerHTML = '<div class="status">ماكو حلقات متوفرة.</div>';
    }
  } catch (error) {
    details.innerHTML = `<div class="status">${escapeHtml(error.message)}</div>`;
  }
}

async function sendMovie(item) {
  const btn = $("#sendMovieBtn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "جاري الإرسال...";
  }

  try {
    await api("/api/send", {
      method: "POST",
      body: JSON.stringify({
        type: "movie",
        sourceId: item.sourceId,
        id: item.id,
        title: item.name
      })
    });

    showToast("تم إرسال الفيلم إلى محادثتك.");
    tg?.HapticFeedback?.notificationOccurred("success");
  } catch (error) {
    showToast(error.message, 4200);
    tg?.HapticFeedback?.notificationOccurred("error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "إرسال إلى Telegram";
    }
  }
}

async function sendEpisode(seriesItem, season, episode) {
  showToast("جاري إرسال الحلقة...");

  try {
    await api("/api/send", {
      method: "POST",
      body: JSON.stringify({
        type: "series",
        sourceId: seriesItem.sourceId,
        id: seriesItem.id,
        season,
        episodeId: episode.id,
        title: episode.title || episode.info?.name || ""
      })
    });

    showToast("تم إرسال الحلقة إلى محادثتك.");
    tg?.HapticFeedback?.notificationOccurred("success");
  } catch (error) {
    showToast(error.message, 4200);
    tg?.HapticFeedback?.notificationOccurred("error");
  }
}

document.querySelectorAll(".type-btn").forEach((btn) => {
  btn.addEventListener("click", () => setType(btn.dataset.type));
});

document.querySelectorAll(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-btn").forEach((x) => x.classList.remove("active"));
    btn.classList.add("active");

    const action = btn.dataset.action;

    if (action === "movies") {
      setType("movie");
    } else if (action === "series") {
      setType("series");
    } else if (action === "search") {
      $("#searchInput").focus();
      window.scrollTo({ top: 0, behavior: "smooth" });
    } else {
      loadHome();
    }
  });
});

$("#searchBtn").addEventListener("click", search);
$("#searchInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter") search();
});

$("#refreshBtn").addEventListener("click", loadHome);
$("#closeModal").addEventListener("click", closeModal);
modal.addEventListener("click", (event) => {
  if (event.target?.dataset?.close === "1") closeModal();
});

(async function init() {
  const ok = await loadBootstrap();
  if (ok) await loadHome();
})();

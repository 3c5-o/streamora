const TelegramBot = require("node-telegram-bot-api");
const crypto = require("crypto");
const { Readable, Transform } = require("stream");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pipeline } = require("stream/promises");
const { loadConfig, updateConfig, addSource } = require("./store");
const xtream = require("./xtream");

function parseSourceInput(text) {
  const parts = String(text || "").split("|").map((v) => v.trim()).filter(Boolean);
  if (parts.length < 2) {
    throw new Error("استخدم: الاسم | رابط السيرفر | المستخدم | كلمة المرور");
  }

  const name = parts[0];
  const rawUrl = parts[1];
  const parsed = new URL(rawUrl);
  const baseUrl = `${parsed.protocol}//${parsed.host}`;

  let username = parsed.searchParams.get("username") || "";
  let password = parsed.searchParams.get("password") || "";

  if (!username && parts[2]) username = parts[2];
  if (!password && parts[3]) password = parts[3];

  if (!username || !password) {
    throw new Error("بيانات Xtream ناقصة.");
  }

  return { name, baseUrl, username, password };
}

function adminKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "مصادر Xtream", callback_data: "admin:sources" },
        { text: "قناة التخزين", callback_data: "admin:channel" }
      ],
      [
        { text: "الهوية والحقوق", callback_data: "admin:brand" },
        { text: "فحص النظام", callback_data: "admin:status" }
      ]
    ]
  };
}

function brandKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "اسم المنصة", callback_data: "admin:brandname" },
        { text: "نص الحقوق", callback_data: "admin:rights" }
      ],
      [
        { text: "غلاف الحقوق", callback_data: "admin:cover" },
        { text: "حذف الغلاف", callback_data: "admin:coverclear" }
      ],
      [{ text: "رجوع", callback_data: "admin:home" }]
    ]
  };
}

function sourceKeyboard(config) {
  const rows = config.sources.map((source) => [
    {
      text: `${source.active === false ? "⏸" : "✅"} ${source.name}`,
      callback_data: `admin:toggle:${source.id}`
    },
    { text: "حذف", callback_data: `admin:delete:${source.id}` }
  ]);

  rows.push([{ text: "إضافة Xtream", callback_data: "admin:addsource" }]);
  rows.push([{ text: "رجوع", callback_data: "admin:home" }]);
  return { inline_keyboard: rows };
}

async function safeAnswer(bot, query, text) {
  try {
    await bot.answerCallbackQuery(query.id, text ? { text } : undefined);
  } catch {}
}

function createTelegramService() {
  const token = process.env.BOT_TOKEN;
  const adminId = String(process.env.ADMIN_ID || "").trim();
  const webAppUrl = String(process.env.WEBAPP_URL || "").trim();
  const botApiBaseUrl = String(process.env.BOT_API_BASE_URL || "").trim();

  if (!token) throw new Error("BOT_TOKEN is required");
  if (!adminId) throw new Error("ADMIN_ID is required");

  const botOptions = {
    polling: true,
    request: { timeout: 6 * 60 * 60 * 1000 }
  };

  if (botApiBaseUrl) {
    botOptions.baseApiUrl = botApiBaseUrl.replace(/\/$/, "");
  }

  const bot = new TelegramBot(token, botOptions);
  const states = new Map();

  // Configure the global Telegram menu button and bot commands automatically.
  if (webAppUrl) {
    Promise.resolve(
      typeof bot.setChatMenuButton === "function"
        ? bot.setChatMenuButton({
            menu_button: {
              type: "web_app",
              text: "فتح Streamora",
              web_app: { url: webAppUrl }
            }
          })
        : null
    ).catch((error) => {
      console.error("setChatMenuButton failed:", error.message);
    });
  }

  Promise.resolve(
    bot.setMyCommands([
      { command: "start", description: "فتح Streamora" },
      { command: "admin", description: "لوحة الإدارة" }
    ])
  ).catch((error) => {
    console.error("setMyCommands failed:", error.message);
  });

  function isAdmin(userId) {
    return String(userId) === adminId;
  }

  async function showUserStart(chatId) {
    const config = loadConfig();
    const keyboard = webAppUrl
      ? {
          inline_keyboard: [[
            { text: `فتح ${config.brand.name || "Streamora"}`, web_app: { url: webAppUrl } }
          ]]
        }
      : undefined;

    await bot.sendMessage(
      chatId,
      webAppUrl
        ? "افتح التطبيق من الزر أدناه واختر الفيلم أو المسلسل، وسيصل المحتوى إلى هذه المحادثة."
        : "البوت يعمل، لكن WEBAPP_URL غير مضبوط بعد.",
      keyboard ? { reply_markup: keyboard } : undefined
    );
  }

  async function showAdmin(chatId) {
    const config = loadConfig();
    const channel = config.storageChannelId || "غير مضبوط";
    const active = config.sources.filter((s) => s.active !== false).length;
    const keyboard = adminKeyboard();

    if (webAppUrl) {
      keyboard.inline_keyboard.unshift([
        {
          text: `فتح ${config.brand.name || "Streamora"}`,
          web_app: { url: webAppUrl }
        }
      ]);
    }

    await bot.sendMessage(
      chatId,
      `إدارة ${config.brand.name || "Streamora"}\n\nمصادر فعالة: ${active}/${config.sources.length}\nقناة التخزين: ${channel}`,
      { reply_markup: keyboard }
    );
  }

  bot.onText(/^\/start(?:\s|$)/, async (msg) => {
    if (isAdmin(msg.from?.id)) {
      await showAdmin(msg.chat.id);
    } else {
      await showUserStart(msg.chat.id);
    }
  });

  bot.onText(/^\/admin(?:\s|$)/, async (msg) => {
    if (!isAdmin(msg.from?.id)) return;
    await showAdmin(msg.chat.id);
  });

  bot.on("callback_query", async (query) => {
    if (!isAdmin(query.from?.id)) {
      await safeAnswer(bot, query, "غير مصرح");
      return;
    }

    const chatId = query.message?.chat?.id;
    if (!chatId) return;

    const data = String(query.data || "");
    await safeAnswer(bot, query);

    if (data === "admin:home") {
      await showAdmin(chatId);
      return;
    }

    if (data === "admin:sources") {
      const config = loadConfig();
      await bot.sendMessage(
        chatId,
        config.sources.length ? "مصادر Xtream:" : "لا توجد مصادر Xtream بعد.",
        { reply_markup: sourceKeyboard(config) }
      );
      return;
    }

    if (data === "admin:addsource") {
      states.set(String(query.from.id), { type: "await_source" });
      await bot.sendMessage(
        chatId,
        "أرسل المصدر بإحدى الصيغتين:\n\nالاسم | http://server:port | username | password\n\nأو:\nالاسم | رابط player_api.php الكامل"
      );
      return;
    }

    if (data.startsWith("admin:toggle:")) {
      const id = data.split(":")[2];
      updateConfig((config) => {
        const source = config.sources.find((s) => s.id === id);
        if (source) source.active = source.active === false;
        return config;
      });
      const config = loadConfig();
      await bot.sendMessage(chatId, "تم تحديث حالة المصدر.", {
        reply_markup: sourceKeyboard(config)
      });
      return;
    }

    if (data.startsWith("admin:delete:")) {
      const id = data.split(":")[2];
      updateConfig((config) => {
        config.sources = config.sources.filter((s) => s.id !== id);
        Object.keys(config.cache || {}).forEach((key) => {
          if (key.startsWith(id + ":")) delete config.cache[key];
        });
        return config;
      });
      const config = loadConfig();
      await bot.sendMessage(chatId, "تم حذف المصدر.", {
        reply_markup: sourceKeyboard(config)
      });
      return;
    }

    if (data === "admin:channel") {
      const config = loadConfig();
      states.set(String(query.from.id), { type: "await_channel" });
      await bot.sendMessage(
        chatId,
        `القناة الحالية: ${config.storageChannelId || "غير مضبوطة"}\n\nأسهل طريقة: حوّل أي منشور من قناة التخزين إلى هذا البوت، وأنا ألتقط ID تلقائياً.\n\nأو أرسل Channel ID مثل -1001234567890 أو @channelusername. يجب أن يكون البوت مشرفاً بالقناة.\nأرسل 0 لإلغاء القناة.`
      );
      return;
    }

    if (data === "admin:brand") {
      const config = loadConfig();
      await bot.sendMessage(
        chatId,
        `اسم المنصة: ${config.brand.name}\nالحقوق: ${config.brand.rights || "غير مضبوطة"}\nالغلاف: ${config.brand.coverFileId ? "موجود" : "غير موجود"}`,
        { reply_markup: brandKeyboard() }
      );
      return;
    }

    if (data === "admin:brandname") {
      states.set(String(query.from.id), { type: "await_brand_name" });
      await bot.sendMessage(chatId, "أرسل اسم المنصة الجديد.");
      return;
    }

    if (data === "admin:rights") {
      states.set(String(query.from.id), { type: "await_rights" });
      await bot.sendMessage(chatId, "أرسل نص الحقوق الذي تريد إضافته مع المحتوى.");
      return;
    }

    if (data === "admin:cover") {
      states.set(String(query.from.id), { type: "await_cover" });
      await bot.sendMessage(chatId, "أرسل صورة الغلاف/الحقوق الآن.");
      return;
    }

    if (data === "admin:coverclear") {
      updateConfig((config) => {
        config.brand.coverFileId = null;
        return config;
      });
      await bot.sendMessage(chatId, "تم حذف غلاف الحقوق.", {
        reply_markup: brandKeyboard()
      });
      return;
    }

    if (data === "admin:status") {
      const config = loadConfig();
      const lines = ["فحص Streamora:", ""];

      for (const source of config.sources) {
        try {
          const status = await xtream.testSource(source);
          lines.push(`${status.ok ? "✅" : "❌"} ${source.name} — ${status.status || "unknown"}`);
        } catch (error) {
          lines.push(`❌ ${source.name} — ${error.message}`);
        }
      }

      if (config.storageChannelId) {
        try {
          const chat = await bot.getChat(config.storageChannelId);
          lines.push("", `✅ قناة التخزين: ${chat.title || chat.username || config.storageChannelId}`);
        } catch (error) {
          lines.push("", `❌ قناة التخزين: ${error.message}`);
        }
      } else {
        lines.push("", "⚠️ قناة التخزين غير مضبوطة.");
      }

      await bot.sendMessage(chatId, lines.join("\n"));
    }
  });

  bot.on("message", async (msg) => {
    if (!isAdmin(msg.from?.id)) return;
    if (String(msg.text || "").startsWith("/")) return;

    const key = String(msg.from.id);
    const state = states.get(key);
    if (!state) return;

    try {
      if (state.type === "await_source") {
        const candidate = parseSourceInput(msg.text);
        const status = await xtream.testSource(candidate);
        if (!status.ok) throw new Error("الحساب لم يرجع auth=1");

        addSource(candidate);
        states.delete(key);
        await bot.sendMessage(
          msg.chat.id,
          `تمت إضافة ${candidate.name}.\nالحالة: ${status.status || "Active"}`
        );
        await showAdmin(msg.chat.id);
        return;
      }

      if (state.type === "await_channel") {
        const forwardedChatId =
          msg.forward_from_chat?.id ||
          msg.forward_origin?.chat?.id ||
          msg.forward_origin?.sender_chat?.id ||
          null;

        const textValue = String(msg.text || "").trim();
        const value = forwardedChatId || textValue;

        if (textValue === "0") {
          updateConfig((config) => {
            config.storageChannelId = null;
            return config;
          });
          states.delete(key);
          await bot.sendMessage(msg.chat.id, "تم إلغاء قناة التخزين.");
          await showAdmin(msg.chat.id);
          return;
        }

        if (!value) {
          throw new Error("حوّل منشور من القناة أو أرسل ID / @username.");
        }

        const chat = await bot.getChat(value);
        if (chat.type !== "channel") {
          throw new Error("المحدد ليس قناة Telegram.");
        }

        try {
          const me = await bot.getMe();
          const member = await bot.getChatMember(chat.id, me.id);
          if (!["administrator", "creator"].includes(member.status)) {
            throw new Error("أضف البوت Admin بالقناة أولاً.");
          }
        } catch (error) {
          if (String(error.message || "").includes("Admin")) throw error;
        }

        updateConfig((config) => {
          config.storageChannelId = String(chat.id);
          return config;
        });

        states.delete(key);
        await bot.sendMessage(
          msg.chat.id,
          `تم حفظ قناة التخزين: ${chat.title || chat.username || chat.id}`
        );
        await showAdmin(msg.chat.id);
        return;
      }

      if (state.type === "await_brand_name") {
        const value = String(msg.text || "").trim().slice(0, 64);
        if (!value) throw new Error("الاسم فارغ.");

        updateConfig((config) => {
          config.brand.name = value;
          return config;
        });
        states.delete(key);
        await bot.sendMessage(msg.chat.id, "تم تحديث اسم المنصة.");
        return;
      }

      if (state.type === "await_rights") {
        const value = String(msg.text || "").trim().slice(0, 800);
        updateConfig((config) => {
          config.brand.rights = value;
          return config;
        });
        states.delete(key);
        await bot.sendMessage(msg.chat.id, "تم تحديث نص الحقوق.");
        return;
      }

      if (state.type === "await_cover") {
        const photos = msg.photo || [];
        if (!photos.length) throw new Error("أرسل صورة، مو نص.");

        const fileId = photos[photos.length - 1].file_id;
        updateConfig((config) => {
          config.brand.coverFileId = fileId;
          return config;
        });
        states.delete(key);
        await bot.sendMessage(msg.chat.id, "تم حفظ غلاف الحقوق.");
      }
    } catch (error) {
      await bot.sendMessage(msg.chat.id, `خطأ: ${error.message}\nأعد المحاولة أو أرسل /admin.`);
    }
  });

  async function sendBrandHeader(chatId, title) {
    const config = loadConfig();
    if (!config.brand.coverFileId) return;

    const caption = [
      config.brand.name || "Streamora",
      title || "",
      config.brand.rights || ""
    ].filter(Boolean).join("\n");

    try {
      await bot.sendPhoto(chatId, config.brand.coverFileId, { caption: caption.slice(0, 1024) });
    } catch {}
  }

  function buildSignedProxyUrl({ source, mediaType, mediaId, extension, seriesId, season }) {
    if (!webAppUrl) throw new Error("WEBAPP_URL غير مضبوط.");

    const payload = Buffer.from(
      JSON.stringify({
        s: source.id,
        t: mediaType,
        i: String(mediaId),
        e: xtream.safeExt(extension),
        r: seriesId ? String(seriesId) : "",
        n: season !== undefined && season !== null ? String(season) : "",
        x: Math.floor(Date.now() / 1000) + 20 * 60
      }),
      "utf8"
    ).toString("base64url");

    const signature = crypto
      .createHmac("sha256", token)
      .update(payload)
      .digest("base64url");

    const ext = xtream.safeExt(extension);
    return `${webAppUrl.replace(/\/$/, "")}/media/${payload}/${signature}/stream.${ext}`;
  }

  function mediaContentType(ext) {
    const value = xtream.safeExt(ext);
    const map = {
      mp4: "video/mp4",
      m4v: "video/mp4",
      mov: "video/quicktime",
      webm: "video/webm",
      mkv: "video/x-matroska",
      avi: "video/x-msvideo",
      ts: "video/mp2t"
    };
    return map[value] || "application/octet-stream";
  }

  function safeFilename(title, ext) {
    const base = String(title || "stream")
      .replace(/[\\/:*?"<>|\r\n]+/g, "_")
      .trim()
      .slice(0, 90) || "stream";
    return `${base}.${xtream.safeExt(ext)}`;
  }

  function formatBytes(bytes) {
    const value = Number(bytes || 0);
    if (!Number.isFinite(value) || value <= 0) return "0 MB";
    const units = ["B", "KB", "MB", "GB"];
    let size = value;
    let index = 0;

    while (size >= 1024 && index < units.length - 1) {
      size /= 1024;
      index += 1;
    }

    const digits = index >= 2 ? 1 : 0;
    return `${size.toFixed(digits)} ${units[index]}`;
  }

  function formatEta(seconds) {
    const value = Math.max(0, Math.round(Number(seconds || 0)));
    if (!Number.isFinite(value)) return "غير معروف";

    if (value < 60) return `${value} ثانية`;

    const minutes = Math.floor(value / 60);
    const secs = value % 60;

    if (minutes < 60) {
      return secs ? `${minutes} دقيقة و${secs} ثانية` : `${minutes} دقيقة`;
    }

    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return mins ? `${hours} ساعة و${mins} دقيقة` : `${hours} ساعة`;
  }

  async function safeEditMessage(chatId, messageId, text) {
    if (!chatId || !messageId) return;
    try {
      await bot.editMessageText(text.slice(0, 3900), {
        chat_id: chatId,
        message_id: messageId
      });
    } catch {}
  }

  async function downloadXtreamToFile({ upstreamUrl, tempPath, maxUploadBytes, onProgress }) {
    const chunkSize = 4 * 1024 * 1024;
    const maxRetries = 6;
    let offset = 0;
    let totalSize = null;
    let rangeSupported = null;
    let lastSignalAt = 0;

    const fileSize = async () => {
      try {
        return (await fs.promises.stat(tempPath)).size;
      } catch {
        return 0;
      }
    };

    const signalProgress = (downloaded, force = false) => {
      if (typeof onProgress !== "function") return;

      const now = Date.now();
      if (!force && now - lastSignalAt < 5000) return;
      lastSignalAt = now;

      Promise.resolve(
        onProgress({
          downloaded,
          total: totalSize,
          force
        })
      ).catch(() => {});
    };

    const appendResponse = async (response, flags = "a") => {
      let downloadedThisResponse = 0;

      const counter = new Transform({
        transform(chunk, encoding, callback) {
          downloadedThisResponse += chunk.length;
          const projected = offset + downloadedThisResponse;

          if (projected > maxUploadBytes) {
            callback(new Error("حجم الملف الفعلي أكبر من حد Telegram Local Bot API المسموح."));
            return;
          }

          signalProgress(projected, false);
          callback(null, chunk);
        }
      });

      await pipeline(
        Readable.fromWeb(response.body),
        counter,
        fs.createWriteStream(tempPath, { flags })
      );

      return downloadedThisResponse;
    };

    for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
      try {
        const response = await fetch(upstreamUrl, {
          method: "GET",
          redirect: "follow",
          headers: {
            "user-agent": "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Safari/537.36",
            accept: "*/*",
            range: `bytes=0-${chunkSize - 1}`
          },
          signal: AbortSignal.timeout(120000)
        });

        if (!response.ok && response.status !== 206) {
          throw new Error(`Xtream HTTP ${response.status}`);
        }

        rangeSupported = response.status === 206;

        if (rangeSupported) {
          const contentRange = String(response.headers.get("content-range") || "");
          const match = contentRange.match(/bytes\s+(\d+)-(\d+)\/(\d+|\*)/i);

          if (match && match[3] !== "*") {
            const announcedTotal = Number(match[3]);
            // بعض مزودي Xtream يرجعون إجمالي خاطئ داخل Content-Range.
            // نستخدمه للتقدم فقط إذا كان ضمن الحد المنطقي، ولا نرفض الملف بناءً عليه.
            totalSize =
              Number.isFinite(announcedTotal) &&
              announcedTotal > 0 &&
              announcedTotal <= maxUploadBytes
                ? announcedTotal
                : null;
          }

          signalProgress(0, true);

          await fs.promises.writeFile(tempPath, Buffer.alloc(0));
          offset = 0;
          const received = await appendResponse(response, "a");
          offset += received;
          signalProgress(offset, true);
        } else {
          await fs.promises.writeFile(tempPath, Buffer.alloc(0));
          offset = 0;
          signalProgress(0, true);
          const received = await appendResponse(response, "a");
          offset += received;
          signalProgress(offset, true);
          return offset;
        }

        break;
      } catch (error) {
        if (attempt === maxRetries) {
          throw new Error(`تعذر تنزيل الفيديو من Xtream بعد عدة محاولات: ${error.message}`);
        }
        await new Promise((resolve) => setTimeout(resolve, attempt * 1200));
      }
    }

    if (!rangeSupported) {
      return offset;
    }

    let reachedEnd = false;

    while (!reachedEnd && (totalSize === null || offset < totalSize)) {
      const end = totalSize
        ? Math.min(offset + chunkSize - 1, totalSize - 1)
        : offset + chunkSize - 1;

      let completed = false;

      for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
        try {
          const response = await fetch(upstreamUrl, {
            method: "GET",
            redirect: "follow",
            headers: {
              "user-agent": "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Safari/537.36",
              accept: "*/*",
              range: `bytes=${offset}-${end}`
            },
            signal: AbortSignal.timeout(120000)
          });

          if (response.status === 416 && offset > 0) {
            // Range Not Satisfiable after downloaded bytes means EOF.
            totalSize = offset;
            reachedEnd = true;
            completed = true;
            signalProgress(offset, true);
            break;
          }

          if (response.status !== 206) {
            throw new Error(`Xtream لم يدعم استكمال التنزيل عند البايت ${offset} (HTTP ${response.status})`);
          }

          const contentRange = String(response.headers.get("content-range") || "");
          const match = contentRange.match(/bytes\s+(\d+)-(\d+)\/(\d+|\*)/i);

          if (match) {
            const returnedStart = Number(match[1]);
            if (returnedStart !== offset) {
              throw new Error("Xtream رجع Range مختلف عن المطلوب.");
            }

            if (match[3] !== "*") {
              const discoveredTotal = Number(match[3]);
              totalSize =
                Number.isFinite(discoveredTotal) &&
                discoveredTotal > 0 &&
                discoveredTotal <= maxUploadBytes
                  ? discoveredTotal
                  : null;
            }
          }

          const before = await fileSize();
          if (before !== offset) {
            offset = before;
          }

          const received = await appendResponse(response, "a");
          if (!received) {
            throw new Error("Xtream رجع جزء فارغ.");
          }

          offset += received;
          signalProgress(offset, true);

          const requestedLength = end - (offset - received) + 1;
          if (received < requestedLength) {
            totalSize = offset;
            reachedEnd = true;
          }

          completed = true;
          break;
        } catch (error) {
          offset = await fileSize();

          if (offset > maxUploadBytes) {
            throw new Error("حجم الملف الفعلي أكبر من حد Telegram Local Bot API المسموح.");
          }

          signalProgress(offset, true);

          if (attempt === maxRetries) {
            throw new Error(`انقطع تنزيل Xtream ولم ينجح الاستكمال: ${error.message}`);
          }

          await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
        }
      }

      if (!completed) {
        throw new Error("تعذر إكمال تنزيل الفيديو من Xtream.");
      }

      if (totalSize !== null && offset >= totalSize) {
        break;
      }
    }

    const finalSize = await fileSize();
    signalProgress(finalSize, true);
    return finalSize;
  }

  async function uploadMediaStream({ target, source, mediaType, mediaId, extension, title, caption, onProgress }) {
    const upstreamUrl = mediaType === "movie"
      ? xtream.movieUrl(source, mediaId, extension)
      : xtream.episodeUrl(source, mediaId, extension);

    const ext = xtream.safeExt(extension);
    const tempDir = path.join(os.tmpdir(), "streamora-media");
    fs.mkdirSync(tempDir, { recursive: true });

    const tempPath = path.join(
      tempDir,
      `${source.id}-${mediaType}-${mediaId}-${Date.now()}.${ext}`
    );

    const maxUploadBytes = 1_990_000_000;

    try {
      const actualSize = await downloadXtreamToFile({
        upstreamUrl,
        tempPath,
        maxUploadBytes,
        onProgress
      });

      if (!actualSize) {
        throw new Error("Xtream رجع ملف فارغ.");
      }

      if (actualSize > maxUploadBytes) {
        throw new Error("حجم الملف الفعلي أكبر من حد Telegram Local Bot API المسموح.");
      }

      let message;

      if (["mp4", "m4v", "mov", "webm"].includes(ext)) {
        message = await bot.sendVideo(
          target,
          tempPath,
          { caption, supports_streaming: true },
          {
            filename: safeFilename(title, ext),
            contentType: mediaContentType(ext)
          }
        );
      } else {
        message = await bot.sendDocument(
          target,
          tempPath,
          { caption },
          {
            filename: safeFilename(title, ext),
            contentType: mediaContentType(ext)
          }
        );
      }

      return { message, actualSize };
    } finally {
      try {
        await fs.promises.unlink(tempPath);
      } catch {}
    }
  }

  async function deliverAuthorizedMedia({ chatId, source, mediaType, mediaId, extension, title, seriesId, season }) {
    const config = loadConfig();
    const key = `${source.id}:${mediaType}:${mediaId}`;
    const kindLabel = mediaType === "movie" ? "الفيلم" : "الحلقة";
    const ext = xtream.safeExt(extension);

    await sendBrandHeader(chatId, title);

    const cached = config.cache?.[key];
    if (cached && config.storageChannelId && cached.messageId) {
      try {
        const status = await bot.sendMessage(
          chatId,
          `الملف موجود مسبقاً في قناة التخزين.\nجاري إرسال ${kindLabel}: ${title}`
        );

        await bot.copyMessage(chatId, config.storageChannelId, cached.messageId);

        await safeEditMessage(
          chatId,
          status.message_id,
          `تم إرسال ${kindLabel} بنجاح.\nالملف: ${title}`
        );

        return { cached: true, messageId: cached.messageId };
      } catch {
        updateConfig((next) => {
          delete next.cache[key];
          return next;
        });
      }
    }

    const rights = config.brand.rights ? `\n\n${config.brand.rights}` : "";
    const caption = `${title || "Streamora"}${rights}`.slice(0, 1024);
    const target = config.storageChannelId || chatId;

    let userStatus = null;
    let channelStatus = null;
    let lastProgressEditAt = 0;
    let progressChain = Promise.resolve();
    const startedAt = Date.now();

    try {
      userStatus = await bot.sendMessage(
        chatId,
        `بدأ تحميل ${kindLabel}.\nالملف: ${title}\nالصيغة: ${ext.toUpperCase()}\nالحالة: جاري الاتصال بـ Xtream...`
      );

      if (config.storageChannelId) {
        channelStatus = await bot.sendMessage(
          config.storageChannelId,
          `بدأ تحميل ${kindLabel}\nالملف: ${title}\nالصيغة: ${ext.toUpperCase()}\nالحالة: جاري التنزيل من Xtream`
        );
      }

      const reportProgress = ({ downloaded, total, force = false }) => {
        const now = Date.now();

        if (!force && now - lastProgressEditAt < 6000) {
          return;
        }

        lastProgressEditAt = now;

        const elapsedSeconds = Math.max(1, (now - startedAt) / 1000);
        const speed = downloaded / elapsedSeconds;
        const remaining = total ? Math.max(0, total - downloaded) : null;
        const percent = total ? Math.min(100, (downloaded / total) * 100) : null;
        const eta = total && speed > 0 ? remaining / speed : null;

        const lines = [
          `جاري تحميل ${kindLabel}`,
          `الملف: ${title}`,
          "",
          total
            ? `تم: ${formatBytes(downloaded)} / ${formatBytes(total)}`
            : `تم تنزيل: ${formatBytes(downloaded)}`,
          total ? `المتبقي: ${formatBytes(remaining)}` : "المتبقي: غير معروف من المصدر",
          percent !== null ? `النسبة: ${percent.toFixed(1)}%` : null,
          speed > 0 ? `السرعة: ${formatBytes(speed)}/ث` : null,
          eta !== null ? `الوقت المتوقع: ${formatEta(eta)}` : null,
          "",
          "الحالة: تنزيل من Xtream"
        ].filter(Boolean);

        progressChain = progressChain
          .then(() => safeEditMessage(chatId, userStatus?.message_id, lines.join("\n")))
          .catch(() => {});
      };

      let sent;
      let actualSize = null;

      if (botApiBaseUrl) {
        const uploadResult = await uploadMediaStream({
          target,
          source,
          mediaType,
          mediaId,
          extension: ext,
          title,
          caption,
          onProgress: reportProgress
        });

        sent = uploadResult.message;
        actualSize = uploadResult.actualSize;

        await progressChain;

        await safeEditMessage(
          chatId,
          userStatus?.message_id,
          `اكتمل تنزيل ${kindLabel}.\nالملف: ${title}\nالحجم: ${formatBytes(actualSize)}\nالحالة: جاري الرفع إلى Telegram...`
        );
      } else {
        const url = buildSignedProxyUrl({
          source,
          mediaType,
          mediaId,
          extension: ext,
          seriesId,
          season
        });

        try {
          if (["mp4", "m4v", "mov", "webm"].includes(ext)) {
            sent = await bot.sendVideo(target, url, {
              caption,
              supports_streaming: true
            });
          } else {
            sent = await bot.sendDocument(target, url, { caption });
          }
        } catch {
          throw new Error(
            "Telegram Cloud Bot API رفض جلب هذا الملف كرابط. الفيديوهات الكبيرة تحتاج Local Bot API."
          );
        }
      }

      if (config.storageChannelId && sent?.message_id) {
        updateConfig((next) => {
          next.cache[key] = {
            messageId: sent.message_id,
            createdAt: new Date().toISOString()
          };
          return next;
        });

        await bot.copyMessage(chatId, config.storageChannelId, sent.message_id);
      }

      await safeEditMessage(
        chatId,
        userStatus?.message_id,
        [
          `تم إرسال ${kindLabel} بنجاح.`,
          `الملف: ${title}`,
          actualSize ? `الحجم: ${formatBytes(actualSize)}` : null,
          config.storageChannelId ? "تم حفظ نسخة في قناة التخزين." : null
        ].filter(Boolean).join("\n")
      );

      if (channelStatus && config.storageChannelId) {
        await safeEditMessage(
          config.storageChannelId,
          channelStatus.message_id,
          [
            `اكتمل تحميل ${kindLabel}`,
            `الملف: ${title}`,
            actualSize ? `الحجم: ${formatBytes(actualSize)}` : null,
            "الحالة: تم الحفظ في القناة"
          ].filter(Boolean).join("\n")
        );
      }

      return { cached: false, messageId: sent?.message_id || null, actualSize };
    } catch (error) {
      await safeEditMessage(
        chatId,
        userStatus?.message_id,
        `فشل تحميل/إرسال ${kindLabel}.\nالملف: ${title}\nالسبب: ${error.message}`
      );

      if (channelStatus && config.storageChannelId) {
        await safeEditMessage(
          config.storageChannelId,
          channelStatus.message_id,
          `فشل تحميل ${kindLabel}\nالملف: ${title}\nالسبب: ${error.message}`
        );
      }

      throw error;
    }
  }

  return {
    bot,
    deliverAuthorizedMedia,
    isAdmin
  };
}

module.exports = { createTelegramService };
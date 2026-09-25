const TelegramBot = require("node-telegram-bot-api");
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

  if (!token) throw new Error("BOT_TOKEN is required");
  if (!adminId) throw new Error("ADMIN_ID is required");

  const bot = new TelegramBot(token, { polling: true });
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
        `القناة الحالية: ${config.storageChannelId || "غير مضبوطة"}\n\nأرسل Channel ID مثل -1001234567890. يجب أن يكون البوت مشرفاً بالقناة.\nأرسل 0 لإلغاء القناة.`
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
        const value = String(msg.text || "").trim();
        if (!/^-?\d+$/.test(value)) throw new Error("Channel ID غير صحيح.");

        if (value === "0") {
          updateConfig((config) => {
            config.storageChannelId = null;
            return config;
          });
        } else {
          await bot.getChat(value);
          updateConfig((config) => {
            config.storageChannelId = value;
            return config;
          });
        }

        states.delete(key);
        await bot.sendMessage(msg.chat.id, value === "0" ? "تم إلغاء قناة التخزين." : "تم حفظ قناة التخزين.");
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

  async function deliverAuthorizedMedia({ chatId, source, mediaType, mediaId, extension, title }) {
    const config = loadConfig();
    const key = `${source.id}:${mediaType}:${mediaId}`;

    await sendBrandHeader(chatId, title);

    const cached = config.cache?.[key];
    if (cached && config.storageChannelId && cached.messageId) {
      try {
        await bot.copyMessage(chatId, config.storageChannelId, cached.messageId);
        return { cached: true, messageId: cached.messageId };
      } catch {
        updateConfig((next) => {
          delete next.cache[key];
          return next;
        });
      }
    }

    const url = mediaType === "movie"
      ? xtream.movieUrl(source, mediaId, extension)
      : xtream.episodeUrl(source, mediaId, extension);

    const rights = config.brand.rights ? `\n\n${config.brand.rights}` : "";
    const caption = `${title || "Streamora"}${rights}`.slice(0, 1024);
    const target = config.storageChannelId || chatId;

    let sent;
    const ext = xtream.safeExt(extension);

    try {
      if (["mp4", "m4v", "mov", "webm"].includes(ext)) {
        sent = await bot.sendVideo(target, url, {
          caption,
          supports_streaming: true
        });
      } else {
        sent = await bot.sendDocument(target, url, { caption });
      }
    } catch (firstError) {
      try {
        sent = await bot.sendDocument(target, url, { caption });
      } catch (secondError) {
        throw new Error(`تعذر إرسال الملف من Xtream: ${secondError.message || firstError.message}`);
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

    return { cached: false, messageId: sent?.message_id || null };
  }

  return {
    bot,
    deliverAuthorizedMedia,
    isAdmin
  };
}

module.exports = { createTelegramService };
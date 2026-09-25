const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = path.resolve(process.env.DATA_DIR || "./data");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");

const DEFAULT_CONFIG = {
  sources: [],
  storageChannelId: null,
  brand: {
    name: "Streamora",
    rights: "",
    coverFileId: null
  },
  cache: {}
};

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadConfig() {
  ensureDir();
  if (!fs.existsSync(CONFIG_FILE)) return clone(DEFAULT_CONFIG);

  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    return {
      ...clone(DEFAULT_CONFIG),
      ...raw,
      brand: { ...DEFAULT_CONFIG.brand, ...(raw.brand || {}) },
      sources: Array.isArray(raw.sources) ? raw.sources : [],
      cache: raw.cache && typeof raw.cache === "object" ? raw.cache : {}
    };
  } catch {
    return clone(DEFAULT_CONFIG);
  }
}

function saveConfig(config) {
  ensureDir();
  const temp = CONFIG_FILE + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(config, null, 2), "utf8");
  fs.renameSync(temp, CONFIG_FILE);
  return config;
}

function updateConfig(mutator) {
  const config = loadConfig();
  const next = mutator(config) || config;
  return saveConfig(next);
}

function addSource(source) {
  return updateConfig((config) => {
    config.sources.push({
      id: crypto.randomUUID().replace(/-/g, "").slice(0, 12),
      name: source.name,
      baseUrl: source.baseUrl.replace(/\/$/, ""),
      username: source.username,
      password: source.password,
      active: true,
      createdAt: new Date().toISOString()
    });
    return config;
  });
}

function publicSource(source) {
  return {
    id: source.id,
    name: source.name,
    active: source.active !== false
  };
}

function activeSources() {
  return loadConfig().sources.filter((s) => s.active !== false);
}

module.exports = {
  loadConfig,
  saveConfig,
  updateConfig,
  addSource,
  publicSource,
  activeSources
};

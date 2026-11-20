const DEFAULT_CONFIG = {
  apiBase: "https://danmu-api-93060.app.workbuddy.host?sharecode=4ZIBWTWGZ4",
  rules: [
    {
      id: "lxyy",
      name: "洛雪TV",
      patterns: ["*://tv.lxyy.club/*"],
      enabled: true,
      autoFill: true,
      autoLoad: true,
      titleSelectors: [
        "h1",
        "h2",
        "[class*='title']",
        "[class*='name']",
        "meta[property='og:title']",
        "meta[name='title']"
      ]
    }
  ],
  style: {
    fontSize: 25,
    color: "#ffffff",
    opacity: 0.9,
    speed: 8,
    maxLines: 8
  },
  cacheTTL: 300000
};

const cache = new Map();

chrome.runtime.onInstalled.addListener(async () => {
  const { config } = await chrome.storage.sync.get({ config: DEFAULT_CONFIG });
  await chrome.storage.sync.set({ config });
  await migrateApiConfig();
  await ensureDefaultRule();
  safeSync();
});

chrome.runtime.onStartup.addListener(async () => {
  await migrateApiConfig();
  await ensureDefaultRule();
  safeSync();
});

async function migrateApiConfig() {
  const { config } = await chrome.storage.sync.get({ config: DEFAULT_CONFIG });
  if (!config || !("shareCode" in config)) return;
  if (config.shareCode && config.apiBase) {
    try {
      const u = new URL(config.apiBase);
      if (!u.searchParams.has("sharecode")) {
        u.searchParams.set("sharecode", config.shareCode);
        config.apiBase = u.toString();
      }
    } catch (e) {}
  }
  delete config.shareCode;
  await chrome.storage.sync.set({ config });
}

async function ensureDefaultRule() {
  const { config } = await chrome.storage.sync.get({ config: DEFAULT_CONFIG });
  if (!config) return;
  let changed = false;
  if (!Array.isArray(config.rules)) {
    config.rules = JSON.parse(JSON.stringify(DEFAULT_CONFIG.rules));
    changed = true;
  }
  if (!config.defaultRuleMigrated) {
    if (!config.rules.some((r) => r.id === "lxyy")) {
      config.rules.unshift(JSON.parse(JSON.stringify(DEFAULT_CONFIG.rules[0])));
    }
    changed = true;
    config.defaultRuleMigrated = true;
  }
  if (changed) await chrome.storage.sync.set({ config });
}

function safeSync() {
  syncContentScripts().catch((e) => console.warn("[danmu] 内容脚本同步失败", e));
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
  return true;
});

async function handleMessage(msg, sender) {
  switch (msg.type) {
    case "GET_CONFIG": {
      const { config } = await chrome.storage.sync.get({ config: DEFAULT_CONFIG });
      if (!config || !Array.isArray(config.rules)) {
        return {
          ok: true,
          config: {
            ...DEFAULT_CONFIG,
            ...(config || {}),
            rules: JSON.parse(JSON.stringify(DEFAULT_CONFIG.rules))
          }
        };
      }
      return { ok: true, config };
    }
    case "SAVE_CONFIG": {
      if (!msg.config || !Array.isArray(msg.config.rules)) throw new Error("配置格式不正确");
      await chrome.storage.sync.set({ config: msg.config });
      cache.clear();
      await syncContentScripts();
      await broadcastConfig(msg.config);
      return { ok: true };
    }
    case "RESET_CONFIG": {
      await chrome.storage.sync.set({ config: DEFAULT_CONFIG });
      cache.clear();
      await syncContentScripts().catch(() => {});
      await broadcastConfig(DEFAULT_CONFIG);
      return { ok: true, config: DEFAULT_CONFIG };
    }
    case "API_SEARCH_ANIME":
      return { ok: true, items: await searchAnime(msg.keyword) };
    case "API_SEARCH_EPISODES":
      return {
        ok: true,
        items: await searchEpisodes(msg.anime, {
          animeId: msg.animeId,
          animeTitle: msg.animeTitle
        })
      };
    case "API_GET_COMMENTS":
      return { ok: true, comments: await getComments(msg) };
    case "AUTO_LOAD":
      return autoLoad(msg.title, sender.tab && sender.tab.id);
    case "DANMU_KEYWORD_MATCHED":
    case "DANMU_WIZARD_STATE":
      return { ok: true };
    default:
      return { ok: false, error: `未知消息: ${msg.type}` };
  }
}

function buildApiUrl(base, path) {
  const u = new URL(base);
  const [p, query] = String(path).split("?");
  const suffix = p.startsWith("/") ? p : `/${p}`;
  u.pathname = `${u.pathname.replace(/\/+$/, "")}${suffix}` || "/";
  if (query) {
    for (const [k, v] of new URLSearchParams(query)) u.searchParams.set(k, v);
  }
  return u.toString();
}

async function api(path, options = {}) {
  const { config } = await chrome.storage.sync.get({ config: DEFAULT_CONFIG });
  if (!config.apiBase || /example\.com/.test(config.apiBase)) {
    throw new Error("请先在插件配置页填写弹幕 API 地址");
  }
  let url;
  try {
    url = buildApiUrl(config.apiBase, path);
  } catch (e) {
    throw new Error("弹幕 API 地址格式不正确");
  }
  const method = options.method || "GET";
  const key = `${method}:${url}`;
  const now = Date.now();
  if (method === "GET" && cache.has(key)) {
    const hit = cache.get(key);
    if (now - hit.t < (config.cacheTTL || 300000)) return hit.v;
    cache.delete(key);
  }
  const res = await fetch(url, {
    method,
    headers: { Accept: "application/json", ...(options.headers || {}) },
    body: options.body
  });
  if (!res.ok) throw new Error(`弹幕 API 返回 ${res.status}`);
  const data = await res.json();
  if (method === "GET") cache.set(key, { t: now, v: data });
  return data;
}

async function searchAnime(keyword) {
  if (!keyword) return [];
  const data = await api(`/api/v2/search/anime?keyword=${encodeURIComponent(keyword)}`);
  return extractItems(data);
}

async function searchEpisodes(anime, filter = {}) {
  const keyword = cleanAnimeKeyword(anime);
  if (!keyword) return [];
  const data = await api(`/api/v2/search/episodes?anime=${encodeURIComponent(keyword)}`);
  const animes = extractItems(data);

  let targetAnimes = animes;
  if (filter.animeId) {
    const byId = animes.filter((a) => String(a.animeId) === String(filter.animeId));
    if (byId.length) targetAnimes = byId;
  }
  if (targetAnimes === animes && filter.animeTitle) {
    const key = cleanAnimeKeyword(filter.animeTitle);
    const exact = animes.filter((a) => cleanAnimeKeyword(a.animeTitle) === key);
    if (exact.length) {
      targetAnimes = exact;
    } else {
      const loose = animes.filter((a) => cleanAnimeKeyword(a.animeTitle).includes(key));
      if (loose.length) targetAnimes = loose;
    }
  }

  const episodes = [];
  for (const a of targetAnimes) {
    const list = Array.isArray(a.episodes) ? a.episodes : [];
    for (const e of list) {
      episodes.push({
        ...e,
        animeTitle: a.animeTitle || a.title || a.name || "",
        animeId: a.animeId
      });
    }
  }
  return episodes;
}

function cleanAnimeKeyword(title) {
  return String(title || "")
    .replace(/【[^】]*】/g, "")
    .replace(/\s*from\s+\w+\s*$/i, "")
    .replace(/\(\d{4}\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function getComments(target = {}) {
  const path = target.id
    ? `/api/v2/comment/${encodeURIComponent(target.id)}?format=json`
    : `/api/v2/comment?url=${encodeURIComponent(target.url || "")}&format=json`;
  const data = await api(path);
  return parseComments(data);
}

async function autoLoad(title, tabId) {
  if (!title) return { ok: false, reason: "no-title" };
  const animes = await searchAnime(title);
  if (!animes.length) return { ok: false, reason: "no-anime" };
  const anime = animes[0];
  const animeName = itemTitle(anime);
  const episodes = await searchEpisodes(animeName, {
    animeId: anime.animeId,
    animeTitle: animeName
  });
  if (!episodes.length) return { ok: false, reason: "no-episode" };

  const wanted = extractEpisodeNo(title);
  let episode = episodes[0];
  if (wanted != null) {
    const matched = episodes.find((e) => extractEpisodeNo(e.episodeTitle) === wanted);
    if (matched) episode = matched;
  }

  const target = commentTarget(episode);
  if (!target.id && !target.url) return { ok: false, reason: "no-comment-target" };
  const comments = await getComments(target);
  const episodeLabel = episode.episodeTitle || episode.title || "";
  if (tabId) {
    await chrome.tabs
      .sendMessage(tabId, { type: "CONTENT_LOAD_DANMU", comments, episode: episodeLabel })
      .catch(() => {});
  }
  return {
    ok: true,
    count: comments.length,
    anime: animeName,
    episode: episodeLabel
  };
}

function extractItems(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];
  for (const key of ["animes", "data", "results", "list", "items"]) {
    if (Array.isArray(data[key])) return data[key];
  }
  return [];
}

function parseComments(data) {
  let arr = extractItems(data);
  if (!arr.length && data && Array.isArray(data.comments)) arr = data.comments;
  return arr.map(normalizeComment).filter((c) => c.text && Number.isFinite(c.time));
}

function normalizeComment(item) {
  if (item && typeof item === "object" && item.p && item.m) {
    const parts = String(item.p).split(",");
    return {
      time: parseFloat(parts[0] ?? item.t ?? 0),
      mode: parseInt(parts[1], 10) || 1,
      color: colorFromDec(parseInt(parts[2], 10)),
      text: String(item.m),
      fontSize: undefined
    };
  }
  if (Array.isArray(item)) {
    return {
      time: parseFloat(item[0]),
      mode: parseInt(item[1], 10) || 1,
      fontSize: parseFloat(item[2]) || undefined,
      color: colorFromDec(parseInt(item[3], 10)),
      text: String(item[4] ?? "")
    };
  }
  const rawTime = item.time ?? item.t ?? item.begin ?? item.P ?? item.second ?? 0;
  const rawMode = item.mode ?? item.type ?? item.position ?? 1;
  const rawColor = item.color ?? item.fontColor ?? item.font_color;
  return {
    time: parseFloat(rawTime),
    mode: typeof rawMode === "string" ? modeFromString(rawMode) : Number(rawMode) || 1,
    fontSize: parseFloat(item.fontSize ?? item.size ?? item.fontsize) || undefined,
    color: typeof rawColor === "number" ? colorFromDec(rawColor) : rawColor || "#ffffff",
    text: String(item.text ?? item.content ?? item.comment ?? "")
  };
}

function modeFromString(s) {
  const v = String(s).toLowerCase();
  if (v.includes("bottom")) return 4;
  if (v.includes("top")) return 5;
  return 1;
}

function colorFromDec(n) {
  if (!Number.isFinite(n)) return "#ffffff";
  const v = Math.max(0, Math.min(0xffffff, n));
  return `#${v.toString(16).padStart(6, "0")}`;
}

function itemTitle(item) {
  return item?.animeTitle || item?.title || item?.name || item?.anime || "";
}

function commentTarget(item) {
  const id = item?.episodeId ?? item?.commentId ?? item?.cid ?? item?.id;
  const url = item?.url ?? item?.videoUrl ?? item?.playUrl;
  return { id: id || undefined, url: url || undefined };
}

function extractEpisodeNo(text) {
  const s = String(text || "");
  let m = s.match(/第\s*0*(\d+)\s*集/);
  if (!m) m = s.match(/[SE]0*\d+E0*(\d+)/i);
  if (!m) m = s.match(/#0*(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

async function broadcastConfig(config) {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch (e) {
    return;
  }
  const messages = [
    { type: "CONTENT_SET_STYLE", style: config.style || {} },
    { type: "CONTENT_SET_RULES", rules: config.rules || [] }
  ];
  await Promise.all(
    tabs.map(async (tab) => {
      let frames = [{ frameId: 0 }];
      try {
        const all = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
        if (all && all.length) frames = all;
      } catch (e) {}
      await Promise.all(
        frames.flatMap((frame) =>
          messages.map((message) =>
            chrome.tabs.sendMessage(tab.id, message, { frameId: frame.frameId }).catch(() => {})
          )
        )
      );
    })
  );
}

async function syncContentScripts() {
  const { config } = await chrome.storage.sync.get({ config: DEFAULT_CONFIG });
  let existing = [];
  try {
    existing = await chrome.scripting.getRegisteredContentScripts();
  } catch (e) {
    existing = [];
  }
  const oldIds = existing.filter((s) => s.id.startsWith("danmu-")).map((s) => s.id);
  if (oldIds.length) await chrome.scripting.unregisterContentScripts({ ids: oldIds });

  const scripts = [];
  for (const rule of config.rules || []) {
    if (!rule.enabled || !Array.isArray(rule.patterns) || !rule.patterns.length) continue;
    scripts.push({
      id: `danmu-${rule.id}`,
      matches: rule.patterns,
      js: ["content.js"],
      runAt: "document_idle",
      allFrames: true
    });
  }
  if (scripts.length) await chrome.scripting.registerContentScripts(scripts);
}

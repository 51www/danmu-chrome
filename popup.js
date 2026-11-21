let tabId = null;
let state = null;
let popupConfig = null;
let editingRuleIndex = -1;
let saveTimer = null;

const $ = (id) => document.getElementById(id);

function setTag(el, text, ok) {
  el.innerHTML = "";
  const tag = document.createElement("span");
  tag.className = `tag ${ok ? "ok" : "no"}`;
  tag.textContent = text;
  el.appendChild(tag);
}

document.addEventListener("DOMContentLoaded", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id || null;

  $("searchBtn").addEventListener("click", doSearch);
  $("keyword").addEventListener("keydown", (e) => {
    if (e.key === "Enter") doSearch();
  });
  $("clearBtn").addEventListener("click", clearDanmu);
  $("autoMatchBtn").addEventListener("click", autoMatch);
  $("addCurrentSite").addEventListener("click", addCurrentSite);
  bindSettings();

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "DANMU_KEYWORD_MATCHED") {
      if (state && msg.url !== state.url) return;
      if (!$("keyword").value) $("keyword").value = msg.keyword;
      setMessage(`已识别弹幕关键字：${msg.keyword}`, "success");
      return;
    }
    if (msg.type === "DANMU_WIZARD_STATE") {
      if (state && msg.url !== state.url) return;
      refreshState();
    }
  });

  await Promise.all([refreshState(), loadConfig()]);
});

async function refreshState() {
  setMessage("");
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "CONTENT_GET_STATE" });
    if (!res || !res.ok) throw new Error("内容脚本无响应");
    state = res;
    setTag($("ruleName"), res.rule || "未命中清单", !!res.rule);
    $("title").textContent = res.title || "-";
    $("episode").textContent = res.episode || "-";
    $("wizardState").textContent = formatWizardState(res);
    $("count").textContent = String(res.loaded || 0);
    if ((res.loaded || 0) > 0) {
      setMessage(`已加载 ${res.loaded} 条弹幕`, "success");
    }
    const { config } = await chrome.runtime.sendMessage({ type: "GET_CONFIG" });
    const rule = (config.rules || []).find((r) => r.name === res.rule);
    const keyword = res.matchedKeyword || (res.matchState === "done" ? res.title : "");
    if (rule?.autoFill !== false && keyword && !$("keyword").value) {
      $("keyword").value = keyword;
    }
  } catch (e) {
    state = null;
    setTag($("ruleName"), "未命中清单", false);
    $("title").textContent = "-";
    $("episode").textContent = "-";
    $("wizardState").textContent = "-";
    $("count").textContent = "0";
    setMessage("当前网址不在清单中，仍可手动搜索；加载弹幕时会向当前页注入弹幕层。", "error");
  }
}

function formatWizardState(res) {
  const names = { keyword: "选关键词", anime: "选作品", episode: "选剧集", done: "完成" };
  if (res.matchState === "done" && !res.wizardBusy) return "完成";
  if (!res.wizardStep) return "-";
  const step = names[res.wizardStep] || res.wizardStep;
  const prefix = res.wizardBusy ? "进行中 · " : res.wizardError ? "需处理 · " : "";
  return `${prefix}${step}${res.wizardStatus ? `：${res.wizardStatus}` : ""}`;
}

async function doSearch() {
  const keyword = $("keyword").value.trim();
  if (!keyword) {
    setMessage("请先输入搜索关键字", "error");
    return;
  }
  setMessage("正在搜索作品…");
  clearResults();
  try {
    const res = await chrome.runtime.sendMessage({
      type: "API_SEARCH_ANIME",
      keyword
    });
    if (!res || !res.ok) throw new Error(res?.error || "搜索失败");
    renderGroup("选择作品", res.items, (item) => item.animeTitle || item.title || item.name, loadEpisodes);
    setMessage(`找到 ${res.items.length} 个作品`);
  } catch (e) {
    setMessage(e.message || String(e), "error");
  }
}

async function loadEpisodes(anime) {
  const animeName = anime.animeTitle || anime.title || anime.name || "";
  setMessage(`正在获取《${animeName}》剧集…`);
  clearResults();
  try {
    const res = await chrome.runtime.sendMessage({
      type: "API_SEARCH_EPISODES",
      anime: animeName,
      animeId: anime.animeId,
      animeTitle: animeName
    });
    if (!res || !res.ok) throw new Error(res?.error || "获取剧集失败");
    renderGroup(
      `选择剧集 · ${animeName}`,
      res.items,
      (item) => item.episodeTitle || item.title || item.name,
      loadComments
    );
    setMessage(`找到 ${res.items.length} 集`);
  } catch (e) {
    setMessage(e.message || String(e), "error");
  }
}

async function autoMatch() {
  if (!(await requireContentScript())) return;
  setMessage("正在按站点标题规则匹配关键词…");
  try {
    let frames = [];
    try {
      frames = (await chrome.webNavigation.getAllFrames({ tabId })) || [];
    } catch (e) {}
    if (!frames.length) frames = [{ frameId: 0 }];
    const results = await Promise.all(
      frames.map((frame) =>
        chrome.tabs
          .sendMessage(tabId, { type: "CONTENT_AUTO_MATCH" }, { frameId: frame.frameId })
          .catch(() => null)
      )
    );
    const candidates = [];
    const seen = new Set();
    for (const res of results) {
      for (const text of res?.candidates || []) {
        if (seen.has(text)) continue;
        seen.add(text);
        candidates.push(text);
      }
    }
    const list = $("keywordOptions");
    list.innerHTML = "";
    candidates.forEach((text) => {
      const option = document.createElement("option");
      option.value = text;
      list.appendChild(option);
    });
    if (!candidates.length) {
      setMessage("未能按规则定位到标题，请手动输入关键词后点「搜索」。", "error");
      return;
    }
    $("keyword").value = candidates[0];
    await refreshState();
    setMessage(`已找到 ${candidates.length} 个候选关键词，可下拉选择；点「搜索」加载弹幕。`, "success");
  } catch (e) {
    setMessage(`自动匹配失败：${e.message || String(e)}`, "error");
  }
}

async function ensureContentScript() {
  if (!tabId) return { ok: false, reason: "no-tab" };
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: ["https://*/*", "http://*/*"] });
  } catch (e) {}
  if (!granted) return { ok: false, reason: "permission" };

  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["content.js"]
    });
  } catch (e) {}
  await new Promise((resolve) => setTimeout(resolve, 800));
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      await chrome.tabs.sendMessage(tabId, { type: "CONTENT_PING" });
      return { ok: true };
    } catch (e) {}
  }
  return { ok: false, reason: "inject" };
}

async function requireContentScript() {
  const result = await ensureContentScript();
  if (result.ok) return true;
  setMessage(
    result.reason === "permission"
      ? "需要允许访问所有站点，才能把弹幕注入播放器 iframe。"
      : "当前页面无法注入弹幕层，请换到普通视频网页。",
    "error"
  );
  return false;
}

async function loadComments(episode) {
  setMessage("正在准备弹幕层…");
  if (!(await requireContentScript())) return;
  setMessage("正在获取弹幕…");
  const target = { id: episode.episodeId || episode.commentId || episode.id, url: episode.url };
  try {
    const res = await chrome.runtime.sendMessage({ type: "API_GET_COMMENTS", ...target });
    if (!res || !res.ok) throw new Error(res?.error || "获取弹幕失败");
    const episodeLabel = episode.episodeTitle || episode.title || "";
    const send = await chrome.tabs.sendMessage(tabId, {
      type: "CONTENT_LOAD_DANMU",
      comments: res.comments,
      episode: episodeLabel
    });
    if (!send || !send.ok) throw new Error("弹幕层未就绪，请重试");
    setMessage(`已加载 ${res.comments.length} 条弹幕：${episodeLabel}`, "success");
    state = state || {};
    state.loaded = res.comments.length;
    $("count").textContent = String(res.comments.length);
    $("episode").textContent = episodeLabel || "-";
  } catch (e) {
    setMessage(e.message || String(e), "error");
  }
}

async function clearDanmu() {
  if (!(await requireContentScript())) return;
  try {
    await chrome.tabs.sendMessage(tabId, { type: "CONTENT_CLEAR_DANMU" });
    $("count").textContent = "0";
    $("episode").textContent = "-";
    setMessage("已清除弹幕", "success");
  } catch (e) {
    setMessage("清除失败，请重试", "error");
  }
}

async function addCurrentSite() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !/^https?:\/\//.test(tab.url)) {
    setMessage("当前页面不是普通网页，无法生成网址规则。", "error");
    return;
  }
  let host;
  try {
    host = new URL(tab.url).host.replace(/:\d+$/, "");
  } catch (e) {
    setMessage("无法解析当前网址。", "error");
    return;
  }
  if (!host) {
    setMessage("无法解析当前网址。", "error");
    return;
  }

  switchTab("settings");
  openRuleEditor(-1);
  $("ruleNameField").value = host;
  $("rulePatternsField").value = `*://${host}/*`;
  $("ruleSelectorsField").value = [
    "h1",
    "h2",
    "[class*='title']",
    "[class*='name']",
    "meta[property='og:title']",
    "meta[name='title']"
  ].join("\n");
  setConfigStatus("已带入当前网站规则，确认后点「保存规则」。", "ok");
}

function renderGroup(title, items, getText, onClick) {
  const box = $("results");
  clearResults();
  const label = document.createElement("div");
  label.className = "group-title";
  label.textContent = `${title}（${items.length}）`;
  box.appendChild(label);
  for (const item of items) {
    const btn = document.createElement("button");
    btn.className = "result-item";
    btn.textContent = getText(item) || "(无标题)";
    btn.addEventListener("click", () => onClick(item));
    box.appendChild(btn);
  }
}

function clearResults() {
  $("results").innerHTML = "";
}

function setMessage(text, type = "") {
  const el = $("message");
  el.textContent = text || "";
  el.className = type;
}

function bindSettings() {
  $("tabDanmu").addEventListener("click", () => switchTab("danmu"));
  $("tabSettings").addEventListener("click", () => switchTab("settings"));

  for (const id of ["setCacheTTL", "setFontSize", "setSpeed", "setMaxLines"]) {
    $(id).addEventListener("input", () => {
      updatePreview();
      scheduleSave();
    });
  }
  $("setOpacity").addEventListener("input", () => {
    $("opacityValue").textContent = $("setOpacity").value;
    updatePreview();
    scheduleSave();
  });
  $("setColor").addEventListener("input", () => {
    $("setColorText").value = $("setColor").value;
    updatePreview();
    scheduleSave();
  });
  $("setColorText").addEventListener("input", updatePreview);
  $("setColorText").addEventListener("change", commitNow);
  $("setApiBase").addEventListener("change", commitNow);

  $("addRuleInline").addEventListener("click", () => openRuleEditor(-1));
  $("cancelRule").addEventListener("click", closeRuleEditor);
  $("saveRuleInline").addEventListener("click", saveRuleInline);
  $("resetConfig").addEventListener("click", resetConfig);
}

function switchTab(name) {
  const settings = name === "settings";
  $("tabDanmu").setAttribute("aria-selected", String(!settings));
  $("tabSettings").setAttribute("aria-selected", String(settings));
  $("panelDanmu").hidden = settings;
  $("panelSettings").hidden = !settings;
  if (settings) {
    renderRuleList();
    updatePreview();
  }
}

async function loadConfig() {
  try {
    const res = await chrome.runtime.sendMessage({ type: "GET_CONFIG" });
    if (!res || !res.ok) throw new Error(res?.error || "读取配置失败");
    popupConfig = res.config;
    if (!Array.isArray(popupConfig.rules)) popupConfig.rules = [];
    fillConfigFields();
    renderRuleList();
  } catch (e) {
    setConfigStatus(e.message || String(e), "err");
  }
}

function fillConfigFields() {
  const c = popupConfig || {};
  const s = c.style || {};
  $("setApiBase").value = c.apiBase || "";
  $("setCacheTTL").value = c.cacheTTL ?? 300000;
  $("setFontSize").value = s.fontSize ?? 25;
  const color = normalizeColor(s.color) || "#ffffff";
  $("setColor").value = color;
  $("setColorText").value = s.color || "#ffffff";
  $("setOpacity").value = s.opacity ?? 0.9;
  $("opacityValue").textContent = String(s.opacity ?? 0.9);
  $("setSpeed").value = s.speed ?? 8;
  $("setMaxLines").value = s.maxLines ?? 8;
  updatePreview();
}

function updatePreview() {
  const track = $("previewTrack");
  track.style.setProperty("--pv-size", `${clamp(Number($("setFontSize").value), 12, 60)}px`);
  track.style.setProperty("--pv-color", normalizeColor($("setColorText").value.trim()) || "#ffffff");
  track.style.setProperty("--pv-opacity", String(clamp(Number($("setOpacity").value), 0.1, 1)));
  track.style.setProperty("--pv-speed", `${clamp(Number($("setSpeed").value), 3, 30)}s`);
}

function clamp(value, min, max) {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;
}

function normalizeColor(value) {
  const s = String(value || "").trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  if (/^#[0-9a-f]{3}$/.test(s)) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  return null;
}

function collectConfig() {
  const c = popupConfig || {};
  const s = c.style || {};
  return {
    ...c,
    apiBase: $("setApiBase").value.trim().replace(/\/+$/, ""),
    cacheTTL: clamp(Number($("setCacheTTL").value), 0, 86400000),
    rules: (c.rules || []).map((r) => ({ ...r })),
    style: {
      ...s,
      fontSize: clamp(Number($("setFontSize").value), 12, 60),
      color: normalizeColor($("setColorText").value.trim()) || "#ffffff",
      opacity: clamp(Number($("setOpacity").value), 0.1, 1),
      speed: clamp(Number($("setSpeed").value), 3, 30),
      maxLines: clamp(Number($("setMaxLines").value), 1, 30)
    }
  };
}

function validateConfig(cfg) {
  if (!cfg.apiBase || !/^https?:\/\//.test(cfg.apiBase)) {
    throw new Error("请填写有效的 API 地址（http 或 https）");
  }
  const ids = new Set();
  for (const rule of cfg.rules) {
    if (!rule.name) throw new Error("存在未命名的规则");
    if (!rule.id || ids.has(rule.id)) throw new Error(`规则 ID 重复或为空：${rule.id || "(空)"}`);
    ids.add(rule.id);
    if (!Array.isArray(rule.patterns) || !rule.patterns.length) {
      throw new Error(`规则「${rule.name}」没有网址模式`);
    }
    for (const pattern of rule.patterns) {
      if (!validPattern(pattern)) throw new Error(`无效的网址模式：${pattern}`);
    }
  }
}

function validPattern(pattern) {
  return /^(\*|https?):\/\/[^/]+\/.*$/.test(pattern);
}

function lines(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function scheduleSave() {
  clearTimeout(saveTimer);
  setConfigStatus("待保存…");
  saveTimer = setTimeout(() => saveConfig("已保存并即时生效"), 400);
}

function commitNow(message = "已保存并即时生效") {
  clearTimeout(saveTimer);
  return saveConfig(message);
}

async function saveConfig(message) {
  return commitConfig(collectConfig(), message);
}

async function commitConfig(cfg, message) {
  try {
    validateConfig(cfg);
    const origins = collectOrigins(cfg);
    if (origins.length) {
      const granted = await chrome.permissions.request({ origins }).catch(() => false);
      if (!granted) throw new Error("未授予站点权限，规则无法生效");
    }
    const res = await chrome.runtime.sendMessage({ type: "SAVE_CONFIG", config: cfg });
    if (!res || !res.ok) throw new Error(res?.error || "保存失败");
    popupConfig = cfg;
    fillConfigFields();
    setConfigStatus(message || "已保存并即时生效", "ok");
    return true;
  } catch (e) {
    setConfigStatus(e.message || String(e), "err");
    return false;
  }
}

function collectOrigins(cfg) {
  const origins = new Set();
  try {
    origins.add(new URL(cfg.apiBase).origin + "/*");
  } catch (e) {}
  for (const rule of cfg.rules || []) {
    for (const pattern of rule.patterns || []) {
      const origin = originFromPattern(pattern);
      if (origin) origins.add(origin);
    }
  }
  return [...origins];
}

function originFromPattern(pattern) {
  const m = String(pattern).match(/^(\*|https?):\/\/(\*|\*\.[^/]+|[^/]+)(\/.*)?$/);
  if (!m) return null;
  const scheme = m[1] === "*" ? "https" : m[1];
  const host = m[2];
  if (host === "*") return `${scheme}://*/*`;
  if (host.startsWith("*.")) return `${scheme}://${host.slice(2)}/*`;
  return `${scheme}://${host}/*`;
}

function renderRuleList() {
  const box = $("ruleList");
  box.innerHTML = "";
  const rules = popupConfig?.rules || [];
  if (!rules.length) {
    const empty = document.createElement("div");
    empty.className = "rule-empty";
    empty.textContent = "还没有站点规则。点「+ 新增规则」开始。";
    box.appendChild(empty);
    return;
  }
  rules.forEach((rule, index) => {
    const card = document.createElement("div");
    card.className = "rule-card";
    const head = document.createElement("div");
    head.className = "rule-head";

    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = rule.enabled !== false;
    toggle.title = "启用规则";
    toggle.addEventListener("change", async () => {
      const next = collectConfig();
      next.rules[index].enabled = toggle.checked;
      await commitConfig(next, "规则已更新，已打开页面同步生效");
    });

    const main = document.createElement("div");
    main.className = "rule-main";
    const title = document.createElement("span");
    title.className = "rule-title";
    title.textContent = rule.name || "(未命名)";
    const pattern = document.createElement("span");
    pattern.className = "rule-pattern";
    pattern.textContent = (rule.patterns || [])[0] || "—";
    pattern.title = (rule.patterns || []).join("\n");
    main.append(title, pattern);

    const edit = document.createElement("button");
    edit.className = "link";
    edit.textContent = "编辑";
    edit.addEventListener("click", () => openRuleEditor(index));

    const del = document.createElement("button");
    del.className = "link danger";
    del.textContent = "删除";
    del.addEventListener("click", async () => {
      if (!confirm(`删除规则「${rule.name || rule.id}」？`)) return;
      const next = collectConfig();
      next.rules.splice(index, 1);
      if (await commitConfig(next, "规则已删除并即时生效")) {
        if (editingRuleIndex === index) closeRuleEditor();
        else if (editingRuleIndex > index) editingRuleIndex -= 1;
        renderRuleList();
      }
    });

    head.append(toggle, main, edit, del);
    card.appendChild(head);
    box.appendChild(card);
  });
}

function openRuleEditor(index) {
  if (!popupConfig) return;
  editingRuleIndex = index;
  const rule = index >= 0
    ? popupConfig.rules[index]
    : { id: "", name: "", patterns: [], titleSelectors: [], enabled: true, autoFill: true, autoLoad: true };
  $("ruleNameField").value = rule.name || "";
  $("ruleIdField").value = rule.id || "";
  $("rulePatternsField").value = (rule.patterns || []).join("\n");
  $("ruleSelectorsField").value = (rule.titleSelectors || []).join("\n");
  $("ruleEnabledField").checked = rule.enabled !== false;
  $("ruleAutoFillField").checked = rule.autoFill !== false;
  $("ruleAutoLoadField").checked = !!rule.autoLoad;
  $("ruleEditor").hidden = false;
  $("ruleNameField").focus();
  $("ruleEditor").scrollIntoView({ block: "nearest" });
}

function closeRuleEditor() {
  $("ruleEditor").hidden = true;
  editingRuleIndex = -1;
}

async function saveRuleInline() {
  const name = $("ruleNameField").value.trim();
  if (!name) {
    setConfigStatus("请填写规则名称", "err");
    return;
  }
  const patterns = lines($("rulePatternsField").value);
  if (!patterns.length) {
    setConfigStatus("至少填写一条网址模式", "err");
    return;
  }
  for (const pattern of patterns) {
    if (!validPattern(pattern)) {
      setConfigStatus(`无效的网址模式：${pattern}`, "err");
      return;
    }
  }
  let id = $("ruleIdField").value.trim() || slugify(name);
  const exists = (popupConfig.rules || []).some((r, i) => i !== editingRuleIndex && r.id === id);
  if (exists) {
    setConfigStatus(`规则 ID 已存在：${id}`, "err");
    return;
  }
  const rule = {
    id,
    name,
    patterns,
    titleSelectors: lines($("ruleSelectorsField").value),
    enabled: $("ruleEnabledField").checked,
    autoFill: $("ruleAutoFillField").checked,
    autoLoad: $("ruleAutoLoadField").checked
  };
  const next = collectConfig();
  if (editingRuleIndex >= 0) next.rules[editingRuleIndex] = rule;
  else next.rules.push(rule);
  if (await commitConfig(next, "规则已保存并即时生效")) {
    const wasEditing = editingRuleIndex >= 0;
    closeRuleEditor();
    renderRuleList();
    if (wasEditing) setConfigStatus("规则已更新并即时生效", "ok");
  }
}

function slugify(name) {
  const base = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || `rule-${Date.now().toString(36)}`;
}

async function resetConfig() {
  if (!confirm("恢复默认配置？当前自定义设置将被覆盖。")) return;
  clearTimeout(saveTimer);
  try {
    const res = await chrome.runtime.sendMessage({ type: "RESET_CONFIG" });
    if (!res || !res.ok) throw new Error(res?.error || "恢复失败");
    popupConfig = res.config;
    if (!Array.isArray(popupConfig.rules)) popupConfig.rules = [];
    closeRuleEditor();
    fillConfigFields();
    renderRuleList();
    setConfigStatus("已恢复默认并即时生效", "ok");
  } catch (e) {
    setConfigStatus(e.message || String(e), "err");
  }
}

function setConfigStatus(text, type = "") {
  const el = $("configStatus");
  el.textContent = text || "";
  el.className = type || "";
}

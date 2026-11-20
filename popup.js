let tabId = null;
let state = null;

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
  $("reloadBtn").addEventListener("click", reloadAuto);
  $("openOptions").addEventListener("click", () => chrome.runtime.openOptionsPage());
  $("addCurrentSite").addEventListener("click", addCurrentSite);

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

  await refreshState();
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

async function reloadAuto() {
  const title = $("keyword").value.trim();
  if (!title) {
    setMessage("请先输入关键字", "error");
    return;
  }
  if (!(await requireContentScript())) return;
  setMessage("正在重新自动装填…");
  try {
    const res = await chrome.runtime.sendMessage({ type: "AUTO_LOAD", title });
    if (!res || !res.ok) {
      setMessage(`自动装填未完成：${res?.reason || res?.error || "未知原因"}`, "error");
      return;
    }
    setMessage(`已自动装填 ${res.count} 条弹幕：${res.episode || res.anime}`, "success");
    $("count").textContent = String(res.count);
    $("episode").textContent = res.episode || "-";
  } catch (e) {
    setMessage(e.message || String(e), "error");
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

  const pattern = `*://${host}/*`;
  const url =
    chrome.runtime.getURL("options.html") +
    `?add=${encodeURIComponent(pattern)}&name=${encodeURIComponent(host)}`;
  await chrome.tabs.create({ url });
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

(() => {
  if (window.__danmuOverlayInjected__) return;
  window.__danmuOverlayInjected__ = true;

  const OVERLAY_ID = "__danmu_overlay__";
  const STYLE_ID = "__danmu_style__";
  const MATCH_BTN_ID = "__danmu_match_btn__";
  const MATCH_CARD_ID = "__danmu_match_card__";
  const TOAST_ID = "__danmu_toast__";
  const PICKER_ID = "__danmu_picker__";

  let config = null;
  let rule = null;
  let video = null;
  let overlay = null;
  let matchBtn = null;
  let matchCard = null;
  let toast = null;
  let matchedKeyword = "";
  let matchState = "idle";
  let wizard = {
    step: "keyword",
    status: "",
    busy: false,
    error: false,
    keyword: "",
    animes: [],
    episodes: [],
    anime: null
  };
  let wizardCandidates = [];
  let wizardOpen = false;
  let comments = [];
  let currentEpisode = "";
  let autoMatched = false;
  let emitted = 0;
  let lastTime = 0;
  let autoTried = false;
  let autoAttemptKey = "";
  let autoNoticeShown = false;
  let retryContext = { keyword: "", episodeHint: null };
  let picker = {
    open: false,
    step: "anime",
    title: "",
    keyword: "",
    animes: [],
    episodes: [],
    anime: null,
    busy: false,
    error: false,
    message: "",
    episodeHint: null
  };
  let pickerCard = null;
  let observer = null;
  let styleInjected = false;
  let videoReady = false;
  let loopStarted = false;
  let bindingsInstalled = false;
  let lastFullscreenEl = null;

  const active = [];
  let laneCursor = 0;
  let topLaneCursor = 0;
  let bottomLaneCursor = 0;
  let overlayHomeParent = null;
  let lastVideoRect = null;
  let rectObserver = null;
  let settleTimer = 0;

  init();

  async function init() {
    const res = await chrome.runtime.sendMessage({ type: "GET_CONFIG" });
    if (!res || !res.ok) return;
    config = res.config;
    rule = findRule(location.href, config.rules) || manualRule();

    injectStyle();
    watchVideo();
    installGlobalListeners();

    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg.type === "CONTENT_PING") {
        sendResponse({ ok: true });
      } else if (msg.type === "CONTENT_GET_STATE") {
        sendResponse({
          ok: true,
          title: getTitle(),
          matchedKeyword,
          matchState,
          wizardStep: wizard.step,
          wizardStatus: wizard.status,
          wizardBusy: wizard.busy,
          wizardError: wizard.error,
          hasVideo: !!video,
          rule: rule.name,
          loaded: comments.length,
          episode: currentEpisode,
          autoMatched,
          url: location.href
        });
      } else if (msg.type === "CONTENT_MATCH_KEYWORD") {
        sendResponse({
          ok: true,
          candidates: collectCandidates(),
          episodeHint: detectActiveEpisode()
        });
      } else if (msg.type === "CONTENT_AUTO_MATCH") {
        refreshVideo();
        const candidates = collectCandidates();
        if (candidates.length) matchedKeyword = candidates[0];
        sendResponse({ ok: true, candidates });
      } else if (msg.type === "CONTENT_OPEN_WIZARD") {
        refreshVideo();
        openMatchCard();
        sendResponse({ ok: true });
      } else if (msg.type === "CONTENT_SHOW_BUTTON") {
        if (matchState === "done") {
          matchState = "idle";
          matchedKeyword = "";
        }
        mountMatchBtn();
        sendResponse({ ok: true });
      } else if (msg.type === "CONTENT_LOAD_DANMU") {
        autoMatched = false;
        loadComments(msg.comments || []);
        currentEpisode = msg.episode || "";
        sendResponse({ ok: true, count: comments.length });
      } else if (msg.type === "CONTENT_CLEAR_DANMU") {
        clearDanmu();
        sendResponse({ ok: true });
      } else if (msg.type === "CONTENT_SET_STYLE") {
        config.style = { ...config.style, ...msg.style };
        applyStyle();
        refreshActiveStyle();
        relayoutActive();
        sendResponse({ ok: true });
      } else if (msg.type === "CONTENT_SET_RULES") {
        config.rules = Array.isArray(msg.rules) ? msg.rules : [];
        rule = findRule(location.href, config.rules) || manualRule();
        sendResponse({ ok: true, rule: rule.name });
      } else {
        sendResponse({ ok: false, error: "未知内容脚本消息" });
      }
      return true;
    });
  }

  function manualRule() {
    return {
      id: "manual",
      name: "手动模式",
      patterns: [],
      enabled: true,
      autoFill: false,
      autoLoad: false,
      titleSelectors: [
        "h1",
        "h2",
        "[class*='title']",
        "[class*='name']",
        "meta[property='og:title']",
        "meta[name='title']"
      ]
    };
  }

  function findRule(url, rules = []) {
    return (
      rules.find((r) => r.enabled && (r.patterns || []).some((p) => matchPattern(p, url))) || null
    );
  }

  function matchPattern(pattern, url) {
    const escaped = String(pattern)
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`).test(url);
  }

  const KEYWORD_SELECTORS = [
    "h1", "h2", "h3", "h4", "h5",
    "[class*='title']", "[class*='name']", "[class*='video-title']",
    "[class*='film-name']", "[class*='movie-name']", "[class*='anime-title']",
    "[class*='drama-title']", "[id*='title']", "[id*='name']",
    "[data-title]", "[data-name]", "figcaption"
  ];
  const NOISE =
    /^(首页|播放|登录|注册|搜索|导航|更多|全部|详情|视频|电影|电视剧|综艺|动漫|选集|剧集|下一集|上一集|正片|预告|花絮|完结|更新至.*集|第\d+集|player\s*version\b.*|video\s*(volume|time|duration|speed|quality|rate)\s*:?.*|play\s*speed\s*:?.*|video\s*player\b.*|video\s*url\b.*|play\s*url\b.*|player\s*url\b.*|video\s*source\b.*|full\s*screen\b.*|loading\b.*|buffering\b.*|版本.*|v?\d+(\.\d+){1,4})$/i;

  function collectCandidates() {
    const found = [];
    const seen = new Set();

    const add = (value, score) => {
      const s = cleanTitle(value);
      if (!s || s.length < 2 || s.length > 120 || NOISE.test(s)) return;
      const existing = found.find((f) => f.text === s);
      if (existing) {
        if (score > existing.score) existing.score = score;
        return;
      }
      seen.add(s);
      found.push({ text: s, score: score || 0 });
    };

    const readNode = (el, score) => {
      if (!el || el.nodeType !== 1) return;
      if (el.tagName === "META") return add(el.getAttribute("content"), score);
      add(el.textContent, score);
      add(el.getAttribute("title"), score - 1);
      add(el.getAttribute("aria-label"), score - 1);
      add(el.getAttribute("data-title"), score);
      add(el.getAttribute("data-name"), score);
      if (el.tagName === "IMG") add(el.getAttribute("alt"), score - 2);
    };

    const scanSelector = (root, score, selectors, step = 0) => {
      selectors.forEach((sel, i) => {
        let nodes;
        try {
          nodes = root.querySelectorAll(sel);
        } catch (e) {
          return;
        }
        const s = score - i * step;
        nodes.forEach((el, ni) => readNode(el, s - Math.min(ni, 6)));
      });
    };

    const siteSelectors = rule?.titleSelectors || [];

    // 第 1 优先级：站点规则里配置的标题选择器，按配置顺序给分，作为核心搜索规则
    scanSelector(document, 300, siteSelectors, 10);

    // 第 2 优先级：语义标题始终优先于播放器周边的控件文案
    scanSelector(document, 280, ["h1", "h2", "h3"], 6);

    // 第 3 层：以 video 为起点，逐层向上扫描兄弟节点与祖先（辅助定位播放器附近标题）
    if (video) {
      let node = video;
      for (let depth = 0; depth < 6 && node; depth++) {
        const parent = node.parentElement;
        if (!parent) break;
        const proximity = 110 - depth * 10;
        for (const sibling of parent.children) {
          if (sibling === node || sibling === video) continue;
          if (sibling.contains(video)) continue;
          if (isKeywordElement(sibling)) readNode(sibling, proximity + 2);
          scanSelector(sibling, proximity, siteSelectors.length ? siteSelectors : KEYWORD_SELECTORS, 4);
        }
        if (isKeywordElement(parent)) readNode(parent, proximity - 4);
        node = parent;
      }
    }

    // 第 3 层：通用标题选择器（兜底，防止规则与周边都没命中）
    scanSelector(document, 60, KEYWORD_SELECTORS, 2);

    // 第 4 层：开放图协议与页面标题（最后兜底，确保不会全部未命中）
    for (const sel of [
      "meta[property='og:title']",
      "meta[name='twitter:title']",
      "meta[itemprop='name']"
    ]) {
      try {
        readNode(document.querySelector(sel), 20);
      } catch (e) {}
    }
    add(document.title, 16);

    return found
      .sort((a, b) => b.score - a.score)
      .slice(0, 12)
      .map((c) => c.text);
  }

  function isKeywordElement(el) {
    if (!el || el.nodeType !== 1 || el === video) return false;
    if (el.tagName === "META") return false;
    if (/^H[1-5]$/.test(el.tagName)) return true;
    try {
      return el.matches(KEYWORD_SELECTORS.join(","));
    } catch (e) {
      return false;
    }
  }

  function getTitle() {
    return collectCandidates()[0] || "";
  }

  function cleanTitle(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .replace(/\s*[-|—_]\s*(洛雪TV|影视推荐).*$/i, "")
      .trim();
  }

  function openMatchCard() {
    matchState = "matching";
    wizardOpen = true;
    wizardCandidates = collectCandidates();
    wizard = {
      step: "keyword",
      status: wizardCandidates.length
        ? `已从视频周边定位到 ${wizardCandidates.length} 个候选标题，请选择。`
        : "未从视频周边定位到标题，请手动输入。",
      busy: false,
      error: false,
      keyword: "",
      animes: [],
      episodes: [],
      anime: null
    };
    renderWizard(wizardCandidates);
    hideMatchBtn();
    notifyWizardState();
  }

  function setWizard(patch) {
    wizard = { ...wizard, ...patch };
    notifyWizardState();
    if (!wizardOpen) return;
    renderWizard(wizardCandidates);
  }

  function notifyWizardState() {
    try {
      chrome.runtime
        .sendMessage({
          type: "DANMU_WIZARD_STATE",
          step: wizard.step,
          status: wizard.status,
          busy: wizard.busy,
          error: wizard.error,
          loaded: comments.length,
          url: location.href
        })
        .catch(() => {});
    } catch (e) {}
  }

  async function chooseKeyword(text) {
    const keyword = cleanTitle(text);
    if (!keyword) return;
    matchedKeyword = keyword;
    notifyKeyword(keyword);
    autoTried = false;
    setWizard({
      step: "anime",
      status: `正在搜索《${keyword}》的作品…`,
      busy: true,
      error: false,
      keyword,
      animes: [],
      episodes: [],
      anime: null
    });
    try {
      const res = await chrome.runtime.sendMessage({
        type: "API_SEARCH_ANIME",
        keyword
      });
      if (!res || !res.ok) throw new Error(res?.error || "作品搜索失败");
      const animes = res.items || [];
      if (!animes.length) {
        setWizard({
          step: "keyword",
          status: `没有找到与「${keyword}」匹配的作品，请换一个关键词重试。`,
          busy: false,
          error: true,
          animes: []
        });
        return;
      }
      setWizard({
        status: `找到 ${animes.length} 个作品，请选择目标作品。`,
        busy: false,
        animes
      });
    } catch (e) {
      setWizard({
        step: "keyword",
        status: `搜索失败：${e.message || e}`,
        busy: false,
        error: true
      });
    }
  }

  async function chooseAnime(anime) {
    const name =
      anime.animeTitle || anime.title || anime.name || anime.anime || wizard.keyword || "";
    setWizard({
      step: "episode",
      status: `正在获取《${name}》的剧集…`,
      busy: true,
      error: false,
      anime,
      episodes: []
    });
    try {
      const res = await chrome.runtime.sendMessage({
        type: "API_SEARCH_EPISODES",
        anime: name,
        animeId: anime.animeId,
        animeTitle: name
      });
      if (!res || !res.ok) throw new Error(res?.error || "剧集获取失败");
      const episodes = res.items || [];
      if (!episodes.length) {
        setWizard({
          step: "anime",
          status: `《${name}》没有可加载的剧集，请换一个作品。`,
          busy: false,
          error: true,
          episodes: []
        });
        return;
      }
      setWizard({
        status: `找到 ${episodes.length} 集，请选择要装填的剧集。`,
        busy: false,
        episodes
      });
    } catch (e) {
      setWizard({
        step: "anime",
        status: `剧集获取失败：${e.message || e}`,
        busy: false,
        error: true
      });
    }
  }

  async function chooseEpisode(episode) {
    const label = episode.episodeTitle || episode.title || episode.name || "该集";
    setWizard({
      status: `正在获取《${label}》的弹幕…`,
      busy: true,
      error: false
    });
    try {
      const target = {
        id: episode.episodeId || episode.commentId || episode.cid || episode.id,
        url: episode.url || episode.videoUrl || episode.playUrl
      };
      const res = await chrome.runtime.sendMessage({ type: "API_GET_COMMENTS", ...target });
      if (!res || !res.ok) throw new Error(res?.error || "弹幕获取失败");
      const loaded = (res.comments || []).length;
      if (!loaded) {
        setWizard({
          status: `《${label}》暂时没有弹幕，可换一集或手动搜索。`,
          busy: false,
          error: true
        });
        return;
      }
      loadComments(res.comments);
      currentEpisode = label;
      matchState = "done";
      autoMatched = false;
      setWizard({
        status: `已装填 ${loaded} 条弹幕 · ${label}`,
        busy: false,
        error: false
      });
      showToast(`已装填 ${loaded} 条弹幕`);
    } catch (e) {
      setWizard({
        status: `弹幕获取失败：${e.message || e}`,
        busy: false,
        error: true
      });
    }
  }

  function backWizard() {
    if (wizard.step === "episode") {
      setWizard({ step: "anime", status: "请重新选择作品。", busy: false, error: false });
    } else if (wizard.step === "anime") {
      setWizard({
        step: "keyword",
        status: `关键词：${wizard.keyword || "未选择"}，请确认或重新选择。`,
        busy: false,
        error: false
      });
    }
  }

  function closeMatchCard(restore = true) {
    wizardOpen = false;
    if (matchCard) matchCard.style.display = "none";
    if (restore) {
      if (matchState === "matching") matchState = "idle";
      wizard.busy = false;
      mountMatchBtn();
    }
  }

  function notifyKeyword(keyword) {
    try {
      chrome.runtime
        .sendMessage({ type: "DANMU_KEYWORD_MATCHED", keyword, url: location.href })
        .catch(() => {});
    } catch (e) {}
  }

  function installGlobalListeners() {
    if (bindingsInstalled) return;
    bindingsInstalled = true;
    window.addEventListener("resize", () => {
      updateOverlayRect(true);
      updateMatchBtnRect();
      updateMatchCardRect();
      updatePickerRect();
    });
    window.addEventListener("scroll", () => {
      updateOverlayRect();
      updateMatchBtnRect();
      updateMatchCardRect();
      updatePickerRect();
    }, true);
    document.addEventListener("fullscreenchange", () => {
      mountOverlay();
      mountMatchBtn();
      const parent = document.fullscreenElement || document.documentElement;
      if (matchCard && matchCard.parentElement !== parent) parent.appendChild(matchCard);
      if (pickerCard && pickerCard.parentElement !== parent) parent.appendChild(pickerCard);
      updateMatchCardRect();
      updatePickerRect();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && picker.open) {
        e.stopPropagation();
        closePicker();
        return;
      }
      if (e.key === "Escape" && wizardOpen) {
        e.stopPropagation();
        closeMatchCard(true);
      }
    }, true);
    document.addEventListener("pointerdown", (e) => {
      if (picker.open) {
        if (pickerCard && pickerCard.contains(e.target)) return;
        closePicker();
        return;
      }
      if (!wizardOpen) return;
      if (matchCard && matchCard.contains(e.target)) return;
      if (matchBtn && matchBtn.contains(e.target)) return;
      closeMatchCard(true);
    }, true);
  }

  function mountMatchBtn() {
    // 取词按钮已由弹窗「自动匹配」取代，网页内不再显示。
    return;
    if (!rule) return;
    if (!matchBtn) {
      matchBtn = document.createElement("button");
      matchBtn.id = MATCH_BTN_ID;
      matchBtn.type = "button";
      matchBtn.setAttribute("aria-label", "取词：选择弹幕搜索关键字");
      matchBtn.style.cssText = [
        "position:fixed",
        "z-index:2147483647",
        "height:26px",
        "padding:0 10px 0 9px",
        "display:inline-flex",
        "align-items:center",
        "gap:7px",
        "border:1px solid #dce5c8",
        "border-left:3px solid #5d8a3a",
        "border-radius:9px",
        "background:#fdfdf6",
        "color:#3b4a2f",
        "font:600 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace",
        "letter-spacing:.1em",
        "cursor:pointer",
        "pointer-events:auto",
        "box-shadow:0 4px 14px rgba(44,58,36,.18)",
        "opacity:1",
        "display:inline-flex",
        "visibility:visible"
      ].join(";");
      matchBtn.textContent = "▸ 取词";
      matchBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        onMatchBtnClick();
      });
    }
    if (matchState === "done") return;
    const parent = document.fullscreenElement || document.documentElement;
    if (matchBtn.parentElement !== parent) parent.appendChild(matchBtn);
    matchBtn.style.opacity = "1";
    matchBtn.style.display = "inline-flex";
    matchBtn.style.visibility = "visible";
    setMatchBtnState(matchState);
    updateMatchBtnRect();
  }

  function onMatchBtnClick() {
    if (wizardOpen) {
      closeMatchCard(true);
      return;
    }
    refreshVideo();
    if (!video) {
      showToast("未找到视频，请播放后再点「取词」");
      return;
    }
    openMatchCard();
  }

  function refreshVideo() {
    const found = findVideo();
    if (!found) return;
    if (found !== video || !videoReady) {
      video = found;
      onVideoReady();
    }
  }

  function updateMatchBtnRect() {
    if (!matchBtn || matchState === "done") return;
    const r = video && video.getBoundingClientRect();
    const anchorRight = r && r.width ? r.right : window.innerWidth;
    const anchorTop = r && r.height ? r.top : 0;
    matchBtn.style.left = `${Math.max(8, anchorRight - 92)}px`;
    matchBtn.style.top = `${anchorTop + 10}px`;
    updateMatchCardRect();
  }

  function updateMatchCardRect() {
    if (!matchCard || matchCard.style.display === "none") return;
    const r = video && video.getBoundingClientRect();
    const anchorRight = r && r.width ? r.right : window.innerWidth;
    const anchorTop = r && r.height ? r.top : 0;
    const width = Math.min(320, window.innerWidth - 24);
    matchCard.style.width = `${width}px`;
    matchCard.style.left = `${Math.max(12, anchorRight - width - 10)}px`;
    matchCard.style.top = `${anchorTop + 44}px`;
  }

  function setMatchBtnState(state) {
    if (!matchBtn) return;
    matchBtn.title = state === "matching" ? "正在取词…" : "点击选择弹幕搜索关键字";
  }

  function renderWizard(candidates) {
    if (!matchCard) {
      matchCard = document.createElement("div");
      matchCard.id = MATCH_CARD_ID;
      matchCard.style.cssText = [
        "position:fixed",
        "z-index:2147483647",
        "display:none",
        "background:#fdfdf6",
        "color:#3b4a2f",
        "border:1px solid #dce5c8",
        "border-radius:12px",
        "box-shadow:0 18px 48px rgba(44,58,36,.22)",
        "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC',sans-serif",
        "pointer-events:auto",
        "overflow:hidden"
      ].join(";");
      matchCard.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 13px 10px;border-bottom:1px solid #dce5c8;background:linear-gradient(180deg,#f6f9e9,transparent)">
          <span style="font:600 10px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.14em;color:#5d8a3a">幕伴 / 自动装填</span>
          <button class="dmc-close" aria-label="关闭" style="display:grid;place-items:center;width:22px;height:22px;border:0;border-radius:50%;background:transparent;color:#8b9c76;font:16px/1 sans-serif;cursor:pointer;padding:0">×</button>
        </div>
        <div class="dmc-steps" style="display:flex;gap:0;padding:10px 13px 0"></div>
        <div class="dmc-status" style="margin:9px 13px 2px;padding:8px 10px;background:#f1f6e4;border-left:2px solid #5d8a3a;border-radius:0 8px 8px 0;font:11px/1.5 ui-monospace,Menlo,monospace;color:#5c6b4d"></div>
        <div class="dmc-list" style="padding:6px 7px;max-height:216px;overflow:auto"></div>
        <div class="dmc-foot" style="display:flex;gap:6px;padding:10px 13px;border-top:1px solid #dce5c8;background:rgba(246,249,233,.7)">
          <input class="dmc-input" placeholder="或手动输入标题" style="flex:1;min-width:0;background:#fffef8;border:1px solid #dce5c8;border-radius:8px;color:#3b4a2f;padding:7px 9px;font:12px sans-serif;outline:none" />
          <button class="dmc-use" style="border:1px solid #d79a20;border-radius:999px;background:linear-gradient(180deg,#f2c25a,#e8ad35);color:#4a3a12;padding:6px 12px;font:600 11px ui-monospace,Menlo,monospace;cursor:pointer">使用</button>
        </div>
      `;
      matchCard.querySelector(".dmc-close").addEventListener("click", (e) => {
        e.stopPropagation();
        closeMatchCard(true);
      });
      matchCard.querySelector(".dmc-use").addEventListener("click", (e) => {
        e.stopPropagation();
        chooseKeyword(matchCard.querySelector(".dmc-input").value);
      });
      matchCard.querySelector(".dmc-input").addEventListener("keydown", (e) => {
        if (e.key === "Enter") chooseKeyword(e.target.value);
        e.stopPropagation();
      });
      const parent = document.fullscreenElement || document.documentElement;
      parent.appendChild(matchCard);
    }

    renderWizardSteps();
    renderWizardStatus();
    renderWizardList(candidates);
    matchCard.style.display = "block";
    updateMatchCardRect();
  }

  function renderWizardSteps() {
    const box = matchCard.querySelector(".dmc-steps");
    box.innerHTML = "";
    const steps = [
      ["keyword", "关键词"],
      ["anime", "作品"],
      ["episode", "剧集"]
    ];
    const order = ["keyword", "anime", "episode"];
    const activeIdx = order.indexOf(wizard.step);
    steps.forEach(([key, label], i) => {
      if (i) {
        const sep = document.createElement("span");
        sep.style.cssText = "flex:1;height:1px;background:#dce5c8;align-self:center;margin:0 6px";
        box.appendChild(sep);
      }
      const node = document.createElement("span");
      const active = i === activeIdx;
      const done = i < activeIdx;
      node.textContent = `${done ? "✓" : i + 1} ${label}`;
      node.style.cssText = [
        "font:10px/1 ui-monospace,Menlo,monospace",
        "letter-spacing:.06em",
        "white-space:nowrap",
        `color:${active ? "#5d8a3a" : done ? "#8fae63" : "#9aa98a"}`
      ].join(";");
      box.appendChild(node);
    });
  }

  function renderWizardStatus() {
    const el = matchCard.querySelector(".dmc-status");
    el.textContent = wizard.status || "准备就绪";
    const color = wizard.error ? "#b4653f" : wizard.busy ? "#d79a20" : "#5d8a3a";
    el.style.borderLeftColor = color;
    el.style.color = wizard.error ? "#a15534" : "#5c6b4d";
    el.textContent = `${wizard.busy ? "◌ " : wizard.error ? "! " : "· "}${el.textContent}`;
  }

  function renderWizardList(candidates) {
    const list = matchCard.querySelector(".dmc-list");
    const foot = matchCard.querySelector(".dmc-foot");
    list.innerHTML = "";

    if (wizard.step === "keyword") {
      foot.style.display = "flex";
      const items = candidates || [];
      if (!items.length) {
        list.appendChild(emptyRow("未定位到标题候选，请在下方手动输入。"));
      }
      items.forEach((text, i) => {
        list.appendChild(makeRow(text, i === 0, () => chooseKeyword(text)));
      });
      if (retryContext.keyword || retryContext.episodeHint != null) {
        const hint = retryContext.episodeHint;
        list.appendChild(
          makeRow(`⚡ 按当前集快速重试${hint != null ? `（第 ${hint} 集）` : ""}`, false, () =>
            quickRetry(
              matchCard.querySelector(".dmc-input").value ||
                wizard.keyword ||
                retryContext.keyword
            )
          )
        );
      }
      return;
    }

    if (wizard.step === "anime") {
      foot.style.display = "none";
      if (wizard.busy) {
        list.appendChild(emptyRow("正在搜索作品…"));
        return;
      }
      wizard.animes.forEach((anime, i) => {
        const text = anime.animeTitle || anime.title || anime.name || anime.anime || "(未命名作品)";
        const meta = anime.animeId ? `#${anime.animeId}` : "";
        list.appendChild(makeRow(text, false, () => chooseAnime(anime), meta));
      });
      list.appendChild(makeRow("‹ 返回重新选择关键词", false, backWizard));
      return;
    }

    if (wizard.step === "episode") {
      foot.style.display = "none";
      if (wizard.busy) {
        list.appendChild(emptyRow("正在获取剧集与弹幕…"));
        return;
      }
      wizard.episodes.forEach((ep, i) => {
        const text = ep.episodeTitle || ep.title || ep.name || `第 ${i + 1} 集`;
        list.appendChild(makeRow(text, i === 0, () => chooseEpisode(ep)));
      });
      list.appendChild(makeRow("‹ 返回重新选择作品", false, backWizard));
    }
  }

  function makeRow(text, highlight, onClick, meta) {
    const item = document.createElement("button");
    const baseColor = highlight ? "#5d8a3a" : "transparent";
    item.style.cssText = [
      "display:flex",
      "justify-content:space-between",
      "align-items:center",
      "gap:8px",
      "width:100%",
      "text-align:left",
      "border:0",
      "border-left:2px solid",
      baseColor,
      "background:transparent",
      "color:#3b4a2f",
      "padding:8px 10px",
      "font:12px/1.4 sans-serif",
      "cursor:pointer"
    ].join(";");
    const label = document.createElement("span");
    label.textContent = text;
    label.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
    item.appendChild(label);
    if (meta) {
      const tag = document.createElement("span");
      tag.textContent = meta;
      tag.style.cssText = "font:9px ui-monospace,Menlo,monospace;color:#8b9c76;flex-shrink:0";
      item.appendChild(tag);
    }
    item.title = text;
    item.addEventListener("mouseenter", () => {
      item.style.background = "#eaf2d9";
      item.style.borderLeftColor = "#5d8a3a";
    });
    item.addEventListener("mouseleave", () => {
      item.style.background = "transparent";
      item.style.borderLeftColor = baseColor;
    });
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
    });
    return item;
  }

  function emptyRow(text) {
    const el = document.createElement("div");
    el.style.cssText = "padding:12px 8px;font-size:12px;color:#8b9c76";
    el.textContent = text;
    return el;
  }

  function hideMatchBtn() {
    if (matchBtn) matchBtn.style.display = "none";
  }

  function showToast(text, options = {}) {
    if (!toast) {
      toast = document.createElement("div");
      toast.id = TOAST_ID;
    }
    const parent = document.fullscreenElement || document.documentElement;
    if (toast.parentElement !== parent) parent.appendChild(toast);

    toast.textContent = text;
    let action = toast.querySelector("button");
    if (options.actionText && typeof options.onAction === "function") {
      if (!action) {
        action = document.createElement("button");
        action.className = "dmc-toast-action";
        action.addEventListener("click", (e) => {
          e.stopPropagation();
          toast.classList.remove("show");
          options.onAction();
        });
        toast.appendChild(action);
      }
      action.textContent = ` ${options.actionText}`;
    } else if (action) {
      action.remove();
    }
    toast.classList.add("show");
    clearTimeout(showToast.timer);
    showToast.timer = 0;
    if (!options.persistent) {
      const duration = options.duration || (options.actionText ? 8000 : 2600);
      showToast.timer = setTimeout(() => toast.classList.remove("show"), duration);
    }
  }

  function hideToast() {
    if (!toast) return;
    clearTimeout(showToast.timer);
    toast.classList.remove("show");
  }

  function createPickerCard() {
    if (pickerCard) return pickerCard;
    pickerCard = document.createElement("div");
    pickerCard.id = PICKER_ID;
    pickerCard.innerHTML = `
      <div class="dmp-head">
        <span class="dmp-eyebrow">幕伴 / 选择</span>
        <button class="dmp-close" type="button" aria-label="取消选择">×</button>
      </div>
      <div class="dmp-match">
        <div class="dmp-label">当前视频 · 已匹配标题</div>
        <div class="dmp-title"></div>
      </div>
      <div class="dmp-steps"><span class="dmp-step"></span><span class="dmp-step"></span></div>
      <div class="dmp-step-labels"><span>01 弹幕作品</span><span>02 目标集数</span></div>
      <div class="dmp-search">
        <input type="text" placeholder="输入作品名重新搜索" />
        <button type="button">搜索</button>
      </div>
      <div class="dmp-list"></div>
      <div class="dmp-foot">
        <span class="dmp-status"></span>
        <button class="dmp-back" type="button" hidden>返回</button>
        <button class="dmp-cancel" type="button">取消</button>
      </div>
    `;
    pickerCard.querySelector(".dmp-close").addEventListener("click", (e) => {
      e.stopPropagation();
      closePicker();
    });
    pickerCard.querySelector(".dmp-cancel").addEventListener("click", (e) => {
      e.stopPropagation();
      closePicker();
    });
    pickerCard.querySelector(".dmp-back").addEventListener("click", (e) => {
      e.stopPropagation();
      backPicker();
    });
    pickerCard.querySelector(".dmp-search button").addEventListener("click", (e) => {
      e.stopPropagation();
      pickerSearch(pickerCard.querySelector(".dmp-search input").value);
    });
    pickerCard.querySelector(".dmp-search input").addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") pickerSearch(e.target.value);
    });
    const parent = document.fullscreenElement || document.documentElement;
    parent.appendChild(pickerCard);
    return pickerCard;
  }

  function openPicker(info = {}) {
    const animes = Array.isArray(info.animes) ? info.animes : [];
    createPickerCard();
    picker = {
      open: true,
      step: "anime",
      title: info.title || "当前视频",
      keyword: info.keyword || info.title || "",
      animes,
      episodes: [],
      anime: null,
      busy: false,
      error: !animes.length,
      message: animes.length
        ? `找到 ${animes.length} 部作品，选择弹幕来源。`
        : "没有匹配到弹幕作品，输入作品名搜索或取消。",
      episodeHint: info.episodeHint ?? null
    };
    pickerCard.querySelector(".dmp-search input").value = picker.keyword;
    renderPicker();
    updatePickerRect();
    hideToast();
  }

  function closePicker() {
    picker.open = false;
    picker.busy = false;
    if (pickerCard) pickerCard.style.display = "none";
  }

  function setPicker(patch) {
    picker = { ...picker, ...patch };
    if (picker.open) renderPicker();
  }

  function renderPicker() {
    if (!pickerCard || !picker.open) return;
    pickerCard.style.display = "block";
    pickerCard.querySelector(".dmp-title").textContent = picker.title;
    const steps = pickerCard.querySelectorAll(".dmp-step");
    steps[0].className = `dmp-step ${picker.step === "anime" ? "active" : "done"}`;
    steps[1].className = `dmp-step ${picker.step === "episode" ? "active" : ""}`;
    const labels = pickerCard.querySelectorAll(".dmp-step-labels span");
    labels[0].className = picker.step === "anime" ? "active" : "";
    labels[1].className = picker.step === "episode" ? "active" : "";
    pickerCard.querySelector(".dmp-search").style.display =
      picker.step === "anime" ? "flex" : "none";
    pickerCard.querySelector(".dmp-back").hidden = picker.step !== "episode";
    const status = pickerCard.querySelector(".dmp-status");
    status.textContent = `${picker.busy ? "◌ " : picker.error ? "! " : "· "}${picker.message}`;
    status.className = `dmp-status ${picker.busy ? "busy" : picker.error ? "error" : ""}`;

    const list = pickerCard.querySelector(".dmp-list");
    list.innerHTML = "";
    if (picker.step === "anime") {
      if (picker.busy) {
        list.appendChild(pickerRow("正在搜索作品…", false));
        return;
      }
      if (!picker.animes.length) {
        const empty = document.createElement("div");
        empty.className = `dmp-empty${picker.error ? " error" : ""}`;
        empty.textContent = picker.message || "没有找到弹幕作品，试试换个关键词。";
        list.appendChild(empty);
        return;
      }
      picker.animes.forEach((anime, i) => {
        const name = anime.animeTitle || anime.title || anime.name || anime.anime || "未命名作品";
        const meta = anime.animeId ? `#${anime.animeId}` : "";
        list.appendChild(pickerRow(name, i === 0, () => pickerChooseAnime(anime), meta));
      });
      return;
    }

    if (picker.busy) {
      list.appendChild(pickerRow("正在获取剧集…", false));
      return;
    }
    if (!picker.episodes.length) {
      const empty = document.createElement("div");
      empty.className = `dmp-empty${picker.error ? " error" : ""}`;
      empty.textContent = picker.message || "该作品暂无可加载的剧集，请返回换一部作品。";
      list.appendChild(empty);
      return;
    }
    picker.episodes.forEach((ep, i) => {
      const label = ep.episodeTitle || ep.title || ep.name || `第 ${i + 1} 集`;
      const recommended =
        picker.episodeHint != null && extractEpisodeNo(label) === picker.episodeHint;
      list.appendChild(
        pickerRow(label, recommended, () => pickerChooseEpisode(ep), recommended ? "当前" : "")
      );
    });
  }

  function pickerRow(text, highlight, onClick, meta) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = `dmp-row${highlight ? " recommended" : ""}`;
    const main = document.createElement("span");
    main.className = "dmp-main";
    main.textContent = text;
    item.appendChild(main);
    if (meta) {
      const tag = document.createElement("span");
      tag.className = "dmp-meta";
      tag.textContent = meta;
      item.appendChild(tag);
    }
    item.title = text;
    if (onClick) {
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        onClick();
      });
    }
    return item;
  }

  function updatePickerRect() {
    if (!pickerCard) return;
    const r = video && video.getBoundingClientRect();
    const width = Math.min(360, window.innerWidth - 24);
    pickerCard.style.width = `${width}px`;
    pickerCard.style.left = `${Math.max(
      12,
      (r && r.width ? r.right : window.innerWidth) - width - 10
    )}px`;
    pickerCard.style.top = `${(r && r.height ? r.top : 0) + 44}px`;
  }

  async function pickerSearch(keyword) {
    const kw = cleanTitle(keyword);
    if (!kw) return;
    setPicker({
      keyword: kw,
      busy: true,
      error: false,
      message: `正在搜索《${kw}》…`,
      animes: [],
      episodes: []
    });
    try {
      const res = await chrome.runtime.sendMessage({ type: "API_SEARCH_ANIME", keyword: kw });
      if (!res || !res.ok) throw new Error(res?.error || "作品搜索失败");
      const animes = res.items || [];
      if (!animes.length) {
        setPicker({
          step: "anime",
          busy: false,
          error: true,
          animes: [],
          message: `没有找到与「${kw}」匹配的作品，换个关键词试试。`
        });
        return;
      }
      setPicker({
        step: "anime",
        busy: false,
        error: false,
        animes,
        message: `找到 ${animes.length} 部作品，选择弹幕来源。`
      });
    } catch (e) {
      setPicker({ busy: false, error: true, message: `搜索失败：${e.message || e}` });
    }
  }

  async function pickerChooseAnime(anime) {
    const name =
      anime.animeTitle || anime.title || anime.name || anime.anime || picker.keyword || "";
    setPicker({
      step: "episode",
      anime,
      episodes: [],
      busy: true,
      error: false,
      message: `正在获取《${name}》的剧集…`
    });
    try {
      const res = await chrome.runtime.sendMessage({
        type: "API_SEARCH_EPISODES",
        anime: name,
        animeId: anime.animeId,
        animeTitle: name
      });
      if (!res || !res.ok) throw new Error(res?.error || "剧集获取失败");
      const episodes = res.items || [];
      if (!episodes.length) {
        setPicker({
          step: "anime",
          busy: false,
          error: true,
          episodes: [],
          message: `《${name}》暂无可加载的剧集，换一部作品试试。`
        });
        return;
      }
      setPicker({
        step: "episode",
        busy: false,
        error: false,
        episodes,
        message: `找到 ${episodes.length} 集，选择目标集数。`
      });
    } catch (e) {
      setPicker({
        step: "anime",
        busy: false,
        error: true,
        message: `剧集获取失败：${e.message || e}`
      });
    }
  }

  async function pickerChooseEpisode(episode) {
    const label = episode.episodeTitle || episode.title || episode.name || "该集";
    setPicker({ busy: true, error: false, message: `正在获取《${label}》的弹幕…` });
    try {
      const target = {
        id: episode.episodeId || episode.commentId || episode.cid || episode.id,
        url: episode.url || episode.videoUrl || episode.playUrl
      };
      const res = await chrome.runtime.sendMessage({ type: "API_GET_COMMENTS", ...target });
      if (!res || !res.ok) throw new Error(res?.error || "弹幕获取失败");
      const loaded = res.comments || [];
      if (!loaded.length) {
        setPicker({
          busy: false,
          error: true,
          message: `《${label}》暂无弹幕，换一集试试。`
        });
        return;
      }
      const animeName = picker.anime
        ? picker.anime.animeTitle || picker.anime.title || picker.anime.name || ""
        : "";
      applyResolved({ comments: loaded, episode: label, anime: animeName }, false);
      closePicker();
      showToast(`已装填 ${loaded.length} 条弹幕 · ${label}`, { duration: 3000 });
    } catch (e) {
      setPicker({ busy: false, error: true, message: `弹幕获取失败：${e.message || e}` });
    }
  }

  function backPicker() {
    if (picker.step !== "episode" || picker.busy) return;
    setPicker({
      step: "anime",
      episodes: [],
      busy: false,
      error: false,
      message: "换一部作品，或重新搜索关键词。"
    });
  }

  function findVideo(root = document) {
    const direct = root.querySelector("video");
    if (direct) return direct;

    for (const el of root.querySelectorAll("*")) {
      if (!el.shadowRoot) continue;
      const found = findVideo(el.shadowRoot);
      if (found) return found;
    }

    if (root === document) {
      for (const iframe of document.querySelectorAll("iframe")) {
        try {
          const doc = iframe.contentDocument;
          if (!doc) continue;
          const found = findVideo(doc);
          if (found) return found;
        } catch (e) {}
      }
    }
    return null;
  }

  function watchVideo() {
    video = findVideo();
    if (video) onVideoReady();

    observer = new MutationObserver(() => {
      if (!video) {
        const found = findVideo();
        if (found) {
          video = found;
          onVideoReady();
        }
      }
    });
    observer.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true
    });

    const poll = setInterval(() => {
      if (video) {
        clearInterval(poll);
        return;
      }
      const found = findVideo();
      if (found) {
        video = found;
        clearInterval(poll);
        onVideoReady();
      }
    }, 400);
  }

  function onVideoReady() {
    if (videoReady) clearDanmu();
    videoReady = true;
    if (!overlayHomeParent) overlayHomeParent = document.body || document.documentElement;
    mountOverlay();
    setupRectObserver();

    video.addEventListener("seeked", resetDanmu);
    video.addEventListener("emptied", clearDanmu);

    lastTime = video.currentTime || 0;
    if (!loopStarted) {
      loopStarted = true;
      loop();
    }
    tryAutoLoad();
  }

  function setupRectObserver() {
    if (rectObserver) {
      try { rectObserver.disconnect(); } catch (e) {}
      rectObserver = null;
    }
    if (typeof ResizeObserver === "undefined" || !video) return;
    rectObserver = new ResizeObserver(() => updateOverlayRect(true));
    rectObserver.observe(video);
  }

  function getVideoKey() {
    const src = video && (video.currentSrc || video.src || "");
    return `${location.href}::${src}`;
  }

  function extractEpisodeNo(text, allowBareNumber = false) {
    const s = String(text || "").trim();
    let m = s.match(/第\s*0*(\d+)\s*[集话]/);
    if (!m) m = s.match(/[SE]0*\d+E0*(\d+)/i);
    if (!m) m = s.match(/EP\s*0*(\d+)/i);
    if (!m) m = s.match(/#0*(\d+)/);
    if (!m && allowBareNumber) m = s.match(/^0*(\d{1,3})$/);
    return m ? parseInt(m[1], 10) : null;
  }

  function detectActiveEpisode() {
    const selectors = [
      "a.active", "a[class*='active' i]", "a.current", "a[class*='current' i]",
      "a[aria-current]", "a[class*='selected' i]", "a.on", "a[class*='playing' i]",
      "li.active a", "li.current a", ".active > a", ".current > a", "[aria-current] > a"
    ];
    for (const sel of selectors) {
      let nodes;
      try {
        nodes = document.querySelectorAll(sel);
      } catch (e) {
        continue;
      }
      for (const el of Array.from(nodes).slice(0, 30)) {
        const text = (el.textContent || "").trim();
        const no = extractEpisodeNo(text, true);
        if (no != null) return no;
        for (const attr of ["title", "data-episode", "data-ep", "data-num", "href"]) {
          const no2 = extractEpisodeNo(el.getAttribute(attr) || "", true);
          if (no2 != null) return no2;
        }
      }
    }
    return null;
  }

  function findEpisodeHint(titles) {
    const active = detectActiveEpisode();
    if (active != null) return active;
    const sources = [...(titles || []), document.title];
    try {
      const nodes = document.querySelectorAll(
        "[class*='episode' i],[id*='episode' i],[class*='ep-num' i],[id*='ep-num' i],h2,h3,h4,h5"
      );
      for (const el of Array.from(nodes).slice(0, 40)) {
        const text = (el.textContent || "").trim();
        if (text && text.length <= 40) sources.push(text);
      }
    } catch (e) {}
    for (const source of sources) {
      const no = extractEpisodeNo(source);
      if (no != null) return no;
    }
    const urlEp = location.href.match(/[?&#/]ep(?:isode)?[=/]0*(\d+)/i);
    return urlEp ? parseInt(urlEp[1], 10) : null;
  }

  async function collectAutoInfoAcrossFrames() {
    try {
      const res = await chrome.runtime.sendMessage({ type: "AUTO_COLLECT_TITLES" });
      if (res && res.ok && Array.isArray(res.titles)) {
        return { titles: res.titles, episodeHint: res.episodeHint ?? null };
      }
    } catch (e) {}
    return { titles: collectCandidates(), episodeHint: detectActiveEpisode() };
  }

  async function tryAutoLoad(retry = 0) {
    if (!rule || !rule.autoLoad || !video) return;
    if (video.ownerDocument && video.ownerDocument !== document) return;
    const key = getVideoKey();
    if (autoAttemptKey === key) return;

    const autoInfo = await collectAutoInfoAcrossFrames();
    let candidates = autoInfo.titles;
    if (matchedKeyword && !candidates.includes(matchedKeyword)) {
      candidates.unshift(matchedKeyword);
    }
    if (!candidates.length && retry < 6) {
      setTimeout(() => tryAutoLoad(retry + 1), 700);
      return;
    }
    autoAttemptKey = key;
    autoNoticeShown = false;
    candidates = candidates.slice(0, 3);
    const episodeHint = autoInfo.episodeHint != null ? autoInfo.episodeHint : findEpisodeHint(candidates);
    console.info("[danmu] 标题匹配候选", {
      titles: candidates,
      episodeHint,
      activeEpisode: autoInfo.episodeHint
    });
    showToast(`正在匹配《${candidates[0] || "当前视频"}》的弹幕…`, { persistent: true });

    let matched = null;
    for (const title of candidates) {
      try {
        const res = await chrome.runtime.sendMessage({
          type: "API_SEARCH_ANIME",
          keyword: title
        });
        if (res && res.ok && (res.items || []).length) {
          matched = { title, animes: res.items };
          break;
        }
      } catch (e) {
        console.info("[danmu] 作品搜索失败", e && e.message ? e.message : String(e));
      }
    }

    if (!matched) {
      console.info("[danmu] 标题匹配失败", { titles: candidates });
      showToast(`没有找到《${candidates[0] || "当前视频"}》的弹幕，点此手动选择`, {
        actionText: "手动选择",
        onAction: () =>
          openPicker({
            title: candidates[0] || "当前视频",
            keyword: candidates[0] || "",
            animes: [],
            episodeHint
          })
      });
      return;
    }

    console.info("[danmu] 标题匹配成功", {
      title: matched.title,
      count: matched.animes.length,
      episodeHint
    });

    if (episodeHint != null) {
      showToast(`已确定《${matched.title}》第 ${episodeHint} 集，正在装填弹幕…`, {
        persistent: true
      });
      let res = null;
      try {
        res = await chrome.runtime.sendMessage({
          type: "AUTO_RESOLVE",
          titles: [matched.title],
          episodeHint,
          videoKey: `${key}::auto::${episodeHint}`
        });
      } catch (e) {
        console.info("[danmu] 按集自动装填失败", e && e.message ? e.message : String(e));
      }
      if (res && res.ok && res.episodeFromHint && (res.comments || []).length) {
        hideToast();
        showToast(`已按第 ${episodeHint} 集自动装填 ${res.comments.length} 条弹幕`, {
          duration: 2600
        });
        applyResolved(res, true);
        return;
      }
      console.info("[danmu] 按集自动装填未命中，改为手动选择", {
        reason: res && res.reason,
        tried: res && res.tried,
        episodeHint
      });
    }

    openPicker({
      title: matched.title,
      keyword: matched.title,
      animes: matched.animes,
      episodeHint
    });
  }

  function applyResolved(res, auto = false) {
    loadComments(res.comments || []);
    currentEpisode = res.episode || "";
    matchState = "done";
    autoMatched = auto;
    if (res.anime) matchedKeyword = res.anime;
    notifyWizardState();
  }

  function notifyAutoFailure(res, candidates, episodeHint) {
    autoNoticeShown = true;
    retryContext = { keyword: candidates[0] || matchedKeyword || "", episodeHint };
    console.info("[danmu] 自动装填未命中", {
      titles: candidates,
      reason: (res && res.reason) || "unknown",
      tried: (res && res.tried) || 0,
      episodeHint
    });
    showToast("自动装填未命中，可改词后按当前集重试", {
      actionText: "改词重试",
      onAction: openRetryCard
    });
  }

  function openRetryCard() {
    openMatchCard();
    const input = matchCard && matchCard.querySelector(".dmc-input");
    if (input) input.value = retryContext.keyword || "";
    const hint = retryContext.episodeHint;
    setWizard({
      status: `「${retryContext.keyword || "当前标题"}」未命中，可改词后按当前集${
        hint != null ? `（第 ${hint} 集）` : ""
      }快速重试。`,
      keyword: retryContext.keyword || ""
    });
  }

  async function quickRetry(keyword) {
    const kw = cleanTitle(keyword);
    if (!kw) return;
    matchedKeyword = kw;
    notifyKeyword(kw);
    setWizard({
      step: "keyword",
      status: `正在按当前集重试《${kw}》…`,
      busy: true,
      error: false,
      keyword: kw
    });
    console.info("[danmu] 改词重试关键词", { keyword: kw, episodeHint: retryContext.episodeHint });
    try {
      const res = await chrome.runtime.sendMessage({
        type: "AUTO_RESOLVE",
        titles: [kw],
        episodeHint: retryContext.episodeHint,
        videoKey: `${getVideoKey()}::retry::${kw}`
      });
      if (res && res.ok && (res.comments || []).length) {
        applyResolved(res, true);
        closeMatchCard(true);
        return;
      }
      setWizard({
        status: `仍未能按「${kw}」装填弹幕，可继续在下方选择作品与剧集。`,
        busy: false,
        error: true
      });
    } catch (e) {
      setWizard({ status: `重试失败：${e.message || e}`, busy: false, error: true });
    }
  }

  function injectStyle() {
    if (styleInjected || document.getElementById(STYLE_ID)) return;
    styleInjected = true;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${OVERLAY_ID} {
        position: fixed;
        z-index: 2147483647;
        pointer-events: none;
        overflow: hidden;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
      }
      #${OVERLAY_ID}[popover] {
        margin: 0;
        inset: auto;
        border: 0;
        padding: 0;
        background: transparent;
      }
      #${OVERLAY_ID} .dm {
        position: absolute;
        left: 0;
        top: 0;
        white-space: nowrap;
        will-change: transform;
        text-shadow: 1px 1px 2px #000, -1px -1px 2px #000, 0 0 3px #000;
        line-height: 1.3;
        transform: translate3d(-99999px, 0, 0);
      }
      #${MATCH_BTN_ID}:hover { border-left-color: #7fa64c; color: #456c2b; }
      #${MATCH_CARD_ID} input:focus { border-color: #5d8a3a !important; box-shadow: 0 0 0 3px rgba(93,138,58,.12); }
      #${MATCH_CARD_ID} .dmc-list::-webkit-scrollbar { width: 6px; }
      #${MATCH_CARD_ID} .dmc-list::-webkit-scrollbar-thumb { background: #c3d3a6; border-radius: 3px; }
      #${TOAST_ID} {
        position: fixed;
        z-index: 2147483647;
        left: 50%;
        top: 22px;
        transform: translateX(-50%) translateY(-8px);
        max-width: min(520px, 84vw);
        padding: 10px 15px;
        border: 1px solid #dce5c8;
        border-left: 3px solid #e8ad35;
        border-radius: 10px;
        background: #fdfdf6;
        color: #3b4a2f;
        font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
        letter-spacing: 0.03em;
        box-shadow: 0 8px 24px rgba(44,58,36,0.18);
        opacity: 0;
        pointer-events: none;
        transition: opacity 180ms ease, transform 180ms ease;
      }
      #${TOAST_ID}.show { opacity: 1; transform: translateX(-50%) translateY(0); }
      #${TOAST_ID} .dmc-toast-action {
        margin-left: 10px;
        padding: 3px 9px;
        border: 1px solid #d79a20;
        border-radius: 999px;
        background: #fbf1d8;
        color: #8a6412;
        font: 600 10px/1.4 ui-monospace, Menlo, monospace;
        cursor: pointer;
        pointer-events: auto;
      }
      #${TOAST_ID}:not(.show) .dmc-toast-action { pointer-events: none; }

      #${PICKER_ID} {
        position: fixed;
        z-index: 2147483647;
        display: none;
        width: 360px;
        max-width: calc(100vw - 24px);
        background: #fdfdf6;
        color: #3b4a2f;
        border: 1px solid #dce5c8;
        border-top: 3px solid #5d8a3a;
        border-radius: 12px;
        box-shadow: 0 18px 48px rgba(44,58,36,0.22);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
        pointer-events: auto;
        overflow: hidden;
      }
      #${PICKER_ID} .dmp-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 13px 14px 10px;
        background: linear-gradient(180deg, #f6f9e9, transparent);
      }
      #${PICKER_ID} .dmp-eyebrow {
        font: 600 10px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
        letter-spacing: 0.16em;
        color: #5d8a3a;
      }
      #${PICKER_ID} .dmp-close {
        display: grid;
        place-items: center;
        width: 22px;
        height: 22px;
        border: 0;
        border-radius: 50%;
        background: transparent;
        color: #8b9c76;
        font: 16px/1 sans-serif;
        cursor: pointer;
        padding: 0;
      }
      #${PICKER_ID} .dmp-close:hover { background: #eaf2d9; color: #456c2b; }
      #${PICKER_ID} .dmp-match { padding: 0 14px 12px; }
      #${PICKER_ID} .dmp-label {
        font: 10px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
        letter-spacing: 0.1em;
        color: #8b9c76;
      }
      #${PICKER_ID} .dmp-title {
        margin-top: 5px;
        font-size: 13px;
        font-weight: 600;
        line-height: 1.4;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: #456c2b;
      }
      #${PICKER_ID} .dmp-steps { display: flex; gap: 6px; padding: 0 14px 8px; }
      #${PICKER_ID} .dmp-step {
        flex: 1;
        height: 4px;
        border-radius: 999px;
        background: #dce5c8;
      }
      #${PICKER_ID} .dmp-step.active { background: #5d8a3a; }
      #${PICKER_ID} .dmp-step.done { background: #8fae63; }
      #${PICKER_ID} .dmp-step-labels {
        display: flex;
        gap: 6px;
        padding: 0 14px 10px;
        font: 10px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
        letter-spacing: 0.08em;
      }
      #${PICKER_ID} .dmp-step-labels span { flex: 1; color: #8b9c76; }
      #${PICKER_ID} .dmp-step-labels span.active { color: #5d8a3a; }
      #${PICKER_ID} .dmp-search { display: flex; gap: 6px; padding: 0 14px 10px; }
      #${PICKER_ID} .dmp-search input {
        flex: 1;
        min-width: 0;
        background: #fffef8;
        border: 1px solid #dce5c8;
        border-radius: 8px;
        color: #3b4a2f;
        padding: 7px 9px;
        font-family: inherit;
        font-size: 12px;
        outline: none;
      }
      #${PICKER_ID} .dmp-search input:focus { border-color: #5d8a3a; box-shadow: 0 0 0 3px rgba(93,138,58,.12); }
      #${PICKER_ID} .dmp-search button {
        border: 1px solid #d79a20;
        border-radius: 999px;
        background: linear-gradient(180deg, #f2c25a, #e8ad35);
        color: #4a3a12;
        padding: 0 14px;
        font: 600 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
        cursor: pointer;
      }
      #${PICKER_ID} .dmp-list {
        max-height: 260px;
        overflow: auto;
        border-top: 1px solid #dce5c8;
      }
      #${PICKER_ID} .dmp-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 10px;
        width: 100%;
        text-align: left;
        border: 0;
        border-left: 3px solid transparent;
        background: transparent;
        color: #3b4a2f;
        padding: 10px 14px;
        font-family: inherit;
        font-size: 12px;
        line-height: 1.4;
        cursor: pointer;
      }
      #${PICKER_ID} .dmp-row:hover { background: #eaf2d9; border-left-color: #5d8a3a; }
      #${PICKER_ID} .dmp-row.recommended { border-left-color: #e8ad35; background: #f6f9e9; }
      #${PICKER_ID} .dmp-main { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      #${PICKER_ID} .dmp-meta {
        font: 9px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
        color: #8b9c76;
        flex-shrink: 0;
      }
      #${PICKER_ID} .dmp-empty {
        padding: 22px 14px;
        text-align: center;
        font-size: 12px;
        line-height: 1.6;
        color: #8b9c76;
      }
      #${PICKER_ID} .dmp-empty.error { color: #b4653f; }
      #${PICKER_ID} .dmp-foot {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 10px 14px;
        border-top: 1px solid #dce5c8;
        background: rgba(246,249,233,0.7);
      }
      #${PICKER_ID} .dmp-status {
        flex: 1;
        font: 10px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
        color: #8b9c76;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #${PICKER_ID} .dmp-status.error { color: #b4653f; }
      #${PICKER_ID} .dmp-status.busy { color: #5d8a3a; }
      #${PICKER_ID} .dmp-back, #${PICKER_ID} .dmp-cancel {
        border: 1px solid #dce5c8;
        border-radius: 8px;
        background: var(--panel, #fdfdf6);
        color: #6f7f5e;
        padding: 5px 11px;
        font-family: inherit;
        font-size: 11px;
        cursor: pointer;
      }
      #${PICKER_ID} .dmp-back:hover, #${PICKER_ID} .dmp-cancel:hover {
        color: #456c2b;
        border-color: #b7d08e;
        background: #eaf2d9;
      }
    `;
    document.head.appendChild(style);
  }

  function canHoldOverlay(el) {
    return (
      el &&
      !/^(VIDEO|AUDIO|IMG|CANVAS|INPUT|TEXTAREA|SELECT|IFRAME|EMBED|OBJECT)$/.test(el.nodeName)
    );
  }

  function refreshPopover() {
    if (!overlay) return;
    if (!overlay.hasAttribute("popover")) overlay.setAttribute("popover", "manual");
    try {
      if (overlay.matches(":popover-open")) overlay.hidePopover();
    } catch (e) {}
    try {
      if (!overlay.matches(":popover-open")) overlay.showPopover();
    } catch (e) {}
  }

  function mountOverlay() {
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = OVERLAY_ID;
      overlayHomeParent = overlayHomeParent || document.body || document.documentElement;
      applyStyle();
    }
    if (!overlayHomeParent || !overlayHomeParent.isConnected) {
      overlayHomeParent = document.body || document.documentElement;
    }
    const fs = document.fullscreenElement || null;
    lastFullscreenEl = fs;

    // 全屏元素可承载子节点时挂进去，避免 popover 在全屏后变 inert；
    // 裸 video / iframe 全屏无法承载内容，保持在 top layer 覆盖视频。
    if (fs && canHoldOverlay(fs)) {
      if (overlay.parentElement !== fs) fs.appendChild(overlay);
    } else if (overlay.parentElement !== overlayHomeParent) {
      overlayHomeParent.appendChild(overlay);
    }
    refreshPopover();
    updateOverlayRect(true);
    scheduleOverlaySettle();
  }

  function scheduleOverlaySettle() {
    clearTimeout(settleTimer);
    requestAnimationFrame(() => updateOverlayRect(true));
    settleTimer = setTimeout(() => {
      updateOverlayRect(true);
      relayoutActive();
    }, 120);
  }

  function applyStyle() {
    if (!overlay || !config || !config.style) return;
    const s = config.style;
    overlay.style.opacity = String(s.opacity ?? 0.9);
    overlay.style.fontSize = `${s.fontSize || 25}px`;
    overlay.style.color = s.color || "#ffffff";
  }

  function refreshActiveStyle() {
    if (!active.length || !config || !config.style) return;
    const s = config.style;
    const duration = Math.max(3, Number(s.speed) || 8);
    const baseSize = Number(s.fontSize) || 25;
    const baseColor = s.color || "#ffffff";
    for (const d of active) {
      d.el.style.color = baseColor;
      d.el.style.fontSize = `${baseSize}px`;
      d.duration = duration;
      d.width = d.el.offsetWidth || 0;
      d.height = d.el.offsetHeight || Math.ceil(baseSize * 1.3);
      d.laneHeight = d.height + 6;
    }
  }

  function updateOverlayRect(force = false) {
    if (!overlay || !video) return;
    const r = video.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const prev = lastVideoRect;
    const moved =
      !prev ||
      Math.abs(prev.left - r.left) > 0.5 ||
      Math.abs(prev.top - r.top) > 0.5 ||
      Math.abs(prev.width - r.width) > 0.5 ||
      Math.abs(prev.height - r.height) > 0.5;
    if (!force && !moved) return;
    const resized =
      !prev ||
      Math.abs(prev.width - r.width) > 1 ||
      Math.abs(prev.height - r.height) > 1;

    overlay.style.left = `${r.left}px`;
    overlay.style.top = `${r.top}px`;
    overlay.style.width = `${r.width}px`;
    overlay.style.height = `${r.height}px`;

    // 祖先带 transform / filter 时 fixed 参照系会整体偏移，用实际矩形反推修正。
    const actual = overlay.getBoundingClientRect();
    const dx = r.left - actual.left;
    const dy = r.top - actual.top;
    if (Math.abs(dx) > 0.5) overlay.style.left = `${r.left + dx}px`;
    if (Math.abs(dy) > 0.5) overlay.style.top = `${r.top + dy}px`;

    lastVideoRect = { left: r.left, top: r.top, width: r.width, height: r.height };
    if (resized) relayoutActive();
  }

  function getSafeArea() {
    const w = overlay.clientWidth || (lastVideoRect ? lastVideoRect.width : 0);
    const h = overlay.clientHeight || (lastVideoRect ? lastVideoRect.height : 0);
    const s = config && config.style ? config.style : {};
    const top = Math.max(0, Number(s.marginTop ?? 2));
    const raw = s.marginBottom;
    let bottom;
    if (raw != null && raw !== "") {
      bottom =
        typeof raw === "string" && raw.trim().endsWith("%")
          ? (h * parseFloat(raw)) / 100
          : Number(raw);
    } else {
      bottom = Math.min(80, Math.max(44, Math.round(h * 0.09)));
    }
    if (!Number.isFinite(bottom) || bottom < 0) bottom = 0;
    return { w, h, top, bottom, renderH: Math.max(1, h - top - bottom) };
  }

  function loadComments(list) {
    clearDanmu();
    comments = (list || [])
      .slice()
      .sort((a, b) => a.time - b.time);
    lastTime = video ? video.currentTime || 0 : 0;
    const duration = Math.max(3, Number(config.style.speed) || 8);
    emitted = lowerBound(comments, lastTime - duration);
  }

  function clearActive() {
    for (const d of active) d.el.remove();
    active.length = 0;
  }

  function clearDanmu() {
    clearActive();
    comments = [];
    currentEpisode = "";
    autoMatched = false;
    emitted = 0;
    laneCursor = 0;
    topLaneCursor = 0;
    bottomLaneCursor = 0;
  }

  function resetDanmu() {
    clearActive();
    laneCursor = 0;
    topLaneCursor = 0;
    bottomLaneCursor = 0;
    const t = video ? video.currentTime || 0 : 0;
    const duration = Math.max(3, Number(config && config.style ? config.style.speed : 0) || 8);
    emitted = lowerBound(comments, t - duration);
    lastTime = t;
  }

  function lowerBound(arr, t) {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].time < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  function loop() {
    requestAnimationFrame(loop);
    if (!video || !overlay) return;
    updateOverlayRect();
    updateMatchBtnRect();
    const fsEl = document.fullscreenElement || null;
    if (fsEl !== lastFullscreenEl) mountOverlay();
    if (!comments.length || video.ended) return;

    const t = video.currentTime || 0;
    if (t < lastTime - 0.5) resetDanmu();
    lastTime = t;

    const duration = Math.max(3, Number(config.style.speed) || 8);
    while (emitted < comments.length && comments[emitted].time <= t) {
      const c = comments[emitted];
      // 历史弹幕按原始时间直接跳过，避免一次性生成几千条 DOM 拖死主线程。
      if (t - c.time < duration) spawn(c, t);
      emitted++;
    }
    if (!video.paused) updateActive(t);
  }

  function updateActive(t) {
    if (!active.length) return;
    const area = getSafeArea();
    for (let i = active.length - 1; i >= 0; i--) {
      const d = active[i];
      const p = (t - d.bornTime) / d.duration;
      if (p >= 1) {
        d.el.remove();
        active.splice(i, 1);
        continue;
      }
      positionDanmu(d, Math.max(0, p), area);
    }
  }

  function positionDanmu(d, p, area) {
    let x;
    let y;
    if (d.kind === "roll") {
      x = area.w - p * (area.w + d.width);
      y = area.top + d.lane * d.laneHeight;
    } else if (d.kind === "top") {
      x = (area.w - d.width) / 2;
      y = area.top + d.lane * d.laneHeight;
    } else {
      x = (area.w - d.width) / 2;
      y = area.h - area.bottom - (d.lane + 1) * d.laneHeight;
    }
    d.el.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
  }

  function relayoutActive() {
    if (!active.length) return;
    const area = getSafeArea();
    const t = video ? video.currentTime || 0 : 0;
    const maxLines = Number((config && config.style && config.style.maxLines) || 8);
    for (const d of active) {
      const laneHeight = d.height + 6;
      const maxLanes = Math.max(
        1,
        Math.min(maxLines, Math.max(1, Math.floor(area.renderH / laneHeight)))
      );
      d.laneHeight = laneHeight;
      d.lane = d.lane % maxLanes;
      positionDanmu(d, Math.max(0, Math.min(1, (t - d.bornTime) / d.duration)), area);
    }
  }

  function spawn(comment, now) {
    if (!overlay || active.length >= 400) return;
    const el = document.createElement("div");
    const mode = Number(comment.mode) || 1;
    const kind =
      mode === 4 || comment.mode === "bottom"
        ? "bottom"
        : mode === 5 || comment.mode === "top"
          ? "top"
          : "roll";
    el.className = `dm ${kind}`;
    el.textContent = comment.text || "";
    const style = config.style || {};
    el.style.color = style.color || comment.color || "#ffffff";
    const fontSize = Number(style.fontSize) || Number(comment.fontSize) || 25;
    el.style.fontSize = `${fontSize}px`;
    overlay.appendChild(el);

    const area = getSafeArea();
    const width = el.offsetWidth || 0;
    const height = el.offsetHeight || Math.ceil(fontSize * 1.3);
    const laneHeight = height + 6;
    const maxLanes = Math.max(
      1,
      Math.min(Number(style.maxLines) || 8, Math.max(1, Math.floor(area.renderH / laneHeight)))
    );
    let lane = 0;
    if (kind === "roll") lane = laneCursor++ % maxLanes;
    else if (kind === "top") lane = topLaneCursor++ % maxLanes;
    else lane = bottomLaneCursor++ % maxLanes;

    const born = Number.isFinite(Number(comment.time)) ? Number(comment.time) : now;
    const d = {
      el,
      kind,
      bornTime: born,
      duration: Math.max(3, Number(style.speed) || 8),
      lane,
      width,
      height,
      laneHeight
    };
    active.push(d);
    positionDanmu(d, Math.max(0, Math.min(1, (now - born) / d.duration)), area);
  }
})();

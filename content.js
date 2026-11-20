(() => {
  if (window.__danmuOverlayInjected__) return;
  window.__danmuOverlayInjected__ = true;

  const OVERLAY_ID = "__danmu_overlay__";
  const STYLE_ID = "__danmu_style__";
  const MATCH_BTN_ID = "__danmu_match_btn__";
  const MATCH_CARD_ID = "__danmu_match_card__";
  const TOAST_ID = "__danmu_toast__";

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
  let emitted = 0;
  let lastTime = 0;
  let autoTried = false;
  let laneCursor = 0;
  let observer = null;
  let styleInjected = false;
  let videoReady = false;
  let loopStarted = false;
  let bindingsInstalled = false;
  let dmPaused = false;
  const dmTimers = new Map();
  let lastFullscreenEl = null;

  init();

  async function init() {
    const res = await chrome.runtime.sendMessage({ type: "GET_CONFIG" });
    if (!res || !res.ok) return;
    config = res.config;
    rule = findRule(location.href, config.rules);
    if (!rule) {
      rule = {
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
          url: location.href
        });
      } else if (msg.type === "CONTENT_MATCH_KEYWORD") {
        sendResponse({ ok: true, candidates: collectCandidates() });
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
        loadComments(msg.comments || []);
        currentEpisode = msg.episode || "";
        sendResponse({ ok: true, count: comments.length });
      } else if (msg.type === "CONTENT_CLEAR_DANMU") {
        clearDanmu();
        sendResponse({ ok: true });
      } else if (msg.type === "CONTENT_SET_STYLE") {
        config.style = { ...config.style, ...msg.style };
        applyStyle();
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: "未知内容脚本消息" });
      }
      return true;
    });
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
    /^(首页|播放|登录|注册|搜索|导航|更多|全部|详情|视频|电影|电视剧|综艺|动漫|选集|剧集|下一集|上一集|正片|预告|花絮|完结|更新至.*集|第\d+集|player\s*version\b.*|video\s*player\b.*|video\s*url\b.*|play\s*url\b.*|player\s*url\b.*|video\s*source\b.*|full\s*screen\b.*|loading\b.*|buffering\b.*|版本.*|v?\d+(\.\d+){1,4})$/i;

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

    // 第 2 层：以 video 为起点，逐层向上扫描兄弟节点与祖先（辅助定位播放器附近标题）
    if (video) {
      let node = video;
      for (let depth = 0; depth < 6 && node; depth++) {
        const parent = node.parentElement;
        if (!parent) break;
        const proximity = 150 - depth * 12;
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
      updateOverlayRect();
      updateMatchBtnRect();
      updateMatchCardRect();
    });
    window.addEventListener("scroll", () => {
      updateOverlayRect();
      updateMatchBtnRect();
      updateMatchCardRect();
    }, true);
    document.addEventListener("fullscreenchange", () => {
      mountOverlay();
      mountMatchBtn();
      if (matchCard) {
        const parent = document.fullscreenElement || document.documentElement;
        if (matchCard.parentElement !== parent) parent.appendChild(matchCard);
      }
      updateMatchCardRect();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && wizardOpen) {
        e.stopPropagation();
        closeMatchCard(true);
      }
    }, true);
    document.addEventListener("pointerdown", (e) => {
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
        "border:1px solid #3b4448",
        "border-left:3px solid #6ed9b8",
        "border-radius:2px",
        "background:#14181a",
        "color:#f2f0e9",
        "font:600 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace",
        "letter-spacing:.1em",
        "cursor:pointer",
        "pointer-events:auto",
        "box-shadow:0 3px 12px rgba(0,0,0,.38)",
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
        "background:#14181a",
        "color:#f2f0e9",
        "border:1px solid #3b4448",
        "border-radius:3px",
        "box-shadow:0 14px 42px rgba(0,0,0,.5)",
        "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC',sans-serif",
        "pointer-events:auto",
        "overflow:hidden"
      ].join(";");
      matchCard.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:11px 13px;border-bottom:1px solid #3b4448">
          <span style="font:600 10px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.14em;color:#6ed9b8">DANMU / 自动装填</span>
          <button class="dmc-close" aria-label="关闭" style="border:0;background:none;color:#929c98;font:16px/1 sans-serif;cursor:pointer;padding:0 2px">×</button>
        </div>
        <div class="dmc-steps" style="display:flex;gap:0;padding:10px 13px 0"></div>
        <div class="dmc-status" style="margin:9px 13px 2px;padding:8px 10px;background:#0c0f11;border-left:2px solid #6ed9b8;font:11px/1.5 ui-monospace,Menlo,monospace;color:#c7cecb"></div>
        <div class="dmc-list" style="padding:6px 7px;max-height:216px;overflow:auto"></div>
        <div class="dmc-foot" style="display:flex;gap:6px;padding:10px 13px;border-top:1px solid #3b4448">
          <input class="dmc-input" placeholder="或手动输入标题" style="flex:1;min-width:0;background:#0c0f11;border:1px solid #3b4448;color:#f2f0e9;padding:6px 8px;font:12px sans-serif;outline:none" />
          <button class="dmc-use" style="border:1px solid #6ed9b8;background:#6ed9b8;color:#14181a;padding:6px 10px;font:600 11px ui-monospace,Menlo,monospace;cursor:pointer">使用</button>
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
        sep.style.cssText = "flex:1;height:1px;background:#3b4448;align-self:center;margin:0 6px";
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
        `color:${active ? "#6ed9b8" : done ? "#7fa89b" : "#5c6663"}`
      ].join(";");
      box.appendChild(node);
    });
  }

  function renderWizardStatus() {
    const el = matchCard.querySelector(".dmc-status");
    el.textContent = wizard.status || "准备就绪";
    const color = wizard.error ? "#e08a6e" : wizard.busy ? "#d9cb8a" : "#6ed9b8";
    el.style.borderLeftColor = color;
    el.style.color = wizard.error ? "#e8b4a3" : "#c7cecb";
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
    const baseColor = highlight ? "#6ed9b8" : "transparent";
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
      "color:#f2f0e9",
      "padding:7px 9px",
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
      tag.style.cssText = "font:9px ui-monospace,Menlo,monospace;color:#6b756f;flex-shrink:0";
      item.appendChild(tag);
    }
    item.title = text;
    item.addEventListener("mouseenter", () => {
      item.style.background = "#20272a";
      item.style.borderLeftColor = "#6ed9b8";
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
    el.style.cssText = "padding:12px 8px;font-size:12px;color:#929c98";
    el.textContent = text;
    return el;
  }

  function hideMatchBtn() {
    if (matchBtn) matchBtn.style.display = "none";
  }

  function showToast(text) {
    if (!toast) {
      toast = document.createElement("div");
      toast.id = TOAST_ID;
    }
    const parent = document.fullscreenElement || document.documentElement;
    if (toast.parentElement !== parent) parent.appendChild(toast);
    toast.textContent = text;
    toast.classList.add("show");
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove("show"), 2600);
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
    mountOverlay();

    video.addEventListener("play", () => setPaused(false));
    video.addEventListener("playing", () => setPaused(false));
    video.addEventListener("pause", () => setPaused(true));
    video.addEventListener("waiting", () => setPaused(true));
    video.addEventListener("seeked", resetDanmu);
    video.addEventListener("emptied", clearDanmu);

    lastTime = video.currentTime || 0;
    if (!loopStarted) {
      loopStarted = true;
      loop();
    }
  }

  async function tryAutoLoad(retry = 0, force = false) {
    if (autoTried || (!rule.autoLoad && !force)) return;
    const title = matchedKeyword || getTitle();
    if (!title) {
      if (retry < 6) setTimeout(() => tryAutoLoad(retry + 1, force), 700);
      return;
    }
    autoTried = true;
    try {
      const res = await chrome.runtime.sendMessage({ type: "AUTO_LOAD", title });
      if (!res || !res.ok) {
        console.info("[danmu] 自动装填未完成", res && res.reason);
      } else {
        matchState = "done";
        notifyWizardState();
      }
    } catch (e) {
      console.info("[danmu] 自动装填失败", e);
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
        white-space: nowrap;
        will-change: transform;
        text-shadow: 1px 1px 2px #000, -1px -1px 2px #000, 0 0 3px #000;
        line-height: 1.3;
      }
      #${OVERLAY_ID} .dm.roll {
        left: 100%;
        animation-name: dmroll;
        animation-timing-function: linear;
        animation-fill-mode: forwards;
      }
      #${OVERLAY_ID} .dm.top {
        left: 50%;
        top: 0;
        transform: translateX(-50%);
      }
      #${OVERLAY_ID} .dm.bottom {
        left: 50%;
        bottom: 0;
        transform: translateX(-50%);
      }
      #${OVERLAY_ID}.paused .dm { animation-play-state: paused !important; }
      @keyframes dmroll {
        from { transform: translateX(0); }
        to { transform: translateX(calc(-1 * var(--dm-distance))); }
      }
      #${MATCH_BTN_ID}:hover { border-left-color: #9df0d6; color: #9df0d6; }
      #${MATCH_CARD_ID} input:focus { border-color: #6ed9b8 !important; }
      #${MATCH_CARD_ID} .dmc-list::-webkit-scrollbar { width: 6px; }
      #${MATCH_CARD_ID} .dmc-list::-webkit-scrollbar-thumb { background: #3b4448; border-radius: 3px; }
      #${TOAST_ID} {
        position: fixed;
        z-index: 2147483647;
        left: 50%;
        top: 22px;
        transform: translateX(-50%) translateY(-8px);
        max-width: min(520px, 84vw);
        padding: 9px 14px;
        border: 1px solid #3b4448;
        border-left: 3px solid #6ed9b8;
        border-radius: 2px;
        background: #14181a;
        color: #f2f0e9;
        font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
        letter-spacing: 0.03em;
        box-shadow: 0 6px 20px rgba(0,0,0,0.45);
        opacity: 0;
        pointer-events: none;
        transition: opacity 180ms ease, transform 180ms ease;
      }
      #${TOAST_ID}.show { opacity: 1; transform: translateX(-50%) translateY(0); }
    `;
    document.head.appendChild(style);
  }

  function isReplacedElement(el) {
    return /^(VIDEO|AUDIO|IMG|CANVAS|INPUT|TEXTAREA|SELECT|IFRAME|EMBED|OBJECT)$/.test(el.tagName);
  }

  function mountOverlay() {
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = OVERLAY_ID;
      applyStyle();
    }
    const fs = document.fullscreenElement;
    lastFullscreenEl = fs;
    if (fs && isReplacedElement(fs)) {
      // 全屏元素本身无法承载可见子节点（如直接对 video 全屏），
      // 改用 popover 把弹幕层提升到 top layer 覆盖在视频之上。
      if (!overlay.hasAttribute("popover")) overlay.setAttribute("popover", "manual");
      try {
        if (!overlay.matches(":popover-open")) overlay.showPopover();
      } catch (e) {}
      if (overlay.parentElement !== document.documentElement) {
        document.documentElement.appendChild(overlay);
      }
    } else {
      try {
        if (overlay.matches(":popover-open")) overlay.hidePopover();
      } catch (e) {}
      if (overlay.hasAttribute("popover")) overlay.removeAttribute("popover");
      const parent = fs || document.documentElement;
      if (overlay.parentElement !== parent) parent.appendChild(overlay);
    }
    updateOverlayRect();
    requestAnimationFrame(() => updateOverlayRect());
  }

  function applyStyle() {
    if (!overlay || !config || !config.style) return;
    const s = config.style;
    overlay.style.opacity = String(s.opacity ?? 0.9);
    overlay.style.fontSize = `${s.fontSize || 25}px`;
    overlay.style.color = s.color || "#ffffff";
  }

  function updateOverlayRect() {
    if (!overlay || !video) return;
    const r = video.getBoundingClientRect();
    if (!r.width || !r.height) return;
    overlay.style.left = `${r.left}px`;
    overlay.style.top = `${r.top}px`;
    overlay.style.width = `${r.width}px`;
    overlay.style.height = `${r.height}px`;

    // 弹幕层处在带 transform / filter 的祖先内时，fixed 参照系会整体偏移，
    // 用实际渲染矩形反推偏差并就地修正，确保始终精确贴合视频容器。
    const actual = overlay.getBoundingClientRect();
    const dx = r.left - actual.left;
    const dy = r.top - actual.top;
    if (Math.abs(dx) > 0.5) overlay.style.left = `${r.left + dx}px`;
    if (Math.abs(dy) > 0.5) overlay.style.top = `${r.top + dy}px`;
  }

  function setPaused(paused) {
    if (!overlay) return;
    dmPaused = !!paused;
    overlay.classList.toggle("paused", dmPaused);
    for (const [el, state] of dmTimers) {
      if (dmPaused) {
        if (state.timer) {
          clearTimeout(state.timer);
          state.timer = null;
          state.remaining = Math.max(0, state.total - (Date.now() - state.startedAt));
        }
      } else if (!state.timer) {
        state.startedAt = Date.now();
        state.timer = setTimeout(() => {
          dmTimers.delete(el);
          el.remove();
        }, state.remaining);
      }
    }
  }

  function scheduleRemoval(el, total, remaining = total) {
    const state = { timer: null, total, startedAt: 0, remaining };
    dmTimers.set(el, state);
    if (!dmPaused) {
      state.startedAt = Date.now();
      state.timer = setTimeout(() => {
        dmTimers.delete(el);
        el.remove();
      }, remaining);
    }
  }

  function clearDanmuTimers() {
    for (const [, state] of dmTimers) {
      if (state.timer) clearTimeout(state.timer);
    }
    dmTimers.clear();
  }

  function loadComments(list) {
    clearDanmu();
    comments = (list || [])
      .slice()
      .sort((a, b) => a.time - b.time);
    emitted = 0;
    lastTime = video ? video.currentTime || 0 : 0;
  }

  function clearDanmu() {
    clearDanmuTimers();
    comments = [];
    currentEpisode = "";
    emitted = 0;
    laneCursor = 0;
    if (overlay) overlay.innerHTML = "";
  }

  function resetDanmu() {
    if (!overlay) return;
    clearDanmuTimers();
    overlay.innerHTML = "";
    laneCursor = 0;
    const t = video ? video.currentTime || 0 : 0;
    emitted = lowerBound(comments, t);
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
    if (!comments.length) return;
    if (video.paused || video.ended) return;

    const t = video.currentTime || 0;
    if (t < lastTime - 0.5) resetDanmu();
    lastTime = t;

    while (emitted < comments.length && comments[emitted].time <= t) {
      spawn(comments[emitted]);
      emitted++;
    }
  }

  function spawn(comment) {
    const el = document.createElement("div");
    const mode = Number(comment.mode) || 1;
    el.className = `dm ${mode === 4 || mode === "bottom" ? "bottom" : mode === 5 || mode === "top" ? "top" : "roll"}`;
    el.textContent = comment.text || "";
    el.style.color = comment.color || config.style.color || "#ffffff";
    el.style.fontSize = `${comment.fontSize || config.style.fontSize || 25}px`;
    overlay.appendChild(el);

    const duration = Math.max(3, Number(config.style.speed) || 8);
    el.style.animationDuration = `${duration}s`;

    if (el.classList.contains("roll")) {
      const h = el.offsetHeight || 30;
      const laneHeight = h + 6;
      const maxLanes = Math.max(
        1,
        Math.floor((overlay.clientHeight || 720) / laneHeight) || config.style.maxLines || 8
      );
      const lane = laneCursor % maxLanes;
      laneCursor++;
      el.style.top = `${lane * laneHeight}px`;
      const distance = (overlay.clientWidth || 1280) + el.offsetWidth;
      el.style.setProperty("--dm-distance", `${distance}px`);
    }

    scheduleRemoval(el, duration * 1000 + 200);
  }
})();

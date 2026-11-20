const $ = (id) => document.getElementById(id);

let config = null;
let dirty = false;
let editingIndex = -1;
let flashIndex = -1;

document.addEventListener("DOMContentLoaded", async () => {
  bind();
  await load();
  applyAddParam();
});

function applyAddParam() {
  const params = new URLSearchParams(location.search);
  const pattern = params.get("add");
  if (!pattern) return;

  openDialog(-1);
  $("ruleName").value = params.get("name") || hostFromPattern(pattern) || "";
  $("rulePatterns").value = pattern;
  $("ruleSelectors").value = [
    "h1",
    "h2",
    "[class*='title']",
    "[class*='name']",
    "meta[property='og:title']",
    "meta[name='title']"
  ].join("\n");
  $("ruleEnabled").checked = true;
  $("ruleAutoFill").checked = true;
  $("ruleAutoLoad").checked = true;
  setStatus("已带入当前网站的网址规则，确认后保存。", "success");
}

function hostFromPattern(pattern) {
  const m = String(pattern || "").match(/^(\*|https?):\/\/([^/]+)\//);
  return m ? m[2] : "";
}

function bind() {
  for (const id of ["apiBase", "cacheTTL", "fontSize", "color", "opacity", "speed", "maxLines"]) {
    $(id).addEventListener("input", markDirty);
  }
  $("addRule").addEventListener("click", () => openDialog(-1));
  $("save").addEventListener("click", save);
  $("reset").addEventListener("click", reset);
  $("dialogClose").addEventListener("click", closeDialog);
  $("dialogCancel").addEventListener("click", closeDialog);
  $("dialogSave").addEventListener("click", saveRule);
  $("ruleDialog").addEventListener("cancel", (e) => {
    e.preventDefault();
    closeDialog();
  });
}

async function load() {
  try {
    const res = await chrome.runtime.sendMessage({ type: "GET_CONFIG" });
    if (!res || !res.ok) {
      setStatus(res?.error || "读取配置失败", "error");
      showRulesMessage("配置读取失败，请重新加载页面");
      return;
    }
    config = JSON.parse(JSON.stringify(res.config));
    if (!Array.isArray(config.rules)) config.rules = [];
    fillFields();
    renderRules();
    dirty = false;
    updateDirty();
    setStatus("");
  } catch (e) {
    setStatus(e.message || String(e), "error");
    showRulesMessage("配置读取失败，请重新加载页面");
  }
}

function fillFields() {
  $("apiBase").value = config.apiBase || "";
  $("cacheTTL").value = config.cacheTTL ?? 300000;
  const s = config.style || {};
  $("fontSize").value = s.fontSize ?? 25;
  $("color").value = s.color || "#ffffff";
  $("opacity").value = s.opacity ?? 0.9;
  $("speed").value = s.speed ?? 8;
  $("maxLines").value = s.maxLines ?? 8;
}

function showRulesMessage(text) {
  const tbody = $("ruleRows");
  tbody.innerHTML = "";
  const tr = document.createElement("tr");
  const td = document.createElement("td");
  td.colSpan = 8;
  td.className = "empty";
  td.textContent = text;
  tr.appendChild(td);
  tbody.appendChild(tr);
}

function renderRules() {
  const tbody = $("ruleRows");
  tbody.innerHTML = "";
  if (!Array.isArray(config?.rules)) {
    showRulesMessage("规则数据格式异常，请恢复默认配置");
    return;
  }
  if (!config.rules.length) {
    showRulesMessage("还没有规则。点「+ 新增规则」开始。");
    return;
  }

  config.rules.forEach((rule, index) => {
    const tr = document.createElement("tr");
    if (index === flashIndex) tr.className = "flash";

    const tdEnabled = addCell(tr);
    const enabled = document.createElement("input");
    enabled.type = "checkbox";
    enabled.checked = rule.enabled !== false;
    enabled.addEventListener("change", () => {
      rule.enabled = enabled.checked;
      markDirty();
    });
    tdEnabled.appendChild(enabled);

    addCell(tr, "name").textContent = rule.name || "(未命名)";

    const tdId = addCell(tr);
    const idCode = document.createElement("code");
    idCode.textContent = rule.id || "";
    tdId.appendChild(idCode);

    const tdPatterns = addCell(tr);
    const patterns = document.createElement("code");
    patterns.className = "pattern";
    patterns.style.whiteSpace = "pre-line";
    patterns.textContent = (rule.patterns || []).join("\n") || "—";
    tdPatterns.appendChild(patterns);

    const tdSelectors = addCell(tr);
    const selectors = rule.titleSelectors || [];
    const selectorCode = document.createElement("code");
    selectorCode.textContent = selectors.length
      ? `${selectors[0]}${selectors.length > 1 ? ` +${selectors.length - 1}` : ""}`
      : "—";
    selectorCode.title = selectors.join("\n");
    tdSelectors.appendChild(selectorCode);

    addCell(tr, rule.autoFill !== false ? "yes" : "no").textContent = rule.autoFill !== false ? "是" : "—";
    addCell(tr, rule.autoLoad ? "yes" : "no").textContent = rule.autoLoad ? "是" : "—";

    const tdActions = addCell(tr);
    const actions = document.createElement("div");
    actions.className = "row-actions";

    const edit = document.createElement("button");
    edit.className = "link";
    edit.textContent = "编辑";
    edit.addEventListener("click", () => openDialog(index));

    const del = document.createElement("button");
    del.className = "link danger";
    del.textContent = "删除";
    del.addEventListener("click", async () => {
      if (!confirm(`删除规则「${rule.name || rule.id}」？`)) return;
      config.rules.splice(index, 1);
      renderRules();
      await save();
      if ($("status").classList.contains("success")) setStatus("规则已删除并保存", "success");
    });

    actions.appendChild(edit);
    actions.appendChild(del);
    tdActions.appendChild(actions);

    tbody.appendChild(tr);
  });

  flashIndex = -1;
}

function addCell(tr, className) {
  const td = document.createElement("td");
  if (className) td.className = className;
  tr.appendChild(td);
  return td;
}

function openDialog(index) {
  editingIndex = index;
  const rule =
    index >= 0
      ? config.rules[index]
      : { id: "", name: "", patterns: [], titleSelectors: [], enabled: true, autoFill: true, autoLoad: true };

  $("dialogTitle").textContent = index >= 0 ? "编辑规则" : "新增规则";
  $("dialogSave").textContent = index >= 0 ? "更新并保存" : "添加并保存";
  $("ruleName").value = rule.name || "";
  $("ruleId").value = rule.id || "";
  $("rulePatterns").value = (rule.patterns || []).join("\n");
  $("ruleSelectors").value = (rule.titleSelectors || []).join("\n");
  $("ruleEnabled").checked = rule.enabled !== false;
  $("ruleAutoFill").checked = rule.autoFill !== false;
  $("ruleAutoLoad").checked = !!rule.autoLoad;
  if (!$("ruleDialog").open) $("ruleDialog").showModal();
}

function closeDialog() {
  if ($("ruleDialog").open) $("ruleDialog").close();
}

async function saveRule() {
  if (!config || !Array.isArray(config.rules)) {
    setStatus("配置尚未加载完成，请稍后再试", "error");
    return;
  }
  const wasEdit = editingIndex >= 0;
  const name = $("ruleName").value.trim();
  if (!name) {
    setStatus("请填写规则名称", "error");
    return;
  }
  const patterns = lines($("rulePatterns").value);
  if (!patterns.length) {
    setStatus("至少填写一条网址模式", "error");
    return;
  }
  for (const pattern of patterns) {
    if (!validPattern(pattern)) {
      setStatus(`无效的网址模式：${pattern}`, "error");
      return;
    }
  }

  let id = $("ruleId").value.trim() || slugify(name);
  if (config.rules.some((r, i) => i !== editingIndex && r.id === id)) {
    setStatus(`规则 ID 已存在：${id}`, "error");
    return;
  }

  const rule = {
    id,
    name,
    patterns,
    titleSelectors: lines($("ruleSelectors").value),
    enabled: $("ruleEnabled").checked,
    autoFill: $("ruleAutoFill").checked,
    autoLoad: $("ruleAutoLoad").checked
  };

  if (editingIndex >= 0) {
    config.rules[editingIndex] = rule;
    flashIndex = editingIndex;
  } else {
    config.rules.push(rule);
    flashIndex = config.rules.length - 1;
  }

  renderRules();
  closeDialog();
  await save();
  if ($("status").classList.contains("success")) {
    setStatus(wasEdit ? "规则已更新并保存" : "规则已添加并保存", "success");
  }
}

function lines(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function validPattern(pattern) {
  return /^(\*|https?):\/\/[^/]+\/.*$/.test(pattern);
}

function slugify(name) {
  const base = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || `rule-${Date.now().toString(36)}`;
}

function collectConfig() {
  return {
    ...config,
    apiBase: $("apiBase").value.trim().replace(/\/+$/, ""),
    cacheTTL: Number($("cacheTTL").value) || 300000,
    rules: config.rules.map((r) => ({ ...r })),
    style: {
      fontSize: Number($("fontSize").value) || 25,
      color: $("color").value.trim() || "#ffffff",
      opacity: Number($("opacity").value) || 0.9,
      speed: Number($("speed").value) || 8,
      maxLines: Number($("maxLines").value) || 8
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

async function save() {
  try {
    const cfg = collectConfig();
    validateConfig(cfg);

    const origins = collectOrigins(cfg);
    if (origins.length) {
      const granted = await chrome.permissions.request({ origins });
      if (!granted) throw new Error("未授予站点权限，规则无法生效");
    }

    const res = await chrome.runtime.sendMessage({ type: "SAVE_CONFIG", config: cfg });
    if (!res || !res.ok) throw new Error(res?.error || "保存失败");

    config = cfg;
    dirty = false;
    updateDirty();
    renderRules();
    setStatus("已保存并生效", "success");
  } catch (e) {
    setStatus(e.message || String(e), "error");
  }
}

async function reset() {
  try {
    const res = await chrome.runtime.sendMessage({ type: "RESET_CONFIG" });
    if (!res || !res.ok) throw new Error(res?.error || "恢复失败");
    await load();
    setStatus("已恢复默认配置", "success");
  } catch (e) {
    setStatus(e.message || String(e), "error");
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

function markDirty() {
  dirty = true;
  updateDirty();
}

function updateDirty() {
  $("dirtyFlag").textContent = dirty ? "· 未保存" : "";
}

function setStatus(text, type = "") {
  const el = $("status");
  el.textContent = text || "";
  el.className = type;
}

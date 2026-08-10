(function () {
  "use strict";

  const LANG_FILES = {
    "zh-CN": "/public/prompts/zh-CN.txt",
    "zh-TW": "/public/prompts/zh-TW.txt",
    en: "/public/prompts/en.txt",
    th: "/public/prompts/th.txt",
  };

  const I18N = {
    "zh-CN": {
      previewLabel: "文案预览",
      charCount: (n) => `${n} 字符`,
      placeholder: "点击「随机文案」生成内容",
      randomBtn: "随机文案",
      tweetBtn: "一键发推",
      themeToggle: "◐ 切换主题",
      createdByBefore: "由 ",
      createdByAfter: " 创建",
    },
    "zh-TW": {
      previewLabel: "文案預覽",
      charCount: (n) => `${n} 字元`,
      placeholder: "點擊「隨機文案」生成內容",
      randomBtn: "隨機文案",
      tweetBtn: "一鍵發推",
      themeToggle: "◐ 切換主題",
      createdByBefore: "由 ",
      createdByAfter: " 創建",
    },
    en: {
      previewLabel: "Edit Preview",
      charCount: (n) => `${n} chars`,
      placeholder: 'Click "Random" to generate',
      randomBtn: "Random",
      tweetBtn: "Post Tweet",
      themeToggle: "◐ Toggle theme",
      createdByBefore: "Created by ",
      createdByAfter: "",
    },
    th: {
      previewLabel: "แก้ไขข้อความ",
      charCount: (n) => `${n} ตัวอักษร`,
      placeholder: 'กด "สุ่มข้อความ" เพื่อสร้าง',
      randomBtn: "สุ่มข้อความ",
      tweetBtn: "โพสต์ทวีต",
      themeToggle: "◐ สลับธีม",
      createdByBefore: "สร้างโดย ",
      createdByAfter: "",
    },
  };

  const promptCache = new Map();
  const CONFIG_POLL_MS = 2000;

  let CONFIG = { keywords: "", hashtags: "" };
  let lastRandomLine = null;
  let previewIsGenerated = false;
  let currentLang = "zh-CN";

  const $ = (id) => document.getElementById(id);

  const preview = $("preview");
  const charCount = $("char-count");
  const btnRandom = $("btn-random");
  const btnTweet = $("btn-tweet");
  const iconRefresh = $("icon-refresh");
  const langTabs = $("lang-tabs");

  const graphemeSegmenter = typeof Intl !== "undefined" && Intl.Segmenter
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

  /** Normalize line endings so each physical Enter counts as one `\n`. */
  function normalizeTweetText(text) {
    return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  }

  /**
   * Match X/Twitter weighted character rules:
   * - Each newline (`\n`) = 1 character
   * - Most emoji graphemes = 2 characters
   * - Other graphemes = 1 character
   */
  function countTwitterChars(text) {
    const normalized = normalizeTweetText(text);
    if (!normalized) return 0;

    if (!graphemeSegmenter) {
      return normalized.length;
    }

    let count = 0;
    for (const { segment } of graphemeSegmenter.segment(normalized)) {
      if (segment === "\n") {
        count += 1;
      } else if (/\p{Extended_Pictographic}/u.test(segment)) {
        count += 2;
      } else {
        count += 1;
      }
    }
    return count;
  }

  function getPreviewText() {
    return preview.value.trim();
  }

  function formatHashtags(raw) {
    return raw
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .join("\n");
  }

  function syncPreviewState() {
    btnTweet.disabled = getPreviewText().length === 0;
    updateCharCount();
  }

  function t(key, ...args) {
    const entry = I18N[currentLang][key];
    return typeof entry === "function" ? entry(...args) : entry;
  }

  function applyI18n(lang) {
    currentLang = lang;
    $("preview-label").textContent = t("previewLabel");
    $("btn-random-label").textContent = t("randomBtn");
    $("btn-tweet-label").textContent = t("tweetBtn");
    $("theme-toggle").textContent = t("themeToggle");
    $("created-by-before").textContent = t("createdByBefore");
    $("created-by-after").textContent = t("createdByAfter");
    preview.placeholder = t("placeholder");
    preview.setAttribute("lang", lang);
    document.body.dataset.uiLang = lang;
    syncPreviewState();
  }

  function updateCharCount() {
    charCount.textContent = t("charCount", countTwitterChars(preview.value));
  }

  function setPreview(text) {
    preview.value = text;
    syncPreviewState();
  }

  async function loadPrompts(lang) {
    if (promptCache.has(lang)) {
      return promptCache.get(lang);
    }

    const url = LANG_FILES[lang];
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to load prompts: ${url}`);
    }

    const text = await res.text();
    const lines = text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    promptCache.set(lang, lines);
    return lines;
  }

  function pickRandom(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  function parseConfig(text) {
    const read = (key) =>
      text.match(new RegExp(`${key}:\\s*"((?:\\\\.|[^"\\\\])*)"`))?.[1] ?? "";
    const unescape = (s) =>
      s
        .replace(/\\\\/g, "\\")
        .replace(/\\"/g, '"')
        .replace(/\\r/g, "\r")
        .replace(/\\n/g, "\n")
        .replace(/\\t/g, "\t");

    return {
      keywords: unescape(read("keywords")),
      hashtags: unescape(read("hashtags")),
    };
  }

  function configSignature(cfg) {
    return `${cfg.keywords}\0${cfg.hashtags}`;
  }

  async function loadConfig() {
    const res = await fetch(`/config.js?_=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) {
      throw new Error("Failed to load config.js");
    }
    return parseConfig(await res.text());
  }

  async function refreshConfig() {
    try {
      const next = await loadConfig();
      const changed = configSignature(next) !== configSignature(CONFIG);
      CONFIG = next;

      if (changed && previewIsGenerated && lastRandomLine) {
        setPreview(buildTweet(lastRandomLine));
      }

      return changed;
    } catch (err) {
      console.error(err);
      return false;
    }
  }

  function buildTweet(randomLine) {
    const parts = [randomLine];
    const tailParts = [];

    if (CONFIG.keywords) {
      tailParts.push(CONFIG.keywords);
    }

    if (CONFIG.hashtags) {
      tailParts.push(formatHashtags(CONFIG.hashtags));
    }

    if (tailParts.length) {
      parts.push(tailParts.join("\n"));
    }

    return parts.join("\n\n");
  }

  async function generateRandomTweet() {
    iconRefresh.classList.add("spin-once");
    iconRefresh.addEventListener(
      "animationend",
      () => iconRefresh.classList.remove("spin-once"),
      { once: true }
    );

    btnRandom.disabled = true;
    try {
      const lines = await loadPrompts(currentLang);
      if (!lines.length) {
        setPreview("");
        return;
      }
      const line = pickRandom(lines);
      lastRandomLine = line;
      previewIsGenerated = true;
      setPreview(buildTweet(line));
    } catch (err) {
      console.error(err);
      lastRandomLine = null;
      previewIsGenerated = false;
      setPreview(`⚠ ${err.message}`);
    } finally {
      btnRandom.disabled = false;
    }
  }

  function postTweet() {
    const text = getPreviewText();
    if (!text) return;
    const url = `https://twitter.com/intent/tweet?text=${encodeURIComponent(normalizeTweetText(preview.value).trim())}`;
    window.open(url, "_blank", "noopener,noreferrer");
  }

  function switchLang(lang) {
    if (lang === currentLang) return;

    langTabs.querySelectorAll("[data-lang]").forEach((tab) => {
      tab.classList.toggle("active", tab.dataset.lang === lang);
    });

    applyI18n(lang);
    lastRandomLine = null;
    previewIsGenerated = false;
    setPreview("");
  }

  function initTheme() {
    const saved = localStorage.getItem("trendx-theme");
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const isDark = saved ? saved === "dark" : prefersDark;
    document.documentElement.classList.toggle("dark", isDark);
  }

  function toggleTheme() {
    const isDark = document.documentElement.classList.toggle("dark");
    localStorage.setItem("trendx-theme", isDark ? "dark" : "light");
  }

  btnRandom.addEventListener("click", generateRandomTweet);
  btnTweet.addEventListener("click", postTweet);
  preview.addEventListener("input", () => {
    previewIsGenerated = false;
    syncPreviewState();
  });
  $("theme-toggle").addEventListener("click", toggleTheme);

  langTabs.addEventListener("click", (e) => {
    const tab = e.target.closest("[data-lang]");
    if (tab) switchLang(tab.dataset.lang);
  });

  async function init() {
    initTheme();
    applyI18n(currentLang);
    await refreshConfig();
    setInterval(refreshConfig, CONFIG_POLL_MS);
    window.addEventListener("focus", refreshConfig);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        refreshConfig();
      }
    });
  }

  init();
})();

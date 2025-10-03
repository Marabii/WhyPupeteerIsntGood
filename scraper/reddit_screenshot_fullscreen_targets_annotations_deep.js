// reddit_screenshot_fullscreen_targets_annotations_deep.js
// Puppeteer v22+ compatible — Home (feed) → Post (comments) workflow with COCO output + comment interaction

const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

const { deepQueryAll, deepQueryVisible } = require("./deepQuery");
const { CocoWriter } = require("./coco");

const CONFIG_PATH = path.resolve(process.cwd(), "config.json");
let runState = "idle"; // "idle" | "running" | "paused" | "stopped"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms, j = 25) =>
  sleep(Math.max(0, ms + Math.round((Math.random() * 2 - 1) * j)));
const toSafe = (s) =>
  String(s)
    .replace(/[^\w.-]+/g, "_")
    .slice(0, 120);

// -------- Config loading & validation (NEW SCHEMA) --------
function mustArray(x, name) {
  return Array.isArray(x) && x.length > 0
    ? true
    : (console.error(`❌ config.json: non-empty "${name}" is required.`),
      process.exit(1));
}
function loadConfigOrCrash() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`❌ Missing config file at ${CONFIG_PATH}`);
    process.exit(1);
  }
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch (e) {
    console.error("❌ Failed to parse config.json:", e.message);
    process.exit(1);
  }

  if (!cfg.home || !cfg.post) {
    console.error("❌ config.json must include both 'home' and 'post' blocks.");
    process.exit(1);
  }
  mustArray(cfg.home.targets, "home.targets");
  mustArray(cfg.post.targets, "post.targets");
  mustArray(cfg.post.annotations, "post.annotations");

  // home.annotations may be empty (optional), but if present validate shape
  const validateAnno = (arr, label) => {
    if (!arr) return;
    const bad = arr.find(
      (p) => !Array.isArray(p) || p.length !== 2 || !p[0] || !p[1]
    );
    if (bad) {
      console.error(
        `❌ Each entry in "${label}" must be [cssSelector, category].`
      );
      process.exit(1);
    }
  };
  validateAnno(cfg.home.annotations, "home.annotations");
  validateAnno(cfg.post.annotations, "post.annotations");

  // open settings
  cfg.home.open = cfg.home.open || {};
  if (!cfg.home.open.selector) {
    cfg.home.open.selector =
      "a[data-click-id='comments'], a[href*='/comments/']";
  }
  if (typeof cfg.home.open.openInNewTab !== "boolean")
    cfg.home.open.openInNewTab = true;
  if (!cfg.home.open.waitUntil)
    cfg.home.open.waitUntil = cfg.waitUntil || "domcontentloaded";
  if (!Number.isFinite(cfg.home.open.stabilizationMs))
    cfg.home.open.stabilizationMs = 800;

  // infinite scroll defaults
  const setInfDefaults = (obj) => {
    obj.infiniteScroll = obj.infiniteScroll || {};
    if (typeof obj.infiniteScroll.enabled !== "boolean")
      obj.infiniteScroll.enabled = true;
    if (!Number.isFinite(obj.infiniteScroll.stableRounds))
      obj.infiniteScroll.stableRounds = 6;
    if (!Number.isFinite(obj.infiniteScroll.step))
      obj.infiniteScroll.step = 1.0; // viewport heights
    if (!Number.isFinite(obj.infiniteScroll.sleepMs))
      obj.infiniteScroll.sleepMs = 350;
  };
  setInfDefaults(cfg.home);
  setInfDefaults(cfg.post);

  // caps
  if (!Number.isFinite(cfg.home.maxPerTarget)) cfg.home.maxPerTarget = 10; // max posts to open from feed
  if (!Number.isFinite(cfg.post.maxShotsPerPost)) cfg.post.maxShotsPerPost = 6; // screenshots per post page

  // interactions defaults
  if (!cfg.post.interactions) cfg.post.interactions = {};
  if (!cfg.post.interactions.comment) {
    cfg.post.interactions.comment = {
      componentSelectors: ["shreddit-comment"],
      buttonSelector: "svg[icon-name='comment-outline']",
      composerSelector: "comment-composer-host",
      timeoutMs: 5000,
    };
  }

  return cfg;
}

function buildCategoryColors(categories, overrides = {}) {
  const palette = [
    "#ff4d4f",
    "#36cfc9",
    "#9254de",
    "#69c0ff",
    "#73d13d",
    "#faad14",
    "#eb2f96",
    "#13c2c2",
    "#52c41a",
    "#2f54eb",
  ];
  const map = new Map();
  let p = 0;
  for (const cat of categories) {
    if (overrides && overrides[cat]) map.set(cat, overrides[cat]);
    else if (p < palette.length) map.set(cat, palette[p++]);
    else {
      const h =
        Math.abs([...cat].reduce((a, c) => a * 33 + c.charCodeAt(0), 7)) % 360;
      map.set(cat, `hsl(${h} 85% 55%)`);
    }
  }
  return map;
}

// ----- Outline helpers -----
async function setOutline(el, css, category) {
  await el.evaluate(
    (node, css, category) => {
      node.__oldOutline = node.style.outline;
      node.style.outline = css;
      node.style.outlineOffset = "0px";
      try {
        node.setAttribute("data-coco-cat", category || "");
      } catch {}
    },
    css,
    category
  );
}
async function clearOutline(el) {
  await el.evaluate((node) => {
    node.style.outline = "none";
  });
}
async function restoreOutline(el) {
  await el.evaluate((node) => {
    node.style.outline = node.__oldOutline || "";
    delete node.__oldOutline;
  });
}
async function paintSync(page) {
  await page.evaluate(() => {
    void document.documentElement.offsetHeight;
    return new Promise(requestAnimationFrame);
  });
}
async function centerElement(el) {
  await el.evaluate((node) => {
    const r = node.getBoundingClientRect();
    const targetY =
      window.scrollY + r.top + r.height / 2 - window.innerHeight / 2;
    window.scrollTo({ top: Math.max(0, targetY), behavior: "instant" });
  });
}

// ----- Utility: visible descendants within a component (with pierce/ fallback) -----
async function queryVisibleWithin(rootEl, selector) {
  let list = [];
  try {
    list = await rootEl.$$(selector);
  } catch {}
  if (!list.length) {
    try {
      list = await rootEl.$$(`pierce/${selector}`);
    } catch {}
  }
  const filtered = [];
  for (const h of list) {
    const ok = await h
      .evaluate((node) => {
        const s = getComputedStyle(node);
        if (
          s.display === "none" ||
          s.visibility === "hidden" ||
          s.opacity === "0"
        )
          return false;
        const r = node.getBoundingClientRect();
        return (
          r.bottom > 0 &&
          r.right > 0 &&
          r.top < innerHeight &&
          r.left < innerWidth
        );
      })
      .catch(() => false);
    if (ok) filtered.push(h);
    else {
      try {
        await h.dispose();
      } catch {}
    }
  }
  return filtered;
}

// ----- Collect post links from home feed -----
async function extractLinkFromTargetHandle(page, el, openSelector) {
  const href = await el.evaluate((node, sel) => {
    function findIn(node, sel) {
      try {
        const cand = node.querySelector(sel);
        if (cand && cand.href) return cand.href;
      } catch {}
      return null;
    }
    const direct = findIn(node, sel);
    if (direct) return direct;
    const alt = node.querySelector("a[href*='/comments/']");
    if (alt && alt.href) return alt.href;
    const any = node.querySelector("a[href]");
    return any?.href || null;
  }, openSelector);
  return href;
}

async function infiniteScrollCollectLinks(
  page,
  selectors,
  { includeIframes, maxCount, stepVH, sleepMs, stableRounds, openSelector }
) {
  const urls = new Set();

  const harvest = async () => {
    for (const sel of selectors) {
      let els = await deepQueryAll(page, sel, { includeIframes }).catch(
        () => []
      );
      if (!els.length) {
        try {
          els = await page.$$(`pierce/${sel}`);
        } catch {}
      }
      for (const el of els) {
        const href = await extractLinkFromTargetHandle(
          page,
          el,
          openSelector
        ).catch(() => null);
        if (href) urls.add(href);
        try {
          await el.dispose();
        } catch {}
      }
    }
  };

  await harvest();
  let stable = 0;
  while (urls.size < maxCount && stable < stableRounds) {
    while (runState === "paused") {
      await sleep(200);
    }
    if (runState === "stopped") {
      console.log("🛑 Stopped by user");
      return Array.from(urls);
    }

    await page.evaluate(
      (vh) => window.scrollBy(0, window.innerHeight * vh),
      stepVH
    );
    await sleep(sleepMs);
    const before = urls.size;
    await harvest();
    if (urls.size > before) stable = 0;
    else stable += 1;
  }

  return Array.from(urls).slice(0, maxCount);
}

// ----- One capture cycle (show outlines → compute COCO bboxes → screenshot → COCO add) -----
async function captureCycle({
  page,
  pageLabel,
  shotIndex,
  annotations,
  includeIframes,
  outlineStyles,
  keepOutlines,
  delayMs,
  outputDir,
  coco,
}) {
  const OUTLINE_WIDTH = outlineStyles.width;
  const OUTLINE_STYLE = outlineStyles.style;
  const colorMap = outlineStyles.colorMap;

  // Gather visible annotation elements
  const annotationHandles = [];
  const annotationCssByHandle = new Map();
  const annotationCatByHandle = new Map();

  for (const [annSelector, category] of annotations) {
    const color = colorMap.get(category);
    const css = `${OUTLINE_WIDTH} ${OUTLINE_STYLE} ${color}`;

    let vis = await deepQueryVisible(page, annSelector, {
      includeIframes,
    }).catch(() => []);
    if (!vis.length) {
      try {
        const all = await page.$$(`pierce/${annSelector}`);
        const filtered = [];
        for (const h of all) {
          const isVis = await h
            .evaluate((node) => {
              const s = getComputedStyle(node);
              if (
                s.display === "none" ||
                s.visibility === "hidden" ||
                s.opacity === "0"
              )
                return false;
              const r = node.getBoundingClientRect();
              return (
                r.bottom > 0 &&
                r.right > 0 &&
                r.top < innerHeight &&
                r.left < innerWidth
              );
            })
            .catch(() => false);
          if (isVis) filtered.push(h);
          else {
            try {
              await h.dispose();
            } catch {}
          }
        }
        vis = filtered;
      } catch {}
    }

    for (const h of vis) {
      annotationHandles.push(h);
      annotationCssByHandle.set(h, css);
      annotationCatByHandle.set(h, category);
    }
  }

  // Preview outlines
  for (const h of annotationHandles) {
    const css = annotationCssByHandle.get(h);
    const cat = annotationCatByHandle.get(h);
    try {
      await setOutline(h, css, cat);
    } catch {}
  }
  await paintSync(page);
  await jitter(delayMs);

  // Compute bboxes
  const { dpr, vw, vh } = await page.evaluate(() => ({
    dpr: window.devicePixelRatio || 1,
    vw: window.innerWidth,
    vh: window.innerHeight,
  }));
  const clipToViewport = (r, vw, vh) => {
    const x1 = Math.max(0, Math.min(vw, r.left));
    const y1 = Math.max(0, Math.min(vh, r.top));
    const x2 = Math.max(0, Math.min(vw, r.right));
    const y2 = Math.max(0, Math.min(vh, r.bottom));
    const w = Math.max(0, x2 - x1);
    const h = Math.max(0, y2 - y1);
    return { x: x1, y: y1, w, h };
  };

  const cocoBoxes = [];
  for (const h of annotationHandles) {
    const cat = annotationCatByHandle.get(h);
    if (!cat) continue;
    const rect = await h.evaluate((node) => {
      const r = node.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    });
    const c = clipToViewport(rect, vw, vh);
    if (c.w > 0 && c.h > 0) {
      cocoBoxes.push({
        cat,
        bboxPx: [c.x * dpr, c.y * dpr, c.w * dpr, c.h * dpr],
      });
    }
  }

  // Optionally clear outlines
  if (!keepOutlines) {
    for (const h of annotationHandles) {
      try {
        await clearOutline(h);
      } catch {}
    }
    await paintSync(page);
  }

  // Screenshot
  const filename = `${toSafe(pageLabel)}__${shotIndex}.png`;
  const filepath = path.join(outputDir, filename);
  await page.screenshot({ path: filepath, fullPage: false });
  console.log(`Saved: ${filepath}`);

  // Restore outlines if we cleared them
  if (!keepOutlines) {
    for (const h of annotationHandles) {
      try {
        await restoreOutline(h);
      } catch {}
    }
    await paintSync(page);
  }
  await jitter(delayMs);

  // COCO entries
  const dprNow = await page.evaluate(() => window.devicePixelRatio || 1);
  const vwNow = await page.evaluate(() => window.innerWidth);
  const vhNow = await page.evaluate(() => window.innerHeight);
  const imageId = coco.addImage({
    fileName: path.basename(filepath),
    width: Math.round(vwNow * dprNow),
    height: Math.round(vhNow * dprNow),
  });
  for (const b of cocoBoxes) {
    coco.addAnnotation({ imageId, categoryName: b.cat, bbox: b.bboxPx });
  }

  // Cleanup
  for (const h of annotationHandles) {
    try {
      await h.dispose();
    } catch {}
  }
}

// ----- Capture routine on a page (targets + annotations → screenshots + COCO) -----
async function captureOnPage({
  page,
  pageLabel, // "home" or "post_#"
  targets, // array of CSS selectors (drive scrolling)
  annotations, // array of [selector, category]
  maxShots, // total screenshots to take on this page
  infScroll, // {enabled, step, sleepMs, stableRounds}
  includeIframes,
  outlineStyles, // {width, style, colorMap}
  keepOutlines,
  delayMs,
  outputDir,
  coco,
  interactions = {}, // { comment: { componentSelectors[], buttonSelector, composerSelector, timeoutMs } }
}) {
  // Collect candidate target elements (with optional infinite scroll)
  let candidateEls = [];
  const collectOnce = async () => {
    const seen = new Set();
    const pushUnique = (arr) => {
      for (const e of arr) {
        if (!seen.has(e)) {
          seen.add(e);
          candidateEls.push(e);
        }
      }
    };
    for (const sel of targets) {
      let found = await deepQueryAll(page, sel, { includeIframes }).catch(
        () => []
      );
      if (!found.length) {
        try {
          found = await page.$$(`pierce/${sel}`);
        } catch {}
      }
      pushUnique(found);
    }
  };

  await collectOnce();
  let stable = 0;
  while (
    infScroll.enabled &&
    candidateEls.length < maxShots &&
    stable < infScroll.stableRounds
  ) {
    while (runState === "paused") {
      await sleep(200);
    }
    if (runState === "stopped") {
      console.log("🛑 Stopped by user");
      return;
    }

    await page.evaluate(
      (vh) => window.scrollBy(0, window.innerHeight * vh),
      infScroll.step
    );
    await sleep(infScroll.sleepMs);
    const before = candidateEls.length;
    candidateEls = [];
    await collectOnce();
    if (candidateEls.length > before) stable = 0;
    else stable += 1;
  }

  const take = Math.min(maxShots, candidateEls.length);
  let shotCounter = 0;

  for (let i = 0; i < take; i++) {
    while (runState === "paused") {
      await sleep(200);
    }
    if (runState === "stopped") {
      console.log("🛑 Stopped by user");
      return;
    }

    const targetEl = candidateEls[i];
    try {
      await centerElement(targetEl);

      // Determine if this target is a "comment component" we should interact with
      const commentCfg = interactions.comment;
      let isCommentComponent = false;
      if (commentCfg && Array.isArray(commentCfg.componentSelectors)) {
        try {
          isCommentComponent = await targetEl.evaluate((node, selectors) => {
            return selectors.some((sel) => {
              try {
                return node.matches(sel);
              } catch {
                return false;
              }
            });
          }, commentCfg.componentSelectors);
        } catch {
          isCommentComponent = false;
        }
      }

      if (isCommentComponent) {
        // 1) Normal capture
        shotCounter += 1;
        await captureCycle({
          page,
          pageLabel,
          shotIndex: shotCounter,
          annotations,
          includeIframes,
          outlineStyles,
          keepOutlines,
          delayMs,
          outputDir,
          coco,
        });

        // 2) Click the comment button inside the component, wait for composer, capture again
        try {
          const buttons = await queryVisibleWithin(
            targetEl,
            commentCfg.buttonSelector
          );
          if (buttons.length) {
            await buttons[0].click({ delay: 20 });
            // wait for composer within the same component
            const start = Date.now();
            let composerFound = false;
            while (Date.now() - start < (commentCfg.timeoutMs || 5000)) {
              const comp = await queryVisibleWithin(
                targetEl,
                commentCfg.composerSelector
              );
              if (comp.length) {
                composerFound = true;
                // dispose temp handles
                for (const h of comp) {
                  try {
                    await h.dispose();
                  } catch {}
                }
                break;
              }
              await sleep(150);
            }
            // even if not found, we still take the second capture to record the state
            shotCounter += 1;
            await captureCycle({
              page,
              pageLabel,
              shotIndex: shotCounter,
              annotations,
              includeIframes,
              outlineStyles,
              keepOutlines,
              delayMs,
              outputDir,
              coco,
            });
          } else {
            // No button found → just do a single normal capture (already done)
          }
        } catch (e) {
          console.warn("⚠️ Comment interaction failed:", e.message);
        }
      } else {
        // Regular target → one capture
        shotCounter += 1;
        await captureCycle({
          page,
          pageLabel,
          shotIndex: shotCounter,
          annotations,
          includeIframes,
          outlineStyles,
          keepOutlines,
          delayMs,
          outputDir,
          coco,
        });
      }

      // Cleanup
      try {
        await targetEl.dispose();
      } catch {}
    } catch (e) {
      console.warn("⚠️ Capture error on target:", e.message);
      try {
        await targetEl.dispose();
      } catch {}
    }
  }
}

// -------- Main orchestration --------
(async () => {
  const cfg = loadConfigOrCrash();

  // Global options
  const TARGET_URL = cfg.targetUrl || "https://www.reddit.com/";
  const OUT_DIR = path.resolve(process.cwd(), cfg.outputDir || "screenshots");
  const DELAY_MS = Number.isFinite(cfg.delayMs) ? Number(cfg.delayMs) : 50;
  const WAIT_UNTIL = cfg.waitUntil || "domcontentloaded";
  const FULLSCREEN = cfg.fullscreen !== false;
  const INCLUDE_IFRAMES = cfg.includeIframes !== false;
  const KEEP_OUTLINES = cfg.keepOutlinesInScreenshots === true;
  const PRE_SCROLL_VH = Number.isFinite(cfg.preScrollViewportHeights)
    ? Number(cfg.preScrollViewportHeights)
    : 0.8;

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  // Categories (union of home+post annotations)
  const homeCats = (cfg.home.annotations || []).map(([, c]) => c);
  const postCats = (cfg.post.annotations || []).map(([, c]) => c);
  const categories = Array.from(new Set([...homeCats, ...postCats]));
  const categoryColor = buildCategoryColors(
    categories,
    cfg.outline?.colors || {}
  );

  // COCO writer
  const cocoOut = path.resolve(
    OUT_DIR,
    cfg.coco?.outputFile || "annotations.coco.json"
  );
  const cocoInfo = cfg.coco?.datasetInfo || {};
  const coco = new CocoWriter({
    outputPath: cocoOut,
    categories,
    info: cocoInfo,
  });

  const browser = await puppeteer.launch({
    headless: false,
    slowMo: 0,
    defaultViewport: null,
    args: FULLSCREEN ? ["--start-fullscreen", "--start-maximized"] : [],
  });

  const outlineStyles = {
    width: cfg.outline?.width || "3px",
    style: cfg.outline?.style || "dashed",
    colorMap: categoryColor,
  };

  try {
    // ----- Open HOME -----
    const homePage = await browser.newPage();
    await homePage.goto(TARGET_URL, { waitUntil: WAIT_UNTIL, timeout: 60_000 });

    // Hotkeys: start = 's', pause/resume = 'p', stop = 'e' (NOT Esc; Esc is used by Reddit)
    const applySignal = (sig) => {
      if (sig === "start") {
        if (runState === "idle") {
          console.log("▶️ Start signal received");
          runState = "running";
        }
      } else if (sig === "toggle") {
        if (runState === "running") {
          console.log("⏸ Paused");
          runState = "paused";
        } else if (runState === "paused") {
          console.log("▶️ Resumed");
          runState = "running";
        }
      } else if (sig === "stop") {
        console.log("🛑 Stop signal received");
        runState = "stopped";
        process.exit(0);
      }
    };

    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (key) => {
      const low = (key || "").toLowerCase();
      if (low === "s") applySignal("start");
      else if (low === "p") applySignal("toggle");
      else if (low === "e" || key === "\u0003") applySignal("stop"); // 'e' or Ctrl+C
    });

    await homePage.exposeFunction("___runSignal", (sig) => {
      try {
        applySignal(sig);
      } catch {}
    });

    // For current and future documents
    const injectKeyHandler = () => {
      window.addEventListener(
        "keydown",
        (e) => {
          if (e.key === "s" || e.key === "S") window.___runSignal("start");
          else if (e.key === "p" || e.key === "P")
            window.___runSignal("toggle");
          else if (e.key === "e" || e.key === "E") window.___runSignal("stop");
        },
        { capture: true }
      );
    };
    await homePage.evaluate(injectKeyHandler);
    await homePage.evaluateOnNewDocument(`(${injectKeyHandler.toString()})();`);

    console.log(
      'Controls: "s" start, "p" pause/resume, "e" stop (terminal or browser tab).'
    );

    // Fullscreen best-effort
    if (FULLSCREEN) {
      try {
        if (process.platform === "darwin") {
          await homePage.keyboard.down("Meta");
          await homePage.keyboard.down("Control");
          await homePage.keyboard.press("KeyF");
          await homePage.keyboard.up("Control");
          await homePage.keyboard.up("Meta");
        } else {
          await homePage.keyboard.press("F11");
        }
      } catch {}
    }

    // Consent
    if (cfg.tryDismissConsent !== false) {
      try {
        await homePage.evaluate(() => {
          const texts = [
            "accept",
            "accept all",
            "i agree",
            "allow all",
            "tous accepter",
            "j’accepte",
          ];
          const nodes = Array.from(
            document.querySelectorAll("button,[role='button']")
          );
          for (const n of nodes) {
            const t = (n.innerText || n.textContent || "").toLowerCase();
            if (texts.some((x) => t.includes(x))) {
              n.click();
              break;
            }
          }
          [
            '[data-testid="accept-button"]',
            '[aria-label="Accept"]',
            '[aria-label="Accept all"]',
          ].forEach((sel) => document.querySelector(sel)?.click());
        });
      } catch {}
    }

    // Pre-scroll + stabilization
    if (PRE_SCROLL_VH > 0) {
      await homePage.evaluate(
        (vh) => window.scrollBy(0, window.innerHeight * vh),
        PRE_SCROLL_VH
      );
      await sleep(100);
    }
    await sleep(3000);

    // Wait until user presses "s" to start
    while (runState === "idle") {
      await sleep(100);
    }

    // Capture HOME
    await captureOnPage({
      page: homePage,
      pageLabel: "home",
      targets: cfg.home.targets,
      annotations: cfg.home.annotations || [],
      maxShots: Number.isFinite(cfg.home.maxShots)
        ? cfg.home.maxShots
        : cfg.home.maxPerTarget,
      infScroll: cfg.home.infiniteScroll,
      includeIframes: INCLUDE_IFRAMES,
      outlineStyles,
      keepOutlines: KEEP_OUTLINES,
      delayMs: DELAY_MS,
      outputDir: OUT_DIR,
      coco,
      interactions: {}, // none on home
    });

    // Collect post links
    const postLinks = await infiniteScrollCollectLinks(
      homePage,
      cfg.home.targets,
      {
        includeIframes: INCLUDE_IFRAMES,
        maxCount: cfg.home.maxPerTarget,
        stepVH: cfg.home.infiniteScroll.step,
        sleepMs: cfg.home.infiniteScroll.sleepMs,
        stableRounds: cfg.home.infiniteScroll.stableRounds,
        openSelector: cfg.home.open.selector,
      }
    );

    console.log(`🧭 Collected ${postLinks.length} post link(s).`);

    // Visit each post → capture on POST page (with comment interaction)
    for (let idx = 0; idx < postLinks.length; idx++) {
      while (runState === "paused") {
        await sleep(200);
      }
      if (runState === "stopped") {
        console.log("🛑 Stopped by user");
        break;
      }

      const href = postLinks[idx];
      console.log(`➡️  Opening post ${idx + 1}/${postLinks.length}: ${href}`);

      let postPage = homePage;
      let openedNew = false;

      if (cfg.home.open.openInNewTab) {
        postPage = await browser.newPage();
        openedNew = true;
      }

      try {
        await postPage.goto(href, {
          waitUntil: cfg.home.open.waitUntil,
          timeout: 60_000,
        });
        await sleep(cfg.home.open.stabilizationMs);

        await captureOnPage({
          page: postPage,
          pageLabel: `post_${idx + 1}`,
          targets: cfg.post.targets,
          annotations: cfg.post.annotations,
          maxShots: cfg.post.maxShotsPerPost,
          infScroll: cfg.post.infiniteScroll,
          includeIframes: INCLUDE_IFRAMES,
          outlineStyles,
          keepOutlines: KEEP_OUTLINES,
          delayMs: DELAY_MS,
          outputDir: OUT_DIR,
          coco,
          interactions: cfg.post.interactions || {},
        });
      } catch (e) {
        console.warn(`⚠️ Failed on post page ${href}:`, e.message);
      } finally {
        if (openedNew) {
          try {
            await postPage.close();
          } catch {}
          await jitter(100);
        } else {
          try {
            await postPage.goBack({
              waitUntil: cfg.home.open.waitUntil,
              timeout: 60_000,
            });
            await sleep(cfg.home.open.stabilizationMs);
          } catch {
            try {
              await postPage.goto(TARGET_URL, {
                waitUntil: WAIT_UNTIL,
                timeout: 60_000,
              });
              await sleep(800);
            } catch {}
          }
        }
      }
    }

    // Write COCO file
    coco.writeSync();
    console.log(
      `📝 COCO annotations saved to: ${path.relative(process.cwd(), cocoOut)}`
    );
    console.log(
      `✅ Screenshots saved in: ${path.relative(process.cwd(), OUT_DIR)}`
    );
  } catch (err) {
    console.error("Error:", err);
    process.exitCode = 1;
  } finally {
    // Optional: close the browser
    // await browser.close();
  }
})();

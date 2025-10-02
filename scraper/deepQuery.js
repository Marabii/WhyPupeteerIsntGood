// deepQuery.js
// Utilities to search across main DOM, open shadow DOM, and same-origin iframes.

async function deepQueryAll(page, selector, { includeIframes = true } = {}) {
  const arrayHandle = await page.evaluateHandle(
    async (sel, includeIframes) => {
      const uniques = new Set();
      const results = [];

      const pushAll = (list) => {
        for (const el of list) {
          if (!uniques.has(el)) {
            uniques.add(el);
            results.push(el);
          }
        }
      };

      const queryAllInRoot = (root) => {
        let matched = [];
        try {
          matched = Array.from(root.querySelectorAll(sel));
        } catch (e) {
          return { __selectorError: e.message };
        }
        pushAll(matched);

        const allElems = root.querySelectorAll("*");
        for (const el of allElems) {
          const sr = el.shadowRoot;
          if (sr) {
            const inner = queryAllInRoot(sr);
            if (inner && inner.__selectorError) return inner;
          }
        }
        return null;
      };

      {
        const err = queryAllInRoot(document);
        if (err && err.__selectorError) return err;
      }

      if (includeIframes) {
        const iframes = Array.from(document.querySelectorAll("iframe"));
        for (const frame of iframes) {
          try {
            const doc = frame.contentDocument;
            if (doc) {
              const err = queryAllInRoot(doc);
              if (err && err.__selectorError) return err;
            }
          } catch {
            // cross-origin -> skip
          }
        }
      }

      return results;
    },
    selector,
    includeIframes
  );

  const arrVal = await arrayHandle.jsonValue().catch(() => undefined);
  if (arrVal && typeof arrVal === "object" && arrVal.__selectorError) {
    throw new Error(
      `Invalid selector "${selector}": ${arrVal.__selectorError}`
    );
  }

  const props = await arrayHandle.getProperties();
  const elements = [];
  for (const prop of props.values()) {
    const el = prop.asElement();
    if (el) elements.push(el);
  }
  await arrayHandle.dispose();
  return elements;
}

async function deepQueryVisible(
  page,
  selector,
  { includeIframes = true } = {}
) {
  const els = await deepQueryAll(page, selector, { includeIframes });
  const visible = [];
  for (const el of els) {
    try {
      const isVis = await el.evaluate((node) => {
        const s = getComputedStyle(node);
        if (
          s.display === "none" ||
          s.visibility === "hidden" ||
          s.opacity === "0"
        )
          return false;
        const r = node.getBoundingClientRect();
        const inViewport =
          r.bottom > 0 &&
          r.right > 0 &&
          r.top < innerHeight &&
          r.left < innerWidth;
        return inViewport;
      });
      if (isVis) visible.push(el);
      else await el.dispose();
    } catch {
      try {
        await el.dispose();
      } catch {}
    }
  }
  return visible;
}

async function waitForAnyDeep(
  page,
  selector,
  { timeoutMs = 20000, pollMs = 200, includeIframes = true } = {}
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const els = await deepQueryAll(page, selector, { includeIframes }).catch(
      () => []
    );
    if (els.length) return els;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return [];
}

module.exports = {
  deepQueryAll,
  deepQueryVisible,
  waitForAnyDeep,
};

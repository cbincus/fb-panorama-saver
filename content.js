/**
 * content.js — Runs on facebook.com pages.
 * Watches network activity for the panorama tile-streaming pattern
 * (many bytestart/byteend range requests to one fbcdn asset). The
 * "Save panorama" button appears only when that pattern is detected,
 * and hides again on SPA navigation.
 */
(function () {
  "use strict";

  // ---- Detection ---------------------------------------------------------

  const MIN_TOTAL_BYTES = 300 * 1024;
  const groups = new Map(); // pathname -> { url, totalBytes, chunks, ranged }
  let onCandidate = null;   // hook set by the UI layer below

  try { performance.setResourceTimingBufferSize(50000); } catch {}

  /**
   * Facebook streams cubemap panoramas as HTTP byte-range chunks of ONE
   * file, using bytestart/byteend query params. Stripping those two
   * params (keeping signature params like oh/oe untouched) yields the
   * URL of the complete tile pack.
   */
  function stripRangeParams(url) {
    try {
      const u = new URL(url);
      u.searchParams.delete("bytestart");
      u.searchParams.delete("byteend");
      return u.toString();
    } catch {
      return url;
    }
  }

  /**
   * Group key: the URL pathname only. Facebook rotates session/tracking
   * query params (e.g. _nc_gid) between chunk requests, so grouping by
   * the full URL splinters one panorama into many single-chunk entries.
   * The pathname contains the unique asset filename and stays constant.
   */
  function groupKey(url) {
    try {
      return new URL(url).pathname;
    } catch {
      return url;
    }
  }

  /**
   * The unambiguous panorama fingerprint: repeated byte-range requests
   * to the same asset. (A single large image, e.g. a cover photo, must
   * NOT summon the button — hence the `ranged` requirement.)
   */
  function isPanoramaSignature(g) {
    return g.ranged && g.chunks >= 3;
  }

  function recordEntry(e) {
    const isFbCdn = /fbcdn\.net/.test(e.name);
    const looksLikeImage = /\.(jpe?g|png|webp)(\?|$)/i.test(e.name);
    if (!isFbCdn || !looksLikeImage) return;
    const key = groupKey(e.name);
    const size = e.decodedBodySize || e.transferSize || 0;
    const g = groups.get(key) ||
      { url: null, totalBytes: 0, chunks: 0, ranged: false };
    g.totalBytes += size;
    g.chunks += 1;
    g.ranged = g.ranged || e.name.includes("bytestart=");
    // Keep the FRESHEST full URL (minus range params) for downloading:
    // it carries valid, unexpired signature params (oh/oe/_nc_*).
    g.url = stripRangeParams(e.name);
    groups.set(key, g);
    if (isPanoramaSignature(g) && onCandidate) onCandidate(g);
  }

  new PerformanceObserver((list) => list.getEntries().forEach(recordEntry))
    .observe({ type: "resource", buffered: true });

  function findPanoramaCandidates() {
    return [...groups.values()]
      .filter((g) => g.totalBytes >= MIN_TOTAL_BYTES || g.chunks >= 3)
      .sort((a, b) => b.chunks - a.chunks || b.totalBytes - a.totalBytes);
  }

  // ---- Save flow ---------------------------------------------------------

  let busy = false;

  function savePanorama() {
    if (busy) return;
    const candidates = findPanoramaCandidates();
    if (candidates.length === 0) {
      // Shouldn't normally happen (button only shows after detection),
      // but state may have been cleared by navigation.
      alert("Panorama no longer detected. Pan around in the 360\u00b0 viewer and try again.");
      hideButton();
      return;
    }
    const best = candidates[0];
    console.log(
      `[Panorama Saver] Best candidate: ${best.chunks} chunk(s), ` +
        `${(best.totalBytes / 1048576).toFixed(1)} MB streamed.\n${best.url}`
    );
    busy = true;
    setButton("Starting\u2026", true);
    chrome.runtime.sendMessage({ type: "SAVE_PANORAMA", url: best.url });
  }

  // ---- UI ----------------------------------------------------------------

  let btn = null;

  function ensureButton() {
    if (document.getElementById("pano-saver-btn")) return;
    btn = document.createElement("button");
    btn.id = "pano-saver-btn";
    btn.textContent = "\u2b07 Save panorama";
    Object.assign(btn.style, {
      display: "none", // hidden until a panorama is detected
      position: "fixed",
      bottom: "20px",
      right: "20px",
      zIndex: 999999,
      padding: "10px 16px",
      background: "#1877f2",
      color: "#fff",
      border: "none",
      borderRadius: "8px",
      fontSize: "14px",
      fontWeight: "600",
      cursor: "pointer",
      boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
      maxWidth: "260px",
    });
    btn.addEventListener("click", savePanorama);
    document.body.appendChild(btn);
  }

  let visible = false;

  function showButton() {
    ensureButton();
    if (!visible) {
      visible = true;
      btn.style.display = "block";
      console.log("[Panorama Saver] Panorama detected \u2014 button shown.");
    }
  }

  function hideButton() {
    visible = false;
    if (btn) btn.style.display = "none";
  }

  function setButton(text, disabled) {
    if (!btn) return;
    btn.textContent = text;
    btn.style.opacity = disabled ? "0.7" : "1";
    btn.style.cursor = disabled ? "default" : "pointer";
  }

  onCandidate = () => showButton();

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== "PANO_PROGRESS") return;
    setButton(msg.text, !msg.done);
    if (msg.done) {
      busy = false;
      setTimeout(() => setButton("\u2b07 Save panorama", false), 4000);
    }
  });

  // Facebook is an SPA: hide the button and reset detection when the URL
  // changes. Safe because opening a photo viewer changes the URL first,
  // and tiles stream (re-triggering detection) after that.
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    if (!busy) {
      groups.clear();
      hideButton();
      setButton("\u2b07 Save panorama", false);
    }
  }, 500);

  // Facebook's DOM rebuilds can remove the button; re-attach, keeping state.
  new MutationObserver(() => {
    if (btn && !document.getElementById("pano-saver-btn")) {
      document.body.appendChild(btn);
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  ensureButton();
  console.log("[Panorama Saver] Watching for panorama tile streams\u2026");
})();

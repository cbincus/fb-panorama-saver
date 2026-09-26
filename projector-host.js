// fb360 — projector host (isolated world).
//
// The whole reason this file exists: fb360.js runs in the page's world, where
// facebook.com's CSP applies and a worker cannot be started, and where
// chrome.runtime does not exist so it cannot even name an extension file. This
// half runs in the isolated world, where chrome.* is available and where a
// chrome-extension:// frame it inserts is not subject to the page's CSP.
//
// It does exactly one thing on request — put the frame in the document, or
// take it out again — and answers on the same window channel. It never touches
// the projection data itself: once the frame exists, fb360.js talks to it
// directly, so face buffers and finished strips move between the page and the
// worker as transfers rather than being copied through here.

"use strict";

(() => {
  const HOST_KEY = "__fb360_projector_host__";
  const MAX_FRAMES = 4;
  const frames = new Map();

  const reply = payload => window.postMessage(payload, location.origin);

  const remove = id => {
    const frame = frames.get(id);
    if (!frame) return;
    frames.delete(id);
    try { frame.remove(); } catch {}
  };

  const create = id => {
    if (frames.has(id)) return;
    // A page that decided to spam this channel should not be able to open an
    // unbounded number of extension frames. One run needs one.
    if (frames.size >= MAX_FRAMES) {
      reply({ [HOST_KEY]: "failed", id, error: "too many projector frames open" });
      return;
    }

    const frame = document.createElement("iframe");
    frame.id = id;
    // Off-screen rather than display:none or visibility:hidden. A frame hidden
    // those two ways is throttled as not-rendered; this one only has to sit
    // somewhere the user cannot see, and it holds no UI at all.
    frame.setAttribute("aria-hidden", "true");
    frame.setAttribute("tabindex", "-1");
    frame.style.cssText =
      "position:fixed;left:-99999px;top:-99999px;width:1px;height:1px;" +
      "border:0;margin:0;padding:0;opacity:0;pointer-events:none;";
    frame.src = chrome.runtime.getURL("projector.html");

    frame.addEventListener("load", () => {
      if (frames.get(id) === frame) reply({ [HOST_KEY]: "created", id });
    }, { once: true });
    frame.addEventListener("error", () => {
      remove(id);
      reply({ [HOST_KEY]: "failed", id, error: "projector frame failed to load" });
    }, { once: true });

    // documentElement, not body: Facebook's React owns the body subtree and
    // reconciles it, and this frame must survive an in-app navigation in the
    // middle of a projection run.
    (document.documentElement || document).appendChild(frame);
    frames.set(id, frame);
  };

  window.addEventListener("message", ev => {
    // Only this page's own world can ask, and only for its own frame id.
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || typeof d !== "object") return;
    const kind = d[HOST_KEY];
    if (kind !== "create" && kind !== "destroy") return;
    if (typeof d.id !== "string" || !/^fb360-projector-[a-z0-9]{1,32}$/.test(d.id)) return;

    if (kind === "create") create(d.id);
    else remove(d.id);
  });
})();

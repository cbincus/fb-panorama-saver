// fb360 — projector frame relay.
//
// Runs inside projector.html, which is an extension-origin document, so
// `new Worker("projector-worker.js")` here is a plain same-origin worker and
// the extension's own CSP allows it. The page that embeds this frame cannot do
// that itself, which is the only reason the frame exists.
//
// This file passes messages through in both directions and does nothing else.
// It does not know or care what the protocol means — that is between fb360.js
// and projector-worker.js.
//
// The one thing it does have to get right is transfers. A face arrives as an
// ArrayBuffer that the page detached to send here; if it were then handed to
// the worker by structured clone, a 4096x4096 face would be copied (64 MiB)
// on the way in and every finished strip copied again on the way out, on this
// thread. collectBuffers finds the buffers in a message so each hop can
// transfer them onward instead. It is a generic walk rather than a list of
// known field names so that the protocol stays the page's business, not this
// file's.

"use strict";

(() => {
  const FRAME_KEY = "__fb360_projector_frame__";
  const MAX_DEPTH = 4;

  let worker = null;
  let parentWindow = null;
  let frameId = null;

  function collectBuffers(value, out = [], depth = 0, seen = new Set()) {
    if (depth > MAX_DEPTH || value === null || typeof value !== "object") return out;
    if (value instanceof ArrayBuffer) { if (!out.includes(value)) out.push(value); return out; }
    if (ArrayBuffer.isView(value)) {
      const b = value.buffer;
      if (b instanceof ArrayBuffer && !out.includes(b)) out.push(b);
      return out;
    }
    if (seen.has(value)) return out;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const v of value) collectBuffers(v, out, depth + 1, seen);
    } else {
      for (const k of Object.keys(value)) collectBuffers(value[k], out, depth + 1, seen);
    }
    return out;
  }

  function toParent(payload, transfer) {
    if (!parentWindow) return;
    // The embedder is cross-origin from here, so "*" is the only usable
    // target. Nothing secret goes back up: it is the page's own pixels
    // returning to the page that sent them.
    parentWindow.postMessage({ ...payload, [FRAME_KEY]: true, id: frameId }, "*", transfer || []);
  }

  function startWorker() {
    if (worker) return true;
    try {
      worker = new Worker("projector-worker.js");
    } catch (e) {
      toParent({ kind: "error", error: `worker failed to start: ${e && e.message || e}` });
      return false;
    }
    worker.onmessage = ev => {
      const msg = ev.data;
      toParent({ kind: "message", msg }, collectBuffers(msg));
    };
    worker.onerror = ev => {
      toParent({ kind: "error", error: (ev && ev.message) || "projection worker crashed" });
    };
    return true;
  }

  function terminate() {
    if (!worker) return;
    try { worker.terminate(); } catch {}
    worker.onmessage = null;
    worker.onerror = null;
    worker = null;
  }

  window.addEventListener("message", ev => {
    // Only the embedder talks to this frame, and only about the id it was
    // created for. The id is settled by the first message and never changes.
    if (ev.source !== window.parent) return;
    const d = ev.data;
    if (!d || typeof d !== "object" || d[FRAME_KEY] !== true) return;
    if (typeof d.id !== "string") return;
    if (frameId === null) { frameId = d.id; parentWindow = ev.source; }
    else if (d.id !== frameId) return;

    if (d.kind === "terminate") { terminate(); return; }
    // "start" only opens the worker. Its own {type:"ready"} then travels back
    // as an ordinary relayed message, so the embedder's handshake is the
    // worker's own and the relay adds nothing to the protocol between them.
    if (d.kind === "start") { startWorker(); return; }
    if (d.kind !== "message") return;
    if (!startWorker()) return;
    worker.postMessage(d.msg, collectBuffers(d.msg));
  });

  window.addEventListener("pagehide", terminate);
})();

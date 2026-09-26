// End-to-end test for the projection worker relay: the worker is started from
// an extension-origin frame, because facebook.com's CSP forbids blob: workers.
//
// It runs the real files — projector-host.js, projector-frame.js and
// projector-worker.js, plus startWorker() lifted verbatim out of fb360.js —
// against a mock window/document/Worker, and drives them exactly as
// runFaceInWorker does: one projectFace message in, chunks and a faceDone out.
// The projection itself is real, so this also proves projection-core.js loads
// and computes inside the worker.

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const EXT = path.join(__dirname, "..");
const read = f => fs.readFileSync(path.join(EXT, f), "utf8");

let failures = 0;
const check = (name, ok, extra) => {
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${ok || extra === undefined ? "" : ` — ${extra}`}`);
  if (!ok) failures++;
};

// ---------------------------------------------------------------- mock DOM

function makeWindow(name) {
  const listeners = [];
  return {
    name,
    listeners,
    addEventListener(type, fn) { if (type === "message") listeners.push(fn); },
    removeEventListener(type, fn) {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    _dispatch(source, data) {
      setImmediate(() => { for (const fn of listeners.slice()) fn({ source, data }); });
    },
  };
}

const pageWindow = makeWindow("page");
const frameWindow = makeWindow("frame");
const transfersToFrame = [];
const transfersToPage = [];

// Page world posting to itself (this is how it reaches the isolated world).
pageWindow.postMessage = (data, _origin) => pageWindow._dispatch(pageWindow, data);
pageWindow.location = { origin: "https://www.facebook.com" };

// A handle on the frame as seen from the page. The relay compares ev.source
// against these handles, so the dispatched source must be the same object the
// code holds — frame.contentWindow on one side, window.parent on the other.
const contentWindowFromPage = {
  postMessage: (data, _origin, transfer) => {
    transfersToFrame.push(transfer || []);
    frameWindow._dispatch(pageFromFrame, data);
  },
};
var pageFromFrame = {
  postMessage: (data, _origin, transfer) => {
    transfersToPage.push(transfer || []);
    pageWindow._dispatch(contentWindowFromPage, data);
  },
};
frameWindow.parent = pageFromFrame;

const frames = new Map();
let failNextFrame = false;
const document = {
  documentElement: {
    appendChild(el) { el._attached = true; if (el.id) frames.set(el.id, el); },
  },
  getElementById: id => frames.get(id) || null,
  createElement() {
    const el = {
      style: {}, id: null, _attached: false, _handlers: {},
      setAttribute() {},
      addEventListener(type, fn) { el._handlers[type] = fn; },
      remove() { el._removed = true; frames.delete(el.id); },
      get contentWindow() { return contentWindowFromPage; },
      set src(v) {
        el._src = v;
        // The frame document loads, then announces itself — unless this run is
        // exercising the failure path.
        setImmediate(() => {
          const h = failNextFrame ? el._handlers.error : el._handlers.load;
          failNextFrame = false;
          if (h) h();
        });
      },
      get src() { return el._src; },
    };
    return el;
  },
};

const chrome = { runtime: { getURL: p => `chrome-extension://testid/${p}` } };

// ------------------------------------------------------------- real worker

function startRealWorker(scriptPath, onMessage, onError) {
  const sandbox = {
    console,
    setTimeout, clearTimeout, setImmediate,
    Uint8ClampedArray, Uint32Array, Float32Array, Float64Array, Array,
    ArrayBuffer, Math, JSON, String, Number, Object, Error, Promise,
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.importScripts = rel => {
    vm.runInContext(read(rel), ctx, { filename: rel });
  };
  sandbox.postMessage = (msg, _transfer) => setImmediate(() => onMessage({ data: msg }));
  const ctx = vm.createContext(sandbox);
  try {
    vm.runInContext(read(scriptPath), ctx, { filename: scriptPath });
  } catch (e) { onError({ message: e.message }); return null; }
  return {
    postMessage: msg => {
      // Structured clone would detach the transferred buffer; the worker only
      // reads it, so passing it through is faithful enough for the maths.
      setImmediate(() => sandbox.onmessage && sandbox.onmessage({ data: msg }));
    },
    terminate() { sandbox.onmessage = null; },
    set onmessage(_) {}, set onerror(_) {},
  };
}

// ------------------------------------------------------------ load the code

// Isolated world.
vm.runInNewContext(read("projector-host.js"),
  { window: pageWindow, document, chrome, location: pageWindow.location, console });

// The frame's own document.
{
  // The relay assigns onmessage/onerror after construction, so hand it a
  // holder object the real worker's callbacks close over.
  const Worker = function (script) {
    const holder = {};
    const real = startRealWorker(script,
      ev => holder.onmessage && holder.onmessage(ev),
      err => holder.onerror && holder.onerror(err));
    if (!real) throw new Error("worker failed to start");
    holder.postMessage = real.postMessage;
    holder.terminate = real.terminate;
    return holder;
  };
  vm.runInNewContext(read("projector-frame.js"), {
    window: frameWindow, Worker, ArrayBuffer, Object, Array, Set, console,
  });
}

// Page world: startWorker() lifted verbatim out of fb360.js.
function extractFunction(src, header) {
  const start = src.indexOf(header);
  if (start < 0) throw new Error(`not found: ${header}`);
  let depth = 0, i = src.indexOf("{", start);
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}" && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error("unbalanced");
}

const fb360Src = read("fb360.js");
const startWorkerSrc = extractFunction(fb360Src, "    function startWorker() {");
const constMatch = /const HOST_KEY = "(.+?)";[\s\S]*?const FRAME_KEY = "(.+?)";[\s\S]*?const PROJECTOR_START_TIMEOUT_MS = (\d+);/
  .exec(fb360Src);
check("startWorker() and its constants were found in fb360.js", !!constMatch && startWorkerSrc.length > 500);

const warnings = [];
const pageCtx = vm.createContext({
  window: pageWindow, document, location: pageWindow.location,
  Math, Error, setTimeout, clearTimeout, console,
  HOST_KEY: constMatch[1], FRAME_KEY: constMatch[2],
  PROJECTOR_START_TIMEOUT_MS: Number(constMatch[3]),
  warn: m => warnings.push(m),
});
vm.runInContext(`${startWorkerSrc.trim()}; this.__startWorker = startWorker;`, pageCtx);
const startWorker = pageCtx.__startWorker;

// ------------------------------------------------------------------- drive

(async () => {
  const ws = await startWorker();
  check("startWorker() resolves a worker proxy", !!ws && !!ws.worker,
    `got ${JSON.stringify(ws)}; warnings: ${warnings.join(" | ")}`);
  check("the frame is the extension's own origin, not the page's",
    [...frames.values()][0]._src.startsWith("chrome-extension://"),
    [...frames.values()][0] && [...frames.values()][0]._src);
  check("no object URL is left to revoke", ws.url === null);

  // Exactly what runFaceInWorker sends: a 4x4 face, transferred.
  const size = 4;
  const raw = { data: new Uint8ClampedArray(size * size * 4), width: size };
  for (let i = 0; i < size * size; i++) {
    raw.data[i * 4] = 200; raw.data[i * 4 + 1] = 40;
    raw.data[i * 4 + 2] = 40; raw.data[i * 4 + 3] = 255;
  }

  const chunks = [];
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), 8000);
    ws.worker.onerror = e => { clearTimeout(timer); reject(e); };
    ws.worker.onmessage = e => {
      const d = e.data || {};
      if (d.type === "chunk") chunks.push(d);
      else if (d.type === "faceDone") {
        clearTimeout(timer);
        d.error ? reject(new Error(d.error)) : resolve();
      }
    };
  });

  const before = transfersToFrame.length;
  ws.worker.postMessage({
    type: "projectFace", faceIndex: 1,
    face: { buf: raw.data.buffer, size, slot: "F", rot: 0, gaps: false },
    rects: [{ colStart: 0, colEnd: 16, rowStart: 0, rowEnd: 8 }],
    width: 16, mask: null,
  }, [raw.data.buffer]);

  check("the face buffer is transferred into the frame, not copied",
    (transfersToFrame[before] || []).includes(raw.data.buffer));

  await done;
  check("a projectFace round-trip completes", true);
  check("finished strips come back as chunks", chunks.length > 0, `${chunks.length} chunks`);
  const painted = chunks.reduce((n, c) => n + c.rows * c.cols, 0);
  check("the chunks cover the requested rectangle", painted === 16 * 8, `${painted} px`);

  // One face owns a quarter of the sphere's width, so most of a full-sphere
  // pass is legitimately transparent — those pixels belong to faces this
  // message did not carry. What matters is that the pixels F does own came
  // back opaque and in the face's colour.
  let opaque = 0, wrongColour = 0;
  for (const c of chunks) {
    const px = new Uint8ClampedArray(c.buf);
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] !== 255) continue;
      opaque++;
      if (px[i] !== 200 || px[i + 1] !== 40 || px[i + 2] !== 40) wrongColour++;
    }
  }
  check("the face's own region came back opaque", opaque > 0, `${opaque} px`);
  check("every projected pixel carries the face colour", wrongColour === 0,
    `${wrongColour} px differ`);
  check("pixels outside the face are left transparent for other faces",
    opaque < painted, `${opaque} of ${painted}`);
  check("chunk buffers are transferred back out of the frame",
    transfersToPage.some(t => t.length > 0));

  ws.worker.terminate();
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  check("terminate() removes the frame from the page",
    [...frames.values()].every(f => f._removed) || frames.size === 0);

  // The fallback the whole design leans on: if the frame cannot be had, the
  // projection must fall back to the main thread rather than hang. This is the
  // only path a user on a locked-down profile would ever take.
  failNextFrame = true;
  warnings.length = 0;
  const bad = await startWorker();
  check("a frame that fails to load resolves null, not a hang", bad === null,
    JSON.stringify(bad));
  check("the fallback is announced to the console",
    warnings.some(w => /falling back to the main thread/.test(w)),
    warnings.join(" | "));
  check("the failed frame is not left in the document",
    [...frames.values()].every(f => f._removed) || frames.size === 0,
    `${frames.size} left`);

  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error("harness error:", e); process.exit(1); });

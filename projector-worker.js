// fb360 — projection worker.
//
// Facebook's CSP refuses blob: workers, and a content script cannot start one
// for the page either, so the worker is a real file started from the
// extension's own origin: projector.html loads it as a same-origin script,
// which the extension's own CSP allows, and projector-frame.js relays messages
// between it and the page.
//
// Each projectFace message projects one cube face; the result comes back as
// row chunks followed by a faceDone. rot90 and projectEquirect come from the
// same shared file the page uses.

"use strict";

importScripts("projection-core.js");

const { rot90, projectEquirect } = self.__fb360ProjectionCore;

  self.onmessage = async ev => {
    const m = ev.data || {};
    if (m.type !== "projectFace") return;
    try {
      const f = m.face;
      const oriented = rot90(
        { data: new Uint8ClampedArray(f.buf), width: f.size, height: f.size },
        f.rot);
      oriented.gaps = f.gaps;
      const cube = { F: null, R: null, B: null, L: null, U: null, D: null };
      cube[f.slot] = oriented;

      // A face's ownership region is not rectangular in equirectangular
      // space. Project only its small bounding rectangles; pixels owned by a
      // different cube face stay transparent and are alpha-composited by the
      // main thread, so previously projected faces are never erased.
      for (const r of m.rects) {
        const opts = {
          rowStart: r.rowStart, rowEnd: r.rowEnd,
          colStart: r.colStart, colEnd: r.colEnd,
          sink: (chunk, firstRow, rows) => {
            const buf = new Uint8ClampedArray(chunk).buffer;
            self.postMessage({ type: "chunk", buf, firstRow, rows,
              firstCol: r.colStart, cols: r.colEnd - r.colStart }, [buf]);
          },
        };
        if (m.mask) opts.mask = m.mask;
        await projectEquirect(cube, m.width, null, opts);
      }
      self.postMessage({ type: "faceDone", faceIndex: m.faceIndex });
    } catch (e) {
      self.postMessage({ type: "faceDone", faceIndex: m.faceIndex,
        error: String((e && (e.stack || e.message)) || e) });
    }
  };
  self.postMessage({ type: "ready" });

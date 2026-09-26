// fb360 — projection core, shared between two contexts.
//
// rot90 and projectEquirect, in exactly one copy for everything that projects.
// This file is loaded twice:
//
//   - as a MAIN-world content script, just before fb360.js, which takes the
//     two functions off the global for its selfTest and its main-thread
//     projection fallback;
//   - through importScripts() in projector-worker.js, the CPU projection
//     worker.
//
// The two functions reference nothing outside themselves, which is what lets
// the same code run in either context.

"use strict";

(function (root) {


  /**
   * Rotate a square RGBA image 90 deg counter-clockwise, k times.
   * Single pass with a single allocation for any k. k=0 returns the input
   * unchanged.
   */
  function rot90(img, k) {
    k = ((k % 4) + 4) % 4;
    if (k === 0) return img;
    const S = img.width, src = img.data;
    const out = new Uint8ClampedArray(S * S * 4);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const d = (y * S + x) * 4;
        let s;
        if (k === 1) s = (x * S + (S - 1 - y)) * 4;              // CCW
        else if (k === 2) s = ((S - 1 - y) * S + (S - 1 - x)) * 4; // 180
        else s = ((S - 1 - x) * S + y) * 4;                      // CW
        out[d] = src[s]; out[d + 1] = src[s + 1];
        out[d + 2] = src[s + 2]; out[d + 3] = src[s + 3];
      }
    }
    return { data: out, width: S, height: S };
  }
  /**
   * Project cubemap -> equirectangular (async, chunked by rows).
   * Faces may have DIFFERENT resolutions; each is sampled at its native size.
   * onProgress(fractionDone) is awaited between chunks so callers can update
   * UI / yield to the event loop.
   *
   * opts:
   *   rowStart, rowEnd   row window of the sphere
   *   colStart, colEnd   column window of the sphere
   *   mask               {h, v, hCenter, vCenter, guard} captured region, in
   *                      radians, or null
   *   sink               per-chunk hand-off
   */
  async function projectEquirect(cube, width, onProgress, opts) {
    const { F, R, B, L, U, D } = cube;
    const W = width, H = width >> 1;
    const rowStart = (opts && opts.rowStart) | 0;
    const rowLimit = opts && opts.rowEnd != null ? opts.rowEnd : H;
    const colStart = (opts && opts.colStart) | 0;
    const colLimit = opts && opts.colEnd != null ? opts.colEnd : W;
    const mask = (opts && opts.mask) || null;
    const sink = (opts && opts.sink) || null;
    const CHUNK = 128;
    const outW = colLimit - colStart;
    // With a sink, each finished chunk is handed off (straight into a canvas
    // via putImageData) and ONE chunk-sized buffer is reused (~8 MiB at
    // W=16384) instead of materializing the whole panorama (~512 MiB at
    // 16384x8192). The sink receives (chunkData, firstRow, rowCount);
    // chunkData is only valid until the sink returns, so copy if it must
    // outlive the call. putImageData copies synchronously, so the canvas case
    // needs no copy.
    const outRows = sink
      ? Math.min(CHUNK, Math.max(0, rowLimit - rowStart))
      : rowLimit - rowStart;
    const out = new Uint8ClampedArray(outW * outRows * 4);

    // A pixel centre landing exactly on the boundary can compare as outside by
    // one ulp, which would discard a whole edge row or column. The tolerance
    // is ~1e-9 rad, many orders of magnitude below one pixel. Sampling is then
    // clamped to sit at least a couple of face texels inside the bounds, or a
    // pixel right on the boundary interpolates against the black padding just
    // outside it and the border goes dark.
    const EPS = 1e-9;
    const halfH = mask ? mask.h / 2 : 0, halfV = mask ? mask.v / 2 : 0;
    const hLim = mask ? Math.max(0, halfH - mask.guard) : 0;
    const vLim = mask ? Math.max(0, halfV - mask.guard) : 0;
    // The captured region is not necessarily centred on (0, 0): a panorama
    // cropped off centre carries the offset in its spherical metadata, and
    // every angular test below is taken relative to that centre.
    const hCen = (mask && mask.hCenter) || 0;
    const vCen = (mask && mask.vCenter) || 0;

    // Columns outside the captured region never get a lonOK entry, so the
    // inner loop skips them and their pixels stay at alpha 0.
    const sinLon = new Float64Array(outW), cosLon = new Float64Array(outW);
    const lonOK = mask ? new Uint8Array(outW) : null;
    for (let k = 0; k < outW; k++) {
      const lon0 = ((colStart + k + 0.5) / W) * 2 * Math.PI - Math.PI;
      let lon = lon0;
      if (mask) {
        // Wrapped into (-pi, pi], so a region straddling the seam stays one
        // contiguous interval about its centre.
        let d = lon0 - hCen;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        if (Math.abs(d) > halfH + EPS) continue;
        lon = hCen + (d < -hLim ? -hLim : d > hLim ? hLim : d);
      }
      sinLon[k] = Math.sin(lon); cosLon[k] = Math.cos(lon);
      if (lonOK) lonOK[k] = 1;
    }

    for (let row0 = rowStart; row0 < rowLimit; row0 += CHUNK) {
      const chunkEnd = Math.min(row0 + CHUNK, rowLimit);
      // The sink buffer is reused, so masked-out pixels would otherwise show
      // the previous chunk's content rather than transparency.
      if (sink) out.fill(0, 0, (chunkEnd - row0) * outW * 4);
      for (let r = row0; r < chunkEnd; r++) {
        const lat0 = Math.PI / 2 - ((r + 0.5) / H) * Math.PI;
        let lat = lat0;
        if (mask) {
          const d = lat0 - vCen;
          if (Math.abs(d) > halfV + EPS) continue;
          lat = vCen + (d < -vLim ? -vLim : d > vLim ? vLim : d);
        }
        const sinLat = Math.sin(lat), cosLat = Math.cos(lat);
        let o = (r - (sink ? row0 : rowStart)) * outW * 4;
        for (let k = 0; k < outW; k++, o += 4) {
          if (lonOK && !lonOK[k]) continue;
          const x = cosLat * sinLon[k];
          const y = sinLat;
          const z = cosLat * cosLon[k];
          const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);

          let face, u, v;
          if (az >= ax && az >= ay) {
            if (z > 0) { face = F; u = (x / az + 1) / 2; v = (-y / az + 1) / 2; }
            else       { face = B; u = (-x / az + 1) / 2; v = (-y / az + 1) / 2; }
          } else if (ax > az && ax >= ay) {
            if (x > 0) { face = R; u = (-z / ax + 1) / 2; v = (-y / ax + 1) / 2; }
            else       { face = L; u = (z / ax + 1) / 2; v = (-y / ax + 1) / 2; }
          } else {
            if (y > 0) { face = U; u = (x / ay + 1) / 2; v = (z / ay + 1) / 2; }
            else       { face = D; u = (x / ay + 1) / 2; v = (-z / ay + 1) / 2; }
          }
          // A face that is absent from the cube is skipped.
          if (!face) continue;

          // Bilinear sample at the face's own resolution
          const S = face.width;
          let fu = u * S - 0.5, fv = v * S - 0.5;
          if (fu < 0) fu = 0; else if (fu > S - 1) fu = S - 1;
          if (fv < 0) fv = 0; else if (fv > S - 1) fv = S - 1;
          const x0 = fu | 0, y0 = fv | 0;
          const x1 = x0 + 1 < S ? x0 + 1 : S - 1;
          const y1 = y0 + 1 < S ? y0 + 1 : S - 1;
          const wx = fu - x0, wy = fv - y0;
          const d = face.data;
          const i00 = (y0 * S + x0) * 4, i01 = (y0 * S + x1) * 4;
          const i10 = (y1 * S + x0) * 4, i11 = (y1 * S + x1) * 4;
          const w00 = (1 - wx) * (1 - wy), w01 = wx * (1 - wy);
          const w10 = (1 - wx) * wy, w11 = wx * wy;

          out[o]     = d[i00] * w00 + d[i01] * w01 + d[i10] * w10 + d[i11] * w11;
          out[o + 1] = d[i00+1] * w00 + d[i01+1] * w01 + d[i10+1] * w10 + d[i11+1] * w11;
          out[o + 2] = d[i00+2] * w00 + d[i01+2] * w01 + d[i10+2] * w10 + d[i11+2] * w11;
          // Facebook's faces are opaque, so writing 255 is the fast path;
          // only a face that had to be assembled with holes pays for the four
          // extra alpha samples.
          if (!face.gaps) out[o + 3] = 255;
          else {
            const a = d[i00+3] * w00 + d[i01+3] * w01 +
                      d[i10+3] * w10 + d[i11+3] * w11;
            out[o + 3] = a > 0 ? 255 : 0;
          }
        }
      }
      if (sink) {
        await sink(out.subarray(0, (chunkEnd - row0) * outW * 4),
                   row0, chunkEnd - row0);
      }
      if (onProgress) await onProgress((chunkEnd - rowStart) / (rowLimit - rowStart));
    }
    if (sink) return { width: outW, height: rowLimit - rowStart, rowStart, streamed: true };
    return { data: out, width: outW, height: rowLimit - rowStart, rowStart };
  }

  root.__fb360ProjectionCore = { rot90, projectEquirect };

})(typeof self !== "undefined" ? self : globalThis);

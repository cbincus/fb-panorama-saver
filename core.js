/**
 * core.js — Pure-JS pipeline for unpacking Facebook panorama tile packs.
 * No browser APIs: works on {data: Uint8ClampedArray(RGBA), width, height}
 * objects, so it runs identically in the extension service worker and Node.
 *
 * Pipeline: splitJpegs -> stitchFaces -> orientFaces -> projectEquirect
 */
(function (root) {
  "use strict";

  /** Find all embedded JPEGs (split at FF D8 FF markers). */
  function splitJpegs(bytes) {
    const starts = [];
    for (let i = 0; i + 2 < bytes.length; i++) {
      if (bytes[i] === 0xff && bytes[i + 1] === 0xd8 && bytes[i + 2] === 0xff) {
        starts.push(i);
      }
    }
    starts.push(bytes.length);
    const out = [];
    for (let i = 0; i < starts.length - 1; i++) {
      out.push(bytes.subarray(starts[i], starts[i + 1]));
    }
    return out;
  }

  /**
   * Stitch six cube faces from decoded tiles.
   * Pack layout: the pyramid tiles of six faces, then 6 preview tiles.
   * Each face's pyramid holds its levels HIGHEST first (row-major), and
   * Facebook drops levels adaptively — e.g. narrow panoramas keep only
   * the 2x2 mid level for up/down faces — so per-face pyramid sizes
   * vary: 84 (8x8+4x4+2x2), 20 (4x4+2x2), or 4 (2x2).
   *
   * Two tile ORDERINGS exist in the wild:
   *   face-major  — face 0's whole pyramid, then face 1's, … (current
   *                 encoder; the common case)
   *   level-major — every face's highest level first (face 0..5), then
   *                 every face's next level, … (older packs, e.g. 2016)
   * Both the composition and the ordering are found by enumerating the
   * candidates and scoring each by how well adjacent tile edges match
   * inside the assembled faces.
   * Returns faces at their native resolutions (may differ per face).
   */
  function stitchFaces(tiles) {
    const N_PREVIEWS = 6;
    if (tiles.length < 6 * 4 + N_PREVIEWS) {
      throw new Error(`Unexpected tile count ${tiles.length} (need >= 30).`);
    }
    const M = tiles.length - N_PREVIEWS;
    const ts = tiles[0].width;
    const BLOCK_GRID = { 84: 8, 20: 4, 4: 2 };   // pyramid size -> hi grid
    const BLOCK_LEVELS = { 84: [8, 4, 2], 20: [4, 2], 4: [2] };

    // All ordered 6-part compositions of M from allowed pyramid sizes.
    const comps = [];
    (function rec(acc, sum) {
      if (acc.length === 6) {
        if (sum === M) comps.push(acc.slice());
        return;
      }
      for (const p of [84, 20, 4]) {
        if (sum + p <= M) { acc.push(p); rec(acc, sum + p); acc.pop(); }
      }
    })([], 0);
    if (comps.length === 0) {
      throw new Error(
        `Unsupported tile count ${tiles.length}: no valid face structure.`);
    }

    /**
     * Start offset of each face's HIGHEST level under an ordering.
     * face-major: levels grouped per face, faces consecutive.
     * level-major: all (face, level) pairs sorted by grid size
     * descending, then face index — so each face's top level sits after
     * every higher-resolution level of all faces, plus the equal-
     * resolution top levels of lower-indexed faces.
     */
    function hiOffsets(comp, ordering) {
      const offs = new Array(6);
      if (ordering === "face-major") {
        let pos = 0;
        for (let f = 0; f < 6; f++) { offs[f] = pos; pos += comp[f]; }
        return offs;
      }
      const seq = []; // [face, grid] pairs in stream order
      for (let f = 0; f < 6; f++) {
        for (const g of BLOCK_LEVELS[comp[f]]) seq.push([f, g]);
      }
      seq.sort((a, b) => (b[1] - a[1]) || (a[0] - b[0]));
      let pos = 0;
      for (const [f, g] of seq) {
        if (g === BLOCK_GRID[comp[f]]) offs[f] = pos;
        pos += g * g;
      }
      return offs;
    }

    // Precompute strided tile edges once for seam scoring.
    const STRIDE = 4, EN = Math.floor(ts / STRIDE);
    const tileEdges = tiles.map((t) => {
      const d = t.data, e = {
        top: new Float32Array(EN * 3), bottom: new Float32Array(EN * 3),
        left: new Float32Array(EN * 3), right: new Float32Array(EN * 3),
      };
      for (let i = 0; i < EN; i++) {
        const p = i * STRIDE;
        let s = p * 4;                       // top row
        e.top[i*3] = d[s]; e.top[i*3+1] = d[s+1]; e.top[i*3+2] = d[s+2];
        s = ((ts - 1) * ts + p) * 4;         // bottom row
        e.bottom[i*3] = d[s]; e.bottom[i*3+1] = d[s+1]; e.bottom[i*3+2] = d[s+2];
        s = p * ts * 4;                      // left col
        e.left[i*3] = d[s]; e.left[i*3+1] = d[s+1]; e.left[i*3+2] = d[s+2];
        s = (p * ts + ts - 1) * 4;           // right col
        e.right[i*3] = d[s]; e.right[i*3+1] = d[s+1]; e.right[i*3+2] = d[s+2];
      }
      return e;
    });

    function arrangementScore(comp, offs) {
      let err = 0, seams = 0;
      for (let f = 0; f < 6; f++) {
        const g = BLOCK_GRID[comp[f]], pos = offs[f];
        for (let r = 0; r < g; r++) {
          for (let c = 0; c < g; c++) {
            const i = pos + r * g + c;
            if (c < g - 1) {
              err += meanAbsDiff(tileEdges[i].right, tileEdges[i + 1].left);
              seams++;
            }
            if (r < g - 1) {
              err += meanAbsDiff(tileEdges[i].bottom, tileEdges[i + g].top);
              seams++;
            }
          }
        }
      }
      return err / seams;
    }

    // Score every (composition, ordering) pair; ties (e.g. uniform
    // blocks where both orderings coincide) keep face-major.
    let bestComp = comps[0], bestOffs = null, bestOrdering = "face-major",
        bestScore = Infinity;
    for (const comp of comps) {
      for (const ordering of ["face-major", "level-major"]) {
        const offs = hiOffsets(comp, ordering);
        const s = arrangementScore(comp, offs);
        if (s < bestScore) {
          bestScore = s; bestComp = comp; bestOffs = offs;
          bestOrdering = ordering;
        }
      }
    }

    // Assemble each face from its highest level at native size.
    const faces = [];
    for (let f = 0; f < 6; f++) {
      const g = BLOCK_GRID[bestComp[f]], S = g * ts, pos = bestOffs[f];
      const data = new Uint8ClampedArray(S * S * 4);
      for (let k = 0; k < g * g; k++) {
        const tile = tiles[pos + k];
        const r = (k / g) | 0, c = k % g;
        for (let ty = 0; ty < ts; ty++) {
          const src = ty * ts * 4;
          const dst = ((r * ts + ty) * S + c * ts) * 4;
          data.set(tile.data.subarray(src, src + ts * 4), dst);
        }
      }
      faces.push({ data, width: S, height: S });
    }
    faces.structure = bestComp;    // exposed for diagnostics
    faces.ordering = bestOrdering; // exposed for diagnostics
    // Preview tiles (one per face, same order as blocks): used for
    // preview-projection fill of truncated panoramas.
    faces.previews = tiles.slice(tiles.length - N_PREVIEWS);
    return faces;
  }

  /** Rotate a square RGBA image 90 deg counter-clockwise, k times. */
  function rot90(img, k) {
    k = ((k % 4) + 4) % 4;
    let cur = img;
    for (let n = 0; n < k; n++) {
      const S = cur.width;
      const out = new Uint8ClampedArray(S * S * 4);
      const src = cur.data;
      for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
          // dst(x,y) = src(S-1-y, x)  [90 deg CCW]
          const d = (y * S + x) * 4;
          const s = (x * S + (S - 1 - y)) * 4;
          out[d] = src[s]; out[d + 1] = src[s + 1];
          out[d + 2] = src[s + 2]; out[d + 3] = src[s + 3];
        }
      }
      cur = { data: out, width: S, height: S };
    }
    return cur;
  }

  /** Box-downsample a square RGBA image to size n (n divides width). */
  function downsample(img, n) {
    const S = img.width, f = S / n, area = f * f;
    const out = new Uint8ClampedArray(n * n * 4);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        let r = 0, g = 0, b = 0;
        for (let dy = 0; dy < f; dy++) {
          let s = ((y * f + dy) * S + x * f) * 4;
          for (let dx = 0; dx < f; dx++, s += 4) {
            r += img.data[s]; g += img.data[s + 1]; b += img.data[s + 2];
          }
        }
        const d = (y * n + x) * 4;
        out[d] = r / area; out[d + 1] = g / area;
        out[d + 2] = b / area; out[d + 3] = 255;
      }
    }
    return { data: out, width: n, height: n };
  }

  /** Extract one edge as Float32Array of RGB triples. */
  function edgeOf(img, which) {
    const S = img.width, d = img.data, out = new Float32Array(S * 3);
    for (let i = 0; i < S; i++) {
      let idx;
      if (which === "top") idx = i * 4;
      else if (which === "bottom") idx = ((S - 1) * S + i) * 4;
      else if (which === "left") idx = i * S * 4;
      else idx = (i * S + S - 1) * 4; // right
      out[i * 3] = d[idx]; out[i * 3 + 1] = d[idx + 1]; out[i * 3 + 2] = d[idx + 2];
    }
    return out;
  }

  function meanAbsDiff(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
    return s / a.length;
  }

  /** Reverse an edge array of RGB triples (triple-wise, not float-wise). */
  function reverseEdge(e) {
    const n = e.length / 3, out = new Float32Array(e.length);
    for (let i = 0; i < n; i++) {
      out[i * 3] = e[(n - 1 - i) * 3];
      out[i * 3 + 1] = e[(n - 1 - i) * 3 + 1];
      out[i * 3 + 2] = e[(n - 1 - i) * 3 + 2];
    }
    return out;
  }

  const PERMS4 = (() => {
    const out = [];
    const rec = (rest, acc) => {
      if (!rest.length) { out.push(acc); return; }
      for (let i = 0; i < rest.length; i++) {
        rec(rest.slice(0, i).concat(rest.slice(i + 1)), acc.concat(rest[i]));
      }
    };
    rec([0, 1, 2, 3], []);
    return out;
  })();

  /**
   * All 12 cube edges for the projection convention used in
   * projectEquirect, derived from its face/uv formulas:
   * [slotA, edgeOfA, slotB, edgeOfB, reversed]. U and D slots use their
   * own rotation; side slots (F,R,B,L) are assumed upright, which holds
   * for Facebook packs.
   */
  const SEAMS = [
    ["F", "right", "R", "left", false],
    ["R", "right", "B", "left", false],
    ["B", "right", "L", "left", false],
    ["L", "right", "F", "left", false],
    ["U", "bottom", "F", "top", false],
    ["U", "right", "R", "top", true],
    ["U", "top", "B", "top", true],
    ["U", "left", "L", "top", false],
    ["D", "top", "F", "bottom", false],
    ["D", "right", "R", "bottom", false],
    ["D", "bottom", "B", "bottom", true],
    ["D", "left", "L", "bottom", true],
  ];

  /**
   * Facebook's encoder writes cube faces in a fixed order (opposite
   * pairs: {0,1} front/back, {2,3} up/down, {4,5} right/left), verified
   * against a real pack by preview-tile matching. This layout is the
   * content-independent default; the seam search below only overrides
   * it when the pack demonstrably uses a different convention.
   */
  const FIXED_LAYOUT = { F: 0, R: 4, B: 1, L: 5, U: 2, D: 3, rotU: 1, rotD: 3 };
  const FIXED_PREFERENCE = 1.1; // search must beat fixed by >10% to win

  /**
   * Determine face layout and orient faces for projection.
   * Content-independent: scores candidate layouts by the total edge
   * mismatch across ALL 12 cube seams (no brightness / uniformity
   * assumptions about sky or ground), preferring the known encoder
   * layout unless another is clearly better.
   */
  function orientFaces(faces) {
    const small = faces.map((f) => downsample(f, 128));

    // Precompute all edges for every face at every rotation, plus
    // reversed variants, so scoring is pure lookups.
    const E = small.map((s) => {
      const perRot = [];
      for (let k = 0; k < 4; k++) {
        const r = rot90(s, k), e = {};
        for (const w of ["top", "bottom", "left", "right"]) {
          e[w] = edgeOf(r, w);
          e["~" + w] = reverseEdge(e[w]);
        }
        perRot.push(e);
      }
      return perRot;
    });

    function scoreLayout(lay) {
      let s = 0;
      for (const [slotA, eA, slotB, eB, rev] of SEAMS) {
        const rotA = slotA === "U" ? lay.rotU : slotA === "D" ? lay.rotD : 0;
        const rotB = slotB === "U" ? lay.rotU : slotB === "D" ? lay.rotD : 0;
        const a = E[lay[slotA]][rotA][eA];
        const b = E[lay[slotB]][rotB][(rev ? "~" : "") + eB];
        s += meanAbsDiff(a, b);
      }
      return s / SEAMS.length;
    }

    // Exhaustive search: every up/down choice, side arrangement, and
    // up/down rotation. ~11.5k layouts, trivial at 128px edges.
    let best = null, bestScore = Infinity;
    for (let u = 0; u < 6; u++) {
      for (let d = 0; d < 6; d++) {
        if (d === u) continue;
        const sides = [0, 1, 2, 3, 4, 5].filter((i) => i !== u && i !== d);
        for (const p of PERMS4) {
          const [F, R, B, L] = p.map((i) => sides[i]);
          for (let rotU = 0; rotU < 4; rotU++) {
            for (let rotD = 0; rotD < 4; rotD++) {
              const lay = { F, R, B, L, U: u, D: d, rotU, rotD };
              const s = scoreLayout(lay);
              // Tie-break equal-score yaw twins deterministically by F.
              if (s < bestScore - 1e-9 ||
                  (Math.abs(s - bestScore) < 1e-6 && best && F < best.F)) {
                bestScore = s; best = lay;
              }
            }
          }
        }
      }
    }

    const fixedScore = scoreLayout(FIXED_LAYOUT);
    const useFixed = fixedScore <= bestScore * FIXED_PREFERENCE;
    const lay = useFixed ? FIXED_LAYOUT : best;

    const result = {
      F: faces[lay.F], R: faces[lay.R], B: faces[lay.B], L: faces[lay.L],
      U: rot90(faces[lay.U], lay.rotU), D: rot90(faces[lay.D], lay.rotD),
      info: { layout: lay, usedFixed: useFixed,
              structure: faces.structure || null,
              ordering: faces.ordering || null,
              fixedScore: +fixedScore.toFixed(3),
              searchScore: +bestScore.toFixed(3),
              searchLayout: best },
    };
    // Orient the preview tiles with the SAME layout, giving a complete
    // low-res cube (Facebook previews are smear-filled at the poles).
    if (faces.previews && faces.previews.length === 6) {
      const p = faces.previews;
      result.previewCube = {
        F: p[lay.F], R: p[lay.R], B: p[lay.B], L: p[lay.L],
        U: rot90(p[lay.U], lay.rotU), D: rot90(p[lay.D], lay.rotD),
      };
    }
    return result;
  }

  /**
   * Project cubemap -> equirectangular (async, chunked by rows).
   * Faces may have DIFFERENT resolutions (truncated packs); each is
   * sampled at its native size. onProgress(fractionDone) is awaited
   * between chunks so callers can update UI / yield to the event loop.
   */
  async function projectEquirect(cube, width, onProgress, opts) {
    const { F, R, B, L, U, D } = cube;
    const W = width, H = width >> 1;
    const rowStart = (opts && opts.rowStart) | 0;
    const rowLimit = opts && opts.rowEnd != null ? opts.rowEnd : H;
    const out = new Uint8ClampedArray(W * (rowLimit - rowStart) * 4);

    const sinLon = new Float64Array(W), cosLon = new Float64Array(W);
    for (let c = 0; c < W; c++) {
      const lon = ((c + 0.5) / W) * 2 * Math.PI - Math.PI;
      sinLon[c] = Math.sin(lon); cosLon[c] = Math.cos(lon);
    }

    const CHUNK = 128;
    for (let row0 = rowStart; row0 < rowLimit; row0 += CHUNK) {
      const chunkEnd = Math.min(row0 + CHUNK, rowLimit);
      for (let r = row0; r < chunkEnd; r++) {
        const lat = Math.PI / 2 - ((r + 0.5) / H) * Math.PI;
        const sinLat = Math.sin(lat), cosLat = Math.cos(lat);
        let o = (r - rowStart) * W * 4;
        for (let c = 0; c < W; c++, o += 4) {
          const x = cosLat * sinLon[c];
          const y = sinLat;
          const z = cosLat * cosLon[c];
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
          out[o + 3] = 255;
        }
      }
      if (onProgress) await onProgress((chunkEnd - rowStart) / (rowLimit - rowStart));
    }
    return { data: out, width: W, height: rowLimit - rowStart, rowStart };
  }

  /**
   * Fill unphotographed black bands (truncated packs) with a
   * Facebook-style edge smear instead of black. Operates in-place on an
   * equirectangular pano. For each column, the boundary of real content
   * is found, an edge color is sampled a few rows INSIDE the content
   * (boundary rows carry a dark fringe from bilinear black-blending),
   * and the band is filled with that color, horizontally blurred with a
   * radius that grows toward the pole (converging-streak look). A
   * smoothstep blend zone straddles the boundary so the smear fades
   * into the content instead of meeting it at a hard line.
   */
  /**
   * Per-column fill depth from the top or bottom edge of an equirect
   * pano: the number of strictly-black rows before real content starts
   * (content = a 3-row run of non-black, skipping JPEG noise specks).
   * depth == H means the whole column is fill.
   */
  const FILL_BLACK = 10, FILL_RUN = 3;
  function bandDepths(pano, isTop) {
    const W = pano.width, H = pano.height, d = pano.data;
    const isContent = (r, c) => {
      const i = (r * W + c) * 4;
      return Math.max(d[i], d[i + 1], d[i + 2]) >= FILL_BLACK;
    };
    const contentRun = (r, c, dir) => {
      for (let k = 0; k < FILL_RUN; k++) {
        const rr = r + dir * k;
        if (rr < 0 || rr >= H || !isContent(rr, c)) return false;
      }
      return true;
    };
    const depth = new Int32Array(W);
    for (let c = 0; c < W; c++) {
      let t = H;
      if (isTop) {
        for (let r = 0; r < H; r++) {
          if (contentRun(r, c, 1)) { t = r; break; }
        }
      } else {
        for (let r = H - 1; r >= 0; r--) {
          if (contentRun(r, c, -1)) { t = H - 1 - r; break; }
        }
      }
      depth[c] = t;
    }
    return depth;
  }

  /**
   * Fill unphotographed black bands by re-projecting the PREVIEW cube
   * (Facebook's own preview tiles, smear-filled at the poles) into the
   * band regions. Near the boundary the projected preview shows the
   * same scene at low resolution, so the smoothstep blend transitions
   * sharp content into a soft version of itself — no synthetic seam.
   * Async (projects strips); mutates pano in place.
   */
  async function smearFillPreview(pano, previewCube, onProgress) {
    const W = pano.width, H = pano.height, d = pano.data;
    const BLEND = Math.max(12, (H / 140) | 0);

    async function fillBand(isTop) {
      const depth = bandDepths(pano, isTop);
      let any = false, maxDepth = 0, fullCol = false;
      for (let c = 0; c < W; c++) {
        if (depth[c] > 0) any = true;
        if (depth[c] >= H) fullCol = true;
        else if (depth[c] > maxDepth) maxDepth = depth[c];
      }
      if (!any) return;
      if (fullCol) maxDepth = H;

      const rows = Math.min(H, maxDepth + BLEND);
      const rowStart = isTop ? 0 : H - rows;
      const strip = await projectEquirect(previewCube, W, onProgress,
        { rowStart, rowEnd: rowStart + rows });
      const sd = strip.data;

      for (let e = 0; e < rows; e++) {
        const r = isTop ? e : H - 1 - e;
        const sr = isTop ? e : rows - 1 - e;
        for (let c = 0; c < W; c++) {
          const fd = depth[c];
          const i = (r * W + c) * 4;
          const j = (sr * W + c) * 4;
          if (e < fd) {
            d[i] = sd[j]; d[i + 1] = sd[j + 1]; d[i + 2] = sd[j + 2];
          } else if (e < fd + BLEND) {
            let a = 1 - (e - fd + 1) / (BLEND + 1);
            a = a * a * (3 - 2 * a); // smoothstep
            d[i]     = a * sd[j]     + (1 - a) * d[i];
            d[i + 1] = a * sd[j + 1] + (1 - a) * d[i + 1];
            d[i + 2] = a * sd[j + 2] + (1 - a) * d[i + 2];
          }
        }
      }
    }

    await fillBand(true);
    await fillBand(false);
    return pano;
  }

  function smearFill(pano) {
    const W = pano.width, H = pano.height, d = pano.data;
    const INSET = Math.max(3, H >> 9);
    const SAMPLE = Math.max(6, H >> 8);
    const BLEND = Math.max(10, (H / 170) | 0);
    const BASE_R = Math.max(2, W >> 9);
    const GROW_R = W / 12;

    /** Box blur of a W*3 color row with horizontal wraparound. */
    function wrapBlur(src, radius) {
      radius = Math.max(0, Math.min(radius | 0, (W >> 1) - 1));
      if (radius === 0) return Float32Array.from(src);
      const out = new Float32Array(W * 3);
      const win = 2 * radius + 1;
      for (let ch = 0; ch < 3; ch++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++) {
          sum += src[((k + W) % W) * 3 + ch];
        }
        for (let c = 0; c < W; c++) {
          out[c * 3 + ch] = sum / win;
          sum += src[((c + radius + 1) % W) * 3 + ch] -
                 src[((c - radius + W) % W) * 3 + ch];
        }
      }
      return out;
    }

    // depth[c] = fill rows measured from the given edge (top or bottom).
    function fillBand(isTop) {
      const depth = bandDepths(pano, isTop);
      let any = false;
      for (let c = 0; c < W; c++) {
        if (depth[c] > 0) { any = true; break; }
      }
      if (!any) return;

      // Edge colors sampled INSET..INSET+SAMPLE rows inside the content.
      const edge = new Float32Array(W * 3);
      const valid = new Uint8Array(W);
      const mean = [0, 0, 0];
      let nValid = 0;
      for (let c = 0; c < W; c++) {
        if (depth[c] >= H) continue;
        const r0 = depth[c] + INSET;
        let a0 = 0, a1 = 0, a2 = 0, n = 0;
        for (let k = 0; k < SAMPLE; k++) {
          const e = Math.min(H - 1, r0 + k);
          const r = isTop ? e : H - 1 - e;
          const i = (r * W + c) * 4;
          a0 += d[i]; a1 += d[i + 1]; a2 += d[i + 2]; n++;
        }
        edge[c * 3] = a0 / n; edge[c * 3 + 1] = a1 / n; edge[c * 3 + 2] = a2 / n;
        valid[c] = 1; nValid++;
        mean[0] += edge[c * 3]; mean[1] += edge[c * 3 + 1]; mean[2] += edge[c * 3 + 2];
      }
      if (nValid === 0) return;
      mean[0] /= nValid; mean[1] /= nValid; mean[2] /= nValid;
      for (let c = 0; c < W; c++) {
        if (!valid[c]) {
          edge[c * 3] = mean[0]; edge[c * 3 + 1] = mean[1]; edge[c * 3 + 2] = mean[2];
        }
      }

      // Pre-smooth the edge colors (two passes ~ gaussian-ish).
      const smoothEdge = wrapBlur(wrapBlur(edge, BASE_R), BASE_R);

      // Median fill depth for the blur-growth scale.
      const sorted = Int32Array.from(depth).sort();
      const med = Math.max(1, sorted[W >> 1]);

      let maxDepth = 0;
      for (let c = 0; c < W; c++) {
        if (depth[c] < H && depth[c] > maxDepth) maxDepth = depth[c];
      }

      for (let e = 0; e < Math.min(H, maxDepth + BLEND); e++) {
        // Blur grows from boundary (e ~ med) toward pole (e = 0).
        const frac = Math.max(0, 1 - e / med);
        const rowSmear = wrapBlur(smoothEdge, BASE_R + GROW_R * frac);
        const r = isTop ? e : H - 1 - e;
        for (let c = 0; c < W; c++) {
          const fd = depth[c];
          const i = (r * W + c) * 4;
          if (e < fd) {
            d[i] = rowSmear[c * 3];
            d[i + 1] = rowSmear[c * 3 + 1];
            d[i + 2] = rowSmear[c * 3 + 2];
          } else if (e < fd + BLEND) {
            let a = 1 - (e - fd + 1) / (BLEND + 1);
            a = a * a * (3 - 2 * a); // smoothstep
            d[i]     = a * rowSmear[c * 3]     + (1 - a) * d[i];
            d[i + 1] = a * rowSmear[c * 3 + 1] + (1 - a) * d[i + 1];
            d[i + 2] = a * rowSmear[c * 3 + 2] + (1 - a) * d[i + 2];
          }
        }
      }
    }

    fillBand(true);
    fillBand(false);
    return pano;
  }

  const api = { splitJpegs, stitchFaces, orientFaces, projectEquirect, smearFill, smearFillPreview, rot90, downsample };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PanoCore = api;
})(typeof self !== "undefined" ? self : globalThis);

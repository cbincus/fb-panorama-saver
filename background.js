/**
 * background.js — MV3 service worker.
 * Receives the panorama base URL from the content script, then:
 *   fetch pack -> split -> decode -> stitch -> orient -> project -> save.
 * All heavy lifting happens here, off the page's main thread.
 */
importScripts("core.js");

const MAX_OUTPUT_WIDTH = 16384; // cap for auto sizing (native width is
                                // 4 x face size; 4096-px faces -> 16384).
                                // Lower to 8192 on low-memory machines.

/** Format settings, editable in the extension's popup. */
const SETTINGS_DEFAULTS = { format: "jpg", qualityJpg: 92, qualityWebp: 80 };

const FORMATS = {
  jpg:  { mime: "image/jpeg", ext: "jpg",  qualityKey: "qualityJpg" },
  png:  { mime: "image/png",  ext: "png",  qualityKey: null },
  webp: { mime: "image/webp", ext: "webp", qualityKey: "qualityWebp" },
};

async function getSettings() {
  try {
    const stored = await chrome.storage.sync.get(SETTINGS_DEFAULTS);
    return { ...SETTINGS_DEFAULTS, ...stored };
  } catch {
    return { ...SETTINGS_DEFAULTS };
  }
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === "SAVE_PANORAMA" && sender.tab) {
    processPanorama(msg.url, sender.tab.id);
  }
  // Fire-and-forget; progress goes back via tabs.sendMessage.
});

function report(tabId, text, done = false, error = false) {
  chrome.tabs.sendMessage(tabId, { type: "PANO_PROGRESS", text, done, error })
    .catch(() => {}); // tab may have navigated away
}

async function processPanorama(url, tabId) {
  let packBytes = null;
  try {
    report(tabId, "Downloading tile pack…");
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) throw new Error(`Fetch failed: HTTP ${res.status}`);
    packBytes = new Uint8Array(await res.arrayBuffer());
    report(tabId, `Downloaded ${(packBytes.length / 1048576).toFixed(1)} MB`);

    const slices = PanoCore.splitJpegs(packBytes);
    if (slices.length < 2) {
      // Not a tile pack — a plain equirectangular JPEG. Save as-is.
      report(tabId, "Single image (not tiled) — saving directly");
      await downloadBytes(packBytes, "image/jpeg",
        `fb-panorama-${Date.now()}.jpg`);
      report(tabId, "Saved!", true);
      return;
    }

    report(tabId, `Decoding ${slices.length} tiles…`);
    const tiles = await decodeTiles(slices);

    report(tabId, "Stitching cube faces…");
    const faces = PanoCore.stitchFaces(tiles);

    report(tabId, "Detecting face layout…");
    const cube = PanoCore.orientFaces(faces);
    console.log("[Panorama Saver] layout:", cube.info);

    // Match output to source resolution: 4 x largest face = native
    // pixel density at the equator (8192 for standard packs, 16384 for
    // high-res 4096-px-face packs).
    const maxFace = Math.max(...faces.map((f) => f.width));
    const outWidth = Math.min(4 * maxFace, MAX_OUTPUT_WIDTH);
    report(tabId, `Projecting at ${outWidth}\u00d7${outWidth >> 1}\u2026`);

    const pano = await PanoCore.projectEquirect(cube, outWidth,
      async (frac) => {
        report(tabId, `Projecting… ${Math.round(frac * 100)}%`);
        await new Promise((r) => setTimeout(r, 0)); // yield
      });

    // Truncated packs (a face block below 20 tiles) have unphotographed
    // zenith/nadir bands; fill them by re-projecting Facebook's own
    // preview tiles (smear-filled at the poles) into the bands.
    if (cube.info.structure && cube.info.structure.some((b) => b < 20) &&
        cube.previewCube) {
      report(tabId, "Filling unphotographed bands…");
      await PanoCore.smearFillPreview(pano, cube.previewCube);
    }

    const settings = await getSettings();
    const fmt = FORMATS[settings.format] || FORMATS.jpg;
    report(tabId, `Encoding ${fmt.ext.toUpperCase()}\u2026`);
    const canvas = new OffscreenCanvas(pano.width, pano.height);
    const ctx = canvas.getContext("2d");
    ctx.putImageData(new ImageData(pano.data, pano.width, pano.height), 0, 0);
    const blobOpts = { type: fmt.mime };
    if (fmt.qualityKey) {
      const q = Number(settings[fmt.qualityKey]);
      blobOpts.quality = Math.min(100, Math.max(1, isFinite(q) ? q : 92)) / 100;
    }
    const blob = await canvas.convertToBlob(blobOpts);

    await downloadBytes(new Uint8Array(await blob.arrayBuffer()),
      fmt.mime,
      `fb-panorama-${pano.width}x${pano.height}-${Date.now()}.${fmt.ext}`);
    report(tabId, "Panorama saved!", true);
  } catch (err) {
    console.error("[Panorama Saver]", err);
    report(tabId, `Failed: ${err.message}`, true, true);
    // Fallback: at least save the raw pack so nothing is lost.
    if (packBytes) {
      try {
        await downloadBytes(packBytes, "image/jpeg",
          `fb-panorama-pack-${Date.now()}.jpg`);
        report(tabId, "Saved raw tile pack instead (unpack it with fb_pano_unpack.py)", true, true);
      } catch (_) { /* give up quietly */ }
    }
  }
}

/** Decode JPEG byte slices into {data,width,height} RGBA objects. */
async function decodeTiles(slices) {
  const first = await createImageBitmap(new Blob([slices[0]]));
  const ts = first.width;
  const canvas = new OffscreenCanvas(ts, ts);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  const tiles = [];
  for (const slice of slices) {
    let bmp;
    try {
      bmp = await createImageBitmap(new Blob([slice]));
    } catch {
      continue; // skip unreadable fragments
    }
    if (bmp.width !== ts || bmp.height !== ts) { bmp.close(); continue; }
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    const img = ctx.getImageData(0, 0, ts, ts);
    tiles.push({ data: img.data, width: ts, height: ts });
  }
  first.close();
  return tiles;
}

/**
 * Trigger a download from the service worker. MV3 workers lack
 * URL.createObjectURL, so we go through a base64 data URL.
 */
async function downloadBytes(bytes, mime, filename) {
  // Array-join instead of string concatenation: PNG output at full
  // resolution can exceed 60 MB, where repeated += gets slow.
  const parts = [];
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK)));
  }
  const dataUrl = `data:${mime};base64,${btoa(parts.join(""))}`;
  await chrome.downloads.download({ url: dataUrl, filename, saveAs: true });
}

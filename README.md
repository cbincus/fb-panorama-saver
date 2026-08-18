# FB Panorama Saver

Chrome extension (Manifest V3) that saves Facebook 360° photos as complete,
stitched equirectangular panoramas — one click, no server, no Python step.

## How it works

Facebook serves cubemap panoramas as a single "tile pack" file: many
concatenated JPEG tiles streamed via HTTP byte-range requests
(`bytestart`/`byteend` URL params).

Each cube face carries a resolution pyramid, stored highest level first
(row-major), and Facebook drops levels adaptively — so a face's pyramid is
**84** tiles (8×8 + 4×4 + 2×2), **20** (4×4 + 2×2), or **4** (2×2 only),
and different faces of the same pack may differ. Six preview tiles (one
per face) close out the pack. A full three-level pack is therefore 510
tiles, an all-4×4 pack is 126, and a maximally truncated one is 30.

Two tile *orderings* exist in the wild — face-major (each face's whole
pyramid contiguous; the current encoder) and level-major (every face's
highest level first, then every face's next level; older packs, e.g.
2016). Both the per-face composition and the ordering are recovered by
enumerating candidates and scoring each by how well adjacent tile edges
match inside the assembled faces.

The pipeline:

1. **content.js** — watches resource-timing entries for the panorama
   fingerprint: repeated byte-range requests to one fbcdn asset. Requests
   are grouped by URL **pathname**, because Facebook rotates tracking
   params (`_nc_gid`, …) between chunks, which would otherwise splinter
   one panorama into many single-chunk entries. The freshest URL minus
   the range params — signature params (`oh`/`oe`/`_nc_*`) intact — is
   what gets downloaded.
2. **background.js** — fetches the full pack, splits it at JPEG `FF D8 FF`
   markers, decodes tiles with `createImageBitmap`
3. **core.js** — stitches the six cube faces at their native resolutions,
   resolves face layout and up/down rotations, then projects the cubemap
   to equirectangular with bilinear sampling
4. Encodes in your chosen format via `OffscreenCanvas` and saves with
   `chrome.downloads`

### Face layout

Facebook's encoder writes faces in a fixed order (opposite pairs: {0,1}
front/back, {2,3} up/down, {4,5} right/left). That known layout is the
content-independent **default**. An exhaustive search over ~11.5k
candidate layouts (every up/down choice, side permutation, and up/down
rotation) is scored against all 12 cube seams at 128 px, and only
overrides the default when it beats it by more than 10%. Scoring uses
pure edge mismatch — no brightness or "sky is uniform" assumptions.

## Install

1. Download this folder
2. Open `chrome://extensions`, enable **Developer mode**
3. Click **Load unpacked**, select the folder

## Use

1. Open a 360° photo on facebook.com (click into the viewer)
2. Pan around briefly so the viewer streams tiles
3. The blue **⬇ Save panorama** button appears at the bottom-right *once a
   panorama is detected* — it stays hidden on ordinary pages, and resets
   itself when you navigate away. Click it.
4. The button doubles as a progress readout; when encoding finishes,
   Chrome opens a **Save As** dialog for the result

Files are named `fb-panorama-<width>x<height>-<timestamp>.<ext>`.

## Settings

Click the toolbar icon for the popup:

- **Format** — JPG (smallest), PNG (lossless, no quality setting, can
  exceed 200 MB at high resolution), or WEBP (smaller than JPG at
  comparable quality)
- **Quality** — 50–100 slider, shown for the lossy formats. JPG and WEBP
  keep independent values; defaults are 92 and 80.

Settings persist via `chrome.storage.sync` and are read at encode time.

## Notes

- Output size adapts to the source: 4 × the largest cube face, which is
  native pixel density at the equator (8192 wide when the biggest face is
  2048 px, 16384 for 4096-px faces). It is capped by `MAX_OUTPUT_WIDTH`
  in `background.js`, currently 16384 — lower it to 8192 on low-memory
  machines. High-res saves take longer and need ~2 GB of headroom.
- Truncated packs (any face reduced to its 2×2 level) lack zenith/nadir
  coverage. Those unphotographed bands are filled by re-projecting
  Facebook's own preview tiles — which are smear-filled at the poles —
  into the band, with a smoothstep blend straddling the boundary so
  sharp content fades into a soft version of itself rather than meeting a
  synthetic seam. An alternative streak-style fill (`smearFill`, which
  smears sampled edge colors with a pole-ward growing blur) remains
  available in `core.js`.
- If reconstruction fails (e.g. an unexpected pack layout), the raw tile
  pack is saved instead so nothing is lost; unpack it with the companion
  `fb_pano_unpack.py` script (not bundled here).
- Non-tiled (plain equirectangular) panoramas are detected — the pack
  splits into fewer than two JPEGs — and saved directly without
  processing.
- To make viewers auto-detect the result as 360°, add XMP metadata:
  `exiftool -ProjectionType=equirectangular panorama.jpg`
- `core.js` touches no browser APIs; it operates on plain
  `{data, width, height}` RGBA objects and exports via `module.exports`
  when required, so the pipeline runs identically in the service worker
  and in Node.
- Personal use only: respect content ownership and Facebook's terms.

## Permissions

| Permission | Why |
| --- | --- |
| `downloads` | Saving the finished panorama |
| `storage` | Persisting format/quality settings |
| `https://*.fbcdn.net/*` | Fetching the tile pack |

Content scripts run on `facebook.com` and its subdomains at
`document_idle`.

## Files

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest (v1.10) |
| `content.js` | Panorama detection + in-page button |
| `background.js` | Service worker: fetch → decode → save orchestration |
| `core.js` | Pure-JS split/stitch/orient/project pipeline |
| `popup.html` / `popup.js` | Format and quality settings |
| `images/` | Extension icons (16/32/48/128) |

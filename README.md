# FB Panorama Saver

Chrome extension that saves Facebook 360° photos as complete, stitched
equirectangular panoramas — one click, no server, no Python step.

## How it works

Facebook serves cubemap panoramas as a single "tile pack" file: 126
concatenated JPEG tiles (6 cube faces × 16 full-res + 4 mid-res tiles,
plus 6 previews), streamed via HTTP byte-range requests
(`bytestart`/`byteend` URL params). Two tile orderings exist in the
wild — face-major (each face's full pyramid contiguous; current
encoder) and level-major (all faces' full-res grids first, then all
mid-res grids; older packs, e.g. 2016) — and both are auto-detected
by seam scoring. This extension:

1. **content.js** — detects the pack's base URL by grouping the page's
   fbcdn requests by URL-minus-range-params (the panorama is the URL
   with many chunked requests)
2. **background.js** — fetches the full pack, splits it at JPEG `FF D8 FF`
   markers, decodes tiles with `createImageBitmap`
3. **core.js** — stitches the six 2048×2048 cube faces, auto-detects
   face adjacency and up/down rotations by edge matching, and projects
   the cubemap to an 8192×4096 equirectangular image (bilinear)
4. Encodes to JPEG via `OffscreenCanvas` and saves with `chrome.downloads`

## Install

1. Download this folder
2. Open `chrome://extensions`, enable **Developer mode**
3. Click **Load unpacked**, select the folder

## Use

1. Open a 360° photo on facebook.com (click into the viewer)
2. Pan around briefly so the viewer streams tiles
3. Click the blue **⬇ Save panorama** button (bottom-right)
4. The button shows progress; the finished JPEG lands in your downloads

## Notes

- Truncated packs (narrow panoramas without zenith/nadir coverage)
  are detected automatically; their unphotographed bands are filled by
  re-projecting Facebook's own preview tiles (smear-filled at the
  poles), blended smoothly into the real content at the boundary. An
  alternative streak-style fill (smearFill) remains available in
  core.js.
- Output size adapts to the source: 4 x the largest cube face (8192
  wide for standard packs, 16384 for high-res packs with 4096-px
  faces), capped by `MAX_OUTPUT_WIDTH` in `background.js` — lower the
  cap on low-memory machines. High-res saves take longer and need
  ~2 GB of headroom.
- If reconstruction fails (e.g. an unexpected pack layout), the raw tile
  pack is saved instead so nothing is lost; unpack it with the companion
  `fb_pano_unpack.py` script.
- To make viewers auto-detect the result as 360°, add XMP metadata:
  `exiftool -ProjectionType=equirectangular panorama.jpg`
- Non-tiled (plain equirectangular) panoramas are detected and saved
  directly without processing.
- Personal use only: respect content ownership and Facebook's terms.

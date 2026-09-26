# Facebook 360 Photo Saver — Chrome extension

Reconstructs a Facebook 360 photo as a single equirectangular image at native
resolution, with its Photo Sphere metadata embedded by default.

## Install

1. `chrome://extensions` → turn on **Developer mode**
2. **Load unpacked** → pick this folder
3. Open a Facebook 360 photo. The blue **Save panorama** button appears in the
   lower right once the viewer requests its first tile.

The chip on the button chooses the output format: Auto, JPG, PNG or WebP. The
same functionality is available from the console — `fb360.equirect()`,
`fb360.status()`, `fb360.cancel()`, `fb360.selfTest()`, `fb360.debug = true`,
and the rest; the header comment in `fb360.js` documents them and their
options.

### Panorama metadata

By default the saved file carries a Photo Sphere (GPano) XMP packet, which is
what lets Facebook, Google Photos and VR viewers show it as 360. The format
menu (the chip on the button) has an **Embed panorama metadata (recommended)**
checkbox, ticked by default; untick it to save the pixels alone. The choice is
remembered across reloads. From the console, the same setting is
`fb360.saveButton.embedMetadata = false`, or per run
`fb360.equirect({embedMetadata: false})`. WebP cannot carry the packet either
way.

No permissions are requested. The extension has no background service worker,
no popup and no options page; everything happens in the page.

## Files

| File | World | What it is |
| --- | --- | --- |
| `manifest.json` | — | MV3. Two content scripts, one web-accessible resource. |
| `fb360.js` | MAIN | The script. |
| `projection-core.js` | MAIN + worker | `rot90` and `projectEquirect`, one copy. |
| `projector-host.js` | ISOLATED | Puts the projector frame in the page. |
| `projector.html` | extension | The frame. |
| `projector-frame.js` | extension | Starts the worker, relays messages. |
| `projector-worker.js` | worker | The projection worker. |
| `test/relay.test.js` | — | `node test/relay.test.js` |

## How it works

`fb360.js` runs in the page's own world (`"world": "MAIN"`), which is what lets
it patch the page's `fetch` and `XMLHttpRequest` rather than a wrapper the
viewer never calls. It is injected at `document_start` on every facebook.com
page, because clicking through to a photo from the feed never loads a
`/photo/` URL from the network.

### The projection worker

WebGL is the default projection path. When it is unavailable or fails, the
projection falls back to a CPU worker, and the page's world cannot start that
worker itself: facebook.com's CSP has no `blob:` in `worker-src`, and an
extension file has no page-origin URL to load from either.

So it is started from a context the page's CSP does not govern.
`projector-host.js` — the isolated world, where `chrome.*` exists — puts an
off-screen `chrome-extension://` frame in the document. Inside that frame
`projector-worker.js` is an ordinary same-origin script, allowed by the
extension's own CSP, and `projector-frame.js` relays messages between it and the
page. The relay finds the `ArrayBuffer`s in each message and transfers them
onward, so a 4096×4096 face moves rather than being copied twice on its way
through.

`startWorker()` returns a proxy with the four members the rest of the code uses
— `postMessage(msg, transfer)`, `onmessage`, `onerror`, `terminate()` — and the
handshake is the worker's own `{type: "ready"}` travelling back through the
relay. If the frame or the worker cannot be started, the projection runs on the
main thread instead.

`projection-core.js` holds the one copy of `rot90` and `projectEquirect`: the
page loads it as a content script, and the worker loads it through
`importScripts`.

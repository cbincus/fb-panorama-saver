// Facebook 360 Photo Saver — a Chrome extension (MV3).
//
// The manifest injects this file at document_start with "world": "MAIN": the
// script has to run in the *page* context to patch the page's own window.fetch
// and XMLHttpRequest, and an isolated world would patch a wrapper the viewer
// never calls.
//
// The extension's files:
//
//   fb360.js             this file — page world, the whole script
//   projection-core.js   rot90 + projectEquirect, loaded into both worlds that
//                        need them so there is one copy of each
//   projector-host.js    isolated world; puts the projector frame in the page
//   projector.html       the frame — an extension-origin document
//   projector-frame.js   inside it: starts the worker and relays messages
//   projector-worker.js  the CPU projection worker
//
// The projector-* files exist only for the CPU projection worker, which this
// page cannot start itself; see startWorker().


/* fb360 — reconstruct a Facebook 360 photo as an equirectangular image.
 *
 * A blue "Save panorama" button appears in the lower right corner of the
 * window as soon as a panorama is detected, so nothing here requires the
 * console. It reports what a run is doing while it runs — mapping tiles,
 * which face is downloading, encoding, embedding metadata — with a progress
 * bar and a cancel control, because a level 3 crawl is several hundred
 * round-trips and a silent button is indistinguishable from a hung one.
 * Detection and the button are the same event: the button appears disabled
 * ("360 photo detected") the moment a tileset id is locked, and enables when
 * the viewer's tile request supplies the template a download needs.
 * fb360.saveButton.hide() / .show() control it; a console-initiated
 * fb360.equirect() drives the same display. The button also carries a
 * permanent note that this instance is locked to the first panorama it saw
 * and that a different one needs a new tab, because the lock outlives both a
 * finished download and an in-app navigation to another photo.
 *
 * The chip on the right of the button chooses the output format — Auto, JPG,
 * PNG or WebP — and the choice is remembered across reloads. Formats this
 * browser cannot encode are shown disabled rather than hidden, and WebP is
 * labelled as carrying no metadata, because it does not: see the format and
 * quality notes below. fb360.saveButton.format reads and sets the same
 * preference, and .formats lists what this browser can actually produce.
 * Below the formats, an "Embed panorama metadata (recommended)" checkbox
 * decides whether the XMP packet goes into the file. It is ticked by default,
 * remembered across reloads like the format, and mirrored by
 * fb360.saveButton.embedMetadata.
 *
 * The hook locks permanently to the first tileset id it sees, learns that
 * panorama's request template, then drives the API itself. A different
 * panorama is ignored until the page is reloaded:
 *
 *     fb360.status()                     what has been captured so far
 *     fb360.captured()                   which levels the browser has loaded
 *     fb360.cancel()                     stop whatever is currently running
 *     fb360.uninstall()                  remove the fetch/XHR hooks entirely
 *     await fb360.selfTest()             check the projection geometry and the
 *                                        bounds maths
 *     fb360.debug = true                 enable verbose capture diagnostics
 *     await fb360.coverage()             which tiles actually exist, as a map
 *     await fb360.equirect()             the panorama, native size, as a single
 *                                        image with its Photo Sphere XMP embedded
 *
 * equirect() is active: it asks the server for every tile that exists at the
 * deepest available level, rather than reusing whatever the viewer happened to
 * load. It therefore needs a captured request template, which the viewer
 * produces as soon as it requests its first tile — so open the photo first.
 *
 * Partial panoramas are the normal case, not an error — but absence of tiles
 * is NOT how Facebook signals them. A partial panorama still has all six cube
 * faces and all their tiles; the ones outside the captured region are padding
 * (usually black). The viewer masks them geometrically in its shader, using a
 * field of view derived from the spherical metadata, and so does this script.
 *
 * That metadata lives in the Relay payload, which reaches the page two
 * different ways. A full page load inlines it in the HTML. An in-app
 * navigation from the feed loads no HTML at all, and the same payload — same
 * shape, same field names — arrives as a GraphQL response instead. Both are
 * searched, so the panorama the viewer is already showing can always be
 * measured. The tile queries carry the tileset id in their variables
 * ({"id":"264386...","tileInfoList":[...]}), and the same id appears beside
 * spherical_metadata and max_tile_level in whichever payload describes this
 * photo. The Facebook post/photo URL, author/profile URL, creation time and
 * accompanying text are read outward from that same anchored encoding, through
 * whichever layout the page used — the story sits above the photo in a feed
 * post and below it on a photo page — while refusing to descend into comment
 * or reshare branches, so a commenter is never mistaken for the author.
 * Anchoring the
 * lookup on that id is what keeps it exact wherever the payload came from: it
 * cannot take metadata from another photo, post or encoding. GraphQL responses
 * that mention spherical_metadata are cached verbatim for this lookup and for
 * nothing else; tile responses are still read only for their tile URLs.
 * fb360.metadata shows the spherical fields, fb360.facebookMetadata shows the
 * descriptive fields, and fb360.status() reports which of the two sources the
 * metadata actually came from. With bounds known:
 * padding tiles are never fetched, partly-covered tiles are clipped exactly,
 * and the equirect is cropped to the region that was really photographed.
 * Nothing is invented to fill the rest.
 *
 * Options:
 *
 *     {width: N}              override the output width (used exactly as
 *                             given; never scaled by the level factor below)
 *     {level: N}              build at a specific level (3 is the ceiling;
 *                             see MAX_PUBLIC_TILE_LEVEL). A level below the
 *                             deepest available one has 1/2 the linear
 *                             resolution per step, so the output is sized
 *                             down to match rather than upsampled to native:
 *                             factor = 2^(maxLevel - level), and the sphere
 *                             (hence the cropped output) is divided by it.
 *                             Level == maxLevel, and therefore the default
 *                             equirect() with no level, is unaffected.
 *     {crop: false}           keep the full sphere instead of cropping to it
 *     {hFovDeg, vFovDeg}      supply the captured region if it was not captured
 *     {hCenterDeg, vCenterDeg} where that region is centred, if not on (0, 0)
 *     {bounds: false}         disable trimming entirely (keeps the padding)
 *     {trim: false}           keep the outermost edge rows even if they came
 *                             out non-opaque (default: trim up to 4px)
 *     {useAncestors:false}    do not backfill edge squares from coarser levels
 *     {prune: false}          survey every tile instead of using the quadtree
 *     {fillFromLevel0: true}  smear the level 0 tile over uncaptured area
 *     {format: "webp"}        output format (see below)
 *     {quality: 0.9}          encoder quality for the lossy formats
 *     {embedMetadata: false}  write the image without its XMP packet (on by
 *                             default; the packet is still returned as xmp)
 *     {concurrency: N}        tile downloads in flight at once (default 12)
 *     {urlConcurrency: N}     tile-url GraphQL queries in flight at once
 *                             (default 10). One query per tile: the endpoint
 *                             does not batch, see queryTiles().
 *     {projection: "auto"}    default: use WebGL for cubemap -> equirectangular
 *                             projection, with the existing CPU Worker/main-
 *                             thread projector as an automatic fallback.
 *                             "cpu" forces the CPU projector; "webgl" requires
 *                             GPU.
 *     {refetch: false}        do not ask for a fresh url when one has expired
 *                             (on by default; a level 3 crawl outlives its own
 *                             survey's signatures)
 *
 * Transient network failures (429, 5xx, timeouts, dropped connections) are
 * retried with jittered exponential backoff and Retry-After support, because a
 * level 3 crawl is several hundred round-trips and losing all of it to one blip
 * is not a reasonable failure mode. Permanent failures (400, GraphQL schema
 * errors) still abort immediately — retrying those only wastes the server's
 * time. fb360.cancel() takes effect at the next await checkpoint, including
 * during a backoff sleep.
 *
 * The two throughput knobs are both about network round-trips, not CPU, and
 * they apply to consecutive stages. `urlConcurrency` is how many tile-url
 * queries are in flight; `concurrency` is how many of the resulting urls are
 * then being downloaded as images at once. Every tile costs one query of its
 * own — the endpoint answers a multi-tile tileInfoList with an empty `tiles`
 * array, so there is nothing to amortise — which makes urlConcurrency the only
 * lever over the survey's request rate. Neither knob has anything to do with
 * threads: both stages are a single thread waiting on many sockets, so
 * lowering either to 1 does not simplify anything, it just idles the thread
 * through every round-trip in turn — an unpruned level 3 survey is about 500
 * of them, which is minutes rather than seconds. Raise them if the connection
 * is fast and idle, lower them if Facebook starts rate-limiting.
 *
 * Format and quality:
 *
 *     {format: "auto"}        the default. JPEG when the panorama is fully
 *                             opaque, PNG when it has transparent regions
 *                             (a crop, or a gap where tiles failed to load).
 *     {format: "jpeg"}        also "jpg", "png", "webp", or the full MIME
 *                             type ("image/jpeg"). Unknown values are
 *                             rejected outright rather than quietly
 *                             becoming JPEG, and a format this browser
 *                             cannot encode is rejected before any work
 *                             starts rather than after.
 *     {quality: 0.0 .. 1.0}   JPEG and WebP only; PNG is lossless and
 *                             ignores it. Default 0.92. A number above 1 is
 *                             read as a percentage, so 85 means 0.85.
 *     {quality: "lossless"}   WebP only — encodes losslessly (quality 1.0),
 *                             which is what Chrome's WebP encoder treats as
 *                             its lossless mode.
 *
 * The filename's extension comes from the MIME type the encoder actually
 * produced, read back off the Blob, not from the one that was requested. The
 * two differ whenever a browser silently falls back — toBlob is specified to
 * emit PNG for any type it cannot encode — and a .webp holding PNG bytes is
 * worse than an honest .png.
 *
 * Output is one image file. It carries XMP inside it — an APP1 segment for
 * JPEG, an iTXt chunk for PNG — holding Photo Sphere (GPano) geometry plus,
 * when found in the same anchored Story, the Facebook source URL,
 * author/profile, creation time and post text. WebP output cannot carry it yet
 * and warns. {embedMetadata: false} — or unticking "Embed panorama metadata"
 * in the button's format menu — leaves the packet out of the file entirely;
 * equirect() still returns it as `xmp`, and reports metadataEmbedded.
 *
 * Notes worth reading before you run it:
 *
 * - Facebook is an SPA, so the hook survives in-app navigation. It must be
 *   injected at document-start and site-wide rather than only on /photo/*:
 *   clicking through to a photo from the feed never loads a /photo/ URL from
 *   the network, so a photo-only pattern would miss exactly this case.
 * - The hook has to run in the *page* context to patch the page's own
 *   window.fetch and XMLHttpRequest. An isolated-world injection would patch a
 *   wrapper the viewer never calls.
 * - One script instance handles ONE panorama. The first tile request with a
 *   tileset id locks the instance to that id. Tile requests, metadata and late
 *   responses for every other panorama are ignored and cannot replace the
 *   request template or mutate tile state. Reload the page before downloading
 *   another panorama. fb360.reset() clears working state but does NOT unlock it.
 * - Tile urls are signed and expire after a while. A survey whose urls have
 *   aged out is repaired in place rather than reported as failures — see
 *   {refetch} above.
 * - Tiles are served with permissive CORS (the viewer itself sets
 *   img.crossOrigin = "anonymous"), so the stitching canvas does not get
 *   tainted and toBlob works.
 * - Faces are stitched one at a time. At level 3, the ceiling, a face is
 *   4096x4096 — 64 MiB as raw canvas pixels, and ~384 MiB for all six.
 * - Projection prefers WebGL. Each assembled cube face is uploaded as one
 *   texture, reprojected by a fragment shader, and released before the next
 *   face is assembled, so native output never retains six 4096x4096 RGBA
 *   faces at once. The equirectangular output
 *   is rendered through a reusable tiled WebGL buffer (normally <=4096px per
 *   side) and composited into the final 2D canvas, so a 12000x6000 panorama
 *   does not need a 12000x6000 GPU framebuffer. If WebGL is unavailable, a face
 *   texture exceeds the hardware limit, or GPU projection fails, "auto" retries
 *   with the CPU projector: one Web Worker, with a main-thread fallback if that
 *   worker cannot be started either.
 * - That worker is the one thing this page cannot start for itself.
 *   facebook.com's CSP has no blob: in worker-src, and an extension file has no
 *   page-origin URL, so it is started from the extension's own origin instead:
 *   the isolated world puts an off-screen chrome-extension:// frame in the
 *   document, and that frame — same-origin with the worker script, under the
 *   extension's CSP rather than Facebook's — starts it and relays messages
 *   with transfers intact; see startWorker().
 *
 * Layout, for reference: level L has 2^L x 2^L tiles on each of 6 faces,
 * row 0 at the top, col 0 at the left, faces indexed
 * 0=-X 1=-Z 2=+X 3=+Z 4=+Y 5=-Y.
 */

(() => {
  "use strict";

  if (window.fb360 && window.fb360.__installed) {
    console.log("%cfb360%c already installed — use fb360.status()",
      "color:#fff;background:#1877f2;padding:2px 6px;border-radius:3px", "");
    return;
  }

  const FACE_NAMES = ["minus_x", "minus_z", "plus_x", "plus_z", "plus_y", "minus_y"];
  const MINUS_X = 0, MINUS_Z = 1, PLUS_X = 2, PLUS_Z = 3, PLUS_Y = 4, MINUS_Y = 5;
  const VIEWER_SUMMARY_IDLE_MS = 1500;

  const state = {
    template: null,   // latest {url, body, headers} from a real tile request
    encodingId: null,
    docId: null,
    maxTileLevel: null,
    // Effective tile state used by active operations. Viewer-observed answers
    // are mirrored here too; fb360's own GraphQL queries update only this store.
    pairs: new Map(),   // "Level: L|Face: F|Col: C|Row: R" -> uri
    pairsAt: new Map(), // same key -> Date.now() when that uri arrived
    resolved: new Set(),// tiles with a valid server answer (present or explicitly absent)
    // Strictly viewer-observed state, kept separate from the survey's own
    // results so captured() and status() can report what the Facebook viewer
    // actually loaded rather than what fb360 went on to fetch itself.
    viewerPairs: new Map(),
    viewerPairsAt: new Map(),  // same key -> Date.now() when the VIEWER saw it
    viewerResolved: new Set(),
    // Background viewer-capture diagnostics are aggregated by default. Set
    // fb360.debug = true to see the per-response tile messages.
    viewerTilesLoaded: 0,
    viewerTilesSkipped: 0,
    viewerResponsesSkipped: 0,
    // Failures on the request side of the hook are counted, not silent. A body
    // that mentions tileInfoList but does not parse is the exact signature of
    // Facebook changing its request encoding, and otherwise the only symptom
    // would be status() saying "no tile request seen yet" on a page where
    // tiles were visibly loading. These turn that from a mystery into a
    // diagnosis.
    graphqlParseFailures: 0,
    graphqlBodiesUnreadable: 0,
    lastGraphqlParseFailure: null,
    // Tile queries ask for exactly one tile, so the only two sane answers are
    // one uri or none. Anything longer means the response shape moved under us.
    // queryTiles takes the first uri and carries on, which is the right
    // recovery but an invisible one, and a silent change here would surface
    // much later as a misaligned mosaic. This is the canary for status().
    oddTileResponses: 0,
    generation: 0,      // operation epoch: initial lock/cancel/reset invalidate in-flight work
    coverage: null,
    foreignTileRequestsIgnored: 0,
    foreignTilesetWarned: false,
    bounds: null,      // metadata-derived bounds only; explicit FOV overrides are call-local
    meta: null,
    metaSource: null,   // "page source" or "graphql response" — whichever answered
    facebookMeta: null, // author/post/source data tied to the same anchored Story
    facebookMetaSource: null,
    facebookMetaMissFor: null,
    facebookMetaMissAt: 0,
    boundsWarned: false,
    // Cache a failed lookup briefly. resolveBounds() and level selection
    // can ask for the same metadata back-to-back; this avoids immediately
    // serialising the multi-megabyte document twice, while still allowing a
    // later retry if Facebook injects the payload after the first attempt.
    metaMissFor: null,
    metaMissAt: 0,
    // The Relay payload does not always arrive as HTML (see metadataSources).
    // Counters only: the payloads themselves are held outside `state`, because
    // publicState() spreads state into fb360.state and these are megabytes.
    graphqlResponsesScanned: 0,
    graphqlMetadataPayloads: 0,
    graphqlMetadataChars: 0,
  };

  const log = (...a) => console.log(
    "%cfb360%c", "color:#fff;background:#1877f2;padding:2px 6px;border-radius:3px",
    "", ...a);
  const warn = (...a) => console.warn(
    "%cfb360%c", "color:#fff;background:#c9770a;padding:2px 6px;border-radius:3px",
    "", ...a);

  let debug = false;
  let viewerSummaryTimer = null;
  let viewerSummaryPrintedLoaded = 0;
  let viewerSummaryPrintedSkipped = 0;

  const debugLog = (...a) => { if (debug) log(...a); };
  const debugWarn = (...a) => { if (debug) warn(...a); };

  function scheduleViewerSummary() {
    if (debug) return;
    if (viewerSummaryTimer !== null) clearTimeout(viewerSummaryTimer);
    viewerSummaryTimer = setTimeout(() => {
      viewerSummaryTimer = null;
      if (debug) return;
      const loaded = state.viewerTilesLoaded;
      const skipped = state.viewerTilesSkipped;
      if (loaded === viewerSummaryPrintedLoaded &&
          skipped === viewerSummaryPrintedSkipped) return;
      viewerSummaryPrintedLoaded = loaded;
      viewerSummaryPrintedSkipped = skipped;
      log(`viewer capture summary: ${loaded} tile${loaded === 1 ? "" : "s"} loaded, ` +
          `${skipped} skipped`);
    }, VIEWER_SUMMARY_IDLE_MS);
  }

  function setDebug(value) {
    debug = !!value;
    if (debug && viewerSummaryTimer !== null) {
      clearTimeout(viewerSummaryTimer);
      viewerSummaryTimer = null;
    } else if (!debug &&
               (state.viewerTilesLoaded !== viewerSummaryPrintedLoaded ||
                state.viewerTilesSkipped !== viewerSummaryPrintedSkipped)) {
      scheduleViewerSummary();
    }
    return debug;
  }

  // ------------------------------------------------------------------
  // Progress channel
  // ------------------------------------------------------------------
  //
  // One place the on-page button (and anything else) can listen to, so the
  // download logic never has to know that a DOM exists. Listeners are
  // deliberately isolated: a throwing listener must not be able to abort a
  // download that has already spent minutes on the network.
  //
  // Event shapes:
  //   {phase: "detected", id}          a tileset id was locked
  //   {phase: "ready"}                 a request template exists — equirect() can run
  //   {phase: "idle"}                  reset() discarded the template
  //   {phase: "start"}                 a run began
  //   {phase: "stage", text, fraction} what the run is doing now (fraction 0..1)
  //   {phase: "done", text, detail}    the file was handed to the browser
  //   {phase: "cancelled", text}       cancel()/reset() invalidated the run
  //   {phase: "error", text}           the run failed
  //   {phase: "uninstalled"}           tear the UI down
  const progressListeners = new Set();
  function subscribeProgress(fn) {
    progressListeners.add(fn);
    return () => progressListeners.delete(fn);
  }
  function emitProgress(event) {
    if (!progressListeners.size) return;
    for (const fn of [...progressListeners]) {
      try { fn(event); }
      catch (e) { debugWarn("a progress listener threw", e); }
    }
  }

  // Stage text is emitted for every tile the survey resolves, which is a few
  // hundred events at level 3. The listener only ever paints the newest one, so
  // identical consecutive messages are dropped here rather than in the UI.
  let lastStageText = null;
  function stage(text, fraction) {
    if (text === lastStageText && fraction == null) return;
    lastStageText = text;
    emitProgress({ phase: "stage", text, fraction });
  }

  // Coarse weights for the progress bar. They only have to be monotonic and
  // roughly proportional to wall-clock time; fetching and projecting the
  // faces genuinely dominates everything else at any level worth using.
  const PROGRESS_SURVEY_START = 0.02;
  const PROGRESS_FACES_START = 0.15;
  const PROGRESS_FINISH_START = 0.85;
  const surveyFraction = (done, total) => total > 0
    ? PROGRESS_SURVEY_START +
      (PROGRESS_FACES_START - PROGRESS_SURVEY_START) * Math.min(1, done / total)
    : PROGRESS_SURVEY_START;
  // `within` is 0..1 through this one face: tiles first, projection after.
  const faceFraction = (ordinal, total, within) => total > 0
    ? PROGRESS_FACES_START + (PROGRESS_FINISH_START - PROGRESS_FACES_START) *
      Math.min(1, Math.max(0, (ordinal - 1 + within) / total))
    : PROGRESS_FACES_START;
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

  // The level is read back out of a key in a few places. Both the writer and
  // the readers derive the offset from one constant, so changing the key
  // format cannot silently yield a wrong level number — which a hardcoded
  // slice would: parseInt of the wrong slice returns NaN or a
  // plausible-but-wrong integer rather than throwing.
  const TILE_KEY_LEVEL_PREFIX = "Level: ";
  const tileKey = t =>
    `${TILE_KEY_LEVEL_PREFIX}${t.level}|Face: ${t.face}|Col: ${t.col}|Row: ${t.row}`;
  const levelOfKey = k => parseInt(k.slice(TILE_KEY_LEVEL_PREFIX.length), 10);

  // Every long-running public operation is bound to the locked panorama and to
  // the current operation epoch. The panorama id never changes during a script
  // lifetime; generation changes on initial lock and when cancel()/reset() invalidates work.
  function beginOperation(name) {
    return { name, encodingId: state.encodingId, generation: state.generation };
  }
  function assertOperation(op) {
    if (!op) return;
    if (op.generation !== state.generation || op.encodingId !== state.encodingId) {
      // Tagged, not string-matched. The button reports a cancel as a cancel
      // and a real failure as a failure, and "aborted" appearing in some
      // unrelated network error message cannot blur the two.
      const err = new Error(`${op.name || "fb360 operation"} aborted: operation state was invalidated`);
      err.fb360Aborted = true;
      throw err;
    }
  }

  // ------------------------------------------------------------------
  // Tile urls expire; tile keys do not identify a photo
  // ------------------------------------------------------------------
  //
  // Two separate lifetime problems, both of which would otherwise end in a
  // silently wrong image rather than an error.
  //
  // 1. The urls Facebook hands back are signed and time-limited. An aged-out
  //    pair is worse than no pair: loadImage just resolves null and the tile is
  //    reported as "had a url but failed to load". So every pair records when
  //    it arrived, a stale one stops counting as *resolved* (the survey re-asks
  //    for it) while still counting as *present* (the tile does exist), and the
  //    loader repairs one on the spot rather than leaving a hole.
  //
  // 2. tileKey carries no tileset id, so mixing two panoramas would be fatal.
  //    That is prevented structurally: the first tileset id wins and all
  //    later ids are rejected before they can mutate the request template/state.
  const PAIR_TTL_MS = 20 * 60 * 1000;
  const pairAge = k => {
    const at = state.pairsAt.get(k);
    return at == null ? Infinity : Date.now() - at;
  };
  const setPair = (k, uri) => {
    const isNew = !state.pairs.has(k);
    state.pairs.set(k, uri);
    state.pairsAt.set(k, Date.now());
    return isNew;
  };
  const setViewerPair = (k, uri) => {
    const isNew = !state.viewerPairs.has(k);
    state.viewerPairs.set(k, uri);
    // Timestamped separately from state.pairsAt. The two stores can disagree:
    // an active refetch refreshes state.pairsAt for a tile whose viewer-observed
    // url is still the stale original.
    // Without this, captured() could not tell "the viewer never saw this tile"
    // from "the viewer saw it half an hour ago and the signature has aged out",
    // which are the same symptom (loadImage resolves null) with opposite fixes.
    state.viewerPairsAt.set(k, Date.now());
    return isNew;
  };
  const viewerPairAge = k => {
    const at = state.viewerPairsAt.get(k);
    return at == null ? Infinity : Date.now() - at;
  };

  // How many of the viewer's urls at a level have outlived the signing TTL.
  // Reported by status(); the build path refreshes expired urls itself.
  function staleViewerTiles(level) {
    let stale = 0, total = 0, oldest = 0;
    for (const k of state.viewerPairs.keys()) {
      if (level != null && levelOfKey(k) !== level) continue;
      total++;
      const age = viewerPairAge(k);
      if (age >= PAIR_TTL_MS) stale++;
      if (age !== Infinity && age > oldest) oldest = age;
    }
    return { stale, total, oldestMinutes: Math.round(oldest / 60000) };
  }
  const dropPair = k => {
    state.pairs.delete(k);
    state.pairsAt.delete(k);
    state.resolved.delete(k);
  };

  // Everything here is scoped to the single locked panorama. It is cleared only
  // by fb360.reset(); navigation never switches this state to another photo.
  function forgetPhoto() {
    state.pairs.clear();
    state.pairsAt.clear();
    state.resolved.clear();
    state.oddTileResponses = 0;
    state.viewerPairs.clear();
    state.viewerPairsAt.clear();
    state.viewerResolved.clear();
    state.coverage = null;
    state.bounds = null;
    state.meta = null;
    state.metaSource = null;
    state.facebookMeta = null;
    state.facebookMetaSource = null;
    state.facebookMetaMissFor = null;
    state.facebookMetaMissAt = 0;
    state.maxTileLevel = null;
    state.boundsWarned = false;
    state.metaMissFor = null;
    state.metaMissAt = 0;
  }

  // Lock to the first identifiable panorama for this script lifetime. A second
  // id is not a "navigation" to handle; it is foreign input and is rejected
  // before captureTemplate()/record() can touch the locked panorama's state.
  function lockEncodingId(id) {
    if (id == null) return false;
    id = String(id);
    if (state.encodingId) {
      if (id === state.encodingId) return true;
      state.foreignTileRequestsIgnored++;
      if (!state.foreignTilesetWarned) {
        state.foreignTilesetWarned = true;
        warn(`ignoring panorama ${id}: this fb360 instance is locked to ` +
             `${state.encodingId}. Reload the page to download another panorama.`);
      }
      return false;
    }

    state.encodingId = id;
    state.generation++;

    // The id is now known, so the metadata lookup — over the page source and
    // over any GraphQL payload already captured — can be anchored exactly to
    // this panorama on its first use.
    state.metaMissFor = null;
    state.metaMissAt = 0;
    state.facebookMetaMissFor = null;
    state.facebookMetaMissAt = 0;
    state.boundsWarned = false;
    log(`locked to tileset ${id} — reload the page before downloading another panorama`);
    // The panorama is now identified. The button appears here rather than
    // waiting for the template, so a detected photo is visible immediately;
    // it stays disabled until the "ready" event below, which is what makes
    // equirect() able to run at all. In practice the two are the same tile
    // request a few statements apart.
    emitProgress({ phase: "detected", id });
    return true;
  }

  // ------------------------------------------------------------------
  // Interception — learn the request template, record any pairs seen
  // ------------------------------------------------------------------

  // GraphQL interception serves two separate purposes, and they must not be
  // confused with each other. Tile requests/responses are parsed for tile urls
  // and for the replay template, and only when they belong to the locked
  // tileset. Every other GraphQL response is read for one reason: it may carry
  // the Relay payload holding this photo's spherical_metadata, which on an
  // in-app navigation is never inlined in the HTML. Those responses are handed
  // to noteGraphqlSource() and are never a source of tile urls.

  function isGraphql(url) {
    try { return /\/api\/graphql\/?$/.test(new URL(url, location.origin).pathname); }
    catch { return false; }
  }

  // Note the asymmetry: a body with no "tileInfoList" in it is simply one of
  // the many GraphQL requests this page makes, and is not counted. Once the
  // substring IS present the request is meant to be a tile query, so every
  // later failure is a real parse failure and worth recording.
  function noteParseFailure(why) {
    state.graphqlParseFailures++;
    state.lastGraphqlParseFailure = why;
    debugWarn(`could not parse a tile request body: ${why}`);
    return null;
  }

  function parseTileRequest(body) {
    if (!body || typeof body !== "string" || body.indexOf("tileInfoList") === -1) return null;
    let variables;
    try {
      variables = new URLSearchParams(body).get("variables");
    } catch {
      return noteParseFailure("body is not form-encoded");
    }
    if (!variables) return noteParseFailure("no `variables` field in the body");
    let parsed;
    try { parsed = JSON.parse(variables); }
    catch { return noteParseFailure("`variables` is not valid JSON"); }
    const list = parsed && parsed.tileInfoList;
    if (!Array.isArray(list)) return noteParseFailure("`tileInfoList` is not an array");
    if (!list.length) return noteParseFailure("`tileInfoList` is empty");
    return { tiles: list, encodingId: parsed.id != null ? String(parsed.id) : null };
  }

  function collectTileResponse(node, out) {
    if (node == null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const v of node) collectTileResponse(v, out);
      return;
    }
    if (Array.isArray(node.errors) && node.errors.length) {
      for (const e of node.errors) {
        out.errors.push(String((e && e.message) || "GraphQL error"));
      }
    }
    if (Array.isArray(node.tiles)) {
      out.tileArrays++;
      for (const t of node.tiles) out.uris.push(t && t.uri ? t.uri : null);
    }
    for (const k of Object.keys(node)) {
      if (k !== "tiles" && k !== "errors") collectTileResponse(node[k], out);
    }
  }

  // Parsing success, GraphQL success and an actual tile payload are separate
  // facts. A response that cannot be parsed, contains GraphQL errors, or no
  // longer has the expected `tiles` structure is NOT evidence that a tile is
  // absent; callers must throw/ignore it and leave the tile state unknown.
  function parseTileResponse(text) {
    const out = { uris: [], errors: [], parsed: 0, tileArrays: 0 };
    const clean = String(text || "").replace(/^\s*for\s*\(;;\);/, "");
    for (const line of clean.split("\n")) {
      const v = line.trim();
      if (!v) continue;
      try {
        const parsed = JSON.parse(v);
        out.parsed++;
        collectTileResponse(parsed, out);
      } catch { /* streamed/pretty-printed body: whole-object fallback below */ }
    }
    if (!out.parsed) {
      try {
        const parsed = JSON.parse(clean.trim());
        out.parsed = 1;
        collectTileResponse(parsed, out);
      } catch { /* invalid response */ }
    }
    return out;
  }


  // Record a response generated by the Facebook viewer. It updates both the
  // effective store and the viewer-only store. fb360's own queryTiles() path
  // deliberately updates only the effective store below.
  function record(tiles, uris) {
    if (uris.length !== tiles.length) {
      // Positional pairing is the only link between a tile and its URL, so a
      // length mismatch has to be discarded rather than guessed at.
      state.viewerTilesSkipped += tiles.length;
      state.viewerResponsesSkipped++;
      debugWarn(`skipped a response: asked for ${tiles.length} tiles, got ${uris.length} uris`);
      scheduleViewerSummary();
      return 0;
    }
    let n = 0;
    for (let i = 0; i < tiles.length; i++) {
      const k = tileKey(tiles[i]);
      state.resolved.add(k);
      state.viewerResolved.add(k);
      if (!uris[i]) {
        state.pairs.delete(k);
        state.pairsAt.delete(k);
        state.viewerPairs.delete(k);
        state.viewerPairsAt.delete(k);
        continue;
      }
      // Last-wins in both stores when the viewer itself supplies a newer signed URL.
      const isNewViewer = setViewerPair(k, uris[i]);
      setPair(k, uris[i]);
      if (isNewViewer) n++;
    }
    if (n) {
      state.viewerTilesLoaded += n;
      scheduleViewerSummary();
    }
    return n;
  }

  function captureTemplate(url, body, headers) {
    // Keep the newest real tile request rather than the first one forever.
    // Facebook can rotate fb_dtsg/lsd/jazoest, doc_id, friendly-name headers,
    // and other Relay form fields during a long SPA session. postTiles()
    // replays this body and changes only the two tile-specific variables, so
    // freshness of the surrounding request matters.
    if (!body || typeof body !== "string") return false;
    let params;
    try { params = new URLSearchParams(body); }
    catch { return false; }
    const rawVars = params.get("variables");
    if (!rawVars) return false;
    let vars;
    try { vars = JSON.parse(rawVars); }
    catch { return false; }
    if (!Array.isArray(vars && vars.tileInfoList)) return false;

    // Defense in depth: callers already reject foreign tile requests, but the
    // replay template is too security/correctness-sensitive to rely on that
    // convention. Never let a request without the exact locked id replace it.
    const requestId = vars.id != null ? String(vars.id) : null;
    if (!state.encodingId || requestId !== String(state.encodingId)) return false;

    const first = !state.template;
    const oldDocId = state.docId;
    state.template = {
      url,
      body,
      headers: { ...(headers || {}) },
      capturedAt: Date.now(),
    };
    state.docId = params.get("doc_id");
    if (first) {
      log("captured request template — you can now run fb360.equirect()");
      emitProgress({ phase: "ready" });
    } else if (oldDocId && state.docId && oldDocId !== state.docId) {
      log(`updated tile request template (doc_id ${oldDocId} -> ${state.docId})`);
    }
    return true;
  }

  const TILE_URI_QUERY = "Comet360PhotoTiledCubemapDataProvider_tileUriQuery";

  function observeTileResponse(url, body, headers, text, requestCtx = null) {
    try {
      const req = requestCtx && requestCtx.req ? requestCtx.req : parseTileRequest(body);
      if (!req) return;

      // Accepted requests are tagged at SEND time. A generation mismatch means
      // cancel()/reset() invalidated this response. Untagged/deferred responses
      // must still prove that they belong to the one locked tileset.
      if (requestCtx) {
        if (requestCtx.generation !== state.generation ||
            requestCtx.encodingId !== state.encodingId) {
          log(`ignored an invalidated tile response for ${requestCtx.encodingId || "unknown tileset"}`);
          return;
        }
      } else {
        if (!req.encodingId || !lockEncodingId(req.encodingId)) return;
      }

      captureTemplate(url, body, headers);
      const parsed = parseTileResponse(text);
      if (parsed.errors.length) {
        warn(`ignored tile response with GraphQL error: ${parsed.errors[0]}`);
        return;
      }
      if (!parsed.parsed || !parsed.tileArrays) {
        warn("ignored tile response with an unexpected/invalid GraphQL payload");
        return;
      }
      const got = record(req.tiles, parsed.uris);
      if (got) debugLog(`+${got} viewer tile${got > 1 ? "s" : ""} ` +
        `(${state.viewerPairs.size} viewer-captured, ${state.pairs.size} effective)`);
    } catch (e) { warn("tile response observation failed", e); }
  }

  function tagTileRequest(url, body, headers) {
    const req = parseTileRequest(body);
    if (!req || !req.encodingId) return null;       // identity is mandatory now
    if (!lockEncodingId(req.encodingId)) return null;

    // Only traffic belonging to the locked panorama may replace the replay template.
    captureTemplate(url, body, headers);
    return { req, encodingId: state.encodingId, generation: state.generation };
  }

  // A Request object can carry the body and headers instead of `init`, and
  // fetch(new Request(url, {method: "POST", body})) is entirely legal. Reading
  // only `init` would see body === null for that shape, so the tile request
  // would go unrecognised and status() would report "no tile request seen
  // yet" on a page where tiles were visibly loading. Facebook does not
  // currently use it, which is exactly why it needs handling rather than
  // assuming.
  function requestCarriesBody(input) {
    try {
      if (!input || typeof input !== "object") return false;
      if (typeof input.clone !== "function" || typeof input.text !== "function") {
        return false;
      }
      const m = String(input.method || "GET").toUpperCase();
      return m !== "GET" && m !== "HEAD";
    } catch { return false; }
  }

  // fetch
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    let url = "", body = null, headers = {};
    try {
      url = typeof input === "string" ? input : (input && input.url) || "";
      body = init && typeof init.body === "string" ? init.body : null;
      if (init && init.headers) {
        const h = init.headers;
        if (h instanceof Headers) h.forEach((v, k) => { headers[k] = v; });
        else if (Array.isArray(h)) for (const [k, v] of h) headers[k] = v;
        else Object.assign(headers, h);
      }
    } catch { /* ignore */ }

    if (!isGraphql(url)) return origFetch.apply(this, arguments);

    // A Request object can carry the body instead of init. Start reading a
    // clone immediately so we can identify a tile request without consuming
    // the Request that Facebook itself is about to send.
    let deferredBody = null;
    if (body == null && requestCarriesBody(input)) {
      try {
        const clone = input.clone();
        try {
          if (clone.headers && typeof clone.headers.forEach === "function") {
            clone.headers.forEach((v, k) => {
              if (!(k in headers)) headers[k] = v;
            });
          }
        } catch { /* ignore */ }
        deferredBody = clone.text().then(t => t || null).catch(() => {
          state.graphqlBodiesUnreadable++;
          return null;
        });
      } catch {
        // The Request refused to clone, so this request's body is
        // unobservable. Counted rather than ignored: it is the other way the
        // hook can miss a tile request that is plainly being made.
        state.graphqlBodiesUnreadable++;
      }
    }

    // With a normal string body we know synchronously whether this is a tile
    // request. Non-tile GraphQL responses are still read while metadata is
    // outstanding, because one of them may be carrying it.
    const requestCtx = deferredBody ? null : tagTileRequest(url, body, headers);
    const deferredCtx = deferredBody
      ? deferredBody.then(sent => ({ sent, requestCtx: tagTileRequest(url, sent, headers) }))
      : null;

    const p = origFetch.apply(this, arguments);
    p.then(res => {
      if (!res.ok) return;

      if (!deferredCtx) {
        // A response is worth buffering if it is a tile response, or if the
        // metadata is still outstanding and this could be the payload that
        // carries it. Once both are settled, nothing here reads a body again.
        if (!requestCtx && !wantsMetadataHarvest()) return;
        let cloned;
        try { cloned = res.clone(); } catch { return; }
        cloned.text().then(t => {
          noteGraphqlSource(t);
          if (requestCtx) observeTileResponse(url, body, headers, t, requestCtx);
        }).catch(() => {});
        return;
      }

      // We do not know the Request-object body synchronously. Clone the
      // response now, before the page can consume it; if the deferred body
      // proves this was neither a tile request nor a metadata payload, the
      // clone is simply discarded.
      let cloned;
      try { cloned = res.clone(); } catch { return; }
      deferredCtx.then(({ sent, requestCtx: ctx }) => {
        if (!ctx && !wantsMetadataHarvest()) return;
        return cloned.text().then(t => {
          noteGraphqlSource(t);
          if (ctx) observeTileResponse(url, sent, headers, t, ctx);
        });
      }).catch(() => {});
    }).catch(() => {});
    return p;
  };
  // Kept so uninstall() can check that nothing patched fetch after we did.
  const hookedFetch = window.fetch;

  // XMLHttpRequest
  const XO = XMLHttpRequest.prototype.open;
  const XS = XMLHttpRequest.prototype.send;
  const XH = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (method, url) {
    // Reusing an XHR object resets the request, so the listener belonging to
    // the previous one has to go with it. Otherwise the listeners would
    // accumulate for as long as the object is reused, and each stale one would
    // re-observe the OLD request's url, body and requestCtx against the NEW
    // response — record()'s length check catches some mismatches, but only
    // one listener per request is actually safe.
    if (this.__fb360Listener) {
      try { this.removeEventListener("load", this.__fb360Listener); }
      catch { /* ignore */ }
      this.__fb360Listener = null;
    }
    this.__fb360 = { url, headers: {} };
    return XO.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    if (this.__fb360) this.__fb360.headers[k] = v;
    return XH.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    try {
      const m = this.__fb360;
      if (m && isGraphql(m.url)) {
        const sent = typeof body === "string" ? body : null;
        const requestCtx = tagTileRequest(m.url, sent, m.headers);
        if (requestCtx || wantsMetadataHarvest()) {
          // One listener per object, tracked so open() can detach it. A tile
          // response is recorded; any other response is only scanned for the
          // metadata payload, and that scan stops once the metadata is known.
          if (this.__fb360Listener) {
            try { this.removeEventListener("load", this.__fb360Listener); }
            catch { /* ignore */ }
          }
          const listener = () => {
            try {
              if (this.status < 200 || this.status >= 300) return;
              const rt = this.responseType;
              if (rt && rt !== "text") return;
              if (!requestCtx && !wantsMetadataHarvest()) return;
              const text = this.responseText;
              noteGraphqlSource(text);
              if (requestCtx) {
                observeTileResponse(m.url, sent, m.headers, text, requestCtx);
              }
            } catch { /* ignore */ }
          };
          this.__fb360Listener = listener;
          this.addEventListener("load", listener);
        }
      }
    } catch { /* ignore */ }
    return XS.apply(this, arguments);
  };


  // max_tile_level sits beside spherical_metadata in the tileset object, so it
  // comes from the same id-anchored lookup. A bare regex over the page would
  // return the first max_tile_level on it, which need not be this photo's.
  function scrapeMaxTileLevel() {
    if (state.maxTileLevel != null) return state.maxTileLevel;
    try { loadTilesetMetadata(state.encodingId); } catch { /* ignore */ }
    return state.maxTileLevel != null ? state.maxTileLevel : null;
  }

  // ------------------------------------------------------------------
  // Driving the API ourselves
  // ------------------------------------------------------------------

  // Transport failures come in two kinds, and they are treated differently.
  //
  // A 400, a 403 or a GraphQL schema error is permanent: retrying changes
  // nothing and the operation should stop. A 429, a 5xx, a timeout or a
  // dropped connection is transient — and a level 3 crawl is several hundred
  // round-trips over minutes, so losing all of it to one blip would make the
  // tool fail more often than it works.
  //
  // Retries are bounded, honour Retry-After, and are jittered so that pool()'s
  // twelve lanes do not resynchronise into a second thundering herd against a
  // server that has just asked for less traffic. assertOperation runs at the
  // top of every attempt, so a cancel during backoff takes effect immediately.
  const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
  const TILE_REQUEST_TIMEOUT_MS = 30000;
  const MAX_TILE_REQUEST_RETRIES = 4;

  async function fetchTiles(url, init, op) {
    let delay = 500;
    for (let attempt = 0; ; attempt++) {
      assertOperation(op);
      let res = null, err = null;
      const ac = typeof AbortController === "function" ? new AbortController() : null;
      const timer = ac
        ? setTimeout(() => ac.abort(), TILE_REQUEST_TIMEOUT_MS) : null;
      try {
        res = await origFetch(url, ac ? { ...init, signal: ac.signal } : init);
      } catch (e) {
        err = e;
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
      if (res && res.ok) return res;

      const what = err
        ? (err.name === "AbortError"
            ? `timed out after ${TILE_REQUEST_TIMEOUT_MS}ms`
            : (err.message || String(err)))
        : `HTTP ${res.status}`;
      const transient = !!err || TRANSIENT_STATUS.has(res.status);
      if (!transient || attempt >= MAX_TILE_REQUEST_RETRIES) {
        throw new Error(`tile GraphQL request failed: ${what}` +
          (attempt ? ` (gave up after ${attempt + 1} attempts)` : ""));
      }

      const ra = res ? Number(res.headers.get("retry-after")) : NaN;
      const wait = Number.isFinite(ra) && ra > 0
        ? Math.min(ra * 1000, 30000)
        : delay + Math.random() * 250;
      warn(`tile query failed (${what}); retrying in ${Math.round(wait)}ms ` +
        `— attempt ${attempt + 2} of ${MAX_TILE_REQUEST_RETRIES + 1}`);
      await new Promise(r => setTimeout(r, wait));
      delay = Math.min(delay * 2, 15000);
    }
  }

  // Replaying the captured body verbatim and swapping only `variables` keeps
  // fb_dtsg, lsd, jazoest and the rest intact, which is far more robust than
  // trying to reconstruct them.
  async function postTiles(tiles, op = null) {
    if (!state.template) throw new Error(
      "No request template captured yet. Open the 360 photo first, then retry.");
    assertOperation(op);
    const photoId = op ? op.encodingId : state.encodingId;
    if (!photoId) throw new Error("no active tileset id");

    // Snapshot the latest template for this replay. A viewer tile request may
    // arrive while this function is awaiting the network and refresh
    // state.template for the next batch; one batch must remain internally
    // consistent. All captured GraphQL variables are preserved below, with
    // only id and tileInfoList replaced.
    const template = state.template;
    const params = new URLSearchParams(template.body);
    let variables = {};
    try {
      const raw = params.get("variables");
      variables = raw ? JSON.parse(raw) : {};
    } catch {
      throw new Error("captured tile request has invalid GraphQL variables");
    }
    variables.id = String(photoId);
    variables.tileInfoList = tiles.map(t =>
      ({ col: t.col, face: t.face, level: t.level, row: t.row }));
    params.set("variables", JSON.stringify(variables));

    const headers = {};
    for (const [k, v] of Object.entries(template.headers)) {
      if (!/^(cookie|host|content-length)$/i.test(k)) headers[k] = v;
    }
    headers["content-type"] = "application/x-www-form-urlencoded";

    // fetchTiles retries the transient failures and only ever returns an ok
    // response, so everything below this line is a schema-level concern.
    const res = await fetchTiles(template.url, {
      method: "POST", body: params.toString(), headers,
      credentials: "include", mode: "same-origin",
    }, op);
    assertOperation(op);
    const text = await res.text();
    assertOperation(op);
    const parsed = parseTileResponse(text);
    if (parsed.errors.length) {
      throw new Error(`tile GraphQL error: ${parsed.errors[0]}`);
    }
    if (!parsed.parsed || !parsed.tileArrays) {
      throw new Error("tile GraphQL response had an unexpected payload; tile state left unknown");
    }
    return parsed.uris;
  }

  // A tile has three states: present, explicitly absent, or unknown. Only a
  // structurally valid, error-free GraphQL answer may move a tile out of
  // unknown. Transport/schema errors therefore abort the operation instead of
  // being converted into permanent holes.
  // The endpoint answers one tile per request and nothing else. Facebook's own
  // viewer never asks for more than one, and a tileInfoList carrying two
  // entries comes back with an empty `tiles` array rather than two uris. That
  // was verified against the live endpoint, not inferred, and it is worth
  // stating here because the shape of the API invites the opposite assumption:
  // tileInfoList is a list, `tiles` is an array, and a multi-tile request is
  // accepted with a 200. It is simply answered with nothing.
  //
  // So there is no batching to be had, and the only lever over the survey's
  // request rate is how many single-tile queries are in flight at once. This
  // is the default; {urlConcurrency} overrides it per run.
  const TILE_QUERY_CONCURRENCY = 10;

  // The other throughput knob: how many tile images are downloaded at once
  // once their urls are known. buildFace() and runEquirect() both default
  // {concurrency} to this, so it is defined once for both of them.
  const TILE_DOWNLOAD_CONCURRENCY = 12;

  // How often the survey writes a "urls d/t" line to the console. A fixed
  // stride, so a logging decision is not tied to any throughput knob.
  const URL_PROGRESS_LOG_STRIDE = 64;

  async function queryTiles(tiles, op = null) {
    if (!tiles.length) return [];
    assertOperation(op);

    // Fan out rather than batch. pool() writes each lane's result back to its
    // original index, so the returned array still lines up with `tiles`, and
    // it stops the surviving lanes and rethrows on the first failure, so a
    // cancel mid-survey does not leave a dozen queries running against a photo
    // nobody is looking at.
    if (tiles.length > 1) {
      return pool(tiles, TILE_QUERY_CONCURRENCY,
        async t => (await queryTiles([t], op))[0]);
    }

    const uris = await postTiles(tiles, op);
    assertOperation(op);

    // One tile asked for, so there is nothing to pair and no ambiguity to
    // recover from: a uri means present, an empty answer means the tile does
    // not exist. postTiles has already rejected anything that was not a
    // structurally valid, error-free response, so an empty `tiles` array here
    // is evidence of absence rather than of a failed request.
    if (uris.length > 1) state.oddTileResponses++;
    const uri = uris.length ? uris[0] : null;

    const k = tileKey(tiles[0]);
    state.resolved.add(k);
    if (uri) setPair(k, uri);
    else {
      state.pairs.delete(k);
      state.pairsAt.delete(k);
    }
    return [uri];
  }

  function enumerateTiles(level) {
    const n = 1 << level, out = [];
    for (let face = 0; face < 6; face++)
      for (let row = 0; row < n; row++)
        for (let col = 0; col < n; col++)
          out.push({ level, face, col, row });
    return out;
  }

  const tileState = t => {
    const k = tileKey(t);
    if (state.pairs.has(k)) return "present";
    if (state.resolved.has(k)) return "absent";
    return "unknown";
  };
  const isPresent = t => tileState(t) === "present";
  const isResolved = t => {
    const k = tileKey(t);
    const s = tileState(t);
    if (s === "unknown") return false;
    if (s === "absent") return true;      // explicit absence does not expire
    return pairAge(k) < PAIR_TTL_MS;       // signed present URL does expire
  };

  async function resolveTiles(tiles, concurrency, onProgress, op = null) {
    const todo = tiles.filter(t => !isResolved(t));
    if (todo.length) {
      // One pool over the whole set rather than a chunked loop: chunking would
      // put a barrier at the end of every chunk, where every lane waits on the
      // slowest one before any can start again.
      await pool(todo, concurrency, async t => {
        assertOperation(op);
        return (await queryTiles([t], op))[0];
      }, onProgress);
      assertOperation(op);
    }
    return tiles.filter(isPresent);
  }


  // ------------------------------------------------------------------
  // Angular bounds — the real shape of a partial panorama
  // ------------------------------------------------------------------
  //
  // A partial panorama still has all six cube faces, and the tiles outside the
  // captured region still exist and still download — they are just padding
  // (usually black). Absence is NOT how Facebook signals partial coverage.
  // The viewer's fragment shader masks geometrically instead:
  //
  //   hAngle = atan(x, -z);  vAngle = atan(y, sqrt(x*x + z*z));
  //   in bounds if |hAngle| < hFov/2 and |vAngle| < vFov/2
  //
  // with the field of view coming from the spherical metadata:
  //
  //   hFov = cropped_area_image_width_pixels  / full_pano_width_pixels  * 2pi
  //   vFov = cropped_area_image_height_pixels / full_pano_height_pixels * pi
  //
  // Everything outside those bounds is padding and must be dropped, not drawn.

  // Forward mapping: (s, t) in [-1,1] on a face -> direction.
  const FACE_DIR = {
    [MINUS_Z]: (s, t) => [s, t, -1],
    [PLUS_X]:  (s, t) => [1, t, s],
    [MINUS_X]: (s, t) => [-1, t, -s],
    [PLUS_Z]:  (s, t) => [-s, t, 1],
    [PLUS_Y]:  (s, t) => [-s, 1, -t],
    [MINUS_Y]: (s, t) => [-s, -1, t],
  };

  function anglesOf(d) {
    return [Math.atan2(d[0], -d[2]), Math.atan2(d[1], Math.hypot(d[0], d[2]))];
  }

  function inBounds(dir, b, margin = 0) {
    if (!b) return true;
    const [h, v] = anglesOf(dir);
    // Horizontal offsets wrap: a region centred near +/-180 straddles the seam
    // and is still one contiguous interval about its centre once wrapped.
    const hc = b.hCenter || 0;
    const dh = hc ? Math.atan2(Math.sin(h - hc), Math.cos(h - hc)) : h;
    const dv = v - (b.vCenter || 0);
    return Math.abs(dh) <= b.h / 2 + margin && Math.abs(dv) <= b.v / 2 + margin;
  }

  // A bounds object is a captured region: an angular size AND the centre it
  // sits on. Both offsets are carried through, and every angular test —
  // inBounds's mask and equirectGeometry's crop — is taken relative to them.
  //
  // Vertically off-centre crops are the common case, not an edge case: a
  // handheld 360 capture almost always covers more sky than ground, so
  // cropped_area_top_pixels is routinely far from centre. Assuming a centred
  // crop would put the mask on the horizon while the content is not, and the
  // panorama would come out clipped along one horizontal edge and padded
  // along the other, with no warning at all.
  function metadataToBounds(m) {
    const hRatio = m.cropped_area_image_width_pixels / m.full_pano_width_pixels;
    const vRatio = m.cropped_area_image_height_pixels / m.full_pano_height_pixels;
    const b = {
      // The ratios are fractions of the sphere, not angles: the viewer scales
      // them by a full turn horizontally and a half turn vertically.
      h: hRatio * 2 * Math.PI,
      v: vRatio * Math.PI,
      hCenter: 0, vCenter: 0,
      source: "spherical_metadata", meta: m,
    };

    // Column i has lon = (i + 0.5)/W * 2pi - pi, so the crop's centre column
    // maps to ((left + w/2)/W - 0.5) * 2pi.
    if (Number.isFinite(m.cropped_area_left_pixels)) {
      b.hCenter = ((m.cropped_area_left_pixels +
        m.cropped_area_image_width_pixels / 2) /
        m.full_pano_width_pixels - 0.5) * 2 * Math.PI;
    }
    // Row j has lat = pi/2 - (j + 0.5)/H * pi, so row 0 is the NORTH pole and
    // the sign is inverted relative to the horizontal case.
    if (Number.isFinite(m.cropped_area_top_pixels)) {
      b.vCenter = (0.5 - (m.cropped_area_top_pixels +
        m.cropped_area_image_height_pixels / 2) /
        m.full_pano_height_pixels) * Math.PI;
    }

    // A region that runs past a pole is not describable as a centre plus a
    // half-angle, and clamping it is closer to the truth than trusting it.
    const over = Math.abs(b.vCenter) + b.v / 2 - Math.PI / 2;
    if (over > 1e-9) {
      warn(`this panorama's declared vertical crop runs ${(over * 180 / Math.PI)
        .toFixed(2)}° past the pole; clamping it`);
      b.v = Math.max(0, 2 * (Math.PI / 2 - Math.abs(b.vCenter)));
    }

    b.full = boundsAreFull(b);
    if (!b.full && (b.hCenter || b.vCenter)) {
      log(`captured region centre: heading ${(b.hCenter * 180 / Math.PI).toFixed(1)}°, ` +
        `pitch ${(b.vCenter * 180 / Math.PI).toFixed(1)}°`);
    }
    return b;
  }

  // Full horizontally means the whole turn regardless of where it is centred;
  // full vertically additionally requires the centre to be on the horizon,
  // since a half-turn hung off centre does not reach both poles.
  const boundsAreFull = b =>
    b.h >= 2 * Math.PI - 1e-6 && b.v >= Math.PI - 1e-6 &&
    Math.abs(b.vCenter || 0) < 1e-6;

  // ------------------------------------------------------------------
  // Spherical metadata, anchored on the tileset id
  // ------------------------------------------------------------------
  //
  // The tile queries carry the tileset id in their variables:
  //
  //   {"id":"26438677315720003","tileInfoList":[{"col":1,...}]}
  //
  // That same id appears in the Relay payload, in the object that also holds
  // spherical_metadata and max_tile_level as sibling keys — whether that
  // payload was inlined in the page or arrived as a GraphQL response.
  // Anchoring on the id is what makes this exact: a session can describe
  // several photos and several encodings per photo, and picking metadata by
  // field name alone can pair a cropped width from one with a full width from
  // another — a wrong field of view that still looks plausible. That risk is
  // higher, not lower, because the search spans responses as well as the page.

  // Brace counting has to ignore braces inside strings, so this walks the text
  // as a tokenizer would rather than scanning for characters.
  function enclosingObjectStarts(text, upTo) {
    const stack = [];
    let inStr = false, esc = false;
    for (let i = 0; i < upTo; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === "{") stack.push(i);
      else if (c === "}") stack.pop();
    }
    return stack;   // outermost first
  }

  // How far balancedObjectAt() will scan for the closing brace before giving
  // up, so an unbalanced or enormous page object cannot become an unbounded
  // walk over the whole document.
  const MAX_BALANCED_OBJECT_CHARS = 4e6;

  function balancedObjectAt(text, start, limit = MAX_BALANCED_OBJECT_CHARS) {
    let depth = 0, inStr = false, esc = false;
    const end = Math.min(text.length, start + limit);
    for (let i = start; i < end; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === "{") depth++;
      else if (c === "}") { if (--depth === 0) return text.slice(start, i + 1); }
    }
    return null;
  }

  // ------------------------------------------------------------------
  // The other place the same payload arrives
  // ------------------------------------------------------------------
  //
  // A full page load inlines the Relay payload in the HTML, so the lookup can
  // find it in document.scripts. An in-app navigation from the feed loads no
  // HTML: the photo's payload arrives as a GraphQL response instead, in the
  // identical format, and a page-source-only lookup therefore found nothing on
  // exactly the page where the viewer was visibly displaying the panorama.
  // Those responses are cached here so the same id-anchored search can run
  // over them.
  //
  // Two properties keep this bounded. Only responses that actually mention
  // spherical_metadata are kept — the same precondition the search applies to
  // a page source, and true of almost no GraphQL traffic. And harvesting stops
  // altogether once the metadata is complete, so the steady state after a
  // successful lookup is the original one: nothing but tile responses is read.
  //
  // The payloads are held here rather than on `state` deliberately:
  // publicState() spreads state into fb360.state, and these are megabytes.
  const MAX_GRAPHQL_METADATA_PAYLOADS = 6;
  const MAX_GRAPHQL_METADATA_CHARS = 12e6;      // total held across payloads
  const MAX_ONE_GRAPHQL_PAYLOAD_CHARS = 8e6;
  const graphqlMetadataPayloads = [];           // oldest first: {key, text}
  const graphqlMetadataKeys = new Set();

  // Metadata is wanted until both halves are known. The descriptive half is
  // optional and may never appear, so this can stay true for the life of the
  // tab; the cost of that is one indexOf per GraphQL response.
  const wantsMetadataHarvest = () => !(state.meta && state.facebookMeta);

  // Cheap identity for deduplication. Facebook re-sends the same payload on
  // back/forward navigation, and both hooks can observe one response.
  const payloadKey = text => `${text.length}:${text.slice(0, 96)}`;

  // Called with every GraphQL response body the hooks can read. Returns true
  // when the body was kept as a metadata source.
  function noteGraphqlSource(text) {
    try {
      if (typeof text !== "string" || !text) return false;
      state.graphqlResponsesScanned++;
      if (text.indexOf("spherical_metadata") === -1) return false;
      if (text.length > MAX_ONE_GRAPHQL_PAYLOAD_CHARS) {
        debugWarn(`ignored a ${(text.length / 1e6).toFixed(1)}M-char GraphQL ` +
          "payload carrying spherical_metadata: over the per-payload cache limit");
        return false;
      }
      const key = payloadKey(text);
      if (graphqlMetadataKeys.has(key)) return false;

      graphqlMetadataKeys.add(key);
      graphqlMetadataPayloads.push({ key, text });
      state.graphqlMetadataChars += text.length;
      while (graphqlMetadataPayloads.length > MAX_GRAPHQL_METADATA_PAYLOADS ||
             (graphqlMetadataPayloads.length > 1 &&
              state.graphqlMetadataChars > MAX_GRAPHQL_METADATA_CHARS)) {
        const dropped = graphqlMetadataPayloads.shift();
        graphqlMetadataKeys.delete(dropped.key);
        state.graphqlMetadataChars -= dropped.text.length;
      }
      state.graphqlMetadataPayloads = graphqlMetadataPayloads.length;
      debugLog("cached a GraphQL response carrying spherical_metadata " +
        `(${graphqlMetadataPayloads.length} held)`);

      // A payload naming the locked tileset is new evidence about THIS
      // panorama, so the "looked and did not find it" caches must not go on
      // answering null for the rest of their window. Payloads that do not
      // name it are kept but change nothing: they describe another photo, or
      // arrived before a tileset was locked, and the miss caches are keyed by
      // id anyway (lockEncodingId clears them when the id is finally known).
      if (!state.encodingId || text.indexOf(`"${state.encodingId}"`) === -1) {
        return true;
      }
      state.metaMissFor = null;
      state.metaMissAt = 0;
      state.facebookMetaMissFor = null;
      state.facebookMetaMissAt = 0;

      // Resolve now rather than at build time. The work is the same either
      // way, but doing it here reports the captured region while the user is
      // still looking at the photo, instead of minutes later mid-build.
      if (!state.meta) {
        try { loadTilesetMetadata(state.encodingId); } catch { /* ignore */ }
      }
      return true;
    } catch (e) {
      debugWarn("could not inspect a GraphQL response for metadata", e);
      return false;
    }
  }

  // A generator, not an array, because the last source is expensive:
  // serialising a Facebook document is multiple megabytes of string, and
  // building it eagerly would mean paying for it on every lookup even when the
  // answer is sitting in the first <script> tag. The captured GraphQL
  // payloads sit between the two: they are already strings in memory, so they
  // cost one indexOf each, and after an in-app navigation they are the only
  // place the metadata exists at all. innerHTML is yielded last and only
  // reached when nothing above it matched.
  function* metadataSources() {
    let scripts = [];
    try { scripts = [...document.scripts]; } catch { /* ignore */ }
    for (const sc of scripts) {
      let t = null;
      try { t = sc.textContent; } catch { /* ignore */ }
      if (t && t.length) yield { text: t, origin: "page source" };
    }
    // Newest first: the most recent payload is the likeliest to describe the
    // photo now on screen. The id anchor is what makes the match exact; this
    // only decides which of two equally valid answers is reached first.
    for (let i = graphqlMetadataPayloads.length - 1; i >= 0; i--) {
      yield { text: graphqlMetadataPayloads[i].text, origin: "graphql response" };
    }
    // Some builds inline the payload outside <script>.
    let html = null;
    try {
      html = document.documentElement ? document.documentElement.innerHTML : null;
    } catch { /* ignore */ }
    if (html) yield { text: html, origin: "page source" };
  }

  // Find the object that declares `id` and read its spherical_metadata and
  // max_tile_level siblings. While we already have the exact tileset occurrence,
  // also walk outward to the enclosing Facebook Story and harvest descriptive
  // metadata. The Story relationship is important: a Facebook page can contain
  // many posts, authors, mentions and photos, so a page-wide field search would
  // very easily attach somebody else's text or profile to the panorama.
  // Search ONE source text. Pure, and identical for an inlined page payload
  // and for a GraphQL response body: the response wrapper (a for(;;); prefix,
  // one JSON object per line) contains no braces of its own, and a completed
  // line's braces have popped off the stack again by the time a later line is
  // reached, so the brace walk needs no special case for it.
  function scanSourceForTileset(text, id) {
    const needle = '"' + id + '"';
    if (text.indexOf(needle) === -1) return null;
    if (text.indexOf("spherical_metadata") === -1) return null;

    let best = null;
    let from = 0;
    for (let guard = 0; guard < 20; guard++) {
      const at = text.indexOf(needle, from);
      if (at === -1) break;
      from = at + needle.length;

      const starts = enclosingObjectStarts(text, at);
      let tileset = null;
      let facebook = null;

      // The encoding object is normally the innermost object. The enclosing
      // Story is several levels farther out. Scan outward only through a
      // bounded number of ancestors so a giant page-level bootstrap object
      // cannot turn one metadata lookup into repeated multi-megabyte parses.
      const minK = Math.max(0, starts.length - 16);
      for (let k = starts.length - 1; k >= minK; k--) {
        const raw = balancedObjectAt(text, starts[k]);
        if (!raw) continue;

        let obj = null;
        if (!tileset && raw.indexOf("spherical_metadata") !== -1) {
          try { obj = JSON.parse(raw); } catch { obj = null; }
          if (obj) tileset = findTilesetNode(obj, id);
        }

        // Cheap text precondition before parsing an ancestor again. Any single
        // marker is enough — the resolver decides what is actually there, and
        // an ancestor with none of them cannot answer anyway. Requiring a
        // combination such as creation_time plus wwwURL would match the feed
        // story and nothing else: the photo page spells the timestamp
        // created_time and may name the author only through owner.
        if (tileset && !isRichFacebook(facebook) &&
            (raw.indexOf("creation_time") !== -1 ||
             raw.indexOf("created_time") !== -1 ||
             raw.indexOf('"wwwURL"') !== -1 ||
             raw.indexOf('"actors"') !== -1 ||
             raw.indexOf('"message"') !== -1 ||
             raw.indexOf('"owner"') !== -1 ||
             raw.indexOf("_story") !== -1)) {
          if (!obj) {
            try { obj = JSON.parse(raw); } catch { obj = null; }
          }
          // Keep walking outward while the record is still thin: the photo
          // page puts the story below the photo but the post id above it, so
          // successive ancestors each contribute a different part of the group.
          if (obj) facebook = mergeFacebook(facebook, shapeFacebookMetadata(obj, id));
        }

        if (tileset && isRichFacebook(facebook)) break;
      }

      if (tileset) {
        const hit = { ...tileset, facebook };
        if (isRichFacebook(facebook)) return hit;
        if (facebookScore(facebook) > facebookScore(best && best.facebook)) best = hit;
        else if (!best) best = hit;
      }
    }
    return best;
  }

  // Try every source in turn and remember which one answered. A hit carrying a
  // complete descriptive record wins immediately and stops the walk; a thinner
  // one is held and topped up from later sources instead of being returned as
  // the final answer. That matters because the two halves genuinely do arrive
  // separately: after an in-app navigation the page source still holds the
  // encoding while only the GraphQL response knows who posted it. Merging is
  // safe precisely because every record here was anchored to the same tileset
  // id, so they cannot be two different photos.
  function lookupTileset(id) {
    if (!id) return null;
    id = String(id);
    let best = null;
    for (const { text, origin } of metadataSources()) {
      const hit = scanSourceForTileset(text, id);
      if (!hit) continue;
      hit.origin = origin;
      if (isRichFacebook(hit.facebook)) return hit;
      if (!best) { best = hit; continue; }
      const merged = mergeFacebook(best.facebook, hit.facebook);
      if (facebookScore(merged) > facebookScore(best.facebook)) {
        // Credit the source that supplied the descriptive half.
        if (!best.facebook && merged) best.origin = origin;
        best.facebook = merged;
      }
    }
    return best;
  }

  // Within a parsed object, locate the node whose id matches and which carries
  // spherical_metadata, so a nested unrelated encoding cannot be picked up.
  function findTilesetNode(node, id) {
    if (node == null || typeof node !== "object") return null;
    if (Array.isArray(node)) {
      for (const v of node) {
        const hit = findTilesetNode(v, id);
        if (hit) return hit;
      }
      return null;
    }
    const sm = node.spherical_metadata;
    if (String(node.id) === id && sm && typeof sm === "object") {
      return shapeTileset(node);
    }
    for (const k of Object.keys(node)) {
      const hit = findTilesetNode(node[k], id);
      if (hit) return hit;
    }
    return null;
  }

  // Shape the matching node into the fields this script uses.
  function shapeTileset(node) {
    return {
      id: String(node.id),
      spherical_metadata: node.spherical_metadata,
      max_tile_level: Number.isFinite(node.max_tile_level)
        ? node.max_tile_level : null,
      projection_type: node.projection_type || null,
    };
  }

  // ------------------------------------------------------------------
  // Descriptive metadata, resolved from the encoding outward
  // ------------------------------------------------------------------
  //
  // The tileset id anchors the spherical fields, and the same anchor has to
  // carry the descriptive ones. Facebook ships at least two layouts:
  //
  //   feed       node_v2[…].attachments[].styles.attachment.media.photo_encodings
  //   photo page currMedia.comet_photo_renderer.photo.photo_encodings
  //
  // In the feed a __typename:"Story" ancestor contains the Photo. On a photo
  // page the story hangs BELOW the photo, as photo.creation_story, so no Story
  // ancestor contains it — and that is the page a saved panorama is most often
  // opened from. Some builds ship no story node at all — just owner and
  // created_time on the photo. Asserting any one shape would fail silently on
  // the others: the spherical half is unaffected, so the symptom would be a
  // file with a perfect GPano block and no FB360 group at all.
  //
  // So no shape is asserted. Find the encoding that carries the
  // wanted id, remember the ancestor chain that led to it, and resolve each
  // field from the NEAREST ancestor outward, trying the known story wrappers
  // at every step. Nearest-first is what keeps the answer about this photo:
  // whichever of the two layouts the page used, the photo and its story are
  // closer to the encoding than anyone else's are.
  //
  // Proximity alone is not enough, though. A comment is nearer to the photo
  // than the post's own author is in some payloads, so the loose fallback
  // search refuses to descend into comment, reshare and neighbouring-media
  // branches. Without that guard the FB360 group fills in — with a commenter's
  // name and a commenter's profile.

  /* Branches holding other people's or other posts' data. The finder walks
   * everything; field resolution must never wander in here. */
  const SKIP_KEYS = new Set([
    "feedback", "comments", "replies_connection", "comment_list_renderer",
    "comment_rendering_instance_for_feed_location", "comment_action_links",
    "attached_story", "work_reposted_story", "prevMedia", "nextMedia",
    "default_mediaset", "bumpers", "subattachments", "all_subattachments",
    "tags", "photo_product_tags", "sponsored_data", "aymt_footer",
  ]);

  const isObj = v => v !== null && typeof v === "object";

  // Every photo_encodings entry matching `id`, each with the chain of objects
  // that led to it, nearest ancestor first. The chain — not a fixed path — is
  // what makes this work across layouts.
  function findEncodingChains(root, id) {
    const out = [];
    const chain = [];
    const visit = (node, depth) => {
      if (!isObj(node) || depth > 80) return;
      if (Array.isArray(node)) {
        chain.push(node);
        for (const v of node) visit(v, depth + 1);
        chain.pop();
        return;
      }
      const encs = node.photo_encodings;
      if (Array.isArray(encs)) {
        for (const enc of encs) {
          if (isObj(enc) && String(enc.id) === id) {
            out.push({
              encoding: enc,
              // owner of photo_encodings, then outward; arrays dropped
              chain: [node].concat(chain.slice().reverse())
                .filter(n => isObj(n) && !Array.isArray(n)),
            });
          }
        }
      }
      chain.push(node);
      for (const k of Object.keys(node)) visit(node[k], depth + 1);
      chain.pop();
    };
    visit(root, 0);
    return out;
  }

  // Read a dotted path, tolerating missing links. Array indices work as keys.
  function dig(obj, path) {
    let cur = obj;
    for (const part of path.split(".")) {
      if (!isObj(cur)) return undefined;
      cur = cur[part];
    }
    return cur;
  }

  // First defined, non-empty value any of `paths` produces against `obj`.
  function firstOf(obj, paths) {
    for (const p of paths) {
      const v = dig(obj, p);
      if (v === null || v === undefined) continue;
      if (typeof v === "string" && !v.trim()) continue;
      return v;
    }
    return undefined;
  }

  // Bounded, skip-list-guarded search for the first object carrying `key`.
  // A last resort for payloads that nest the story deeper than the known
  // wrappers reach; never descends into the branches named above.
  function scanForKey(node, key, maxDepth) {
    let found;
    (function visit(n, d) {
      if (found !== undefined || !isObj(n) || d > maxDepth) return;
      if (Array.isArray(n)) {
        for (let i = 0; i < n.length && found === undefined; i++) visit(n[i], d + 1);
        return;
      }
      const v = n[key];
      if (v !== undefined && v !== null && !(typeof v === "string" && !v.trim())) {
        found = v;
        return;
      }
      for (const k of Object.keys(n)) {
        if (found !== undefined) break;
        if (SKIP_KEYS.has(k)) continue;
        visit(n[k], d + 1);
      }
    })(node, 0);
    return found;
  }

  // The same, for the post text, which is an object rather than a scalar.
  function scanForMessageText(node, maxDepth) {
    let found;
    (function visit(n, d) {
      if (found !== undefined || !isObj(n) || d > maxDepth) return;
      if (Array.isArray(n)) {
        for (let i = 0; i < n.length && found === undefined; i++) visit(n[i], d + 1);
        return;
      }
      if (isObj(n.message) && typeof n.message.text === "string" && n.message.text) {
        found = n.message.text;
        return;
      }
      for (const k of Object.keys(n)) {
        if (found !== undefined) break;
        if (SKIP_KEYS.has(k)) continue;
        visit(n[k], d + 1);
      }
    })(node, 0);
    return found;
  }

  // Walk ancestors nearest-first, returning the first hit from `paths`. Only
  // the innermost few ancestors get the loose fallback: by the time the walk
  // reaches a page-level bootstrap object, "the first creation_time in here"
  // has stopped being a statement about this photo.
  const FALLBACK_ANCESTORS = 6;
  function fromAncestors(chain, paths, fallbackKey) {
    for (const node of chain) {
      const v = firstOf(node, paths);
      if (v !== undefined) return v;
    }
    if (!fallbackKey) return undefined;
    const near = Math.min(chain.length, FALLBACK_ANCESTORS);
    for (let i = 0; i < near; i++) {
      const f = fallbackKey === "message"
        ? scanForMessageText(chain[i], 5)
        : scanForKey(chain[i], fallbackKey, 5);
      if (f !== undefined) return f;
    }
    return undefined;
  }

  // Wrappers a story is known to hide behind, relative to any ancestor.
  const STORY_ROOTS = ["", "creation_story.", "container_story.", "story.",
    "comet_sections.content.story.", "comet_sections.context_layout.story.",
    "comet_sections.message.story.", "comet_sections.timestamp.story."];

  const storyPaths = suffix => STORY_ROOTS.map(r => r + suffix);

  // A bare `url` is deliberately absent from postUrl: on the photo page the
  // nearest ancestor is the Photo, whose own `url` is the photo permalink, and
  // reading it as the post url labels every photo-page save with the wrong
  // link. wwwURL is story-specific, so it leads; `url` is accepted only when
  // an explicit story wrapper vouches for it.
  const FB_FIELDS = {
    postUrl: {
      paths: storyPaths("wwwURL")
        .concat(STORY_ROOTS.slice(1).map(r => r + "url"), ["permalink_url"]),
      fallback: "wwwURL",
    },
    postId: {
      paths: storyPaths("post_id").concat(storyPaths("legacy_story_hideable_id")),
    },
    creationTimeUnix: {
      paths: storyPaths("creation_time").concat(["created_time"]),
      fallback: "creation_time",
    },
    authorName: {
      paths: storyPaths("actors.0.name").concat([
        "owner.name", "owning_profile.name", "feedback.owning_profile.name"]),
    },
    authorId: {
      paths: storyPaths("actors.0.id").concat([
        "owner.id", "owner.user_id", "owning_profile.id",
        "feedback.owning_profile.id"]),
    },
    authorProfileUrl: {
      paths: storyPaths("actors.0.url").concat(
        storyPaths("actors.0.profile_url"), ["owner.url", "owner.profile_url"]),
    },
    text: { paths: storyPaths("message.text"), fallback: "message" },
  };

  const facebookPageUrl = v => typeof v === "string" &&
    /^https?:\/\/(?:www\.)?facebook\.com\//i.test(v) ? v : null;

  // Tracking parameters. Dropping the whole query string would be simpler and
  // wrong: /photo/?fbid=… and /profile.php?id=… carry their identity there.
  const TRACKING_PARAMS = new Set([
    "hint", "ref", "refid", "notif_id", "notif_t", "rdid", "share_url",
    "comment_id", "reply_comment_id", "_rdr", "mibextid", "sfnsn", "extid",
    "paipv", "eav", "av", "source", "story_type",
  ]);

  function tidyUrl(u) {
    if (typeof u !== "string" || !u) return null;
    try {
      const x = new URL(u, "https://www.facebook.com");
      const keep = [];
      x.searchParams.forEach((val, key) => {
        if (!key.startsWith("__") && !TRACKING_PARAMS.has(key)) keep.push([key, val]);
      });
      x.search = keep.length
        ? "?" + keep.map(([k, v]) =>
            `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")
        : "";
      x.hash = "";
      const s = x.toString();
      return s.endsWith("/") && x.pathname !== "/" ? s.slice(0, -1) : s;
    } catch { return u; }
  }

  // The photo page carries no actor url, so derive the profile from the post
  // url: "/<vanity>/posts/<pfbid>" -> "/<vanity>". Group posts are excluded,
  // because their first segment names the group and not the author.
  function profileFromPostUrl(url) {
    if (!url) return null;
    try {
      const u = new URL(url, "https://www.facebook.com");
      const seg = u.pathname.split("/").filter(Boolean);
      if (seg.length >= 2 && seg[0] !== "groups" &&
          /^(posts|photos|videos)$/.test(seg[1])) {
        return "https://www.facebook.com/" + seg[0];
      }
    } catch { /* malformed */ }
    return null;
  }

  // The media node is the nearest ancestor that actually looks like a photo.
  function photoNodeOf(chain) {
    for (const n of chain) {
      if ((n.__typename === "Photo" || n.__isMedia === "Photo") && n.id != null) return n;
    }
    for (const n of chain) if (n.id != null) return n;
    return chain[0] || null;
  }

  function resolveFromChain(hit) {
    const chain = hit.chain;
    const photo = photoNodeOf(chain);

    const rec = {};
    for (const [field, spec] of Object.entries(FB_FIELDS)) {
      const v = fromAncestors(chain, spec.paths, spec.fallback);
      rec[field] = v === undefined ? null : v;
    }

    rec.postId = rec.postId != null ? String(rec.postId) : null;
    rec.authorId = rec.authorId != null ? String(rec.authorId) : null;
    rec.photoId = photo && photo.id != null ? String(photo.id) : null;

    rec.postUrl = facebookPageUrl(tidyUrl(rec.postUrl));

    // Read the photo's own permalink from the photo node, never from a story:
    // a story url describes the post, which may hold many photos.
    const directPhotoUrl = photo
      ? facebookPageUrl(tidyUrl(photo.url)) ||
        facebookPageUrl(tidyUrl(photo.wwwURL)) ||
        facebookPageUrl(tidyUrl(photo.permalink_url))
      : null;
    rec.photoUrl = directPhotoUrl || (rec.photoId
      ? `https://www.facebook.com/photo/?fbid=${encodeURIComponent(rec.photoId)}`
      : null);

    rec.authorProfileUrl = facebookPageUrl(tidyUrl(rec.authorProfileUrl)) ||
      profileFromPostUrl(rec.postUrl) ||
      (rec.authorId
        ? `https://www.facebook.com/profile.php?id=${encodeURIComponent(rec.authorId)}`
        : null);

    rec.authorName = typeof rec.authorName === "string" && rec.authorName
      ? rec.authorName : null;
    rec.text = typeof rec.text === "string" ? rec.text : null;

    rec.creationTimeUnix = Number.isFinite(rec.creationTimeUnix)
      ? rec.creationTimeUnix : null;
    rec.creationDate = rec.creationTimeUnix != null
      ? new Date(rec.creationTimeUnix * 1000).toISOString() : null;

    rec.sourceUrl = rec.postUrl || rec.photoUrl || null;
    return rec;
  }

  // How much of the group this record can actually fill.
  const FB_SCORED = ["postUrl", "photoUrl", "authorName", "authorProfileUrl",
    "creationTimeUnix", "text", "postId", "photoId", "authorId"];
  const facebookScore = rec => rec
    ? FB_SCORED.reduce((n, k) => n + (rec[k] !== null && rec[k] !== undefined ? 1 : 0), 0)
    : -1;

  // "Rich" means there is nothing worth continuing to look for: an author, a
  // link and a timestamp. Anything less is kept as a candidate but does not
  // stop the search, because a later source may describe the same photo more
  // completely — the id anchor guarantees it is the same photo.
  const isRichFacebook = rec => !!rec && !!rec.authorName &&
    !!(rec.postUrl || rec.photoUrl) && rec.creationTimeUnix != null;

  // Fill gaps in the better record from the worse one. Both are anchored to
  // the same tileset id, so they describe one photo and cannot be crossed.
  function mergeFacebook(a, b) {
    if (!a) return b || null;
    if (!b) return a;
    const [rich, poor] = facebookScore(a) >= facebookScore(b) ? [a, b] : [b, a];
    const out = { ...rich };
    for (const k of Object.keys(poor)) {
      if (out[k] === null || out[k] === undefined) out[k] = poor[k];
    }
    if (out.creationTimeUnix != null && !out.creationDate) {
      out.creationDate = new Date(out.creationTimeUnix * 1000).toISOString();
    }
    out.sourceUrl = out.postUrl || out.photoUrl || null;
    return out;
  }

  // Resolve every occurrence of the tileset in this object and merge them.
  // Returns null when nothing descriptive was found, so the caller keeps
  // looking in the next source rather than settling for an empty group.
  function shapeFacebookMetadata(root, id) {
    const hits = findEncodingChains(root, String(id));
    if (!hits.length) return null;
    let best = null;
    for (const hit of hits) {
      const rec = resolveFromChain(hit);
      best = mergeFacebook(best, rec);
      if (isRichFacebook(best)) break;
    }
    // photoId alone is derivable from the anchor itself and says nothing about
    // the post, so it does not count as having found descriptive metadata.
    const meaningful = best && (best.postUrl || best.authorName ||
      best.creationTimeUnix != null || best.text || best.postId);
    return meaningful ? best : null;
  }

  const SPHERICAL_FIELDS = [
    "cropped_area_image_width_pixels", "cropped_area_image_height_pixels",
    "full_pano_width_pixels", "full_pano_height_pixels",
  ];

  // What "usable metadata" means before trusting the object that was found.
  const isCompleteSpherical = sm => !!sm && typeof sm === "object" &&
    SPHERICAL_FIELDS.every(f => Number.isFinite(sm[f]) && sm[f] > 0);

  // Reads spherical_metadata and max_tile_level from the Relay payload —
  // inlined in the page or captured from a GraphQL response, whichever holds
  // it — anchored to the locked tileset id.
  const META_MISS_RETRY_MS = 2000;
  function loadTilesetMetadata(id) {
    const want = id != null ? String(id) : state.encodingId;
    if (!want) return null;
    if (state.meta && String(state.encodingId) === want) return state.meta;
    if (state.metaMissFor === want && Date.now() - state.metaMissAt < META_MISS_RETRY_MS) {
      return null;
    }

    let hit = null;
    try { hit = lookupTileset(want); }
    catch (e) { warn("metadata lookup failed", e); }

    if (!hit) {
      state.metaMissFor = want;
      state.metaMissAt = Date.now();
      return null;
    }

    if (hit.facebook) {
      state.facebookMeta = hit.facebook;
      state.facebookMetaSource = hit.origin;
      state.facebookMetaMissFor = null;
      state.facebookMetaMissAt = 0;
    }

    const sm = hit.spherical_metadata;
    if (!isCompleteSpherical(sm)) {
      warn(`tileset ${hit.id} found in ${hit.origin} but its spherical_metadata is incomplete`);
      state.metaMissFor = want;
      state.metaMissAt = Date.now();
      return null;
    }
    if (hit.max_tile_level != null && state.maxTileLevel == null) {
      state.maxTileLevel = hit.max_tile_level;
      log(`max_tile_level ${hit.max_tile_level} (from the same ${hit.origin} object)`);
    }
    state.meta = sm;
    state.metaSource = hit.origin;
    state.metaMissFor = null;
    state.metaMissAt = 0;
    return sm;
  }

  // Descriptive Facebook metadata is optional and has its own retry cache.
  // It may arrive later than the photo encoding in Facebook's streamed Relay
  // payload, so a successful spherical lookup must not permanently freeze a
  // prior social-metadata miss.
  function loadFacebookMetadata(id) {
    const want = id != null ? String(id) : state.encodingId;
    if (!want) return null;
    if (state.facebookMeta && String(state.encodingId) === want) {
      return state.facebookMeta;
    }
    if (state.facebookMetaMissFor === want &&
        Date.now() - state.facebookMetaMissAt < META_MISS_RETRY_MS) {
      return null;
    }

    let hit = null;
    try { hit = lookupTileset(want); }
    catch (e) { warn("Facebook metadata lookup failed", e); }

    if (hit && hit.facebook) {
      state.facebookMeta = hit.facebook;
      state.facebookMetaSource = hit.origin;
      state.facebookMetaMissFor = null;
      state.facebookMetaMissAt = 0;
      return state.facebookMeta;
    }

    state.facebookMetaMissFor = want;
    state.facebookMetaMissAt = Date.now();
    return null;
  }

  function resolveBounds(opts = {}) {
    if (!opts || typeof opts !== "object" || Array.isArray(opts))
      throw new Error("bounds options must be an object");
    if (opts.bounds != null && typeof opts.bounds !== "boolean")
      throw new Error("{bounds} must be true or false");
    const hasH = opts.hFovDeg != null, hasV = opts.vFovDeg != null;
    if (hasH !== hasV) throw new Error("{hFovDeg, vFovDeg} must be supplied together");
    if (hasH) {
      if (typeof opts.hFovDeg !== "number" || !Number.isFinite(opts.hFovDeg) ||
          opts.hFovDeg <= 0 || opts.hFovDeg > 360)
        throw new Error("{hFovDeg} must be a finite number in (0, 360]");
      if (typeof opts.vFovDeg !== "number" || !Number.isFinite(opts.vFovDeg) ||
          opts.vFovDeg <= 0 || opts.vFovDeg > 180)
        throw new Error("{vFovDeg} must be a finite number in (0, 180]");
      for (const k of ["hCenterDeg", "vCenterDeg"]) {
        if (opts[k] == null) continue;
        const lim = k === "hCenterDeg" ? 360 : 90;
        if (typeof opts[k] !== "number" || !Number.isFinite(opts[k]) ||
            Math.abs(opts[k]) > lim)
          throw new Error(`{${k}} must be a finite number in [-${lim}, ${lim}]`);
      }
    } else if (opts.hCenterDeg != null || opts.vCenterDeg != null) {
      throw new Error(
        "{hCenterDeg, vCenterDeg} only apply alongside {hFovDeg, vFovDeg}");
    }
    // Populate state.meta regardless of whether angular bounds are wanted.
    // full_pano_width_pixels is what makes the output native resolution, and
    // it is a different question from "should the padding be trimmed". So it
    // runs before both early returns below: {bounds: false} — "give me the
    // whole sphere" — and {hFovDeg, vFovDeg} — "here are the angles" — still
    // want native resolution, not a 4096px fallback that blames metadata
    // sitting in the page the whole time.
    if (state.encodingId && !state.meta) {
      try { loadTilesetMetadata(state.encodingId); } catch { /* ignore */ }
    }

    if (opts.bounds === false) return null;

    // Explicit override wins and is deliberately CALL-LOCAL. Never assign it
    // to state.bounds: a one-off crop must not change later calls on this photo.
    if (opts.hFovDeg != null && opts.vFovDeg != null) {
      // {hCenterDeg} is allowed the full +/-360 for convenience, so normalise
      // it into (-pi, pi] the way metadata-derived centres already are.
      const hc = (opts.hCenterDeg || 0) * Math.PI / 180;
      const b = { h: opts.hFovDeg * Math.PI / 180, v: opts.vFovDeg * Math.PI / 180,
                  hCenter: Math.atan2(Math.sin(hc), Math.cos(hc)),
                  vCenter: (opts.vCenterDeg || 0) * Math.PI / 180,
                  source: "supplied" };
      b.full = boundsAreFull(b);
      return b;
    }
    if (state.bounds) return state.bounds;

    if (!state.encodingId) {
      if (!state.boundsWarned) {
        state.boundsWarned = true;
        warn("no tileset id seen yet, so the captured region is unknown and " +
          "padding cannot be trimmed. Open the 360 photo so the viewer issues " +
          `a ${TILE_URI_QUERY} request, or pass {hFovDeg, vFovDeg} yourself.`);
      }
      return null;
    }

    const m = loadTilesetMetadata(state.encodingId);
    if (!m) {
      if (!state.boundsWarned) {
        state.boundsWarned = true;
        warn(`tileset ${state.encodingId} was not found with usable spherical_metadata ` +
          "in the page source or in any GraphQL response seen so far, so the captured " +
          "region is unknown and padding cannot be trimmed. Reload the photo with this " +
          "installed, or pass {hFovDeg, vFovDeg}.");
      }
      return null;
    }

    state.bounds = metadataToBounds(m);
    state.bounds.source =
      `${state.metaSource || "page source"}, tileset ${state.encodingId}`;
    const b = state.bounds;
    log(`captured region: ${(b.h * 180 / Math.PI).toFixed(1)}° x ` +
      `${(b.v * 180 / Math.PI).toFixed(1)}°` +
      (b.hCenter || b.vCenter
        ? ` centred on (${(b.hCenter * 180 / Math.PI).toFixed(1)}°, ` +
          `${(b.vCenter * 180 / Math.PI).toFixed(1)}°)` : "") +
      (b.full ? " (full sphere)" : ""));
    return b;
  }

  // A tile is worth fetching only if some of it falls inside the bounds.
  // It is tested at an N x N grid of points across its face-coordinate span.
  const TILE_BOUNDS_SAMPLES = 9;

  function tileInBounds(t, b, samples = TILE_BOUNDS_SAMPLES) {
    if (!b || b.full) return true;
    const n = 1 << t.level;
    const s0 = 2 * t.col / n - 1, s1 = 2 * (t.col + 1) / n - 1;
    const t1 = 1 - 2 * t.row / n, t0 = 1 - 2 * (t.row + 1) / n;
    // Keep a ring of edge tiles rather than clip content. inBounds adds this
    // to half-angles in RADIANS, so it cannot be a face-coordinate width: a
    // face coordinate maps to an angle through atan, and the two diverge by a
    // factor of ~2 between face centre and corner. 2*atan(1/n) is the widest
    // angle any single tile on this face subtends, which is the honest
    // spelling of "one tile of slack" and is what 2/n was approximating.
    const margin = 2 * Math.atan(1 / n);
    const dir = FACE_DIR[t.face];
    for (let i = 0; i < samples; i++) {
      const s = s0 + (s1 - s0) * i / (samples - 1);
      for (let j = 0; j < samples; j++) {
        const tt = t0 + (t1 - t0) * j / (samples - 1);
        if (inBounds(dir(s, tt), b, margin)) return true;
      }
    }
    return false;
  }

  // Nearest ancestor of a tile that we actually have, mirroring the viewer's
  // getBestTileTexture: halve col and row each level until something is there.
  function bestAncestorTile(t) {
    for (let k = 1; k <= t.level; k++) {
      const anc = { level: t.level - k, face: t.face,
                    col: t.col >> k, row: t.row >> k };
      if (state.pairs.has(tileKey(anc))) return anc;
    }
    return null;
  }

  // ------------------------------------------------------------------
  // Coverage survey
  // ------------------------------------------------------------------

  // Tiles form a quadtree, so an absent parent should mean four absent
  // children. Walking coarse-to-fine and only descending into present parents
  // turns a full 6*4^L enumeration into something proportional to the area
  // actually captured — a big saving on a narrow-band panorama.
  //
  // That invariant is inferred, not documented, so it gets spot-checked: a few
  // children of absent parents are queried anyway, and if any of them exists
  // the pruning is abandoned for a full enumeration.
  //
  // SURVEY_VERIFY_SAMPLES is how many of those children are spot-checked by
  // default ({verifySamples}; 0 turns the check off).
  const SURVEY_VERIFY_SAMPLES = 6;

  async function survey(level, opts = {}) {
    if (!opts || typeof opts !== "object" || Array.isArray(opts)) validatePublicOptions(opts);
    if (!opts._op) {
      validatePublicOptions({ ...opts, level });
      opts = { ...opts, _op: beginOperation("survey()") };
    }
    const { prune = true, urlConcurrency = TILE_QUERY_CONCURRENCY,
            verifySamples = SURVEY_VERIFY_SAMPLES, onProgress = null } = opts;
    const op = opts._op;
    assertOperation(op);

    const b = opts.bounds === false ? null : resolveBounds(opts);
    if (level === 0 || !prune) {
      await resolveTiles(enumerateTiles(level).filter(t => tileInBounds(t, b)),
        urlConcurrency, onProgress, op);
      assertOperation(op);
      return coverageAt(level);
    }

    await survey(level - 1, opts);
    assertOperation(op);
    // Only parents that were actually in the survey domain may participate in
    // pruning. A bounds-skipped parent is UNKNOWN, not absent.
    const parents = enumerateTiles(level - 1).filter(t => tileInBounds(t, b));
    const live = parents.filter(t => tileState(t) === "present");
    const dead = parents.filter(t => tileState(t) === "absent");

    const children = [];
    for (const p of live) {
      for (let dr = 0; dr < 2; dr++)
        for (let dc = 0; dc < 2; dc++) {
          const t = { level, face: p.face, col: p.col * 2 + dc, row: p.row * 2 + dr };
          if (tileInBounds(t, b)) children.push(t);
        }
    }

    // Spot-check only explicitly absent parents, and only with children that
    // are themselves inside the requested angular domain.
    if (dead.length && verifySamples > 0) {
      const step = Math.max(1, Math.floor(dead.length / verifySamples));
      const probes = [];
      for (let i = 0; i < dead.length && probes.length < verifySamples; i += step) {
        const p = dead[i];
        let picked = null;
        for (let dr = 0; dr < 2 && !picked; dr++)
          for (let dc = 0; dc < 2 && !picked; dc++) {
            const t = { level, face: p.face, col: p.col * 2 + dc, row: p.row * 2 + dr };
            if (tileInBounds(t, b)) picked = t;
          }
        if (picked) probes.push(picked);
      }
      if (probes.length) {
        const got = await queryTiles(probes, op);
        if (got.some(u => u)) {
          warn("quadtree pruning looked unsafe (a child of an absent parent " +
               "exists) — falling back to a full in-bounds enumeration at this level");
          await resolveTiles(enumerateTiles(level).filter(t => tileInBounds(t, b)),
            urlConcurrency, onProgress, op);
          assertOperation(op);
          return coverageAt(level);
        }
      }
    }

    await resolveTiles(children, urlConcurrency, onProgress, op);
    assertOperation(op);
    return coverageAt(level);
  }


  function coverageAt(level) {
    const n = 1 << level;
    const faces = [];
    let total = 0;
    for (let face = 0; face < 6; face++) {
      const grid = [];
      let count = 0, absent = 0, unknown = 0;
      let minCol = n, maxCol = -1, minRow = n, maxRow = -1;
      for (let row = 0; row < n; row++) {
        const line = [];
        for (let col = 0; col < n; col++) {
          const ts = tileState({ level, face, col, row });
          const here = ts === "present";
          line.push(here);
          if (ts === "absent") absent++;
          else if (ts === "unknown") unknown++;
          if (here) {
            count++;
            if (col < minCol) minCol = col;
            if (col > maxCol) maxCol = col;
            if (row < minRow) minRow = row;
            if (row > maxRow) maxRow = row;
          }
        }
        grid.push(line);
      }
      total += count;
      faces.push({
        face, name: FACE_NAMES[face], count, absent, unknown, total: n * n, grid,
        empty: count === 0,
        partial: count > 0 && count < n * n,
        bbox: count ? { minCol, maxCol, minRow, maxRow } : null,
        hasLevel0: isPresent({ level: 0, face, col: 0, row: 0 }),
      });
    }
    return { level, size: n, faces, total, expected: 6 * n * n };
  }

  function printCoverage(cov) {
    log(`coverage at level ${cov.level}: ${cov.total}/${cov.expected} tiles`);
    for (const f of cov.faces) {
      const tag = f.empty ? "EMPTY" : f.partial ? "partial" : "full";
      console.log(`  face ${f.face} ${f.name.padEnd(8)} ${String(f.count).padStart(4)}/${f.total}  ${tag}`);
      if (f.partial && cov.size <= 32) {
        for (const row of f.grid) {
          console.log("      " + row.map(v => v ? "#" : ".").join(""));
        }
      }
    }
    return cov;
  }

  async function probeMaxLevel(limit = MAX_PUBLIC_TILE_LEVEL, op = null) {
    validateProbeLimit(limit);
    if (!op) op = beginOperation("probeMaxLevel()");
    // Probe the centre of the front (-Z) face. A valid explicit null ends the
    // search; request/GraphQL failures propagate and must never masquerade as a
    // lower maximum level.
    let best = 0;
    for (let level = 1; level <= limit; level++) {
      assertOperation(op);
      const c = Math.floor((1 << level) / 2);
      const [uri] = await queryTiles([{ level, face: MINUS_Z, col: c, row: c }], op);
      if (!uri) break;
      best = level;
    }
    return best;
  }

  // ------------------------------------------------------------------
  // Image loading and stitching
  // ------------------------------------------------------------------

  // A request that stalls — connection held open, no response, no error —
  // fires neither onload nor onerror, so without a timeout this promise could
  // stay pending forever. That would wedge a pool() lane permanently, and
  // enough of them would mean Promise.all never settles: the run hangs with no
  // error, no progress and nothing to cancel. Timing out to null is the right shape, because null
  // is already what the caller's refresh-and-retry path expects.
  const TILE_IMAGE_TIMEOUT_MS = 30000;

  function loadImage(uri, timeoutMs = TILE_IMAGE_TIMEOUT_MS) {
    return new Promise(resolve => {
      const img = new Image();
      let timer = null;
      const settle = v => {
        if (timer === null) return;      // already settled
        clearTimeout(timer); timer = null;
        img.onload = img.onerror = null;
        resolve(v);
      };
      timer = setTimeout(() => {
        try { img.src = ""; } catch { /* ignore */ }
        settle(null);
      }, timeoutMs);
      img.crossOrigin = "anonymous";   // matches the viewer; keeps canvas clean
      img.onload = () => settle(img);
      img.onerror = () => settle(null);
      img.src = uri;
    });
  }

  // A tile whose signed url has expired fails in exactly the way a tile that
  // never existed fails: loadImage resolves null. The two are worth telling
  // apart, because the first is repairable — ask for a fresh url and try once
  // more. A level 3 crawl can easily outlive the urls its own survey collected,
  // and without this it emits holes and calls them failures.
  //
  // Resolves to {img, refreshed} so callers can report how much repair happened.
  async function loadTileWithRefresh(t, allowRefetch, op = null) {
    const k = tileKey(t);
    const uri = state.pairs.get(k);
    if (uri) {
      const img = await loadImage(uri);
      assertOperation(op);
      if (img) return { img, refreshed: false };
    }
    if (!allowRefetch || !state.template) return { img: null, refreshed: false };
    dropPair(k);
    let fresh = null;
    [fresh] = await queryTiles([t], op);
    assertOperation(op);
    // Same url back means the url was never the problem — the image itself is
    // gone or blocked, and asking again would only loop.
    if (!fresh || fresh === uri) return { img: null, refreshed: false };
    const img = await loadImage(fresh);
    assertOperation(op);
    return { img, refreshed: !!img };
  }

  // The tile size is declared nowhere, so it has to be read off a real image —
  // but off one at THIS level. The first entry of state.pairs will not do: Map
  // iteration is insertion order, so that is whatever the viewer happened to
  // request first — normally level 0 or 1, never the level being built. Every drawImage offset downstream is a multiple of this number, so
  // if any level is ever served at a different tile size the face is the wrong
  // size and every tile lands at the wrong place — a silently misaligned
  // mosaic rather than an error.
  //
  // Probes the centre of each non-empty face's bounding box, so an edge tile
  // (the one most likely to be cropped, if Facebook ever crops them) is not
  // what defines the grid.
  async function probeTileSize(level, cov, allowRefetch, op = null) {
    for (const f of cov.faces) {
      if (!f.bbox) continue;
      const t = {
        level, face: f.face,
        col: (f.bbox.minCol + f.bbox.maxCol) >> 1,
        row: (f.bbox.minRow + f.bbox.maxRow) >> 1,
      };
      // The bbox centre can be a hole on a sparse face; fall back to a corner
      // that the survey confirmed is there.
      const cand = isPresent(t)
        ? [t] : [t, { level, face: f.face, col: f.bbox.minCol, row: f.bbox.minRow }];
      for (const c of cand) {
        if (!isPresent(c)) continue;
        const { img } = await loadTileWithRefresh(c, allowRefetch, op);
        if (img && img.naturalWidth) return img.naturalWidth;
      }
    }
    return 0;
  }

  // A bounded-concurrency runner over async tasks. `limit` is how many tasks
  // may be *in flight* at once, which for every caller here means how many
  // tile images are downloading simultaneously.
  //
  // Nothing about this is parallelism, and the lanes below are not threads —
  // the only real thread this script starts is the projection worker, much
  // further down. These lanes all run on the one JS thread and only ever
  // interleave at an await. That is precisely why the limit matters: the
  // thread is idle for the whole of each round-trip, so the useful number of
  // lanes is set by the network, not by the CPU. Dropping to 1 would not make
  // anything simpler or more correct, it would just serialize the survey's
  // several hundred round-trips — 384 tiles at level 3, plus the coarser
  // levels the pruning pass walks on the way down.
  //
  // Lane failures are contained rather than left to escape. Promise.all
  // rejects on the first error, but the other lanes are detached and would
  // keep running: one thrown assertOperation (the user clicked through to
  // another photo) would produce the error the caller sees PLUS up to eleven
  // unhandled rejections PLUS a burst of continued traffic against a photo
  // nobody is looking at any more. The first error is recorded and rethrown
  // after every lane has stopped, and the loop condition stops the survivors
  // from picking up new work.
  async function pool(items, limit, fn, onProgress) {
    const results = new Array(items.length);
    let index = 0, done = 0, failure = null;
    const lanes = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
      while (failure === null) {
        const i = index++;                 // the shared cursor each lane pulls from
        if (i >= items.length) return;
        try {
          results[i] = await fn(items[i], i);
        } catch (e) {
          if (failure === null) failure = e;
          return;
        }
        done++;
        if (onProgress && done % 8 === 0) onProgress(done, items.length);
      }
    });
    await Promise.all(lanes);
    if (failure) throw failure;
    if (onProgress) onProgress(items.length, items.length);
    return results;
  }

  async function buildFace(faceCov, level, tileSize, level0Img, opts) {
    const { concurrency = TILE_DOWNLOAD_CONCURRENCY, fillFromLevel0 = false, bounds = null,
            useAncestors = true, willReadFrequently = false,
            allowRefetch = false, op = null,
            // Reporting only — where this face sits in the run, so the button
            // can say "face 2 of 4" instead of an unanchored tile count.
            faceOrdinal = 0, faceTotal = 0, onTileProgress = null } = opts || {};
    const face = faceCov.face;
    const n = 1 << level;
    const size = tileSize * n;
    const canvas = document.createElement("canvas");
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext("2d", willReadFrequently ? { willReadFrequently: true } : undefined);
    ctx.clearRect(0, 0, size, size);

    // Off by default: upscaling the level 0 tile to cover a whole face is
    // where the smeared blur comes from, and it fills area that was never
    // photographed in the first place.
    if (fillFromLevel0 && level0Img) {
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(level0Img, 0, 0, size, size);
    }

    const tiles = [], coarse = [];
    let missingNoAncestor = 0;
    for (let row = 0; row < n; row++)
      for (let col = 0; col < n; col++) {
        const t = { level, face, col, row };
        if (!tileInBounds(t, bounds)) continue;
        if (faceCov.grid[row][col]) { tiles.push(t); continue; }
        // Missing at this level but inside the captured region. Facebook does
        // not always generate a tile for a square that is mostly padding, even
        // when a sliver of it holds real photo — which is exactly what happens
        // along the panorama's edge. Left alone those squares stay unpainted
        // and show up as a thin transparent rim.
        const anc = bestAncestorTile(t);
        if (anc) coarse.push({ tile: t, anc });
        else missingNoAncestor++;
      }

    // Draw the coarse stand-ins first so real tiles paint over them. This is
    // the viewer's own getBestTileTexture behaviour: walk up the quadtree
    // (col >> 1, row >> 1 each step) to the nearest level that does have the
    // tile, and use that square's sub-region. It is real imagery from
    // Facebook, just at a lower resolution — not invented fill, and it is
    // exactly what the viewer puts on screen for the same squares.
    let coarseDrawn = 0, refreshed = 0;
    if (useAncestors && coarse.length) {
      // Keyed by ancestor tile rather than by url: one ancestor typically
      // stands in for many squares, and after a refresh its url is no longer
      // the one the cache was keyed on.
      const cache = new Map();
      const get = anc => {
        const ck = tileKey(anc);
        // Counted on the cache miss, not per awaiting square: one ancestor
        // commonly stands in for a dozen of them.
        if (!cache.has(ck)) {
          cache.set(ck, loadTileWithRefresh(anc, allowRefetch, op)
            .then(r => { if (r.refreshed) refreshed++; return r; }));
        }
        return cache.get(ck);
      };
      await pool(coarse, concurrency, async ({ tile, anc }) => {
        const { img } = await get(anc);
        if (!img) return;
        const k = tile.level - anc.level;         // generations climbed
        const span = 1 << k;                      // ancestor covers span x span
        // Source coordinates belong to the ANCESTOR image, not to the target
        // level's tile grid. Use its actual decoded dimensions; assuming the
        // target tileSize here silently mis-samples if Facebook changes tile
        // resolution between levels.
        const subW = img.naturalWidth / span;
        const subH = img.naturalHeight / span;
        ctx.drawImage(img,
          (tile.col % span) * subW, (tile.row % span) * subH, subW, subH,
          tile.col * tileSize, tile.row * tileSize, tileSize, tileSize);
        coarseDrawn++;
      });
    }

    let failed = 0;
    await pool(tiles, concurrency, async t => {
      const { img, refreshed: r } = await loadTileWithRefresh(t, allowRefetch, op);
      if (r) refreshed++;
      if (!img) { failed++; return; }
      // row 0 is the top row, col 0 the left column
      ctx.drawImage(img, t.col * tileSize, t.row * tileSize);
    }, onTileProgress ? (done, total) =>
        onTileProgress(done, total, faceOrdinal, faceTotal) : null);

    // The face is deliberately left UNMASKED. Clipping to the captured region
    // puts alpha 0 next to real pixels, and the equirect's bilinear sampling
    // would blend that transparency inward and fringe the border. The
    // reprojection reads the unmasked face and applies its own hard-edged
    // bounds test instead.
    const gaps = (fillFromLevel0 && level0Img) ? 0 :
      failed + missingNoAncestor +
      (useAncestors ? coarse.length - coarseDrawn : coarse.length);
    return { canvas, ctx, drawn: tiles.length - failed, failed, gaps,
             coarse: coarseDrawn, used: tiles.length, refreshed,
             absent: faceCov.total - faceCov.count };
  }

  // ------------------------------------------------------------------
  // Cubemap -> equirectangular
  // ------------------------------------------------------------------
  //
  // Face orientations, from the rotations the viewer applies to its base quad
  // (which sits at z = -1, s rightward, t upward, both in [-1,1]):
  //   -Z ( s,  t, -1)   +X ( 1,  t,  s)   -X (-1,  t, -s)
  //   +Z (-s,  t,  1)   +Y (-s,  1, -t)   -Y (-s, -1,  t)
  // What follows is the inverse of that.

  // Geometry is split out from the projection so faces can be fed in one at a
  // time. Holding all six as ImageData is fine at level 1, but at level 3 they
  // are 4096px squares — roughly 384 MiB together, on top of the output buffer
  // and whatever the host page is already holding.
  let seamWarned = false;

  function equirectGeometry(width, bounds, crop) {
    const height = width >> 1;

    // Only generate the part of the sphere that was actually photographed.
    // lon maps exactly to the shader's hAngle and lat to its vAngle, so the
    // bounds test is just a comparison on the output coordinates.
    // Round the crop INWARD, so every pixel in the window has its centre
    // inside the bounds. Rounding outward leaves a border row and column that
    // fail the test and come out transparent.
    let i0 = 0, i1 = width - 1, j0 = 0, j1 = height - 1;
    if (bounds && !bounds.full && crop) {
      const hc = bounds.hCenter || 0, vc = bounds.vCenter || 0;
      // The window is taken about the captured centre, not about zero.
      const wantI0 = Math.ceil((Math.PI + hc - bounds.h / 2) / (2 * Math.PI) * width - 0.5);
      const wantI1 = Math.floor((Math.PI + hc + bounds.h / 2) / (2 * Math.PI) * width - 0.5);
      // A region straddling the +/-180 seam is two runs of columns, not one,
      // and clamping it to the canvas would silently crop away real content.
      // Keeping the full width is honest; the per-pixel mask still clips it.
      if (wantI0 < 0 || wantI1 > width - 1 || wantI1 < wantI0) {
        if (!seamWarned) {
          seamWarned = true;
          warn("the captured region wraps the +/-180 seam, so it is not a " +
            "contiguous column range; keeping the full output width");
        }
      } else {
        i0 = wantI0; i1 = wantI1;
      }
      j0 = Math.max(0,
        Math.ceil((Math.PI / 2 - vc - bounds.v / 2) / Math.PI * height - 0.5));
      j1 = Math.min(height - 1,
        Math.floor((Math.PI / 2 - vc + bounds.v / 2) / Math.PI * height - 0.5));
    }
    return { width, height, i0, i1, j0, j1,
             outW: i1 - i0 + 1, outH: j1 - j0 + 1, bounds };
  }

  function faceAngularRects(face, bounds) {
    const P = Math.PI, Q = P / 4;
    const pole = Math.atan(1 / Math.SQRT2);
    let r;
    switch (face) {
      case MINUS_Z: r = [[-Q, Q, -Q, Q]]; break;
      case PLUS_X:  r = [[ Q, 3 * Q, -Q, Q]]; break;
      case MINUS_X: r = [[-3 * Q, -Q, -Q, Q]]; break;
      case PLUS_Z:  r = [[-P, -3 * Q, -Q, Q], [3 * Q, P, -Q, Q]]; break;
      case PLUS_Y:  r = [[-P, P, pole, P / 2]]; break;
      case MINUS_Y: r = [[-P, P, -P / 2, -pole]]; break;
      default: return [];
    }

    // Intersect the coarse rectangles with the captured-region mask as well,
    // about its own centre rather than about lon/lat zero. Especially valuable
    // for partial panoramas rendered with crop:false.
    if (bounds && !bounds.full) {
      const half = bounds.h / 2, v = bounds.v / 2;
      const vc = bounds.vCenter || 0;
      const hc0 = bounds.hCenter || 0;
      const hc = Math.atan2(Math.sin(hc0), Math.cos(hc0));   // into (-pi, pi]

      // The mask's longitude span as one or two intervals inside [-pi, pi]. A
      // region straddling the seam is genuinely two of them, and collapsing it
      // to a single min/max would silently discard whichever half does not
      // contain the centre — which for a rear-facing panorama is most of it.
      const spans = half >= Math.PI ? [[-Math.PI, Math.PI]] : (() => {
        const lo = hc - half, hi = hc + half;
        if (lo < -Math.PI) return [[-Math.PI, hi], [lo + 2 * Math.PI, Math.PI]];
        if (hi > Math.PI) return [[lo, Math.PI], [-Math.PI, hi - 2 * Math.PI]];
        return [[lo, hi]];
      })();

      const out = [];
      for (const a of r) {
        const lat0 = Math.max(a[2], vc - v), lat1 = Math.min(a[3], vc + v);
        if (lat0 > lat1) continue;
        for (const [s0, s1] of spans) {
          const lon0 = Math.max(a[0], s0), lon1 = Math.min(a[1], s1);
          if (lon0 <= lon1) out.push([lon0, lon1, lat0, lat1]);
        }
      }
      r = out;
    }
    return r;
  }

  // ------------------------------------------------------------------
  // Projection
  // ------------------------------------------------------------------
  //
  // fb360 gets its tiles from the GraphQL API one at a time, with the level,
  // face, row and column stated in the request, so every tile's face identity
  // and orientation are known up front: there is nothing to recover by
  // seam-matching and no layout to search for. Projection is therefore two
  // steps — put each face into one fixed cube layout (CUBE_LAYOUT below), then
  // project the cube to equirectangular with projectEquirect.
  //
  // projectEquirect is built for partial panoramas:
  //
  //   - it takes a column window (colStart/colEnd) beside the row window, so
  //     it can project a sub-rectangle of the sphere rather than whole rows,
  //     because the captured region is usually narrower than the sphere.
  //   - it applies the angular mask, so pixels outside the captured region are
  //     left transparent. Unphotographed area is never filled afterwards:
  //     nothing is invented to fill the rest.
  //
  // It writes a real alpha channel, not a constant 255: a face can be absent,
  // or assembled with holes, and both have to survive to the PNG.

  // rot90 and projectEquirect live in projection-core.js, which is loaded as a
  // MAIN-world content script just before this file and again through
  // importScripts() inside the projection worker, so exactly one copy of each
  // serves the worker, the main-thread fallback and selfTest().
  const { rot90, projectEquirect } = self.__fb360ProjectionCore;
  // Handed over, so the page is not left with them on its global.
  try { delete self.__fb360ProjectionCore; } catch {}

  // The fixed cube layout projectEquirect is fed.
  //
  // The two use different axis conventions: projectEquirect names its faces
  // F/R/B/L/U/D and puts +z forward, fb360 indexes them 0..5 and puts -z
  // forward (see FACE_DIR). Composing the two projections gives an exact
  // correspondence, so not one formula inside projectEquirect has to be
  // touched:
  //
  //     F = -Z   R = +X   B = +Z   L = -X
  //     U = +Y rotated 180 deg      D = -Y rotated 180 deg
  //
  // with rot90 applied to the two pole faces.
  const CUBE_LAYOUT = { F: MINUS_Z, R: PLUS_X, B: PLUS_Z, L: MINUS_X,
                        U: PLUS_Y,  D: MINUS_Y, rotU: 2, rotD: 2 };

  // Inverse of CUBE_LAYOUT: fb360 face index -> [projectEquirect slot,
  // rotation]. Faces arrive here one at a time, so the cube is oriented face
  // by face as they land rather than all six at once.
  const FACE_SLOT = (() => {
    const m = new Array(6);
    m[CUBE_LAYOUT.F] = ["F", 0];
    m[CUBE_LAYOUT.R] = ["R", 0];
    m[CUBE_LAYOUT.B] = ["B", 0];
    m[CUBE_LAYOUT.L] = ["L", 0];
    m[CUBE_LAYOUT.U] = ["U", CUBE_LAYOUT.rotU];
    m[CUBE_LAYOUT.D] = ["D", CUBE_LAYOUT.rotD];
    return m;
  })();


  // Top-left output rectangles for the part of the sphere a cube face can
  // reach. Only used to skip faces that cannot contribute at all; the
  // projection itself re-derives ownership per pixel, so the one-pixel pad
  // here is harmless.
  const FACE_RECT_PAD_PX = 1;

  function cpuFaceOutputRects(face, geom, pad = FACE_RECT_PAD_PX) {
    const rs = faceAngularRects(face, geom.bounds);
    const { width: W, height: H, i0, i1, j0, j1 } = geom;
    const ix = lon => (lon + Math.PI) / (2 * Math.PI) * W - 0.5;
    const jy = lat => (Math.PI / 2 - lat) / Math.PI * H - 0.5;
    const out = [];
    for (const [lon0, lon1, lat0, lat1] of rs) {
      let a = Math.floor(ix(lon0)) - pad;
      let b = Math.ceil(ix(lon1)) + pad;
      let c = Math.floor(jy(lat1)) - pad;
      let d = Math.ceil(jy(lat0)) + pad;
      a = Math.max(a, i0); b = Math.min(b, i1);
      c = Math.max(c, j0); d = Math.min(d, j1);
      if (a <= b && c <= d) {
        out.push({ x: a - i0, y: c - j0, w: b - a + 1, h: d - c + 1 });
      }
    }
    return out;
  }

  // Trim just the alpha edges of a canvas without materialising the full
  // equirectangular frame as ImageData. Only <= TRIM_MAX_PX + 1 edge
  // rows/columns are read. TRIM_MAX_PX is the most {trim} will take off any
  // one side; the selfTest cases pass 4 explicitly because their expected
  // rectangles are written for that value.
  const TRIM_MAX_PX = 4;

  function trimCanvasEdges(canvas, maxTrim = TRIM_MAX_PX) {
    const w = canvas.width, h = canvas.height;
    // The option here is a no-op whenever the caller already made a context —
    // it is the creating getContext that decides. Callers that hand a canvas
    // to this function should create its context with the flag; the projector
    // does. Kept anyway so a canvas arriving here untouched still gets it.
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const nx = Math.min(maxTrim + 1, w), ny = Math.min(maxTrim + 1, h);
    const left = ctx.getImageData(0, 0, nx, h).data;
    const right = ctx.getImageData(w - nx, 0, nx, h).data;
    const top = ctx.getImageData(0, 0, w, ny).data;
    const bottom = ctx.getImageData(0, h - ny, w, ny).data;

    // Each scan is restricted to the span the perpendicular edges have not
    // already given up. Judging a whole row across the full width would
    // not work: one transparent column means NO row is fully opaque, so the
    // vertical scan would run away to maxTrim — on a panorama with a 1px soft
    // rim, trimming 4px from every side instead of 1 and throwing away three
    // rows and columns of real photography each time.
    const opaqueLeftCol = (x, yLo, yHi) => {
      for (let y = yLo; y <= yHi; y++) if (left[((y * nx + x) << 2) + 3] < 255) return false;
      return true;
    };
    const opaqueRightCol = (xFromRight, yLo, yHi) => {
      const x = nx - 1 - xFromRight;
      for (let y = yLo; y <= yHi; y++) if (right[((y * nx + x) << 2) + 3] < 255) return false;
      return true;
    };
    const opaqueTopRow = (y, xLo, xHi) => {
      const off = y * w * 4;
      for (let x = xLo; x <= xHi; x++) if (top[off + (x << 2) + 3] < 255) return false;
      return true;
    };
    const opaqueBottomRow = (yFromBottom, xLo, xHi) => {
      const y = ny - 1 - yFromBottom, off = y * w * 4;
      for (let x = xLo; x <= xHi; x++) if (bottom[off + (x << 2) + 3] < 255) return false;
      return true;
    };

    // Which span to use is circular — each axis depends on the other — so it
    // is relaxed to a fixed point. The seed excludes the maximum possible trim
    // from each perpendicular edge, which is the narrowest span any answer can
    // have; starting there means the first pass cannot over-trim on evidence
    // that later turns out to lie in a region being cut anyway. The cuts only
    // ever grow from that floor and are capped at maxTrim, so this settles in
    // at most 4*maxTrim increments. Halving guards the seed on a canvas too
    // small to exclude maxTrim from both ends without the span collapsing.
    const seedY = Math.min(maxTrim, (h - 1) >> 1);
    const seedX = Math.min(maxTrim, (w - 1) >> 1);
    let l = 0, rCut = 0, t = 0, bCut = 0;
    let yLo = seedY, yHi = h - 1 - seedY, xLo = seedX, xHi = w - 1 - seedX;

    for (let pass = 0; pass <= 4 * maxTrim + 1; pass++) {
      const l0 = l, r0 = rCut, t0 = t, b0 = bCut;
      while (l < maxTrim && l < w - 1 - rCut && !opaqueLeftCol(l, yLo, yHi)) l++;
      while (rCut < maxTrim && rCut < w - 1 - l && !opaqueRightCol(rCut, yLo, yHi)) rCut++;
      xLo = l; xHi = w - 1 - rCut;
      while (t < maxTrim && t < h - 1 - bCut && !opaqueTopRow(t, xLo, xHi)) t++;
      while (bCut < maxTrim && bCut < h - 1 - t && !opaqueBottomRow(bCut, xLo, xHi)) bCut++;
      yLo = t; yHi = h - 1 - bCut;
      if (l === l0 && rCut === r0 && t === t0 && bCut === b0) break;
    }
    return { l, r: w - 1 - rCut, t, b: h - 1 - bCut };
  }

  // ------------------------------------------------------------------
  // WebGL projection — GPU fast path
  // ------------------------------------------------------------------
  //
  // "auto" tries this WebGL path first and falls back to the CPU projector
  // below if WebGL cannot be created, cannot fit a cube-face texture, or
  // reports a projection failure. The output itself is tiled, so it does not
  // have to fit in one WebGL drawing buffer.
  //
  // Faces are handled one at a time. That is important at level 3:
  // keeping six 4096x4096 textures would merely move the memory problem from
  // JS heap to GPU memory. Instead, one stitched 2D face canvas is
  // uploaded, projected into the persistent equirectangular framebuffer, then
  // its texture is deleted before the next face is assembled.
  //
  // The fragment shader reproduces projectEquirect's pixel-centre geometry,
  // face-selection tie rules, mask wrapping/clamping and bilinear sampling.
  // LINEAR texture filtering is the GPU equivalent of the four-tap bilinear
  // interpolation in projectEquirect.

  function webglProjectionError(message, cause = null) {
    const e = new Error(message);
    e.fb360WebGL = true;
    if (cause) e.cause = cause;
    return e;
  }

  function compileWebGLShader(gl, type, source) {
    const s = gl.createShader(type);
    if (!s) throw webglProjectionError("WebGL could not allocate a shader");
    gl.shaderSource(s, source);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const msg = gl.getShaderInfoLog(s) || "shader compilation failed";
      gl.deleteShader(s);
      throw webglProjectionError(`WebGL shader compilation failed: ${msg}`);
    }
    return s;
  }

  function linkWebGLProgram(gl, vertexSource, fragmentSource) {
    const vs = compileWebGLShader(gl, gl.VERTEX_SHADER, vertexSource);
    const fs = compileWebGLShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
    const p = gl.createProgram();
    if (!p) {
      gl.deleteShader(vs); gl.deleteShader(fs);
      throw webglProjectionError("WebGL could not allocate a shader program");
    }
    gl.attachShader(p, vs); gl.attachShader(p, fs);
    gl.linkProgram(p);
    gl.deleteShader(vs); gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      const msg = gl.getProgramInfoLog(p) || "program link failed";
      gl.deleteProgram(p);
      throw webglProjectionError(`WebGL program link failed: ${msg}`);
    }
    return p;
  }

  // Keep the transient WebGL render target modest even when the final panorama
  // is huge. A 12000x6000 RGBA default framebuffer alone is ~275 MiB, and the
  // stitched cube-face texture exists at the same time. Many drivers therefore
  // fail allocation well below their advertised MAX_VIEWPORT_DIMS. Rendering
  // into <=4096px tiles bounds the GPU framebuffer to <=64 MiB while the final
  // equirectangular image lives in the same 2D canvas the CPU path already uses.
  const WEBGL_OUTPUT_TILE_MAX = 4096;
  const WEBGL_OUTPUT_TILE_MIN = 512;

  function createWebGLProjector(geom, size) {
    const contextOptions = {
      alpha: true, antialias: false, depth: false, stencil: false,
      premultipliedAlpha: false, preserveDrawingBuffer: true,
      powerPreference: "high-performance",
    };

    // Query limits on a tiny context first. We do not make the real context
    // full-output-sized: reported viewport limits are capability limits, not a
    // promise that a framebuffer of that size fits in memory right now.
    let probeCanvas = document.createElement("canvas");
    probeCanvas.width = 1; probeCanvas.height = 1;
    let probe = null;
    try { probe = probeCanvas.getContext("webgl", contextOptions); }
    catch (e) {
      releaseCanvas(probeCanvas);
      return { projector: null, reason: `context creation threw: ${e.message || e}` };
    }
    if (!probe) {
      releaseCanvas(probeCanvas);
      return { projector: null, reason: "WebGL is unavailable or disabled" };
    }

    const maxTexture = probe.getParameter(probe.MAX_TEXTURE_SIZE) || 0;
    const maxRenderbuffer = probe.getParameter(probe.MAX_RENDERBUFFER_SIZE) || 0;
    const maxViewport = probe.getParameter(probe.MAX_VIEWPORT_DIMS) || [0, 0];
    const highp = probe.getShaderPrecisionFormat(probe.FRAGMENT_SHADER, probe.HIGH_FLOAT);
    const probeLose = probe.getExtension("WEBGL_lose_context");
    try { if (probeLose) probeLose.loseContext(); } catch {}
    releaseCanvas(probeCanvas);
    probeCanvas = null; probe = null;

    if (size > maxTexture) {
      return { projector: null,
        reason: `a ${size}px cube face exceeds MAX_TEXTURE_SIZE ${maxTexture}` };
    }
    if (!highp || !highp.precision) {
      return { projector: null,
        reason: "highp floating-point fragment shaders are unavailable" };
    }

    const hardTileLimit = Math.floor(Math.min(
      WEBGL_OUTPUT_TILE_MAX,
      maxTexture || WEBGL_OUTPUT_TILE_MAX,
      maxRenderbuffer || WEBGL_OUTPUT_TILE_MAX,
      maxViewport[0] || WEBGL_OUTPUT_TILE_MAX,
      maxViewport[1] || WEBGL_OUTPUT_TILE_MAX));
    if (hardTileLimit < 1) {
      return { projector: null, reason: "WebGL reported unusable framebuffer limits" };
    }

    // Allocation can fail from current GPU memory pressure even inside the
    // advertised limits. Try the preferred tile size, then progressively halve
    // it. A new canvas/context is used for every attempt because a failed resize
    // can permanently lose the old context.
    let canvas = null, gl = null, bufferW = 0, bufferH = 0;
    let edge = hardTileLimit;
    const tried = [];
    while (edge >= Math.min(WEBGL_OUTPUT_TILE_MIN, hardTileLimit)) {
      const tw = Math.max(1, Math.min(geom.outW, edge));
      const th = Math.max(1, Math.min(geom.outH, edge));
      tried.push(`${tw}x${th}`);
      const c = document.createElement("canvas");
      c.width = tw; c.height = th;
      let g = null;
      try { g = c.getContext("webgl", contextOptions); } catch {}
      if (g && !g.isContextLost() &&
          g.drawingBufferWidth === tw && g.drawingBufferHeight === th) {
        const err = g.getError();
        if (err === g.NO_ERROR) {
          canvas = c; gl = g; bufferW = tw; bufferH = th;
          break;
        }
      }
      if (g) {
        try {
          const lose = g.getExtension("WEBGL_lose_context");
          if (lose) lose.loseContext();
        } catch {}
      }
      releaseCanvas(c);
      if (edge <= WEBGL_OUTPUT_TILE_MIN) break;
      edge = Math.max(WEBGL_OUTPUT_TILE_MIN, Math.floor(edge / 2));
      if (tried.length > 12) break;
    }
    if (!gl) {
      return { projector: null,
        reason: `could not allocate even a tiled WebGL buffer (tried ${tried.join(", ")})` };
    }

    let outputCanvas = document.createElement("canvas");
    outputCanvas.width = geom.outW; outputCanvas.height = geom.outH;
    let outputCtx = null;
    try {
      outputCtx = outputCanvas.getContext("2d", { willReadFrequently: true });
    } catch {}
    if (!outputCtx) {
      try {
        const lose = gl.getExtension("WEBGL_lose_context");
        if (lose) lose.loseContext();
      } catch {}
      releaseCanvas(canvas); releaseCanvas(outputCanvas);
      return { projector: null,
        reason: `could not allocate the final ${geom.outW}x${geom.outH} 2D output canvas` };
    }
    outputCtx.imageSmoothingEnabled = false;

    const vertexSource = `
      attribute vec2 aPos;
      void main() {
        gl_Position = vec4(aPos, 0.0, 1.0);
      }`;

    // Face ids here are fb360's native indexes:
    // 0=-X 1=-Z 2=+X 3=+Z 4=+Y 5=-Y.
    //
    // uTileX/uTileY describe the reusable GPU tile in top-left output
    // coordinates. gl_FragCoord remains bottom-left based inside that tile, so
    // uTileH converts it back to the same top-left row convention used by the
    // CPU projector.
    const fragmentSource = `
      precision highp float;
      uniform sampler2D uFace;
      uniform float uSphereW;
      uniform float uSphereH;
      uniform float uI0;
      uniform float uJ0;
      uniform float uTileX;
      uniform float uTileY;
      uniform float uTileH;
      uniform int uFaceIndex;
      uniform int uHasMask;
      uniform int uGaps;
      uniform vec4 uMask;       // h, v, hCenter, vCenter
      uniform vec2 uMaskLimit;  // hLim, vLim

      const float PI = 3.1415926535897932384626433832795;
      const float EPS = 1.0e-9;

      void main() {
        float colCenter = uI0 + uTileX + gl_FragCoord.x;
        float rowCenter = uJ0 + uTileY + (uTileH - gl_FragCoord.y);
        float lon0 = (colCenter / uSphereW) * (2.0 * PI) - PI;
        float lat0 = PI * 0.5 - (rowCenter / uSphereH) * PI;
        float lon = lon0;
        float lat = lat0;

        if (uHasMask != 0) {
          float halfH = uMask.x * 0.5;
          float halfV = uMask.y * 0.5;
          float dlon0 = lon0 - uMask.z;
          float dlon = atan(sin(dlon0), cos(dlon0));
          float dlat = lat0 - uMask.w;
          if (abs(dlon) > halfH + EPS || abs(dlat) > halfV + EPS) discard;
          lon = uMask.z + clamp(dlon, -uMaskLimit.x, uMaskLimit.x);
          lat = uMask.w + clamp(dlat, -uMaskLimit.y, uMaskLimit.y);
        }

        float sinLat = sin(lat), cosLat = cos(lat);
        float x = cosLat * sin(lon);
        float y = sinLat;
        float z = cosLat * cos(lon);
        float ax = abs(x), ay = abs(y), az = abs(z);

        int chosen;
        vec2 uv;
        if (az >= ax && az >= ay) {
          if (z > 0.0) {
            chosen = 1;
            uv = vec2((x / az + 1.0) * 0.5, (-y / az + 1.0) * 0.5);
          } else {
            chosen = 3;
            uv = vec2((-x / az + 1.0) * 0.5, (-y / az + 1.0) * 0.5);
          }
        } else if (ax > az && ax >= ay) {
          if (x > 0.0) {
            chosen = 2;
            uv = vec2((-z / ax + 1.0) * 0.5, (-y / ax + 1.0) * 0.5);
          } else {
            chosen = 0;
            uv = vec2((z / ax + 1.0) * 0.5, (-y / ax + 1.0) * 0.5);
          }
        } else {
          if (y > 0.0) {
            chosen = 4;
            vec2 oriented = vec2((x / ay + 1.0) * 0.5,
                                 (z / ay + 1.0) * 0.5);
            uv = vec2(1.0) - oriented;
          } else {
            chosen = 5;
            vec2 oriented = vec2((x / ay + 1.0) * 0.5,
                                 (-z / ay + 1.0) * 0.5);
            uv = vec2(1.0) - oriented;
          }
        }
        if (chosen != uFaceIndex) discard;

        vec4 c = texture2D(uFace, clamp(uv, 0.0, 1.0));
        if (uGaps == 0) c.a = 1.0;
        else c.a = c.a > 0.0 ? 1.0 : 0.0;
        gl_FragColor = c;
      }`;

    let program = null, posBuffer = null, texture = null, uniforms = null;
    let contextLost = false, aborted = false, finalized = false;
    let startedAt = 0, facesDrawn = 0, gpuTilesDrawn = 0;
    let uploadMs = 0, submitMs = 0, copyMs = 0, finishMs = 0;
    const neededRects = new Array(6);
    for (let face = 0; face < 6; face++) neededRects[face] = cpuFaceOutputRects(face, geom);

    const loseExt = gl.getExtension("WEBGL_lose_context");
    const onContextLost = e => {
      e.preventDefault();
      contextLost = true;
    };
    canvas.addEventListener("webglcontextlost", onContextLost, false);

    const cleanupGL = lose => {
      if (!gl) return;
      try {
        if (texture) gl.deleteTexture(texture);
        if (posBuffer) gl.deleteBuffer(posBuffer);
        if (program) gl.deleteProgram(program);
      } catch {}
      texture = null; posBuffer = null; program = null;
      if (lose && loseExt) {
        try { loseExt.loseContext(); } catch {}
      }
    };

    const releaseGLCanvas = () => {
      if (!canvas) return;
      try { canvas.removeEventListener("webglcontextlost", onContextLost, false); }
      catch {}
      releaseCanvas(canvas);
      canvas = null;
    };

    const failInit = e => {
      cleanupGL(true);
      releaseGLCanvas();
      releaseCanvas(outputCanvas);
      outputCanvas = null; outputCtx = null;
      return { projector: null, reason: e.message || String(e) };
    };

    try {
      program = linkWebGLProgram(gl, vertexSource, fragmentSource);
      gl.useProgram(program);
      uniforms = {
        face: gl.getUniformLocation(program, "uFace"),
        sphereW: gl.getUniformLocation(program, "uSphereW"),
        sphereH: gl.getUniformLocation(program, "uSphereH"),
        i0: gl.getUniformLocation(program, "uI0"),
        j0: gl.getUniformLocation(program, "uJ0"),
        tileX: gl.getUniformLocation(program, "uTileX"),
        tileY: gl.getUniformLocation(program, "uTileY"),
        tileH: gl.getUniformLocation(program, "uTileH"),
        faceIndex: gl.getUniformLocation(program, "uFaceIndex"),
        hasMask: gl.getUniformLocation(program, "uHasMask"),
        gaps: gl.getUniformLocation(program, "uGaps"),
        mask: gl.getUniformLocation(program, "uMask"),
        maskLimit: gl.getUniformLocation(program, "uMaskLimit"),
      };

      const posLoc = gl.getAttribLocation(program, "aPos");
      if (posLoc < 0) throw webglProjectionError("WebGL vertex attribute aPos is unavailable");
      posBuffer = gl.createBuffer();
      if (!posBuffer) throw webglProjectionError("WebGL could not allocate a vertex buffer");
      gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
      gl.bufferData(gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(posLoc);
      gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

      texture = gl.createTexture();
      if (!texture) throw webglProjectionError("WebGL could not allocate a face texture");
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      if (gl.UNPACK_COLORSPACE_CONVERSION_WEBGL != null) {
        gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      }

      gl.uniform1i(uniforms.face, 0);
      gl.uniform1f(uniforms.sphereW, geom.width);
      gl.uniform1f(uniforms.sphereH, geom.height);
      gl.uniform1f(uniforms.i0, geom.i0);
      gl.uniform1f(uniforms.j0, geom.j0);

      const bounds = geom.bounds;
      if (bounds && !bounds.full) {
        const guard = 2 * Math.atan(1 / size);
        gl.uniform1i(uniforms.hasMask, 1);
        gl.uniform4f(uniforms.mask,
          bounds.h, bounds.v, bounds.hCenter || 0, bounds.vCenter || 0);
        gl.uniform2f(uniforms.maskLimit,
          Math.max(0, bounds.h / 2 - guard),
          Math.max(0, bounds.v / 2 - guard));
      } else {
        gl.uniform1i(uniforms.hasMask, 0);
        gl.uniform4f(uniforms.mask, 0, 0, 0, 0);
        gl.uniform2f(uniforms.maskLimit, 0, 0);
      }

      gl.disable(gl.BLEND);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.DITHER);
      gl.enable(gl.SCISSOR_TEST);
      gl.clearColor(0, 0, 0, 0);

      const err = gl.getError();
      if (err !== gl.NO_ERROR) {
        throw webglProjectionError(`WebGL initialization failed (GL error 0x${err.toString(16)})`);
      }
    } catch (e) {
      return failInit(e);
    }

    const intersectRect = (r, x, y, w, h) => {
      const x0 = Math.max(r.x, x), y0 = Math.max(r.y, y);
      const x1 = Math.min(r.x + r.w, x + w), y1 = Math.min(r.y + r.h, y + h);
      return x1 > x0 && y1 > y0
        ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
        : null;
    };

    async function addFace(face, faceCanvas, ctx, gaps = false) {
      if (aborted || !faceCanvas || !neededRects[face] || !neededRects[face].length) return;
      if (contextLost || gl.isContextLost()) {
        throw webglProjectionError("WebGL context was lost before projecting a face");
      }
      if (!startedAt) startedAt = performance.now();

      try {
        const u0 = performance.now();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA,
                      gl.UNSIGNED_BYTE, faceCanvas);
        uploadMs += performance.now() - u0;
        let err = gl.getError();
        if (err !== gl.NO_ERROR) {
          throw webglProjectionError(
            `WebGL face upload failed for face ${face} (GL error 0x${err.toString(16)})`);
        }

        gl.uniform1i(uniforms.faceIndex, face);
        gl.uniform1i(uniforms.gaps, gaps ? 1 : 0);

        for (let tileY = 0; tileY < geom.outH; tileY += bufferH) {
          const tileH = Math.min(bufferH, geom.outH - tileY);
          for (let tileX = 0; tileX < geom.outW; tileX += bufferW) {
            const tileW = Math.min(bufferW, geom.outW - tileX);
            const intersections = [];
            for (const r of neededRects[face]) {
              const q = intersectRect(r, tileX, tileY, tileW, tileH);
              if (q) intersections.push(q);
            }
            if (!intersections.length) continue;

            gl.viewport(0, 0, tileW, tileH);
            gl.uniform1f(uniforms.tileX, tileX);
            gl.uniform1f(uniforms.tileY, tileY);
            gl.uniform1f(uniforms.tileH, tileH);

            // Only the lower-left tileW x tileH part of the fixed drawing
            // buffer is used. In DOM/top-left canvas coordinates that rectangle
            // begins at y = bufferH - tileH when copied below.
            gl.scissor(0, 0, tileW, tileH);
            gl.clear(gl.COLOR_BUFFER_BIT);

            const p0 = performance.now();
            for (const q of intersections) {
              const lx = q.x - tileX;
              const ly = q.y - tileY;
              gl.scissor(lx, tileH - (ly + q.h), q.w, q.h);
              gl.drawArrays(gl.TRIANGLES, 0, 3);
            }
            gl.flush();
            submitMs += performance.now() - p0;
            err = gl.getError();
            if (err !== gl.NO_ERROR) {
              throw webglProjectionError(
                `WebGL tiled draw failed for face ${face} at ${tileX},${tileY} ` +
                `(GL error 0x${err.toString(16)})`);
            }

            // Copy only the union of this face's bounding rectangles in the
            // tile. Pixels discarded by the shader remain transparent and
            // source-over compositing leaves earlier faces untouched.
            let ux0 = tileX + tileW, uy0 = tileY + tileH;
            let ux1 = tileX, uy1 = tileY;
            for (const q of intersections) {
              ux0 = Math.min(ux0, q.x); uy0 = Math.min(uy0, q.y);
              ux1 = Math.max(ux1, q.x + q.w); uy1 = Math.max(uy1, q.y + q.h);
            }
            const copyW = ux1 - ux0, copyH = uy1 - uy0;
            const localX = ux0 - tileX, localY = uy0 - tileY;
            const c0 = performance.now();
            outputCtx.drawImage(canvas,
              localX, bufferH - tileH + localY, copyW, copyH,
              ux0, uy0, copyW, copyH);
            copyMs += performance.now() - c0;
            gpuTilesDrawn++;
          }
        }
        facesDrawn++;
      } catch (e) {
        if (e && e.fb360WebGL) throw e;
        throw webglProjectionError(`WebGL projection failed on face ${face}: ${e.message || e}`, e);
      }
    }

    function abort() {
      if (aborted) return;
      aborted = true;
      cleanupGL(true);
      releaseGLCanvas();
      if (!finalized && outputCanvas) {
        releaseCanvas(outputCanvas);
        outputCanvas = null; outputCtx = null;
      }
    }

    async function finish(trim) {
      if (aborted) throw webglProjectionError("WebGL projector was aborted");
      if (contextLost || gl.isContextLost()) {
        throw webglProjectionError("WebGL context was lost before projection completed");
      }
      try {
        const f0 = performance.now();
        gl.finish();
        finishMs += performance.now() - f0;
        const err = gl.getError();
        if (err !== gl.NO_ERROR) {
          throw webglProjectionError(
            `WebGL finish failed (GL error 0x${err.toString(16)})`);
        }

        // The GPU tile has already been copied after every draw, so WebGL owns
        // no part of the final image now and can be discarded before trimming
        // or encoding the potentially very large 2D canvas.
        cleanupGL(true);
        releaseGLCanvas();

        let dx = 0, dy = 0, trimAmount = 0;
        let resultCanvas = outputCanvas;
        if (trim) {
          const tr = trimCanvasEdges(outputCanvas);
          const w = tr.r - tr.l + 1, h = tr.b - tr.t + 1;
          trimAmount = Math.max(tr.l, tr.t,
            outputCanvas.width - 1 - tr.r, outputCanvas.height - 1 - tr.b);
          if (trimAmount) {
            const c = document.createElement("canvas");
            c.width = w; c.height = h;
            const c2d = c.getContext("2d");
            if (!c2d) throw webglProjectionError("could not allocate trimmed output canvas");
            c2d.drawImage(outputCanvas, tr.l, tr.t, w, h, 0, 0, w, h);
            resultCanvas = c; dx = tr.l; dy = tr.t;
            releaseCanvas(outputCanvas);
          }
        }

        const wall = startedAt ? performance.now() - startedAt : 0;
        log(`timing: WebGL projection ${wall.toFixed(0)} ms ` +
            `(${facesDrawn} face${facesDrawn === 1 ? "" : "s"}, ` +
            `${gpuTilesDrawn} GPU tile draw${gpuTilesDrawn === 1 ? "" : "s"}, ` +
            `texture upload ${uploadMs.toFixed(0)} ms, command submit ` +
            `${submitMs.toFixed(0)} ms, GPU->canvas copy ${copyMs.toFixed(0)} ms, ` +
            `GPU finish ${finishMs.toFixed(0)} ms)`);

        const xmp = {
          UsePanoramaViewer: true,
          ProjectionType: "equirectangular",
          FullPanoWidthPixels: geom.width, FullPanoHeightPixels: geom.height,
          CroppedAreaImageWidthPixels: resultCanvas.width,
          CroppedAreaImageHeightPixels: resultCanvas.height,
          CroppedAreaLeftPixels: geom.i0 + dx,
          CroppedAreaTopPixels: geom.j0 + dy,
        };

        outputCanvas = resultCanvas;
        outputCtx = null;
        finalized = true;
        let released = false;
        return {
          canvas: resultCanvas, xmp,
          trimmed: trimAmount,
          cropped: resultCanvas.width !== geom.width || resultCanvas.height !== geom.height,
          release: () => {
            if (released) return;
            released = true;
            releaseCanvas(resultCanvas);
          },
        };
      } catch (e) {
        if (e && e.fb360WebGL) throw e;
        throw webglProjectionError(`WebGL finalization failed: ${e.message || e}`, e);
      }
    }

    const cols = Math.ceil(geom.outW / bufferW);
    const rows = Math.ceil(geom.outH / bufferH);
    return {
      projector: {
        backend: "webgl",
        mode: `WebGL GPU projector (incremental one-face texture; tiled ` +
              `${bufferW}x${bufferH} buffer, ${cols}x${rows} output tiles; ` +
              `max texture ${maxTexture}px)`,
        cpuReadback: false,
        faceProgressVerb: "GPU-projected",
        faceNeeded: face => !!(neededRects[face] && neededRects[face].length),
        addFace, finish, abort,
      },
      reason: null,
    };
  }

  // {projection} when the caller does not name one: WebGL first, CPU on
  // failure. runEquirect() defaults the public option to the same value.
  const DEFAULT_PROJECTION = "auto";

  function createProjectionProjector(geom, size, preference = DEFAULT_PROJECTION) {
    if (preference !== "cpu") {
      const w = createWebGLProjector(geom, size);
      if (w.projector) return w.projector;
      if (preference === "webgl") {
        throw webglProjectionError(`WebGL projection was required but unavailable: ${w.reason}`);
      }
      warn(`WebGL projection unavailable (${w.reason}); using the CPU fallback`);
    }
    return createWorkerProjector(geom, size);
  }

  // ------------------------------------------------------------------
  // Projection worker — exactly one, doing the whole output
  // ------------------------------------------------------------------
  //
  // This is the script's only actual thread. Everything else that looks
  // concurrent — pool()'s lanes, the fanned-out tile-url queries — is one
  // thread waiting on many sockets, and is bounded by {concurrency} and
  // {urlConcurrency} rather than by anything to do with cores.
  //
  // Projection is the only expensive stage, and the one place it must not run
  // is facebook.com's main thread. projectEquirect awaits onProgress between
  // chunks, and on the page's event loop that yield resumes only once the host
  // page's own queued work has run; a hidden tab clamps each setTimeout to
  // 1000ms on top of that. The arithmetic is unchanged either way, but the
  // wall time is not: the yields dominate it.
  //
  // So one worker runs projectEquirect over the whole output. Inside a worker
  // nothing else is queued, so it needs no yields at all — onProgress is null
  // and the sink is synchronous, which is the fastest this loop can be driven.
  // Finished 128-row RGBA strips are posted back and painted straight into the
  // canvas, so only one chunk is ever in flight and the full panorama never
  // exists as a single JS buffer (512 MiB at 16384x8192).
  //
  // rot90 and projectEquirect are shared with the worker through
  // projection-core.js rather than duplicated, so the extension holds exactly
  // one copy of each and the main-thread fallback below runs byte-for-byte the
  // same code. The worker itself is projector-worker.js, started from the
  // extension's origin as startWorker() below describes.

  // Incremental projector: a face is read back, projected and released before
  // the next face is assembled. At level 3 this changes the retained face data
  // from ~384 MiB (six 4096^2 RGBA buffers) to at most one native face plus a
  // temporary rotated copy for a pole face.
  const WORKER_IDLE_TIMEOUT_MS = 60000;

  // The two message tags this file shares with the rest of
  // the extension. HOST_KEY addresses projector-host.js, which is this page's
  // isolated world and reachable only through window messages; FRAME_KEY
  // addresses the projector frame itself. Both are filtered on sender and on a
  // per-start random id as well as on the tag, because facebook.com posts
  // plenty of window messages of its own.
  const HOST_KEY = "__fb360_projector_host__";
  const FRAME_KEY = "__fb360_projector_frame__";
  const PROJECTOR_START_TIMEOUT_MS = 10000;

  function createWorkerProjector(geom, size) {
    const oneFaceBytes = size * size * 4;
    if (oneFaceBytes > 256 * 1024 * 1024) {
      warn(`one projection face is about ${(oneFaceBytes / 1073741824).toFixed(2)} GiB RGBA`);
    }

    const neededRects = new Array(6);
    for (let face = 0; face < 6; face++) neededRects[face] = cpuFaceOutputRects(face, geom);

    let canvas = document.createElement("canvas");
    canvas.width = geom.outW; canvas.height = geom.outH;
    // getContext options are honoured only on the call that CREATES the
    // context; a later getContext("2d", opts) on the same canvas returns the
    // existing one and drops the options on the floor. finish() reads this
    // canvas back through trimCanvasEdges, so the flag has to be set here to
    // mean anything. It also suits the workload: every chunk arrives as
    // ImageData from the CPU side, so a software-backed canvas avoids a GPU
    // round-trip per chunk as well as on the readback.
    const cctx = canvas.getContext("2d", { willReadFrequently: true });
    let scratch = document.createElement("canvas");
    let sctx = scratch.getContext("2d");
    let faceReadbackMs = 0, projectMs = 0, uploadMs = 0;
    let orientMs = 0, yieldMs = 0, yieldCount = 0;
    let workerStatePromise = null, workerState = null, aborted = false;

    // This script runs in the page's own world — it has to, to patch the
    // page's fetch — and in that world a worker cannot be started at all: facebook.com's CSP has no blob: in worker-src, so
    // `new Worker(URL.createObjectURL(...))` throws, and there is no
    // page-origin URL an extension file could be served from either.
    //
    // So the worker is started from a context the page's CSP does not govern.
    // projector-host.js — the isolated-world half of this extension — puts a
    // chrome-extension:// frame in the document; that frame is same-origin
    // with projector-worker.js and runs under the extension's CSP, where a
    // plain same-origin worker is allowed. It then relays messages between
    // that worker and this window, keeping transfers intact in both
    // directions, so a face buffer moves rather than being copied.
    //
    // What comes back from here is a proxy exposing the four things
    // runFaceInWorker and abort()/finish() use — postMessage(msg, transfer),
    // onmessage, onerror, terminate() — and the handshake is the worker's own
    // {type:"ready"}, relayed. If any of this fails, resolve(null) and the
    // projection runs on the main thread instead.
    function startWorker() {
      return new Promise(resolve => {
        const id = `fb360-projector-${Math.random().toString(36).slice(2)}`;
        let frame = null, timer = null, settled = false, proxy = null;

        const give = (worker, err) => {
          if (settled) return;
          settled = true;
          if (timer !== null) clearTimeout(timer);
          if (!worker) {
            window.removeEventListener("message", onMessage);
            destroyFrame();
            if (err) warn(`projection worker unavailable (${err.message}); ` +
                          `falling back to the main thread, which is much slower`);
          }
          // `url` is part of the shape abort()/finish() expect, and they
          // revoke it; no object URL backs this worker, so it is null.
          resolve(worker ? { worker, url: null } : null);
        };

        const destroyFrame = () => {
          try { window.postMessage({ [HOST_KEY]: "destroy", id }, location.origin); } catch {}
        };

        function onMessage(ev) {
          const d = ev.data;
          if (!d || typeof d !== "object" || d.id !== id) return;

          // Two senders, both required to name this frame's id. The host's
          // replies come from this window; the frame's come from the frame.
          if (ev.source === window && d[HOST_KEY] === "created") {
            frame = document.getElementById(id);
            if (!frame || !frame.contentWindow) {
              give(null, new Error("projector frame vanished"));
              return;
            }
            // Identifies this window to the frame and tells it to start the
            // worker. The worker's own {type:"ready"} then arrives below, so
            // the handshake is still the worker's, not the relay's.
            frame.contentWindow.postMessage({ [FRAME_KEY]: true, id, kind: "start" }, "*");
            return;
          }
          if (ev.source === window && d[HOST_KEY] === "failed") {
            give(null, new Error(d.error || "projector frame failed to load"));
            return;
          }
          if (d[FRAME_KEY] !== true || !frame || ev.source !== frame.contentWindow) return;

          if (d.kind === "error") {
            const e = new Error(d.error || "projection worker crashed");
            if (!settled) give(null, e);
            else if (proxy.onerror) proxy.onerror(e);
            return;
          }
          if (d.kind !== "message") return;
          if (!settled) {
            if ((d.msg || {}).type === "ready") give(proxy);
            return;
          }
          if (proxy.onmessage) proxy.onmessage({ data: d.msg });
        }

        proxy = {
          onmessage: null,
          onerror: null,
          postMessage(msg, transfer) {
            if (!frame || !frame.contentWindow) return;
            frame.contentWindow.postMessage(
              { [FRAME_KEY]: true, id, kind: "message", msg }, "*", transfer || []);
          },
          terminate() {
            window.removeEventListener("message", onMessage);
            proxy.onmessage = null; proxy.onerror = null;
            if (frame && frame.contentWindow) {
              try {
                frame.contentWindow.postMessage(
                  { [FRAME_KEY]: true, id, kind: "terminate" }, "*");
              } catch {}
            }
            frame = null;
            destroyFrame();
          },
        };

        window.addEventListener("message", onMessage);
        try {
          window.postMessage({ [HOST_KEY]: "create", id }, location.origin);
        } catch (e) { give(null, e); return; }
        // Two hops (frame document, then worker script), both local files,
        // so this is only a bound on something being wrong.
        timer = setTimeout(
          () => give(null, new Error("startup timed out")), PROJECTOR_START_TIMEOUT_MS);
      });
    }

    async function getWorkerState() {
      if (workerStatePromise === null) {
        workerStatePromise = startWorker().then(v => (workerState = v));
      }
      return workerStatePromise;
    }

    // Transparent pixels in a face pass must not erase pixels painted by an
    // earlier face. putImageData itself does not composite, so stage each strip
    // through a tiny scratch canvas and draw it source-over onto the output.
    function paint(view, firstCol, firstRow, cols, rows) {
      const u0 = performance.now();
      if (scratch.width !== cols || scratch.height !== rows) {
        scratch.width = cols; scratch.height = rows;
        sctx = scratch.getContext("2d");
      } else {
        sctx.clearRect(0, 0, cols, rows);
      }
      sctx.putImageData(new ImageData(view, cols, rows), 0, 0);
      cctx.drawImage(scratch, firstCol - geom.i0, firstRow - geom.j0);
      uploadMs += performance.now() - u0;
    }

    function faceRectsForWorker(face) {
      return (neededRects[face] || []).map(r => ({
        colStart: geom.i0 + r.x, colEnd: geom.i0 + r.x + r.w,
        rowStart: geom.j0 + r.y, rowEnd: geom.j0 + r.y + r.h,
      }));
    }

    // A worker killed by the OS under memory pressure can go silent without
    // firing onerror, which left this promise pending forever and hung the
    // whole run with no error. The watchdog is reset by every chunk, so it
    // bounds SILENCE rather than total projection time — a legitimately slow
    // 4096px face keeps the timer alive by making progress.
    function runFaceInWorker(ws, face, raw, gaps, mask) {
      return new Promise((resolve, reject) => {
        const slot = FACE_SLOT[face];
        const w = ws.worker;
        let timer = null, settled = false;
        const settle = err => {
          if (settled) return;
          settled = true;
          if (timer !== null) clearTimeout(timer);
          w.onmessage = null; w.onerror = null;
          err ? reject(err) : resolve();
        };
        const kick = () => {
          if (timer !== null) clearTimeout(timer);
          timer = setTimeout(() => settle(new Error(
            `projection worker went silent for ${WORKER_IDLE_TIMEOUT_MS}ms on ` +
            `face ${face}; it may have been killed under memory pressure`)),
            WORKER_IDLE_TIMEOUT_MS);
        };
        w.onerror = e => settle(new Error(e.message || "projection worker crashed"));
        w.onmessage = e => {
          const d = e.data || {};
          if (d.type === "chunk") {
            kick();
            paint(new Uint8ClampedArray(d.buf), d.firstCol, d.firstRow, d.cols, d.rows);
          } else if (d.type === "faceDone" && d.faceIndex === face) {
            settle(d.error ? new Error(d.error) : null);
          }
        };
        kick();
        w.postMessage({
          type: "projectFace", faceIndex: face,
          face: { buf: raw.data.buffer, size: raw.width,
                  slot: slot[0], rot: slot[1], gaps: !!gaps },
          rects: faceRectsForWorker(face), width: geom.width, mask,
        }, [raw.data.buffer]);
      });
    }

    async function runFaceOnMain(face, raw, gaps, mask) {
      const slot = FACE_SLOT[face];
      const o0 = performance.now();
      const oriented = rot90(
        { data: raw.data, width: raw.width, height: raw.width }, slot[1]);
      orientMs += performance.now() - o0;
      oriented.gaps = !!gaps;
      const cube = { F: null, R: null, B: null, L: null, U: null, D: null };
      cube[slot[0]] = oriented;
      let lastYield = performance.now();
      const onProgress = async () => {
        if (performance.now() - lastYield > 100) {
          const y0 = performance.now();
          await new Promise(res => setTimeout(res, 0));
          yieldMs += performance.now() - y0; yieldCount++;
          lastYield = performance.now();
        }
      };
      for (const r of faceRectsForWorker(face)) {
        const opts = {
          rowStart: r.rowStart, rowEnd: r.rowEnd,
          colStart: r.colStart, colEnd: r.colEnd,
          sink: (chunk, firstRow, rows) =>
            paint(chunk, r.colStart, firstRow, r.colEnd - r.colStart, rows),
        };
        if (mask) opts.mask = mask;
        await projectEquirect(cube, geom.width, onProgress, opts);
      }
    }

    async function addFace(face, faceCanvas, ctx, gaps = false) {
      if (aborted || !faceCanvas || !neededRects[face] || !neededRects[face].length) return;
      const c = ctx || faceCanvas.getContext("2d", { willReadFrequently: true });
      const r0 = performance.now();
      const img = c.getImageData(0, 0, faceCanvas.width, faceCanvas.height);
      faceReadbackMs += performance.now() - r0;

      const bounds = geom.bounds;
      const mask = bounds && !bounds.full
        // guard is subtracted from half-angles in projectEquirect, and that
        // function's contract says the whole mask is in radians. 2/size is a
        // face-coordinate texel width, not an angle; 2*atan(1/size) is the
        // same texel expressed the way the consumer actually uses it.
        ? { h: bounds.h, v: bounds.v, guard: 2 * Math.atan(1 / size),
            hCenter: bounds.hCenter || 0, vCenter: bounds.vCenter || 0 } : null;
      const ws = await getWorkerState();
      if (aborted) return;
      const p0 = performance.now();
      try {
        if (ws) await runFaceInWorker(ws, face, img, gaps, mask);
        else await runFaceOnMain(face, img, gaps, mask);
      } catch (e) {
        abort();
        throw e;
      }
      projectMs += performance.now() - p0;
      // `img` is detached after a worker transfer, or becomes unreachable here
      // on the main-thread path. No face-sized array survives into the next face.
    }

    function abort() {
      aborted = true;
      if (workerState) {
        try { workerState.worker.terminate(); } catch {}
        try { URL.revokeObjectURL(workerState.url); } catch {}
        workerState = null;
      }
    }

    async function finish(trim) {
      if (workerStatePromise) await workerStatePromise;
      if (workerState) {
        try { workerState.worker.terminate(); } catch {}
        try { URL.revokeObjectURL(workerState.url); } catch {}
        workerState = null;
      }

      let dx = 0, dy = 0, trimAmount = 0;
      if (trim) {
        const tr = trimCanvasEdges(canvas);
        const w = tr.r - tr.l + 1, h = tr.b - tr.t + 1;
        trimAmount = Math.max(tr.l, tr.t,
          canvas.width - 1 - tr.r, canvas.height - 1 - tr.b);
        if (trimAmount) {
          const c = document.createElement("canvas");
          c.width = w; c.height = h;
          c.getContext("2d").drawImage(canvas, tr.l, tr.t, w, h, 0, 0, w, h);
          releaseCanvas(canvas);
          canvas = c; dx = tr.l; dy = tr.t;
        }
      }

      log(`timing: face readback ${faceReadbackMs.toFixed(0)} ms, ` +
          (orientMs ? `orientation ${orientMs.toFixed(0)} ms, ` : "") +
          `projection ${projectMs.toFixed(0)} ms, canvas composite ${uploadMs.toFixed(0)} ms` +
          (yieldMs ? ` + ${yieldMs.toFixed(0)} ms yielded to the page (${yieldCount} yields)` : ""));

      // UsePanoramaViewer is what actually flips a viewer out of flat-image
      // mode; without it the geometry below is just described, not acted on.
      const xmp = {
        UsePanoramaViewer: true,
        ProjectionType: "equirectangular",
        FullPanoWidthPixels: geom.width, FullPanoHeightPixels: geom.height,
        CroppedAreaImageWidthPixels: canvas.width,
        CroppedAreaImageHeightPixels: canvas.height,
        CroppedAreaLeftPixels: geom.i0 + dx,
        CroppedAreaTopPixels: geom.j0 + dy,
      };
      return {
        canvas, xmp,
        trimmed: trimAmount,
        cropped: canvas.width !== geom.width || canvas.height !== geom.height,
        release: () => releaseCanvas(canvas),
      };
    }

    return {
      backend: "cpu",
      mode: "CPU projector, incremental face-at-a-time projection worker",
      cpuReadback: true,
      faceProgressVerb: "projected",
      faceNeeded: face => !!(neededRects[face] && neededRects[face].length),
      addFace, finish, abort,
    };
  }

  // ------------------------------------------------------------------
  // CRC32 — used by the PNG iTXt chunk that carries the XMP packet
  // ------------------------------------------------------------------

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  // Incremental, so a CRC can be taken over a Blob's stream without ever
  // holding the whole file as one buffer.
  function crc32Update(crc, buf) {
    for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
    return crc;
  }

  function crc32(buf) {
    return (crc32Update(0xFFFFFFFF, buf) ^ 0xFFFFFFFF) >>> 0;
  }

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  // ------------------------------------------------------------------
  // Output format and quality
  // ------------------------------------------------------------------
  //
  // canvas.toBlob has two failure modes that both end in a file whose name
  // lies about its contents, and both are silent:
  //
  //   - a `type` it does not recognise as a MIME type is ignored outright,
  //     and a type it recognises but cannot encode "must fall back to
  //     image/png" (HTML spec). Either way PNG bytes come back: passed through
  //     as-is, even {format: "jpeg"} — not a MIME type — would produce PNG,
  //     and a file named after the request would call it .jpg.
  //   - a `quality` outside 0..1 (or a non-Number) is ignored and the UA's
  //     own default is used instead, so {quality: 85} would silently do
  //     nothing.
  //
  // The cure for both is the same: normalise what goes in, and believe the
  // Blob about what came out.

  // {format} when none is given — normalizeFormat(), runEquirect() and the
  // button's picker all start from this — and the lossy-encoder quality
  // runEquirect() uses when {quality} is not supplied.
  const DEFAULT_OUTPUT_FORMAT = "auto";
  const DEFAULT_LOSSY_QUALITY = 0.92;

  // {embedMetadata} when none is given, and the button's checkbox before the
  // user has ever touched it. On, because a panorama without its GPano packet
  // is a flat 2:1 image to every viewer that would otherwise show it as 360.
  const DEFAULT_EMBED_METADATA = true;

  const MIME_FOR_FORMAT = {
    "auto": "auto",
    "png": "image/png", "image/png": "image/png",
    "jpg": "image/jpeg", "jpeg": "image/jpeg",
    "image/jpg": "image/jpeg", "image/jpeg": "image/jpeg",
    "webp": "image/webp", "image/webp": "image/webp",
  };

  const EXT_FOR_MIME = {
    "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp",
  };

  // The extension always follows the MIME type the encoder really emitted, so
  // an unexpected one still gets a truthful name rather than a wrong one.
  const extFor = mime => EXT_FOR_MIME[mime] ||
    (String(mime).split("/")[1] || "").replace(/[^a-z0-9]/gi, "").toLowerCase() ||
    "bin";

  // Only PNG and WebP carry an alpha channel. Forcing anything else over an
  // image that has transparent regions flattens them, usually to black.
  const keepsAlpha = mime => mime === "image/png" || mime === "image/webp";

  // PNG is lossless, so quality is meaningless for it and must not be passed.
  const isLossy = mime => mime === "image/jpeg" || mime === "image/webp";

  // Whether this browser can actually encode a type, asked once and cached.
  // toDataURL answers synchronously and follows the same fallback rule as
  // toBlob, so a one-pixel canvas settles it: if the prefix that comes back is
  // not the type asked for, the encoder is not there.
  const formatSupport = new Map();
  function formatSupported(mime) {
    if (mime === "image/png") return true;   // always available
    if (!formatSupport.has(mime)) {
      let ok = false;
      try {
        const c = document.createElement("canvas");
        c.width = c.height = 1;
        ok = c.toDataURL(mime).startsWith(`data:${mime}`);
      } catch { ok = false; }
      formatSupport.set(mime, ok);
    }
    return formatSupport.get(mime);
  }

  // Validated up front, before a survey and six face stitches have been paid
  // for, so a typo costs a second rather than several minutes.
  function normalizeFormat(format) {
    if (format == null) return DEFAULT_OUTPUT_FORMAT;
    const key = String(format).trim().toLowerCase();
    const mime = MIME_FOR_FORMAT[key];
    if (!mime) {
      throw new Error(`unknown {format: ${JSON.stringify(format)}} — use ` +
        `"auto", "png", "jpeg", "webp", or a full MIME type`);
    }
    if (mime !== "auto" && !formatSupported(mime)) {
      throw new Error(`this browser cannot encode ${mime}; it would silently ` +
        `write PNG bytes instead. Use {format: "png"} or {format: "auto"}.`);
    }
    return mime;
  }

  // Returns undefined for PNG and for "leave it to the encoder", which is the
  // only way to actually get the UA default rather than a number it ignores.
  function normalizeQuality(quality, mime) {
    if (!isLossy(mime)) return undefined;       // PNG: lossless, no knob
    if (quality == null) return undefined;
    if (typeof quality === "string" && quality.trim().toLowerCase() === "lossless") {
      if (mime !== "image/webp") {
        throw new Error(`{quality: "lossless"} only applies to WebP; ` +
          `${mime} has no lossless mode. Use {format: "webp"} with it, or ` +
          `{format: "png"} for lossless without WebP.`);
      }
      return 1;                                  // Chrome's WebP lossless path
    }
    let q = Number(quality);
    if (!Number.isFinite(q)) {
      throw new Error(`{quality: ${JSON.stringify(quality)}} is not a number`);
    }
    // 0..1 is the API's scale, but 0..100 is what everyone types, so a value
    // above 1 is read as a percentage. That heuristic had no lower guard,
    // which made {quality: 2} mean 0.02 — a several-minute run encoded into
    // unusable mush, silently. Nothing plausible lives between 1 and 10 on
    // either scale, so that gap is an error naming both readings rather than
    // a guess at which was meant.
    if (q > 1) {
      if (q > 100) throw new Error(`{quality: ${q}} is out of range (0..1, or 0..100)`);
      if (q < 10) {
        throw new Error(`{quality: ${JSON.stringify(quality)}} is ambiguous — ` +
          `0..1 is the canvas API's scale and 0..100 the percentage one, and ` +
          `${q} is implausible on either. Write ${q / 100} if you meant ${q}%, ` +
          `or ${Math.round(q) * 10} if you meant ${Math.round(q) * 10}%.`);
      }
      q /= 100;
    }
    if (q < 0) throw new Error(`{quality: ${quality}} is out of range (0..1, or 0..100)`);
    return q;
  }

  // Both options in one call, so every entry point validates the same way and
  // does it before the work rather than after. In "auto" mode the type is
  // chosen per image and JPEG is always a possible outcome, so quality is
  // checked against JPEG's rules — which is what makes {quality: "lossless"}
  // an error here (it needs an explicit {format: "webp"} to mean anything)
  // instead of a surprise thrown from the middle of encoding face 4.
  function normalizeOutput(opts = {}) {
    const format = normalizeFormat(opts.format);
    normalizeQuality(opts.quality, format === "auto" ? "image/jpeg" : format);
    return format;
  }

  // Encodes and reports what it actually produced. The returned `type` is the
  // Blob's own, so callers name files after the bytes they hold.
  //
  // This returns the Blob; encodeCanvas wraps it to hand back bytes, which the
  // equirect needs because the XMP packet has to be spliced into them.
  let encoderFallbackWarned = false;
  async function encodeCanvasToBlob(canvas, mime, quality) {
    const q = normalizeQuality(quality, mime);
    const blob = await new Promise(resolve =>
      canvas.toBlob(resolve, mime, q));
    // toBlob hands back null when the canvas has no pixels or exceeds what the
    // browser will encode. It is checked here, outside the toBlob callback: a
    // throw inside that callback would be swallowed and the promise would
    // never settle, hanging the download with no error.
    if (!blob) {
      throw new Error(`could not encode a ${canvas.width}x${canvas.height} ` +
        `canvas as ${mime} — it is likely past this browser's encoder limit`);
    }
    const actual = (blob.type || "").split(";")[0].trim().toLowerCase() || mime;
    if (actual !== mime && !encoderFallbackWarned) {
      encoderFallbackWarned = true;
      warn(`asked for ${mime} but the browser encoded ${actual}; files are ` +
           `named for what they actually contain`);
    }
    return { blob, type: actual, ext: extFor(actual) };
  }

  async function encodeCanvas(canvas, mime, quality) {
    const enc = await encodeCanvasToBlob(canvas, mime, quality);
    return { bytes: new Uint8Array(await enc.blob.arrayBuffer()),
             type: enc.type, ext: enc.ext };
  }

  const releaseCanvas = c => { c.width = 0; c.height = 0; };

  // One ceiling for the concept, shared by option validation and the level
  // probe. Two different limits would let a level validate cleanly and then
  // ask enumerateTiles for hundreds of thousands of tiles and the canvas for a
  // face it cannot encode — a failure that would arrive minutes later as a
  // null from toBlob.
  //
  // The number is a canvas budget, not a guess at Facebook's tiling: level L
  // needs a (tileSize << L)px square face per side, which is 4096px at L=3
  // for the usual 512px tiles. Raise it only alongside a test that the
  // resulting face canvas actually encodes.
  //
  // In practice 3 is the ceiling for the foreseeable future, so the comments
  // throughout this file cost their examples at level 3: 384 tiles, 4096px
  // faces, ~64 MiB per face as RGBA.
  const MAX_PUBLIC_TILE_LEVEL = 3;
  // The tile edge Facebook serves in practice. Only used to cost a level in
  // messages; the real tile size is always measured (probeTileSize).
  const TYPICAL_TILE_SIZE_PX = 512;
  const faceSizeAtLevel = (level, tileSize = TYPICAL_TILE_SIZE_PX) => tileSize << level;

  // A level the user asked for explicitly is an error when it is out of range;
  // a level discovered from the page or the server is not the user's fault, so
  // it clamps and says so rather than aborting an otherwise fine download.
  function clampDiscoveredLevel(level, source) {
    if (level == null || level <= MAX_PUBLIC_TILE_LEVEL) return level;
    warn(`${source} reports level ${level}, which would need a ` +
      `${faceSizeAtLevel(level)}px face canvas; capping at ` +
      `${MAX_PUBLIC_TILE_LEVEL} (${faceSizeAtLevel(MAX_PUBLIC_TILE_LEVEL)}px faces). ` +
      "The output is correspondingly lower resolution.");
    return MAX_PUBLIC_TILE_LEVEL;
  }
  const assertBoolOpt = (opts, name) => {
    if (opts[name] != null && typeof opts[name] !== "boolean")
      throw new Error(`{${name}} must be true or false`);
  };
  function assertIntOpt(opts, name, min, max) {
    if (opts[name] == null) return;
    const v = opts[name];
    if (!Number.isInteger(v) || v < min || v > max)
      throw new Error(`{${name}: ${JSON.stringify(v)}} must be an integer in ${min}..${max}`);
  }
  function assertFiniteOpt(opts, name, min, max) {
    if (opts[name] == null) return;
    const v = opts[name];
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max)
      throw new Error(`{${name}: ${JSON.stringify(v)}} must be a finite number in ${min}..${max}`);
  }
  function validateProbeLimit(limit) {
    if (!Number.isInteger(limit) || limit < 0 || limit > MAX_PUBLIC_TILE_LEVEL)
      throw new Error(`probeMaxLevel(limit) requires an integer in 0..${MAX_PUBLIC_TILE_LEVEL}`);
  }
  function validatePublicOptions(opts = {}) {
    if (!opts || typeof opts !== "object" || Array.isArray(opts))
      throw new Error("fb360 options must be an object");
    if (opts.level != null && Number.isInteger(opts.level) &&
        opts.level > MAX_PUBLIC_TILE_LEVEL) {
      throw new Error(`{level: ${opts.level}} would need a ` +
        `${faceSizeAtLevel(opts.level)}px face canvas and ` +
        `${6 * 4 ** opts.level} tiles. The ceiling is ` +
        `${MAX_PUBLIC_TILE_LEVEL} (${faceSizeAtLevel(MAX_PUBLIC_TILE_LEVEL)}px faces).`);
    }
    assertIntOpt(opts, "level", 0, MAX_PUBLIC_TILE_LEVEL);
    assertIntOpt(opts, "urlConcurrency", 1, 64);
    assertIntOpt(opts, "concurrency", 1, 256);
    assertIntOpt(opts, "verifySamples", 0, 1024);
    if (opts.width != null) {
      if (typeof opts.width !== "number" || !Number.isFinite(opts.width) || opts.width < 2)
        throw new Error(`{width: ${JSON.stringify(opts.width)}} must be a finite number >= 2`);
    }
    const hasH = opts.hFovDeg != null, hasV = opts.vFovDeg != null;
    if (hasH !== hasV) throw new Error("{hFovDeg, vFovDeg} must be supplied together");
    if (hasH) {
      assertFiniteOpt(opts, "hFovDeg", Number.MIN_VALUE, 360);
      assertFiniteOpt(opts, "vFovDeg", Number.MIN_VALUE, 180);
      assertFiniteOpt(opts, "hCenterDeg", -360, 360);
      assertFiniteOpt(opts, "vCenterDeg", -90, 90);
    } else if (opts.hCenterDeg != null || opts.vCenterDeg != null) {
      throw new Error(
        "{hCenterDeg, vCenterDeg} only apply alongside {hFovDeg, vFovDeg}");
    }
    for (const name of ["crop", "bounds", "trim", "useAncestors",
                        "prune", "fillFromLevel0", "refetch",
                        "embedMetadata"]) assertBoolOpt(opts, name);
    if (opts.projection != null &&
        !["auto", "webgl", "cpu"].includes(String(opts.projection).toLowerCase())) {
      throw new Error('{projection} must be "auto", "webgl", or "cpu"');
    }
    if (opts.onProgress != null && typeof opts.onProgress !== "function")
      throw new Error("{onProgress} must be a function");
    normalizeOutput(opts);
    return opts;
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  async function coverage(opts = {}) {
    validatePublicOptions(opts);
    const op = beginOperation("coverage()");
    const level = opts.level != null ? opts.level : await resolveLevelChoice(op);
    assertOperation(op);
    log(`surveying level ${level}...`);
    const cov = await survey(level, { ...opts, _op: op });
    assertOperation(op);
    state.coverage = cov;
    return printCoverage(cov);
  }

  async function resolveLevelChoice(op = null) {
    const declared = state.maxTileLevel ?? scrapeMaxTileLevel();
    let level = declared;
    if (level == null) {
      log("probing for the highest available level...");
      level = await probeMaxLevel(MAX_PUBLIC_TILE_LEVEL, op);
    }
    if (!level && level !== 0) throw new Error("could not determine a tile level");
    // state.maxTileLevel keeps what the page actually declared; only the level
    // this run will build is capped, so status() still reports the truth.
    state.maxTileLevel = level;
    return clampDiscoveredLevel(level, "the page");
  }

  // ------------------------------------------------------------------
  // What the viewer itself has loaded — reporting only
  // ------------------------------------------------------------------

  // Diagnostic. equirect() surveys the server rather than reusing these tiles,
  // but knowing how far the viewer got is useful when a photo will not load.
  //
  // The viewer is not view-dependent: its renderer walks level 1, 2, 3...
  // and only advances once every tile of the current level is in its texture
  // cache. So it tends to yield *complete* levels rather than whatever
  // happened to be on screen — panning changes nothing, waiting does.
  function captured() {
    const present = new Map(), resolved = new Map();
    const bump = (m, l) => m.set(l, (m.get(l) || 0) + 1);
    for (const k of state.viewerPairs.keys()) bump(present, levelOfKey(k));
    for (const k of state.viewerResolved) bump(resolved, levelOfKey(k));

    const maxLevel = Math.max(-1, ...resolved.keys(), ...present.keys());
    const rows = [];
    for (let l = 0; l <= maxLevel; l++) {
      const p = present.get(l) || 0, r = resolved.get(l) || 0;
      // On a partial panorama a level never reaches 6*4^L tiles, so
      // completeness is measured against the quadtree instead: every child of
      // a tile that exists one level up should have been asked about.
      const due = l === 0 ? 6 : 4 * (present.get(l - 1) || 0);
      rows.push({ level: l, tiles: p, asked: r, due,
                  expected: 6 * 4 ** l, complete: due > 0 && r >= due });
    }

    const complete = rows.filter(x => x.complete && x.tiles > 0);
    let best = null, why = "";
    if (complete.length) {
      best = complete[complete.length - 1].level;
      why = "deepest fully-loaded level";
    } else {
      // Nothing finished — compare completion fractions, not absolute tile
      // counts. Deeper levels have 4x as many possible tiles, so raw counts
      // systematically preferred a barely-started deeper level.
      let bestRow = null, bestFrac = -1;
      for (const x of rows) {
        if (!x.tiles) continue;
        const frac = x.due > 0 ? Math.min(1, x.asked / x.due) : x.tiles / x.expected;
        if (frac > bestFrac || (frac === bestFrac && (!bestRow || x.level > bestRow.level))) {
          bestRow = x; bestFrac = frac;
        }
      }
      if (bestRow) {
        best = bestRow.level;
        why = `most-complete level (${(bestFrac * 100).toFixed(1)}%, none finished loading)`;
      }
    }
    return { levels: rows, best, why };
  }

  // Canvas has a hard ceiling on total pixels (~268M in Chrome) and each
  // output pixel costs 4 bytes twice over, so a full-sphere native resolution
  // can be out of reach even when a cropped one is not.
  const MAX_OUTPUT_PIXELS = 268435456;

  // ------------------------------------------------------------------
  // XMP, embedded in the file
  // ------------------------------------------------------------------
  //
  // A reprojected equirectangular image is not recognisable as a panorama from
  // its pixels: it is simply a very wide photo. What makes Google Photos,
  // Facebook, Flickr and every VR viewer treat it as 360 is a Photo Sphere XMP
  // packet, and the only place they look for it is inside the file — APP1 for
  // JPEG, an iTXt chunk for PNG. A sidecar file would be readable by scripts
  // and by nothing else, so the packet travels inside the file.
  //
  // The property names also need the GPano: prefix to mean anything.

  const XMP_NS = "http://ns.adobe.com/xap/1.0/";
  const GPANO_NS = "http://ns.google.com/photos/1.0/panorama/";
  const DC_NS = "http://purl.org/dc/elements/1.1/";
  const FB360_NS = "https://github.com/local/fb360/ns/facebook/1.0/";

  function concatBytes(parts) {
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  const xmlClean = s => String(s).replace(
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
  const xmlEscape = s => xmlClean(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  function xmpPacket(x) {
    const facebook = x && x.Facebook && typeof x.Facebook === "object"
      ? x.Facebook : null;

    const gpanoAttrs = Object.keys(x || {})
      .filter(k => k !== "Facebook")
      .map(k => {
        const v = x[k];
        // XMP booleans are the words, not 1/0.
        const s = typeof v === "boolean" ? (v ? "True" : "False") : String(v);
        return `   GPano:${k}="${xmlEscape(s)}"`;
      });

    const extraAttrs = [];
    if (facebook) {
      if (facebook.sourceUrl) {
        extraAttrs.push(`   dc:source="${xmlEscape(facebook.sourceUrl)}"`);
      }
      if (facebook.postUrl) {
        extraAttrs.push(`   FB360:PostURL="${xmlEscape(facebook.postUrl)}"`);
      }
      if (facebook.photoUrl) {
        extraAttrs.push(`   FB360:PhotoURL="${xmlEscape(facebook.photoUrl)}"`);
      }
      if (facebook.authorProfileUrl) {
        extraAttrs.push(`   FB360:AuthorProfileURL="${xmlEscape(facebook.authorProfileUrl)}"`);
      }
      if (facebook.creationDate) {
        extraAttrs.push(`   FB360:CreationDate="${xmlEscape(facebook.creationDate)}"`);
      }
      if (facebook.creationTimeUnix != null) {
        extraAttrs.push(`   FB360:CreationTimeUnix="${xmlEscape(facebook.creationTimeUnix)}"`);
      }
      if (facebook.postId) {
        extraAttrs.push(`   FB360:PostID="${xmlEscape(facebook.postId)}"`);
      }
      if (facebook.photoId) {
        extraAttrs.push(`   FB360:PhotoID="${xmlEscape(facebook.photoId)}"`);
      }
      if (facebook.authorId) {
        extraAttrs.push(`   FB360:AuthorID="${xmlEscape(facebook.authorId)}"`);
      }
    }

    const children = [];
    if (facebook && facebook.authorName) {
      children.push(
        "   <dc:creator><rdf:Seq><rdf:li>" +
        xmlEscape(facebook.authorName) +
        "</rdf:li></rdf:Seq></dc:creator>");
    }
    if (facebook && facebook.text != null) {
      children.push(
        '   <dc:description><rdf:Alt><rdf:li xml:lang="x-default">' +
        xmlEscape(facebook.text) +
        "</rdf:li></rdf:Alt></dc:description>");
    }

    const attrs = gpanoAttrs.concat(extraAttrs).join("\n");
    const body = children.length
      ? ">\n" + children.join("\n") + "\n  </rdf:Description>\n"
      : "/>\n";

    return '<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>\n' +
      '<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="fb360">\n' +
      ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n' +
      '  <rdf:Description rdf:about=""\n' +
      `   xmlns:GPano="${GPANO_NS}"\n` +
      `   xmlns:dc="${DC_NS}"\n` +
      `   xmlns:FB360="${FB360_NS}"\n` +
      attrs + body +
      ' </rdf:RDF>\n' +
      '</x:xmpmeta>\n' +
      '<?xpacket end="w"?>';
  }

  // Returns new bytes, or null if this is not a file of the expected shape or
  // the packet will not fit. Never throws and never returns partial output:
  // a panorama without its metadata is worth far more than a corrupt file.
  function embedXmpJpeg(bytes, packet) {
    if (bytes.length < 4 || bytes[0] !== 0xFF || bytes[1] !== 0xD8) return null;
    const enc = new TextEncoder();
    const sig = enc.encode(XMP_NS + "\0");
    const payload = concatBytes([sig, enc.encode(packet)]);
    // The APP1 length field is two bytes and counts itself.
    if (payload.length + 2 > 0xFFFF) return null;    // needs ExtendedXMP

    // One pass over the header segments: find where an APP1 may go — JFIF
    // requires its APP0 to come first — and note any XMP APP1 already present,
    // so that embedding twice replaces rather than duplicates.
    let insertAt = 2, i = 2, sawOther = false;
    const drop = [];
    while (i + 4 <= bytes.length && bytes[i] === 0xFF) {
      const marker = bytes[i + 1];
      if (marker === 0xDA || marker === 0xD9) break;      // SOS / EOI: entropy data
      const len = (bytes[i + 2] << 8) | bytes[i + 3];
      const end = i + 2 + len;
      if (len < 2 || end > bytes.length) break;
      if (marker === 0xE0 && !sawOther) {
        insertAt = end;
      } else {
        sawOther = true;                                  // keeps drops >= insertAt
        if (marker === 0xE1) {
          let match = true;
          for (let k = 0; k < sig.length; k++) {
            if (bytes[i + 4 + k] !== sig[k]) { match = false; break; }
          }
          if (match) drop.push([i, end]);
        }
      }
      i = end;
    }

    const seg = new Uint8Array(4 + payload.length);
    seg[0] = 0xFF; seg[1] = 0xE1;
    seg[2] = (payload.length + 2) >> 8;
    seg[3] = (payload.length + 2) & 0xFF;
    seg.set(payload, 4);

    const parts = [bytes.subarray(0, insertAt), seg];
    let cursor = insertAt;
    for (const [s, e] of drop) { parts.push(bytes.subarray(cursor, s)); cursor = e; }
    parts.push(bytes.subarray(cursor));
    return concatBytes(parts);
  }

  const PNG_SIG = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
  const PNG_XMP_KEYWORD = "XML:com.adobe.xmp";

  function embedXmpPng(bytes, packet) {
    if (bytes.length < 8 + 12) return null;
    for (let k = 0; k < 8; k++) if (bytes[k] !== PNG_SIG[k]) return null;
    const enc = new TextEncoder();
    const key = enc.encode(PNG_XMP_KEYWORD);
    const text = enc.encode(packet);

    // iTXt payload: keyword \0 compressionFlag compressionMethod
    //               languageTag \0 translatedKeyword \0 text
    const data = new Uint8Array(key.length + 5 + text.length);
    let o = 0;
    data.set(key, o); o += key.length;
    data[o++] = 0;    // keyword terminator
    data[o++] = 0;    // not compressed
    data[o++] = 0;    // compression method (ignored when uncompressed)
    data[o++] = 0;    // empty language tag
    data[o++] = 0;    // empty translated keyword
    data.set(text, o);

    const typeBytes = enc.encode("iTXt");
    const chunk = new Uint8Array(12 + data.length);
    const cdv = new DataView(chunk.buffer);
    cdv.setUint32(0, data.length, false);          // PNG is big-endian
    chunk.set(typeBytes, 4);
    chunk.set(data, 8);
    // The CRC covers the type and the data, not the length.
    cdv.setUint32(8 + data.length, crc32(concatBytes([typeBytes, data])), false);

    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let i = 8, insertAt = -1;
    const drop = [];
    while (i + 12 <= bytes.length) {
      const len = dv.getUint32(i, false);
      const end = i + 12 + len;
      if (len < 0 || end > bytes.length) break;
      const t = String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]);
      if (t === "IHDR") insertAt = end;             // XMP must follow the header
      else if (t === "iTXt" && i + 8 + key.length < bytes.length) {
        let match = true;
        for (let k = 0; k < key.length; k++) {
          if (bytes[i + 8 + k] !== key[k]) { match = false; break; }
        }
        if (match && bytes[i + 8 + key.length] === 0) drop.push([i, end]);
      }
      if (t === "IEND") break;
      i = end;
    }
    if (insertAt < 0) return null;                  // no IHDR: not a PNG we know

    const parts = [bytes.subarray(0, insertAt), chunk];
    let cursor = insertAt;
    for (const [s, e] of drop) { parts.push(bytes.subarray(cursor, s)); cursor = e; }
    parts.push(bytes.subarray(cursor));
    return concatBytes(parts);
  }

  // WebP would need the file rebuilt as an extended (VP8X) RIFF container, and
  // getting the alpha and canvas-size flags wrong there produces a file that
  // decodes incorrectly rather than one that merely lacks metadata. Warned
  // about instead of guessed at.
  function embedXmp(bytes, mime, xmp) {
    let out = null;
    try {
      const packet = xmpPacket(xmp);
      if (mime === "image/jpeg") out = embedXmpJpeg(bytes, packet);
      else if (mime === "image/png") out = embedXmpPng(bytes, packet);
      else {
        warn(`XMP cannot be embedded in ${mime} yet — only JPEG and PNG — so ` +
          "this panorama will not announce itself as one. The packet is in " +
          'xmp.json; use {format: "jpeg"} or {format: "png"} if a viewer ' +
          "needs to recognise it.");
        return bytes;
      }
    } catch (e) {
      warn("XMP embedding failed", e);
      return bytes;
    }
    if (!out) {
      warn(`could not embed the XMP packet in this ${mime}; the image itself ` +
        "is untouched, but viewers will not recognise it as 360");
      return bytes;
    }
    return out;
  }

  // ------------------------------------------------------------------
  // The equirect pipeline, in one copy
  // ------------------------------------------------------------------
  //
  // One entry point, so the geometry sizing, the face loop and the opacity
  // decision each exist once, and the same photo comes out the same size
  // however it is asked for.

  // Sizing: round to an exact 2:1 sphere, fit inside the canvas ceiling, then
  // — only when the width was chosen natively from the metadata — snap to the
  // declared crop size.
  function planEquirect(width, bounds, crop, meta, explicitWidth) {
    width = Math.max(2, Math.round(width / 2) * 2);   // keep 2:1 exact
    let geom = equirectGeometry(width, bounds, crop);
    if (geom.outW * geom.outH > MAX_OUTPUT_PIXELS) {
      const scale = Math.sqrt(MAX_OUTPUT_PIXELS / (geom.outW * geom.outH));
      const reduced = Math.max(2, Math.round(width * scale / 2) * 2);
      warn(`${geom.outW}x${geom.outH} exceeds what a canvas can hold; ` +
        `reducing to ${reduced}px wide. Pass {width: N} to choose your own.`);
      width = reduced;
      geom = equirectGeometry(width, bounds, crop);
    }

    // Both angular bounds can land exactly on a pixel centre, in which case
    // the closed interval keeps one row or column more than the metadata
    // declares. Snap to the declared size so "native" means exactly native.
    //
    // Only ever SHRINK. equirectGeometry can come out *under* the declared
    // size — one-ulp noise in the (pi/2 -/+ v/2)/pi * H arithmetic tips a ceil
    // or floor the wrong way — and growing the window to compensate would push
    // i1 and j1 outward, bringing back rows and columns that inward rounding
    // deliberately excluded. The mask leaves those transparent: an empty line
    // along the bottom and right edges. If the geometry came out short, the
    // honest answer is a panorama one pixel shorter than the metadata claims.
    //
    // Skipped when the caller named a width, because then there is no declared
    // size to be native to — {width: N} output does not snap.
    if (meta && crop && bounds && !bounds.full && !explicitWidth) {
      const wantW = meta.cropped_area_image_width_pixels;
      const wantH = meta.cropped_area_image_height_pixels;
      if (Number.isFinite(wantW) && geom.outW > wantW && geom.outW - wantW <= 2) {
        geom.i1 -= (geom.outW - wantW); geom.outW = wantW;
      }
      if (Number.isFinite(wantH) && geom.outH > wantH && geom.outH - wantH <= 2) {
        geom.j1 -= (geom.outH - wantH); geom.outH = wantH;
      }
    }
    return geom;
  }

  // Faces, built and projected one at a time so no two full-size RGBA buffers
  // are ever live together.
  async function projectFaces(targets, level, tileSize, projector, opts) {
    const { concurrency, fillFromLevel0, bounds, useAncestors,
            allowRefetch, op } = opts;
    const stats = { failed: 0, absent: 0, coarse: 0, refreshed: 0, gaps: false };
    const cpuReadback = !!projector && projector.cpuReadback;
    let done = 0;
    for (const f of targets) {
      const ordinal = done + 1;
      log(`face ${f.face} (${f.name}) — ${f.count}/${f.total} tiles...`);
      stage(`Face ${ordinal} of ${targets.length} — ${plural(f.count, "tile")}`,
        faceFraction(ordinal, targets.length, 0));
      const level0Img = f.hasLevel0
        ? (await loadTileWithRefresh(
            { level: 0, face: f.face, col: 0, row: 0 }, allowRefetch, op)).img
        : null;
      let built;
      try {
        built = await buildFace(f, level, tileSize, level0Img,
          { concurrency, fillFromLevel0, bounds, useAncestors,
            willReadFrequently: cpuReadback, allowRefetch, op,
            faceOrdinal: ordinal, faceTotal: targets.length,
            // Tiles are ~80% of a face's wall-clock time; the projection that
            // follows is the rest, so the bar does not stall at the handover.
            onTileProgress: (d, t, o, n) => stage(
              `Face ${o} of ${n} — downloading tiles ${d}/${t}`,
              faceFraction(o, n, t > 0 ? 0.8 * (d / t) : 0)) });
      } catch (e) {
        if (projector) projector.abort();
        throw e;
      }
      stats.failed += built.failed;
      stats.absent += built.absent;
      stats.coarse += built.coarse;
      stats.refreshed += built.refreshed;
      if (built.gaps > 0) stats.gaps = true;

      try {
        if (projector) {
          stage(`Face ${ordinal} of ${targets.length} — ${projector.faceProgressVerb}...`,
            faceFraction(ordinal, targets.length, 0.85));
          await projector.addFace(f.face, built.canvas, built.ctx, built.gaps);
        }
        assertOperation(op);
      } catch (e) {
        if (projector) projector.abort();
        releaseCanvas(built.canvas);
        throw e;
      }
      releaseCanvas(built.canvas);
      done++;
      if (projector) log(`  ${projector.faceProgressVerb} ${done}/${targets.length}`);
    }
    return stats;
  }

  // The opacity rule for the projected panorama.
  //
  // Facebook's source tiles are opaque, so the projected panorama is opaque
  // too unless something left a hole: a face the projection needed but could
  // not build, a face assembled with gaps, an uncropped partial sphere, or the
  // 1-2px soft edge that {trim: false} keeps instead of removing. That last
  // case is easy to miss, and missing it would make {trim: false} with
  // {format: "auto"} choose JPEG and blacken the very edge the option exists
  // to keep.
  async function finishEquirect(projector, opts) {
    const { trim, format, quality, bounds, crop, projectionGaps,
            embedMetadata } = opts;
    stage("Rendering the equirectangular image...", PROGRESS_FINISH_START);
    const result = await projector.finish(trim);
    const { canvas: c, xmp, cropped, trimmed } = result;
    if (trimmed) log(`trimmed ${trimmed}px of soft edge`);

    // The descriptive half is only ever wanted for the packet, so it is not
    // looked up when there will be no packet to put it in.
    if (embedMetadata) {
      const facebook = loadFacebookMetadata(state.encodingId);
      if (facebook) xmp.Facebook = facebook;
    }

    const partial = !!(bounds && !bounds.full);
    const transparent = !!projectionGaps || (partial && !crop) ||
                        (partial && trim === false);
    const type = format === "auto"
      ? (transparent ? "image/png" : "image/jpeg") : format;
    if (transparent && !keepsAlpha(type)) {
      warn(`the equirect has transparent regions but {format} forces ${type}, ` +
           `which cannot store them; they will flatten to black`);
    }
    let enc;
    stage(`Encoding ${c.width}x${c.height} as ${extFor(type).toUpperCase()}...`,
      PROGRESS_FINISH_START + 0.05);
    try { enc = await encodeCanvas(c, type, quality); }
    catch (e) { result.release(); throw e; }
    const width = c.width, height = c.height;
    result.release();

    // Embedded by default, because a panorama without the packet is useless
    // as one. enc.type is the format the encoder ACTUALLY produced, not the
    // one asked for, which matters when a browser silently falls back to PNG.
    //
    // {embedMetadata: false} writes the pixels alone. The packet is still
    // built and returned as `xmp`, so the geometry is not lost, only kept out
    // of the file.
    let bytes = enc.bytes;
    if (embedMetadata) {
      stage("Embedding Photo Sphere metadata...", PROGRESS_FINISH_START + 0.1);
      bytes = embedXmp(enc.bytes, enc.type, xmp);
      if (bytes !== enc.bytes) {
        log(`embedded a ${bytes.length - enc.bytes.length} byte XMP packet ` +
          `(${xmp.Facebook ? "GPano + Facebook" : "GPano"}, ${enc.type})`);
      }
    } else {
      log("metadata embedding is off: the file carries no XMP packet, so " +
        "viewers will not recognise it as 360");
    }
    return { bytes, type: enc.type, ext: enc.ext, width, height, xmp,
             metadataEmbedded: bytes !== enc.bytes, cropped, trimmed };
  }

  // The panorama, at native resolution and the deepest level available,
  // downloaded as a single image with its XMP packet embedded.
  //
  // equirect() is a thin reporting shell around runEquirect() so that every
  // run drives the on-page button, including one started from the console.
  // The counter exists because two overlapping runs would otherwise let the
  // first one to finish report "done" while the second is still working.
  let activeRuns = 0;
  async function equirect(opts = {}) {
    activeRuns++;
    if (activeRuns === 1) {
      lastStageText = null;
      emitProgress({ phase: "start" });
    }
    try {
      const result = await runEquirect(opts);
      if (activeRuns === 1) {
        emitProgress({
          phase: "done",
          text: result.name,
          detail: `${result.width}x${result.height}, ` +
            `${(result.bytes / 1048576).toFixed(1)} MB`,
        });
      }
      return result;
    } catch (e) {
      if (activeRuns === 1) {
        emitProgress({
          phase: e && e.fb360Aborted ? "cancelled" : "error",
          text: e && e.message ? e.message : String(e),
        });
      }
      throw e;
    } finally {
      activeRuns--;
    }
  }

  async function runEquirect(opts = {}) {
    validatePublicOptions(opts);
    const op = beginOperation("equirect()");
    stage("Preparing...", 0);

    // The survey is the only source of tiles, and it cannot run without a
    // request template. The viewer captures one as soon as it asks for its
    // first tile, so this fires only when the photo has not been opened yet.
    if (!state.template) {
      throw new Error("Nothing captured yet. Open the 360 photo (and pan it) " +
        "so the viewer issues a tile request, then run fb360.equirect() again.");
    }

    const {
      format: wantFormat = DEFAULT_OUTPUT_FORMAT, quality = DEFAULT_LOSSY_QUALITY,
      concurrency = TILE_DOWNLOAD_CONCURRENCY,
      urlConcurrency = TILE_QUERY_CONCURRENCY,
      // trim defaults ON: trimCanvasEdges reads only the <=5 edge rows and
      // columns, so the defence costs next to nothing, and it keeps the 1-2px
      // non-opaque edge it exists to absorb out of the file.
      prune = true, crop = true, trim = true,
      useAncestors = true, fillFromLevel0 = false,
      projection: projectionOption = DEFAULT_PROJECTION,
      embedMetadata = DEFAULT_EMBED_METADATA,
    } = opts;
    const projection = String(projectionOption).toLowerCase();

    // Fail on a bad format or quality now, not after several minutes of
    // surveying, stitching and projecting.
    const format = normalizeOutput({ format: wantFormat, quality });

    const bounds = resolveBounds(opts);
    const meta = state.meta;

    // The page's declared max_tile_level, or a probe when it is not there.
    // resolveLevelChoice caps whatever it finds; an explicit opts.level was
    // already range-checked by validatePublicOptions.
    //
    // Resolved even when the caller named a level, because a shallower level
    // is shallower *than* something: the output is scaled by
    // 2^(maxLevel - level), and without maxLevel there is no factor. When the
    // caller chose the level, failing to discover the maximum is not fatal —
    // it only costs the downscale, so it warns and builds at native width.
    let maxLevel = null;
    stage("Checking the available resolution...", 0.01);
    try {
      maxLevel = await resolveLevelChoice(op);
    } catch (e) {
      if (opts.level == null) throw e;
      warn(`could not determine the deepest available level (${e.message}); ` +
        `building level ${opts.level} at native width, unscaled`);
    }
    assertOperation(op);
    const level = opts.level != null ? opts.level : maxLevel;
    validateProbeLimit(level);
    assertOperation(op);
    const n = 1 << level;

    // Each level down halves the linear tile resolution, so a level below the
    // deepest one carries 1/factor of the source pixels per axis, and the
    // sphere is sized down to match rather than upsampled back to
    // full_pano_width_pixels — which would be a bigger file with no more
    // detail in it. maxLevel is the deepest level that can actually be
    // fetched (clamped to MAX_PUBLIC_TILE_LEVEL), which is exactly the level a
    // bare equirect() uses, so the default output is at native size.
    const factor = (maxLevel != null && level < maxLevel)
      ? 2 ** (maxLevel - level) : 1;

    // Width: the panorama's own full_pano_width_pixels, so one output pixel is
    // one source pixel. Without the metadata there is nothing to be native to.
    let width = opts.width;
    if (width == null) {
      if (meta && meta.full_pano_width_pixels > 0) {
        width = meta.full_pano_width_pixels;
      } else {
        width = 4096;
        warn(`no full_pano_width_pixels available; falling back to ${width}px`);
      }
      // The height follows: equirectGeometry derives it as width >> 1, and the
      // cropped output window is a fraction of the sphere, so dividing the
      // sphere width by the factor divides both output dimensions by it too.
      if (factor > 1) {
        const full = width;
        width = Math.max(2, full / factor);
        log(`level ${level} is ${maxLevel - level} level(s) below the deepest ` +
          `available (${maxLevel}); scaling the output by 1/${factor} ` +
          `(${full}x${full >> 1} -> ${Math.round(width)}x${Math.round(width) >> 1} sphere)`);
      }
    } else if (factor > 1) {
      // An explicit width is the size the caller asked for, not a native size
      // to scale down from, so it is used as given.
      log(`{width: ${width}} given, so level ${level} is not scaled by 1/${factor}`);
    }

    const geom = planEquirect(width, bounds, crop, meta, opts.width != null);
    log(`level ${level}, sphere ${geom.width}x${geom.height}, ` +
      `output ${geom.outW}x${geom.outH}`);

    // Expired urls are repairable by asking again. {refetch: false} opts out.
    const allowRefetch = opts.refetch != null ? !!opts.refetch : true;

    // BEFORE the survey, not after: coverageAt reads isPresent at level 0
    // when it fills in hasLevel0, so resolving level 0 afterwards left that
    // flag false on every face and {fillFromLevel0: true} silently did
    // nothing. It only showed up with {prune: false}, because a pruning
    // survey recurses down to level 0 of its own accord.
    if (level > 0) await resolveTiles(enumerateTiles(0), urlConcurrency, null, op);
    stage("Mapping the available tiles...", PROGRESS_SURVEY_START);
    const cov = await survey(level, { ...opts, _op: op, prune, urlConcurrency,
      onProgress: (d, t) => {
        if (d % URL_PROGRESS_LOG_STRIDE === 0) log(`  urls ${d}/${t}`);
        stage(`Mapping tiles ${d}/${t}`, surveyFraction(d, t));
      } });
    assertOperation(op);
    state.coverage = cov;
    if (cov.total === 0) throw new Error("no tiles available at this level");

    stage("Measuring the tiles...", PROGRESS_FACES_START);
    const tileSize = await probeTileSize(level, cov, allowRefetch, op);
    assertOperation(op);
    if (!tileSize) {
      throw new Error(`could not load any tile image at level ${level} ` +
        "(CORS, or every url has expired — try again, or fb360.reset() first)");
    }

    const targets = cov.faces.filter(f => !f.empty);
    const targetFaces = new Set(targets.map(f => f.face));

    const runProjection = async projector => {
      log(`projection: ${projector.mode}`);
      // Dedicated equirect output does not need cube faces whose angular domain
      // cannot intersect the requested crop. This saves face stitching/readback
      // as well as projection work for narrow partial panoramas.
      const neededTargets = targets.filter(f => projector.faceNeeded(f.face));
      let projectionGaps = false;
      for (let face = 0; face < 6; face++) {
        if (projector.faceNeeded(face) && !targetFaces.has(face)) projectionGaps = true;
      }

      const stats = await projectFaces(neededTargets, level, tileSize, projector,
        { concurrency, fillFromLevel0, bounds, useAncestors, allowRefetch, op });
      if (stats.gaps) projectionGaps = true;
      if (stats.refreshed) {
        log(`${stats.refreshed} tile url(s) had expired and were re-fetched`);
      }
      // Without this, a tile that had a url and still would not load would
      // leave a hole in the output and say nothing at all.
      //
      // Reported, but NOT folded into projectionGaps: buildFace already counts
      // failures in its own `gaps`, and deliberately zeroes that when
      // {fillFromLevel0: true} covered the hole. Forcing transparency here would
      // override that and push a fully-painted panorama to PNG.
      if (stats.failed) {
        warn(`${stats.failed} tiles had a url but failed to load` +
          (allowRefetch ? " even after a refresh" :
           " — pass {refetch: true} to ask for fresh urls and retry them") +
          (stats.gaps ? "; the panorama has holes where they should be" : ""));
      }

      assertOperation(op);
      const out = await finishEquirect(projector,
        { trim, format, quality, bounds, crop, projectionGaps, embedMetadata });
      assertOperation(op);
      return { out, stats, neededTargets };
    };

    let projector = createProjectionProjector(geom, tileSize * n, projection);
    let projectionRun;
    try {
      projectionRun = await runProjection(projector);
    } catch (e) {
      // A context can still be lost after successful WebGL setup (GPU reset,
      // memory pressure, driver issue). In auto mode, rebuild the contributing
      // faces and rerun them through the CPU projector. Browser image
      // caching normally makes the second face build much cheaper than the
      // first network pass.
      if (projector.backend === "webgl" && e && e.fb360WebGL &&
          projection === "auto") {
        try { projector.abort(); } catch {}
        warn(`WebGL projection failed (${e.message}); retrying with the CPU fallback`);
        assertOperation(op);
        projector = createWorkerProjector(geom, tileSize * n);
        projectionRun = await runProjection(projector);
      } else {
        throw e;
      }
    }
    const { out, stats, neededTargets } = projectionRun;
    log(`  projection complete`);

    const name = `fb360_${op.encodingId || "photo"}_` +
      `${out.width}x${out.height}.${out.ext}`;
    stage("Saving the file...", 0.99);
    download(new Blob([out.bytes], { type: out.type }), name);

    // Compared against the declared crop size *at this level's scale*, or a
    // deliberate 1/factor build would report itself as a mismatch every time.
    if (meta) {
      const wantW = meta.cropped_area_image_width_pixels / factor;
      const wantH = meta.cropped_area_image_height_pixels / factor;
      if (Math.abs(out.width - wantW) > 2 || Math.abs(out.height - wantH) > 2) {
        log(`note: metadata declares ${meta.cropped_area_image_width_pixels}x` +
          `${meta.cropped_area_image_height_pixels} for the cropped area` +
          (factor > 1 ? ` (${Math.round(wantW)}x${Math.round(wantH)} at 1/${factor})` : ""));
      }
    }
    log(`done — ${name} (${(out.bytes.length / 1048576).toFixed(1)} MB, ${out.type})`);
    log(`xmp: ${JSON.stringify(out.xmp)}`);
    // Only the faces that were actually built; `targets` included ones the
    // projector had no use for and which were therefore never touched.
    return { level, width: out.width, height: out.height, xmp: out.xmp, name,
             format: out.type, metadataEmbedded: out.metadataEmbedded,
             faces: neededTargets.map(f => f.face),
             bytes: out.bytes.length };
  }

  function status() {
    const levels = {}, viewerLevels = {};
    for (const k of state.pairs.keys()) {
      const l = levelOfKey(k);
      levels[l] = (levels[l] || 0) + 1;
    }
    for (const k of state.viewerPairs.keys()) {
      const l = levelOfKey(k);
      viewerLevels[l] = (viewerLevels[l] || 0) + 1;
    }
    const info = {
      captured: !!state.template,
      locked: !!state.encodingId,
      encodingId: state.encodingId,
      generation: state.generation,
      foreignTileRequestsIgnored: state.foreignTileRequestsIgnored,
      oddTileResponses: state.oddTileResponses,
      docId: state.docId,
      maxTileLevel: scrapeMaxTileLevel(),   // returns state.maxTileLevel if set
      metadataLookupMissedFor: state.metaMissFor,
      metadataSource: state.metaSource,
      facebookMetadata: !!state.facebookMeta,
      facebookMetadataSource: state.facebookMetaSource,
      graphqlMetadataPayloads: state.graphqlMetadataPayloads,
      graphqlResponsesScanned: state.graphqlResponsesScanned,
      pairs: state.pairs.size,
      viewerPairs: state.viewerPairs.size,
      viewerUrlsPastTtl: staleViewerTiles(null).stale,
      debug,
      viewerTilesLoaded: state.viewerTilesLoaded,
      viewerTilesSkipped: state.viewerTilesSkipped,
      viewerResponsesSkipped: state.viewerResponsesSkipped,
      graphqlParseFailures: state.graphqlParseFailures,
      graphqlBodiesUnreadable: state.graphqlBodiesUnreadable,
      lastGraphqlParseFailure: state.lastGraphqlParseFailure,
      byLevel: Object.fromEntries(Object.entries(levels).map(
        ([l, c]) => [l, `${c}/${6 * 4 ** l}`])),
      viewerByLevel: Object.fromEntries(Object.entries(viewerLevels).map(
        ([l, c]) => [l, `${c}/${6 * 4 ** l}`])),
    };
    console.table(info);
    if (!state.template) {
      if (state.graphqlParseFailures) {
        warn(`no tile request captured, but ${state.graphqlParseFailures} request(s) ` +
          `looked like tile queries and would not parse (last: ` +
          `${state.lastGraphqlParseFailure}). Facebook has probably changed the ` +
          "request encoding; parseTileRequest is what needs updating.");
      } else if (state.graphqlBodiesUnreadable) {
        warn(`no tile request captured, and ${state.graphqlBodiesUnreadable} GraphQL ` +
          "request body could not be read at all, so tile queries may be passing " +
          "through unobserved.");
      } else {
        warn("no tile request seen yet — open the 360 photo so the viewer loads tiles");
      }
    }
    return info;
  }

  // ------------------------------------------------------------------
  // Self-test
  // ------------------------------------------------------------------
  //
  // The projection geometry is the part of this file most able to be wrong
  // while looking right. CUBE_LAYOUT's correspondence to projectEquirect's
  // face convention is derived by hand, and a sign error in FACE_DIR or FACE_SLOT does not throw
  // — it produces a plausible panorama with two faces swapped or a pole
  // rotated, which nobody notices until they look at the sky.
  //
  // Everything here is pure or uses a throwaway canvas, so it touches no
  // captured state and can be run on any page at any time.
  async function selfTest() {
    const results = [];
    const check = (name, pass, detail = "") => {
      results.push({ name, pass: !!pass, detail: pass ? "" : String(detail) });
    };
    const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

    // --- crc32 against the standard check vector -------------------------
    // CRC-32/ISO-HDLC of "123456789" is 0xCBF43926. If this passes, the table
    // and the final inversion are both right, which is the whole algorithm.
    check("crc32(\"123456789\") === 0xCBF43926",
      crc32(new TextEncoder().encode("123456789")) === 0xCBF43926,
      crc32(new TextEncoder().encode("123456789")).toString(16));
    check("crc32(empty) === 0", crc32(new Uint8Array(0)) === 0);

    // --- rot90 ------------------------------------------------------------
    // A 2x2 with distinct red channels: [1 2 / 3 4]. One CCW turn sends the
    // top-right to the top-left, so it becomes [2 4 / 1 3].
    const mk = vals => ({
      data: Uint8ClampedArray.from(vals.flatMap(v => [v, 0, 0, 255])),
      width: 2, height: 2,
    });
    const reds = img => [0, 1, 2, 3].map(i => img.data[i * 4]);
    check("rot90 k=0 is identity", reds(rot90(mk([1, 2, 3, 4]), 0)).join() === "1,2,3,4");
    check("rot90 k=1 turns counter-clockwise",
      reds(rot90(mk([1, 2, 3, 4]), 1)).join() === "2,4,1,3",
      reds(rot90(mk([1, 2, 3, 4]), 1)).join());
    check("rot90 k=2 is a half turn",
      reds(rot90(mk([1, 2, 3, 4]), 2)).join() === "4,3,2,1");
    check("rot90 four times is identity",
      reds(rot90(rot90(rot90(rot90(mk([1, 2, 3, 4]), 1), 1), 1), 1)).join() === "1,2,3,4");
    check("rot90 k=-1 equals k=3",
      reds(rot90(mk([1, 2, 3, 4]), -1)).join() === reds(rot90(mk([1, 2, 3, 4]), 3)).join());

    // --- FACE_DIR centres -------------------------------------------------
    // Each face's centre must sit at the angle the face is named for. This is
    // the assertion probeMaxLevel silently depends on for -Z.
    const centres = [
      [MINUS_Z, 0, 0], [PLUS_X, Math.PI / 2, 0], [PLUS_Z, Math.PI, 0],
      [MINUS_X, -Math.PI / 2, 0], [PLUS_Y, 0, Math.PI / 2], [MINUS_Y, 0, -Math.PI / 2],
    ];
    for (const [face, lon, lat] of centres) {
      const [h, v] = anglesOf(FACE_DIR[face](0, 0));
      const lonOK = near(Math.abs(v), Math.PI / 2) || near(Math.cos(h - lon), 1);
      check(`FACE_DIR[${FACE_NAMES[face]}] centre`, lonOK && near(v, lat),
        `got lon ${(h * 180 / Math.PI).toFixed(1)}, lat ${(v * 180 / Math.PI).toFixed(1)}`);
    }

    // --- metadataToBounds -------------------------------------------------
    const fullMeta = {
      full_pano_width_pixels: 8000, full_pano_height_pixels: 4000,
      cropped_area_image_width_pixels: 8000, cropped_area_image_height_pixels: 4000,
      cropped_area_left_pixels: 0, cropped_area_top_pixels: 0,
    };
    const fb = metadataToBounds(fullMeta);
    check("full sphere metadata -> bounds.full", fb.full === true);
    check("full sphere is centred", near(fb.hCenter, 0) && near(fb.vCenter, 0));

    // Half width, and vertically high: 1000px tall starting 500px down on a
    // 4000px sphere. Centre row is 1000, i.e. a quarter down from the top,
    // which is +45 deg of pitch.
    const offMeta = {
      full_pano_width_pixels: 8000, full_pano_height_pixels: 4000,
      cropped_area_image_width_pixels: 4000, cropped_area_image_height_pixels: 1000,
      cropped_area_left_pixels: 2000, cropped_area_top_pixels: 500,
    };
    const ob = metadataToBounds(offMeta);
    check("half-width crop -> 180 deg of horizontal fov", near(ob.h, Math.PI));
    check("quarter-height crop -> 45 deg of vertical fov", near(ob.v, Math.PI / 4));
    check("horizontally centred crop -> hCenter 0", near(ob.hCenter, 0),
      (ob.hCenter * 180 / Math.PI).toFixed(3));
    check("crop high on the sphere -> vCenter +45 deg",
      near(ob.vCenter, Math.PI / 4), (ob.vCenter * 180 / Math.PI).toFixed(3));
    check("off-centre crop is not full", ob.full === false);
    // The off-centre case: with vCenter honoured, the horizon is OUTSIDE a band
    // that sits entirely above it. Assuming a centred crop would include it.
    check("inBounds respects vCenter (horizon excluded from a high band)",
      inBounds(FACE_DIR[MINUS_Z](0, 0), ob) === false);
    check("inBounds accepts the band's own centre",
      inBounds([0, Math.tan(Math.PI / 4), -1], ob) === true);

    // --- cube -> equirect round trip --------------------------------------
    // Each face gets a distinct colour, is oriented exactly as addFace does,
    // and the result is sampled where each face must land. A swapped pair or
    // an inverted axis moves at least one of these six samples.
    const S = 8, W = 64, H = W >> 1;
    const COLOURS = {
      [MINUS_Z]: [200, 10, 10], [PLUS_X]: [10, 200, 10], [PLUS_Z]: [10, 10, 200],
      [MINUS_X]: [200, 200, 10], [PLUS_Y]: [200, 10, 200], [MINUS_Y]: [10, 200, 200],
    };
    const solidFace = rgb => {
      const d = new Uint8ClampedArray(S * S * 4);
      for (let i = 0; i < S * S; i++) {
        d[i * 4] = rgb[0]; d[i * 4 + 1] = rgb[1]; d[i * 4 + 2] = rgb[2]; d[i * 4 + 3] = 255;
      }
      return { data: d, width: S, height: S };
    };
    const buildCube = faceImages => {
      const cube = { F: null, R: null, B: null, L: null, U: null, D: null };
      for (let face = 0; face < 6; face++) {
        const slot = FACE_SLOT[face];
        const oriented = rot90(faceImages[face], slot[1]);
        cube[slot[0]] = { data: oriented.data, width: oriented.width,
                          height: oriented.height, gaps: false };
      }
      return cube;
    };
    const cube = buildCube(Object.fromEntries(
      Object.entries(COLOURS).map(([f, rgb]) => [f, solidFace(rgb)])));
    const projected = await projectEquirect(cube, W, null, {});
    const pixelAt = (col, row) => {
      const o = (row * projected.width + col) * 4;
      return [projected.data[o], projected.data[o + 1], projected.data[o + 2]];
    };
    // col -> lon = ((col + 0.5) / W) * 2pi - pi, so lon 0 is the middle column.
    const colFor = lon => Math.round(((lon + Math.PI) / (2 * Math.PI)) * W - 0.5);
    const sameColour = (got, want) => got.every((v, i) => Math.abs(v - want[i]) <= 2);
    const equatorSamples = [
      ["front (lon 0)", MINUS_Z, colFor(0)],
      ["right (lon +90)", PLUS_X, colFor(Math.PI / 2)],
      ["left (lon -90)", MINUS_X, colFor(-Math.PI / 2)],
      ["back (lon 180)", PLUS_Z, 0],
    ];
    for (const [label, face, col] of equatorSamples) {
      const got = pixelAt(col, H >> 1);
      check(`projection: ${label} -> ${FACE_NAMES[face]}`,
        sameColour(got, COLOURS[face]), `got rgb(${got})`);
    }
    check("projection: north pole -> plus_y",
      sameColour(pixelAt(colFor(0), 0), COLOURS[PLUS_Y]),
      `got rgb(${pixelAt(colFor(0), 0)})`);
    check("projection: south pole -> minus_y",
      sameColour(pixelAt(colFor(0), H - 1), COLOURS[MINUS_Y]),
      `got rgb(${pixelAt(colFor(0), H - 1)})`);

    // Uniform faces cannot catch a wrong ROTATION, only a wrong face. So give
    // the +Y face two halves: FACE_DIR maps its upper half (t > 0) to lon 0
    // and its lower half to lon 180, and CUBE_LAYOUT's rotU=2 is what makes
    // that survive the trip through projectEquirect's U slot.
    const splitY = (() => {
      const d = new Uint8ClampedArray(S * S * 4);
      for (let row = 0; row < S; row++) {
        for (let col = 0; col < S; col++) {
          const i = (row * S + col) * 4;
          const top = row < S / 2;                    // t > 0
          d[i] = top ? 250 : 5; d[i + 1] = 5; d[i + 2] = top ? 5 : 250; d[i + 3] = 255;
        }
      }
      return { data: d, width: S, height: S };
    })();
    const rotCube = buildCube(Object.assign(
      Object.fromEntries(Object.entries(COLOURS).map(([f, rgb]) => [f, solidFace(rgb)])),
      { [PLUS_Y]: splitY }));
    const rotProj = await projectEquirect(rotCube, W, null, { rowStart: 0, rowEnd: 2 });
    const polePixel = col => {
      const o = (0 * rotProj.width + col) * 4;
      return [rotProj.data[o], rotProj.data[o + 1], rotProj.data[o + 2]];
    };
    const atLon0 = polePixel(colFor(0)), atLon180 = polePixel(0);
    check("pole orientation: +Y upper half faces lon 0",
      atLon0[0] > atLon0[2], `got rgb(${atLon0})`);
    check("pole orientation: +Y lower half faces lon 180",
      atLon180[2] > atLon180[0], `got rgb(${atLon180})`);

    // --- trimCanvasEdges --------------------------------------------------
    // One transparent column on the left, everything else opaque.
    const tc = document.createElement("canvas");
    tc.width = 16; tc.height = 8;
    const tctx = tc.getContext("2d", { willReadFrequently: true });
    tctx.fillStyle = "rgb(120,120,120)";
    tctx.fillRect(1, 0, 15, 8);
    const tr = trimCanvasEdges(tc, 4);
    check("trimCanvasEdges finds a 1px transparent left edge",
      tr.l === 1 && tr.t === 0 && tr.r === 15 && tr.b === 7, JSON.stringify(tr));
    const opaque = document.createElement("canvas");
    opaque.width = 8; opaque.height = 8;
    const octx = opaque.getContext("2d", { willReadFrequently: true });
    octx.fillStyle = "rgb(9,9,9)";
    octx.fillRect(0, 0, 8, 8);
    const tr2 = trimCanvasEdges(opaque, 4);
    check("trimCanvasEdges trims nothing from a fully opaque canvas",
      tr2.l === 0 && tr2.t === 0 && tr2.r === 7 && tr2.b === 7, JSON.stringify(tr2));
    releaseCanvas(tc); releaseCanvas(opaque);

    // The mirror of the first case. Each axis is judged only over the span the
    // other has not trimmed; otherwise a single transparent edge line on one
    // axis drives the OTHER axis to maxTrim, because no line crossing it can
    // ever be fully opaque.
    const tcr = document.createElement("canvas");
    tcr.width = 16; tcr.height = 8;
    const tcrx = tcr.getContext("2d", { willReadFrequently: true });
    tcrx.fillStyle = "rgb(120,120,120)";
    tcrx.fillRect(0, 1, 16, 7);
    const tr3 = trimCanvasEdges(tcr, 4);
    check("trimCanvasEdges finds a 1px transparent top edge and no side trim",
      tr3.l === 0 && tr3.t === 1 && tr3.r === 15 && tr3.b === 7, JSON.stringify(tr3));

    // The case that actually reaches a panorama: a thin rim on all four sides.
    // The trim must match the rim, not run to the limit.
    const rim = document.createElement("canvas");
    rim.width = 40; rim.height = 20;
    const rimx = rim.getContext("2d", { willReadFrequently: true });
    rimx.fillStyle = "rgba(120,120,120,0.5)";
    rimx.fillRect(0, 0, 40, 20);
    rimx.fillStyle = "rgb(120,120,120)";
    rimx.fillRect(1, 1, 38, 18);
    const tr4 = trimCanvasEdges(rim, 4);
    check("trimCanvasEdges takes exactly 1px off a 1px rim, not maxTrim",
      tr4.l === 1 && tr4.t === 1 && tr4.r === 38 && tr4.b === 18, JSON.stringify(tr4));

    // And it must still stop at maxTrim when the rim is genuinely deeper.
    const deep = document.createElement("canvas");
    deep.width = 40; deep.height = 20;
    const deepx = deep.getContext("2d", { willReadFrequently: true });
    deepx.fillStyle = "rgb(120,120,120)";
    deepx.fillRect(9, 6, 22, 8);
    const tr5 = trimCanvasEdges(deep, 4);
    check("trimCanvasEdges clamps at maxTrim on a deeper rim",
      tr5.l === 4 && tr5.t === 4 && tr5.r === 35 && tr5.b === 15, JSON.stringify(tr5));
    releaseCanvas(tcr); releaseCanvas(rim); releaseCanvas(deep);

    // --- tileKey / levelOfKey --------------------------------------------
    check("tileKey round-trips its level through levelOfKey",
      [0, 1, 3, 9].every(l => levelOfKey(tileKey({ level: l, face: 2, col: 5, row: 6 })) === l));

    // --- metadata scanning -------------------------------------------------
    // The same scan runs over an inlined page payload and over a GraphQL
    // response body, and the response shape is the one that could break it:
    // a for(;;); prefix and one JSON object per line. Both are handled by the
    // brace walk rather than by special-casing, so this is what proves it.
    const smFixture = {
      cropped_area_image_width_pixels: 4096,
      cropped_area_image_height_pixels: 1024,
      full_pano_width_pixels: 8192,
      full_pano_height_pixels: 4096,
      cropped_area_left_pixels: 0,
      cropped_area_top_pixels: 1536,
    };
    const graphqlFixture =
      "for (;;);" + JSON.stringify({ data: { unrelated: { id: "77" } } }) + "\n" +
      JSON.stringify({
        data: {
          node: {
            __typename: "Photo",
            id: "777",
            photo_encodings: [{
              id: "12345",
              max_tile_level: 3,
              projection_type: "cubestrip",
              spherical_metadata: smFixture,
            }],
          },
        },
      }) + "\n";
    const scanned = scanSourceForTileset(graphqlFixture, "12345");
    check("scanSourceForTileset reads a newline-delimited GraphQL response",
      !!scanned && scanned.id === "12345" && scanned.max_tile_level === 3 &&
      isCompleteSpherical(scanned.spherical_metadata),
      JSON.stringify(scanned));
    check("scanSourceForTileset ignores a tileset id it was not asked for",
      scanSourceForTileset(graphqlFixture, "12346") === null);
    // The id anchor is the whole reason a wrong-photo match cannot happen:
    // an encoding carrying the id but no spherical_metadata is not a hit.
    check("scanSourceForTileset will not match an id without spherical_metadata",
      scanSourceForTileset(JSON.stringify({
        data: { node: { photo_encodings: [{ id: "12345" }] },
                other: { spherical_metadata: smFixture } },
      }), "12345") === null);

    // --- descriptive metadata across both layouts --------------------------
    // The story sits above the photo in the feed and below it on the photo
    // page. Both layouts are asserted here because opening a photo from the
    // feed only ever exercises one, and a failure on the other is silent: a
    // correct GPano block, no FB360 group.
    const encFixture = [{
      id: "12345", max_tile_level: 3, projection_type: "tiled_cubemap",
      spherical_metadata: smFixture,
    }];
    const storyBits = {
      wwwURL: "https://www.facebook.com/jane.doe/posts/pfbid02abc",
      creation_time: 1762868298,
      message: { text: "Sunset over the lake" },
      actors: [{ id: "100001", name: "Jane Doe",
                 url: "https://www.facebook.com/jane.doe" }],
    };
    const photoPageFixture = JSON.stringify({ data: { currMedia: {
      __typename: "Photo", id: "777",
      comet_photo_renderer: { photo: {
        __typename: "Photo", id: "777", photo_encodings: encFixture,
        creation_story: { __typename: "Story", id: "S:_I1", ...storyBits },
      } },
    } } });
    const feedFixture = JSON.stringify({ data: { node_v2: {
      __typename: "Story", id: "S:_I1", post_id: "998", ...storyBits,
      attachments: [{ styles: { attachment: { media: {
        __typename: "Photo", id: "777", photo_encodings: encFixture,
      } } } }],
    } } });
    for (const [layout, src] of [["photo page", photoPageFixture],
                                 ["feed post", feedFixture]]) {
      const fb = (scanSourceForTileset(src, "12345") || {}).facebook;
      check(`the FB360 group is extracted from the ${layout} layout`,
        !!fb && fb.authorName === "Jane Doe" &&
        fb.creationTimeUnix === 1762868298 &&
        fb.postUrl === "https://www.facebook.com/jane.doe/posts/pfbid02abc" &&
        fb.text === "Sunset over the lake" && fb.photoId === "777",
        JSON.stringify(fb));
    }
    // Proximity is not authorship. A commenter sits nearer the photo than the
    // poster does in some payloads, so the loose search must refuse to enter
    // comment branches — otherwise the group fills in with the wrong person.
    const commentFixture = JSON.stringify({ data: { currMedia: {
      __typename: "Photo", id: "777", photo_encodings: encFixture,
      created_time: 1762868298,
      owner: { id: "100001", name: "Jane Doe" },
      feedback: { comments: { nodes: [{
        author: { id: "900", name: "Random Commenter" },
        message: { text: "Nice shot!" }, creation_time: 1799999999,
      }] } },
    } } });
    const commentFb = (scanSourceForTileset(commentFixture, "12345") || {}).facebook;
    check("a commenter is never mistaken for the author",
      !!commentFb && commentFb.authorName === "Jane Doe" &&
      commentFb.text !== "Nice shot!" &&
      commentFb.creationTimeUnix === 1762868298,
      JSON.stringify(commentFb));
    // The photo's own permalink is not the post's. Reading `url` off the
    // nearest ancestor — a Photo on the photo page — mislabels every save.
    const urlFixture = JSON.stringify({ data: { currMedia: {
      __typename: "Photo", id: "777", photo_encodings: encFixture,
      url: "https://www.facebook.com/photo/?fbid=777&__cft__[0]=xyz",
      creation_story: { __typename: "Story", id: "S:_I1", ...storyBits },
    } } });
    const urlFb = (scanSourceForTileset(urlFixture, "12345") || {}).facebook;
    check("the photo permalink does not become the post url",
      !!urlFb &&
      urlFb.postUrl === "https://www.facebook.com/jane.doe/posts/pfbid02abc" &&
      urlFb.photoUrl === "https://www.facebook.com/photo/?fbid=777",
      JSON.stringify(urlFb));

    // --- report -----------------------------------------------------------
    const failed = results.filter(r => !r.pass);
    console.table(results.map(r => ({ test: r.name, pass: r.pass, detail: r.detail })));
    if (failed.length) {
      warn(`self-test: ${failed.length} of ${results.length} FAILED — ` +
        failed.map(f => f.name).join("; "));
    } else {
      log(`self-test: all ${results.length} checks passed`);
    }
    return { passed: results.length - failed.length, failed: failed.length, results };
  }

  function manifest() {
    return Object.fromEntries(state.pairs);
  }

  // Operations routinely run for minutes and every await checkpoint calls
  // assertOperation, so bumping the generation is all a cancel needs to do.
  function cancel() {
    state.generation++;
    log("cancelled — any running operation aborts at its next checkpoint");
  }

  // reset() is intentionally NOT an unlock. It discards transient working state
  // for the current panorama but preserves the first tileset id for the entire
  // script lifetime. Reload the page to choose another panorama.
  //
  // The captured GraphQL metadata payloads also survive it, on the same
  // reasoning as the lock. They are evidence that arrived once and will not be
  // sent again: after an in-app navigation there is no page source to fall
  // back on, so dropping them would make reset() the one action that
  // permanently loses this photo's metadata.
  function reset() {
    state.generation++;
    const lockedId = state.encodingId;
    forgetPhoto();
    state.template = null;
    state.docId = null;
    state.viewerTilesLoaded = 0;
    state.viewerTilesSkipped = 0;
    state.viewerResponsesSkipped = 0;
    state.graphqlParseFailures = 0;
    state.graphqlBodiesUnreadable = 0;
    state.lastGraphqlParseFailure = null;
    viewerSummaryPrintedLoaded = 0;
    viewerSummaryPrintedSkipped = 0;
    if (viewerSummaryTimer !== null) {
      clearTimeout(viewerSummaryTimer);
      viewerSummaryTimer = null;
    }
    encoderFallbackWarned = false;
    // The template is gone, so equirect() cannot run until the viewer issues
    // another tile request. The button reflects that rather than staying
    // enabled and failing on the next click.
    emitProgress({ phase: "idle" });
    if (lockedId) {
      log(`cleared working state for locked tileset ${lockedId}; reload the page to select another panorama`);
    } else {
      log("cleared — waiting for the first panorama");
    }
  }

  // The hooks are installed at document-start and, in an SPA that stays open
  // all day, observe every GraphQL response for the life of the tab. That is
  // bounded — tile-shaped requests are read for their urls, and other
  // responses only until the metadata is complete — but it is not zero, and
  // this is the way to stop it short of reloading.
  //
  // Restoring a monkey patch is only correct if ours is still the outermost
  // one. If something else patched fetch after us, assigning origFetch back
  // discards THEIR hook as well, so that case warns and leaves fetch alone;
  // the XHR methods get the same treatment. Reload for a guaranteed-clean
  // page either way.
  function uninstall() {
    if (window.fetch === hookedFetch) {
      window.fetch = origFetch;
    } else {
      warn("window.fetch was patched again after fb360 installed; leaving it " +
        "alone rather than discarding the other hook. Reload to remove ours.");
    }
    for (const [name, original] of
         [["open", XO], ["send", XS], ["setRequestHeader", XH]]) {
      XMLHttpRequest.prototype[name] = original;
    }
    reset();
    emitProgress({ phase: "uninstalled" });
    progressListeners.clear();
    try { delete window.fb360; } catch { window.fb360 = undefined; }
    log("uninstalled — reload the page to reinstall");
  }

  // state.template.body is the captured GraphQL request verbatim, which means
  // it contains fb_dtsg, lsd and jazoest. @grant none puts this object in page
  // context, so returning `state` raw published the session's CSRF token to
  // every script running on facebook.com — third-party tags, other extensions'
  // page-context injections, and anything that lands an XSS. That is not a new
  // capability for an attacker who already runs code here, but it is a
  // gift-wrapped one, and nothing outside this closure needs the body.
  function publicState() {
    const { template, ...rest } = state;
    return {
      ...rest,
      template: template
        ? { url: template.url, capturedAt: template.capturedAt, present: true }
        : null,
    };
  }

  // ------------------------------------------------------------------
  // The on-page save button
  // ------------------------------------------------------------------
  //
  // Appears in the lower right corner as soon as a panorama is detected, and
  // reports what the run is doing while it runs: a level 3 crawl is several
  // hundred round-trips and minutes, and a button that just sits there
  // looking pressed is indistinguishable from one that has hung.
  //
  // Every implementation choice below is forced by the host page:
  //
  // - Shadow DOM, because Facebook's stylesheet is global and aggressive; an
  //   unshadowed button inherits whatever the feed is wearing this week.
  // - Styles are written through the CSSOM (element.style.*), never through an
  //   injected <style> element or a style="" attribute. Facebook serves a
  //   Content-Security-Policy and style-src governs both of those, while
  //   CSSOM writes are outside its scope. The spinner follows the same rule:
  //   the Web Animations API rather than @keyframes.
  // - The host is re-attached if it vanishes. React owns document.body's
  //   children and an in-app navigation can carry a foreign node off with it.
  // - It follows document.fullscreenElement. A fixed-position node in <body>
  //   is not painted over a fullscreened viewer, which is precisely when
  //   someone is looking at a 360 photo.
  // - Pointer events stop at the pill. A click that reaches Facebook's viewer
  //   closes the lightbox, which would cancel the thing being clicked on.

  const BUTTON_PALETTE = {
    waiting:   { bg: "#1877f2", hover: "#1877f2", fg: "#ffffff", dim: true },
    ready:     { bg: "#1877f2", hover: "#166fe5", fg: "#ffffff" },
    running:   { bg: "#1877f2", hover: "#1877f2", fg: "#ffffff" },
    done:      { bg: "#31a24c", hover: "#2b9147", fg: "#ffffff" },
    error:     { bg: "#d93025", hover: "#c5221f", fg: "#ffffff" },
    cancelled: { bg: "#65676b", hover: "#5a5c60", fg: "#ffffff" },
  };

  const BUTTON_ICONS = {
    save: "M8 1.5v8.5M4.5 7L8 10.5 11.5 7M2.5 13.5h11",
    done: "M2.5 8.5l3.5 3.5 7.5-8",
    error: "M8 2.5v6.5M8 12.2h.01",
    cancelled: "M4 4l8 8M12 4l-8 8",
  };

  const SVG_NS = "http://www.w3.org/2000/svg";
  const BUTTON_FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', " +
    "Roboto, Helvetica, Arial, sans-serif";

  // The picker's options. `id` goes straight to equirect({format}) and is
  // therefore a key MIME_FOR_FORMAT already understands. `mime` is what
  // formatSupported() is asked about, and is null for "auto" because auto
  // resolves at the end of the run to JPEG or PNG, both always encodable.
  //
  // The hints are the tradeoffs someone actually has to choose between, and
  // they are the honest ones: WebP really cannot carry the XMP packet in this
  // build, and a panorama without its GPano geometry is not a panorama as far
  // as any viewer is concerned. Better said on the menu than discovered after
  // a ten-minute crawl.
  const OUTPUT_FORMATS = [
    { id: "auto", chip: "AUTO", label: "Auto", mime: null,
      hint: "JPG, or PNG if the image has gaps" },
    { id: "jpeg", chip: "JPG", label: "JPG", mime: "image/jpeg",
      hint: "Smallest file. No transparency" },
    { id: "png", chip: "PNG", label: "PNG", mime: "image/png",
      hint: "Lossless. Keeps transparent gaps" },
    { id: "webp", chip: "WEBP", label: "WebP", mime: "image/webp",
      hint: "Small, but carries no metadata" },
  ];

  // Permanent, and worth the two lines it costs. The single-panorama lock is
  // the script's most surprising property: the button stays on screen after a
  // download and after an in-app navigation to a different photo, and it will
  // keep saving the FIRST panorama it saw either way. A message that only
  // appeared on the console, or only once, would leave that discoverable
  // solely by getting the wrong file.
  //
  // "New tab" rather than "reload", because Facebook is an SPA: clicking
  // through to another photo from the feed never loads a page, so a reload is
  // only equivalent if you are already sitting on the photo you want.
  const BUTTON_LOCK_NOTE =
    "Locked to the first 360 photo detected. To save a different one, " +
    "open it in a new tab.";

  const FORMAT_STORAGE_KEY = "fb360.outputFormat";
  const EMBED_METADATA_STORAGE_KEY = "fb360.embedMetadata";
  const EMBED_METADATA_LABEL = "Embed panorama metadata (recommended)";

  // Longest status line shown on the pill itself; the full text goes in the
  // tooltip.
  const PILL_DETAIL_MAX_CHARS = 60;
  const FORMAT_ALIASES = {
    jpg: "jpeg", "image/jpeg": "jpeg", "image/jpg": "jpeg",
    "image/png": "png", "image/webp": "webp",
  };

  const formatById = id =>
    OUTPUT_FORMATS.find(f => f.id === id) || OUTPUT_FORMATS[0];
  // Asked of the browser, not assumed: a format this browser cannot encode
  // would silently come back as PNG bytes, which is exactly the confusion
  // normalizeFormat() exists to prevent. Unsupported options are shown
  // disabled rather than hidden, so the absence is explained.
  const formatUsable = f => !f.mime || formatSupported(f.mime);

  function resolveFormatChoice(value) {
    const key = String(value == null ? "" : value).trim().toLowerCase();
    const fmt = OUTPUT_FORMATS.find(f => f.id === (FORMAT_ALIASES[key] || key));
    if (!fmt) {
      throw new Error(`unknown output format ${JSON.stringify(value)} — use ` +
        `"auto", "jpeg", "png" or "webp"`);
    }
    if (!formatUsable(fmt)) {
      throw new Error(`this browser cannot encode ${fmt.mime}`);
    }
    return fmt.id;
  }

  // The choice survives a reload, because picking PNG once and getting JPEG
  // on the next photo is the kind of small betrayal that makes a control feel
  // broken. Storage can be unavailable or full; that costs the persistence
  // and nothing else.
  function readStoredFormat() {
    try {
      const stored = window.localStorage.getItem(FORMAT_STORAGE_KEY);
      const fmt = OUTPUT_FORMATS.find(f => f.id === stored);
      if (fmt && formatUsable(fmt)) return fmt.id;
    } catch { /* storage blocked: fall through to the default */ }
    return DEFAULT_OUTPUT_FORMAT;
  }

  function storeFormat(id) {
    try { window.localStorage.setItem(FORMAT_STORAGE_KEY, id); }
    catch { /* the choice just will not survive a reload */ }
  }

  // Same treatment as the format. Only an explicit "0" turns it off, so a
  // missing, blocked or unrecognised value lands on the default rather than
  // silently producing files that are not panoramas.
  function readStoredEmbedMetadata() {
    try {
      const stored = window.localStorage.getItem(EMBED_METADATA_STORAGE_KEY);
      if (stored === "0") return false;
      if (stored === "1") return true;
    } catch { /* storage blocked: fall through to the default */ }
    return DEFAULT_EMBED_METADATA;
  }

  function storeEmbedMetadata(on) {
    try { window.localStorage.setItem(EMBED_METADATA_STORAGE_KEY, on ? "1" : "0"); }
    catch { /* the choice just will not survive a reload */ }
  }

  function createSaveButton() {
    if (typeof document === "undefined" || !document.documentElement) return null;

    const setStyle = (el, styles) => {
      for (const k of Object.keys(styles)) el.style[k] = styles[k];
    };
    // A value the browser does not understand is discarded by the CSSOM, so
    // the plain value assigned first survives as the fallback.
    const trySetStyle = (el, prop, value) => {
      try { el.style[prop] = value; } catch { /* older browser: keep fallback */ }
    };

    const host = document.createElement("div");
    host.id = "fb360-save-panorama";
    setStyle(host, {
      position: "fixed", right: "16px", bottom: "16px", zIndex: "2147483000",
      margin: "0", padding: "0", border: "0", width: "auto", height: "auto",
      pointerEvents: "none", colorScheme: "light",
    });
    trySetStyle(host, "right", "max(16px, env(safe-area-inset-right, 0px))");
    trySetStyle(host, "bottom", "max(16px, env(safe-area-inset-bottom, 0px))");

    let root = host;
    try { root = host.attachShadow({ mode: "open" }); }
    catch { root = host; }   // no shadow DOM: still works, just less isolated

    const pill = document.createElement("div");
    pill.setAttribute("role", "button");
    pill.setAttribute("tabindex", "0");
    setStyle(pill, {
      position: "relative", overflow: "hidden", boxSizing: "border-box",
      display: "flex", flexDirection: "column", alignItems: "stretch",
      maxWidth: "320px", padding: "10px 14px 12px", borderRadius: "10px",
      background: BUTTON_PALETTE.ready.bg, color: "#ffffff",
      fontFamily: BUTTON_FONT, fontSize: "14px", fontWeight: "600",
      lineHeight: "1.25", textAlign: "left",
      boxShadow: "0 6px 18px rgba(0,0,0,.28)",
      cursor: "pointer", userSelect: "none", pointerEvents: "auto",
      transition: "background-color .15s ease, opacity .15s ease",
    });
    trySetStyle(pill, "maxWidth", "min(340px, calc(100vw - 32px))");

    const icon = document.createElementNS(SVG_NS, "svg");
    icon.setAttribute("viewBox", "0 0 16 16");
    icon.setAttribute("width", "16");
    icon.setAttribute("height", "16");
    icon.setAttribute("aria-hidden", "true");
    setStyle(icon, { flex: "0 0 auto", display: "block", overflow: "visible" });
    const iconPath = document.createElementNS(SVG_NS, "path");
    iconPath.setAttribute("d", BUTTON_ICONS.save);
    iconPath.setAttribute("fill", "none");
    iconPath.setAttribute("stroke", "currentColor");
    iconPath.setAttribute("stroke-width", "1.7");
    iconPath.setAttribute("stroke-linecap", "round");
    iconPath.setAttribute("stroke-linejoin", "round");
    icon.appendChild(iconPath);

    const spinner = document.createElement("div");
    setStyle(spinner, {
      flex: "0 0 auto", boxSizing: "border-box", display: "none",
      width: "16px", height: "16px", borderRadius: "50%",
      border: "2px solid rgba(255,255,255,.35)", borderTopColor: "#ffffff",
    });
    let spinnerAnim = null;
    function setSpinning(on) {
      spinner.style.display = on ? "block" : "none";
      icon.style.display = on ? "none" : "block";
      if (!on) {
        if (spinnerAnim) { try { spinnerAnim.pause(); } catch { /* ignore */ } }
        return;
      }
      if (!spinnerAnim && typeof spinner.animate === "function") {
        try {
          spinnerAnim = spinner.animate(
            [{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }],
            { duration: 850, iterations: Infinity });
        } catch { spinnerAnim = null; }
      }
      if (spinnerAnim) { try { spinnerAnim.play(); } catch { /* ignore */ } }
    }

    const textCol = document.createElement("div");
    textCol.setAttribute("aria-live", "polite");
    setStyle(textCol, {
      display: "flex", flexDirection: "column", gap: "2px",
      minWidth: "0", flex: "1 1 auto",
    });
    const titleEl = document.createElement("div");
    setStyle(titleEl, {
      whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
    });
    const detailEl = document.createElement("div");
    setStyle(detailEl, {
      display: "none", fontSize: "11px", fontWeight: "400", opacity: ".85",
      whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
    });
    textCol.appendChild(titleEl);
    textCol.appendChild(detailEl);

    // The current output format, and the way into the menu that changes it.
    // It lives inside the pill so the choice is visible without opening
    // anything: a control that hides its own state is how someone ends up
    // waiting ten minutes for a PNG they did not ask for.
    const formatChip = document.createElement("div");
    formatChip.setAttribute("role", "button");
    formatChip.setAttribute("tabindex", "0");
    formatChip.setAttribute("aria-haspopup", "menu");
    formatChip.setAttribute("aria-expanded", "false");
    formatChip.setAttribute("aria-label", "Output format");
    setStyle(formatChip, {
      display: "flex", alignItems: "center", gap: "3px", flex: "0 0 auto",
      boxSizing: "border-box", padding: "3px 6px", borderRadius: "6px",
      background: "rgba(255,255,255,.18)", color: "#ffffff",
      fontSize: "11px", fontWeight: "700", lineHeight: "1.4",
      whiteSpace: "nowrap", cursor: "pointer",
    });
    const formatChipLabel = document.createElement("span");
    const formatChipCaret = document.createElement("span");
    formatChipCaret.textContent = "\u25be";
    formatChipCaret.setAttribute("aria-hidden", "true");
    setStyle(formatChipCaret, { fontSize: "9px", opacity: ".9" });
    formatChip.appendChild(formatChipLabel);
    formatChip.appendChild(formatChipCaret);

    const cancelBtn = document.createElement("div");
    cancelBtn.setAttribute("role", "button");
    cancelBtn.setAttribute("tabindex", "0");
    cancelBtn.setAttribute("aria-label", "Cancel");
    cancelBtn.title = "Cancel this download";
    cancelBtn.textContent = "\u00d7";
    setStyle(cancelBtn, {
      display: "none", flex: "0 0 auto", boxSizing: "border-box",
      width: "22px", height: "22px", borderRadius: "50%",
      background: "rgba(255,255,255,.18)", color: "#ffffff",
      fontSize: "16px", fontWeight: "700", lineHeight: "22px",
      textAlign: "center", cursor: "pointer",
    });

    const track = document.createElement("div");
    setStyle(track, {
      position: "absolute", left: "0", right: "0", bottom: "0", height: "3px",
      display: "none", background: "rgba(255,255,255,.25)",
    });
    const fill = document.createElement("div");
    setStyle(fill, {
      width: "0%", height: "100%", background: "#ffffff",
      transition: "width .2s linear",
    });
    track.appendChild(fill);

    const pillRow = document.createElement("div");
    setStyle(pillRow, {
      display: "flex", alignItems: "center", gap: "10px", minWidth: "0",
    });
    pillRow.appendChild(icon);
    pillRow.appendChild(spinner);
    pillRow.appendChild(textCol);
    pillRow.appendChild(formatChip);
    pillRow.appendChild(cancelBtn);

    // The one line here that is allowed to wrap. Truncating this particular
    // sentence to an ellipsis would hide the half that says what to do about
    // it, which is the only half that matters.
    const lockNote = document.createElement("div");
    lockNote.setAttribute("role", "note");
    lockNote.textContent = BUTTON_LOCK_NOTE;
    setStyle(lockNote, {
      marginTop: "8px", paddingTop: "6px",
      borderTop: "1px solid rgba(255,255,255,.22)",
      fontSize: "11px", fontWeight: "400", lineHeight: "1.35",
      opacity: ".85", whiteSpace: "normal",
    });

    pill.appendChild(pillRow);
    pill.appendChild(lockNote);
    pill.appendChild(track);

    // The format menu, opened by the chip and stacked above the pill so it
    // opens into the page rather than off the bottom of the window.
    const panel = document.createElement("div");
    panel.setAttribute("role", "menu");
    panel.setAttribute("aria-label", "Output format");
    setStyle(panel, {
      display: "none", boxSizing: "border-box", marginBottom: "8px",
      minWidth: "244px", maxWidth: "320px", padding: "6px",
      borderRadius: "10px", background: "#ffffff", color: "#050505",
      fontFamily: BUTTON_FONT, fontSize: "13px", lineHeight: "1.3",
      textAlign: "left", boxShadow: "0 8px 24px rgba(0,0,0,.28)",
      pointerEvents: "auto", userSelect: "none",
    });

    const formatRows = new Map();
    for (const fmt of OUTPUT_FORMATS) {
      const usable = formatUsable(fmt);
      const row = document.createElement("div");
      row.setAttribute("role", "menuitemradio");
      row.setAttribute("tabindex", usable ? "0" : "-1");
      row.setAttribute("aria-disabled", usable ? "false" : "true");
      setStyle(row, {
        display: "flex", alignItems: "center", gap: "8px",
        boxSizing: "border-box", padding: "7px 8px", borderRadius: "6px",
        cursor: usable ? "pointer" : "default", opacity: usable ? "1" : ".45",
      });

      const tick = document.createElement("span");
      tick.setAttribute("aria-hidden", "true");
      setStyle(tick, {
        flex: "0 0 auto", width: "14px", textAlign: "center",
        color: "#1877f2", fontWeight: "700",
      });

      const col = document.createElement("div");
      setStyle(col, { display: "flex", flexDirection: "column", gap: "1px", minWidth: "0" });
      const name = document.createElement("div");
      name.textContent = fmt.label;
      setStyle(name, { fontWeight: "600" });
      const hint = document.createElement("div");
      hint.textContent = usable ? fmt.hint : "Not supported by this browser";
      setStyle(hint, { fontSize: "11px", color: "#65676b" });
      col.appendChild(name);
      col.appendChild(hint);

      row.appendChild(tick);
      row.appendChild(col);
      if (usable) {
        row.addEventListener("click", ev => {
          ev.preventDefault();
          ev.stopPropagation();
          chooseFormat(fmt.id);
        });
        row.addEventListener("keydown", ev => {
          if (ev.key !== "Enter" && ev.key !== " " && ev.key !== "Spacebar") return;
          ev.preventDefault();
          ev.stopPropagation();
          chooseFormat(fmt.id);
        });
        row.addEventListener("mouseenter", () => {
          if (fmt.id !== formatId) row.style.background = "#f0f2f5";
        });
        row.addEventListener("mouseleave", () => paintFormatRows());
      }
      formatRows.set(fmt.id, { row, tick });
      panel.appendChild(row);
    }

    // Whether the XMP packet goes into the file. It sits in this menu because
    // it is part of the same decision — what the saved file will contain —
    // and, like the format, it is fixed for the length of a run.
    //
    // A real checkbox is drawn, but the row is the control: the input takes
    // no pointer events and no focus, so a click cannot toggle it natively
    // and then toggle it back through the row's own handler.
    const separator = document.createElement("div");
    separator.setAttribute("role", "separator");
    setStyle(separator, {
      height: "1px", margin: "6px 4px", background: "#e4e6eb",
    });
    panel.appendChild(separator);

    const metaRow = document.createElement("div");
    metaRow.setAttribute("role", "menuitemcheckbox");
    metaRow.setAttribute("tabindex", "0");
    setStyle(metaRow, {
      display: "flex", alignItems: "flex-start", gap: "8px",
      boxSizing: "border-box", padding: "7px 8px", borderRadius: "6px",
      cursor: "pointer",
    });
    const metaBox = document.createElement("input");
    metaBox.type = "checkbox";
    metaBox.tabIndex = -1;
    metaBox.setAttribute("aria-hidden", "true");
    setStyle(metaBox, {
      flex: "0 0 auto", width: "14px", height: "14px", margin: "1px 0 0",
      pointerEvents: "none", accentColor: "#1877f2",
    });
    const metaCol = document.createElement("div");
    setStyle(metaCol, { display: "flex", flexDirection: "column", gap: "1px", minWidth: "0" });
    const metaName = document.createElement("div");
    metaName.textContent = EMBED_METADATA_LABEL;
    setStyle(metaName, { fontWeight: "600" });
    const metaHint = document.createElement("div");
    setStyle(metaHint, { fontSize: "11px", color: "#65676b" });
    metaCol.appendChild(metaName);
    metaCol.appendChild(metaHint);
    metaRow.appendChild(metaBox);
    metaRow.appendChild(metaCol);
    panel.appendChild(metaRow);

    // Toggling leaves the menu open, unlike picking a format: a checkbox is
    // something you look at after changing, and closing would hide the
    // result of the click that was just made.
    metaRow.addEventListener("click", ev => {
      ev.preventDefault();
      ev.stopPropagation();
      chooseEmbedMetadata(!embedMetadata);
    });
    metaRow.addEventListener("keydown", ev => {
      if (ev.key !== "Enter" && ev.key !== " " && ev.key !== "Spacebar") return;
      ev.preventDefault();
      ev.stopPropagation();
      chooseEmbedMetadata(!embedMetadata);
    });
    metaRow.addEventListener("mouseenter", () => { metaRow.style.background = "#f0f2f5"; });
    metaRow.addEventListener("mouseleave", () => { metaRow.style.background = "transparent"; });

    const wrap = document.createElement("div");
    setStyle(wrap, {
      display: "flex", flexDirection: "column", alignItems: "flex-end",
      pointerEvents: "none",
    });
    wrap.appendChild(panel);
    wrap.appendChild(pill);
    root.appendChild(wrap);

    let mode = "waiting";
    let running = false;
    let hidden = false;
    let destroyed = false;
    let revertTimer = null;
    let keepAlive = null;
    let waitingForBody = false;
    let formatId = readStoredFormat();
    let embedMetadata = readStoredEmbedMetadata();
    let panelOpen = false;

    // Whether a press on the pill should do anything. The saved message is
    // deliberately inert: the run has only just finished, the file is in the
    // browser's downloads, and a stray second click on a button that has not
    // moved would silently start the whole crawl again — minutes of network
    // and a duplicate file. The confirmation reverts to "Save panorama" on
    // its own, and error and cancelled states stay clickable because there a
    // second press is exactly what someone means.
    const acceptsClicks = () => !running && mode !== "done";

    function paintFormatRows() {
      for (const fmt of OUTPUT_FORMATS) {
        const entry = formatRows.get(fmt.id);
        if (!entry) continue;
        const selected = fmt.id === formatId;
        entry.tick.textContent = selected ? "\u2713" : "";
        entry.row.style.background = selected ? "rgba(24,119,242,.12)" : "transparent";
        entry.row.setAttribute("aria-checked", selected ? "true" : "false");
      }
    }

    // The hint says what the tick actually means for the format chosen above
    // it. WebP cannot carry the packet whatever the box says, and pretending
    // otherwise is how someone ends up with a "360" file no viewer accepts.
    function paintMetadataRow() {
      metaBox.checked = embedMetadata;
      metaRow.setAttribute("aria-checked", embedMetadata ? "true" : "false");
      let hint;
      if (!embedMetadata) hint = "Off: viewers will show a flat image, not 360";
      else if (formatId === "webp") hint = "WebP cannot carry it; choose JPG or PNG";
      else hint = "Lets viewers recognise the image as 360";
      metaHint.textContent = hint;
    }

    function paintFormatChip() {
      formatChipLabel.textContent = formatById(formatId).chip;
      formatChip.style.opacity = running ? ".7" : "1";
      formatChip.style.cursor = running ? "default" : "pointer";
      formatChip.title = running
        ? `Saving as ${formatById(formatId).label}`
        : "Choose the output format";
    }

    // Closing on an outside press has to look through the shadow boundary:
    // composedPath() is the only thing that reports our own nodes, since an
    // event retargeted at the host would otherwise read as "outside".
    const onOutsidePointer = ev => {
      const path = typeof ev.composedPath === "function" ? ev.composedPath() : [];
      if (ev.target === host || path.indexOf(host) !== -1) return;
      setPanel(false);
    };
    const onPanelKey = ev => {
      if (ev.key !== "Escape" && ev.key !== "Esc") return;
      ev.stopPropagation();
      setPanel(false);
      try { formatChip.focus(); } catch { /* not focusable yet */ }
    };

    function setPanel(open) {
      const next = !!open && !running && !destroyed;
      if (next === panelOpen) {
        if (!next) panel.style.display = "none";
        return;
      }
      panelOpen = next;
      panel.style.display = panelOpen ? "block" : "none";
      formatChip.setAttribute("aria-expanded", panelOpen ? "true" : "false");
      if (panelOpen) {
        paintFormatRows();
        paintMetadataRow();
        document.addEventListener("pointerdown", onOutsidePointer, true);
        document.addEventListener("keydown", onPanelKey, true);
      } else {
        document.removeEventListener("pointerdown", onOutsidePointer, true);
        document.removeEventListener("keydown", onPanelKey, true);
      }
    }

    function chooseFormat(id) {
      const fmt = formatById(id);
      if (!formatUsable(fmt)) return false;
      formatId = fmt.id;
      storeFormat(fmt.id);
      paintFormatRows();
      paintMetadataRow();
      paintFormatChip();
      setPanel(false);
      // The resting caption names the format, so the choice is still visible
      // once the menu is gone.
      if (!running && (mode === "ready" || mode === "waiting")) paintRest();
      return true;
    }

    // Like chooseFormat, safe during a run: the run already has its value.
    function chooseEmbedMetadata(on) {
      embedMetadata = !!on;
      storeEmbedMetadata(embedMetadata);
      paintMetadataRow();
      if (mode === "ready" || mode === "waiting") paintRest();
      return true;
    }

    function whenBodyExists(fn) {
      if (document.body) { fn(); return; }
      if (waitingForBody) return;
      waitingForBody = true;
      let fired = false;
      const go = () => {
        if (fired || !document.body) return;
        fired = true;
        waitingForBody = false;
        try { observer.disconnect(); } catch { /* ignore */ }
        fn();
      };
      const observer = new MutationObserver(go);
      try { observer.observe(document.documentElement, { childList: true }); }
      catch { /* ignore */ }
      document.addEventListener("DOMContentLoaded", go, { once: true });
    }

    function mount() {
      if (destroyed || hidden) return;
      if (!document.body) { whenBodyExists(mount); return; }
      const fs = document.fullscreenElement || document.webkitFullscreenElement;
      const parent = (fs && fs !== document.documentElement && fs.appendChild)
        ? fs : document.body;
      if (host.parentNode !== parent) parent.appendChild(host);
      if (keepAlive === null) {
        // Cheap insurance against React reclaiming the subtree we live in.
        keepAlive = setInterval(() => {
          if (destroyed || hidden) return;
          if (!host.isConnected) mount();
        }, 2000);
      }
    }

    const onFullscreenChange = () => mount();
    document.addEventListener("fullscreenchange", onFullscreenChange);
    document.addEventListener("webkitfullscreenchange", onFullscreenChange);

    function paint(nextMode, title, detail, fraction) {
      mode = nextMode;
      running = nextMode === "running";
      const palette = BUTTON_PALETTE[nextMode] || BUTTON_PALETTE.ready;
      pill.style.background = palette.bg;
      pill.style.color = palette.fg;
      pill.style.opacity = palette.dim ? ".75" : "1";
      pill.style.cursor =
        (nextMode === "waiting" || !acceptsClicks()) ? "default" : "pointer";
      pill.setAttribute("aria-disabled", acceptsClicks() ? "false" : "true");
      titleEl.textContent = title;
      setDetail(detail);
      iconPath.setAttribute("d", BUTTON_ICONS[nextMode] || BUTTON_ICONS.save);
      setSpinning(running);
      if (running) setPanel(false);
      paintFormatChip();
      cancelBtn.style.display = running ? "block" : "none";
      track.style.display = running ? "block" : "none";
      if (!running) fill.style.width = "0%";
      setFraction(fraction);
    }

    function setDetail(text) {
      if (text) {
        detailEl.textContent = text;
        detailEl.style.display = "block";
      } else {
        detailEl.textContent = "";
        detailEl.style.display = "none";
      }
    }

    function setFraction(fraction) {
      if (typeof fraction !== "number" || !isFinite(fraction)) return;
      const pct = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
      fill.style.width = `${pct}%`;
    }

    function clearRevert() {
      if (revertTimer !== null) { clearTimeout(revertTimer); revertTimer = null; }
    }

    function scheduleRevert(ms) {
      clearRevert();
      revertTimer = setTimeout(() => { revertTimer = null; paintRest(); }, ms);
    }

    // The button's resting appearance, which depends only on whether a run is
    // actually possible right now.
    function restDetail() {
      const fmt = formatById(formatId);
      const name = fmt.id === "auto" ? "auto format" : fmt.label;
      const noMeta = fmt.id === "webp" || !embedMetadata;
      return `Native resolution \u00b7 ${name}` + (noMeta ? ", no metadata" : "");
    }

    function paintRest() {
      pill.title = "";
      if (state.template) {
        paint("ready", "Save panorama", restDetail(), null);
      } else {
        paint("waiting", "360 photo detected",
          "Waiting for the viewer to load tiles\u2026", null);
      }
    }
    paintFormatRows();
    paintMetadataRow();
    paintFormatChip();
    paintRest();

    function activate() {
      if (destroyed || !acceptsClicks()) return;
      clearRevert();
      if (!state.template) {
        paint("waiting", "Not ready yet",
          "Pan the photo so the viewer requests a tile", null);
        scheduleRevert(4000);
        return;
      }
      const fmt = formatById(formatId);
      paint("running", "Saving panorama\u2026", `Starting\u2026 (${fmt.chip})`, 0);
      // The progress channel reports the outcome, including failures, so the
      // catch here exists only to keep an unhandled rejection out of the
      // console when a run the user started from the button fails. An
      // unencodable format is rejected by normalizeOutput() before any work
      // starts, and arrives back here as the error phase.
      Promise.resolve().then(() => equirect({ format: fmt.id, embedMetadata }))
        .catch(() => { /* reported through the progress channel */ });
    }

    const swallow = ev => ev.stopPropagation();
    for (const type of ["mousedown", "pointerdown", "touchstart", "dblclick"]) {
      pill.addEventListener(type, swallow);
      panel.addEventListener(type, swallow);
    }

    // The chip sits inside the pill, so its click has to be kept from
    // bubbling up into the pill's own handler — otherwise opening the menu
    // would also start the download it is meant to configure.
    formatChip.addEventListener("click", ev => {
      ev.preventDefault();
      ev.stopPropagation();
      if (running) return;
      setPanel(!panelOpen);
    });
    formatChip.addEventListener("keydown", ev => {
      if (ev.key !== "Enter" && ev.key !== " " && ev.key !== "Spacebar") return;
      ev.preventDefault();
      ev.stopPropagation();
      if (!running) setPanel(!panelOpen);
    });
    pill.addEventListener("click", ev => {
      ev.preventDefault();
      ev.stopPropagation();
      activate();
    });
    pill.addEventListener("keydown", ev => {
      if (ev.key !== "Enter" && ev.key !== " " && ev.key !== "Spacebar") return;
      ev.preventDefault();
      ev.stopPropagation();
      activate();
    });
    pill.addEventListener("mouseenter", () => {
      const palette = BUTTON_PALETTE[mode];
      if (palette && !palette.dim && acceptsClicks()) {
        pill.style.background = palette.hover;
      }
    });
    pill.addEventListener("mouseleave", () => {
      const palette = BUTTON_PALETTE[mode] || BUTTON_PALETTE.ready;
      pill.style.background = palette.bg;
    });
    cancelBtn.addEventListener("click", ev => {
      ev.preventDefault();
      ev.stopPropagation();
      if (!running) return;
      setDetail("Cancelling\u2026");
      cancel();
    });
    cancelBtn.addEventListener("keydown", ev => {
      if (ev.key !== "Enter" && ev.key !== " " && ev.key !== "Spacebar") return;
      ev.preventDefault();
      ev.stopPropagation();
      if (running) { setDetail("Cancelling\u2026"); cancel(); }
    });

    // Long messages are for the tooltip, not for a 340px pill.
    const short = (text, limit = PILL_DETAIL_MAX_CHARS) => {
      const s = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
      return s.length > limit ? `${s.slice(0, limit - 1)}\u2026` : s;
    };

    function handle(event) {
      if (destroyed) return;
      switch (event.phase) {
        case "detected":
          // The id is only interesting when something has gone wrong, so it
          // goes in the tooltip rather than on the face of the button.
          if (event.id) lockNote.title = `Locked to tileset ${event.id}`;
          mount();
          if (!running) { clearRevert(); paintRest(); }
          break;
        case "ready":
          mount();
          if (!running) { clearRevert(); paintRest(); }
          break;
        case "idle":
          if (!running) { clearRevert(); paintRest(); }
          break;
        case "start":
          mount();
          clearRevert();
          paint("running", "Saving panorama\u2026", "Starting\u2026", 0);
          break;
        case "stage":
          if (!running) break;
          setDetail(short(event.text));
          setFraction(event.fraction);
          break;
        case "done":
          clearRevert();
          paint("done", "Panorama saved",
            short(event.detail || event.text), null);
          pill.title = event.text ? `Saved ${event.text}` : "";
          scheduleRevert(12000);
          break;
        case "cancelled":
          clearRevert();
          paint("cancelled", "Cancelled", "Click to start again", null);
          scheduleRevert(6000);
          break;
        case "error":
          clearRevert();
          paint("error", "Could not save", short(event.text), null);
          pill.title = String(event.text || "");
          scheduleRevert(15000);
          break;
        default:
          break;
      }
    }

    function show() {
      if (destroyed) return;
      hidden = false;
      mount();
    }

    function hide() {
      hidden = true;
      if (host.parentNode) host.parentNode.removeChild(host);
    }

    function destroy() {
      destroyed = true;
      // Two listeners live on `document` while the menu is open, so closing
      // it first is what actually removes them.
      setPanel(false);
      clearRevert();
      if (keepAlive !== null) { clearInterval(keepAlive); keepAlive = null; }
      if (spinnerAnim) { try { spinnerAnim.cancel(); } catch { /* ignore */ } }
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      document.removeEventListener("webkitfullscreenchange", onFullscreenChange);
      if (host.parentNode) host.parentNode.removeChild(host);
    }

    return {
      handle, show, hide, destroy,
      get visible() { return !destroyed && !hidden && host.isConnected; },
      get element() { return host; },
      get format() { return formatId; },
      setFormat(value) { return chooseFormat(resolveFormatChoice(value)); },
      get embedMetadata() { return embedMetadata; },
      setEmbedMetadata(on) { return chooseEmbedMetadata(on); },
    };
  }

  // Built on the first event rather than at install time, so a page that
  // never shows a 360 photo never gets a node inserted into it.
  let saveButtonUI = null;
  let saveButtonFailed = false;
  function ensureSaveButton() {
    if (saveButtonUI || saveButtonFailed) return saveButtonUI;
    try { saveButtonUI = createSaveButton(); }
    catch (e) { warn("could not create the save button", e); }
    if (!saveButtonUI) saveButtonFailed = true;
    return saveButtonUI;
  }

  subscribeProgress(event => {
    if (event.phase === "uninstalled") {
      if (saveButtonUI) saveButtonUI.destroy();
      saveButtonUI = null;
      saveButtonFailed = true;   // do not resurrect it after uninstall()
      return;
    }
    const ui = ensureSaveButton();
    if (ui) ui.handle(event);
  });

  const saveButton = {
    show() {
      const ui = ensureSaveButton();
      if (ui) ui.show();
      return !!ui;
    },
    hide() { if (saveButtonUI) saveButtonUI.hide(); },
    get visible() { return !!(saveButtonUI && saveButtonUI.visible); },
    // Readable and settable before the button has ever been built, since the
    // preference outlives any one instance of it. An unknown or unencodable
    // format throws here rather than being quietly ignored, matching what
    // equirect({format}) does with the same value.
    get format() { return saveButtonUI ? saveButtonUI.format : readStoredFormat(); },
    set format(value) {
      const id = resolveFormatChoice(value);
      if (saveButtonUI) saveButtonUI.setFormat(id);
      else storeFormat(id);
    },
    // The metadata checkbox, readable and settable the same way. Only a real
    // boolean is accepted, as with equirect({embedMetadata}).
    get embedMetadata() {
      return saveButtonUI ? saveButtonUI.embedMetadata : readStoredEmbedMetadata();
    },
    set embedMetadata(value) {
      if (typeof value !== "boolean")
        throw new Error(`embedMetadata must be true or false, not ${JSON.stringify(value)}`);
      if (saveButtonUI) saveButtonUI.setEmbedMetadata(value);
      else storeEmbedMetadata(value);
    },
    get formats() {
      return OUTPUT_FORMATS.map(f => ({
        id: f.id, label: f.label, supported: formatUsable(f),
      }));
    },
  };

  window.fb360 = {
    __installed: true,
    version: "2026.08.24.1",
    saveButton,
    equirect, captured, status, manifest, reset, cancel, uninstall, selfTest,
    get debug() { return debug; },
    set debug(value) { setDebug(value); },
    bounds: resolveBounds,
    get metadata() { return state.meta; },
    get facebookMetadata() { return state.facebookMeta; },
    coverage, survey, probeMaxLevel,
    get pairs() { return state.pairs; },
    get viewerPairs() { return state.viewerPairs; },
    get state() { return publicState(); },
  };

  log("installed in single-panorama mode. The first 360 tileset wins; reload the page for another.\n"
    + "Open the panorama and let it load. A blue \"Save panorama\" button appears\n"
    + "in the lower right corner once it is detected — or use the console:\n"
    + "    await fb360.equirect() — the panorama, native resolution, as one image\n"
    + "    fb360.cancel()         — stop whatever is running\n"
    + "    fb360.saveButton.hide()— remove the button (.show() puts it back)\n"
    + "    fb360.saveButton.format — \"auto\", \"jpeg\", \"png\" or \"webp\"\n"
    + "    fb360.saveButton.embedMetadata — true (default) or false\n"
    + "    fb360.debug = true     — show verbose viewer-capture diagnostics (default false)");
})();

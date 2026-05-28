// tui-grab.js
//
// PC통신-style hover-and-click "grab" on top of a Claude TUI xterm.
// When the user moves the mouse over a chunk of assistant output, we
// figure out which assistant message it belongs to (by substring match
// against the on-disk JSONL transcript), draw a subtle overlay across
// the matching rows, and copy the *original* markdown to the clipboard
// on click — bypassing xterm's column-wrapped selection.
//
// Server pieces this talks to (see lib/tui-transcript-index.js and
// the tui_transcript_request / tui_transcript_state messages in
// lib/project-sessions.js):
//
//   c2s tui_transcript_request { id }
//        Asked once when attachTuiGrab() runs against a Claude TUI
//        session, so we have the index before the user starts moving
//        the mouse.
//
//   s2c tui_transcript_state { id, cliSessionId, messages: [...] }
//        Full replacement of the assistant index for one session.
//        Also pushed by the server when the JSONL file grows after a
//        new assistant turn.
//
// Codex sessions never receive a transcript_state (no JSONL), so the
// overlay stays disabled — selection copy still works normally.

import { copyToClipboard, showToast } from './utils.js';
import { getWs } from './ws-ref.js';

// Minimum probe length. Short enough to fit between markdown
// decorations (a probe like "tui-grab.js" lives inside both sides:
// the matchKey wraps it in backticks, the rendered TUI strips them,
// but the 11-char content run is contiguous in both). Long enough
// to be reasonably unique across messages — at 14 chars random
// noise basically can't collide.
var MIN_MATCH_LEN = 14;

// Cap on the probe length per offset. We deliberately stay short so
// each probe lives inside one content run between decorations and
// won't fail just because matchKey has a backtick or "**" at its
// boundary. Multi-offset windowing covers the rest of the block.
var PROBE_LEN = 24;

// Debounce mousemove → match work. Same row hovered twice in a row
// short-circuits without re-computing, but this debounce also avoids
// burning CPU while the cursor flies across the terminal on its way
// to somewhere else.
var HOVER_DEBOUNCE_MS = 60;

// Per-localId cache so flipping between TUI sessions doesn't need a
// fresh round-trip. Replaced wholesale on every tui_transcript_state.
var indexBySession = Object.create(null);

var active = null;  // { xterm, containerEl, localId, overlayEl, hoverHandler, ... }

function clearActive() {
  if (!active) return;
  if (active.hoverHandler) {
    active.containerEl.removeEventListener("mousemove", active.hoverHandler);
    active.containerEl.removeEventListener("mouseleave", active.leaveHandler);
    active.containerEl.removeEventListener("click", active.clickHandler, true);
  }
  if (active.overlayEl && active.overlayEl.parentNode) {
    active.overlayEl.parentNode.removeChild(active.overlayEl);
  }
  if (active.debounceTimer) clearTimeout(active.debounceTimer);
  active = null;
}

function buildOverlay(containerEl) {
  var overlay = document.createElement("div");
  overlay.className = "tui-grab-overlay hidden";
  overlay.style.cssText =
    "position:absolute;left:0;right:0;pointer-events:none;display:none;" +
    "background:rgba(120,170,255,0.10);border:1px solid rgba(120,170,255,0.55);" +
    "border-radius:4px;transition:opacity 80ms ease-out;z-index:5;";
  var hint = document.createElement("div");
  hint.className = "tui-grab-hint";
  hint.textContent = "Click to grab";
  hint.style.cssText =
    "position:absolute;right:6px;top:-22px;font-size:11px;" +
    "padding:2px 8px;border-radius:10px;color:#fff;" +
    "background:rgba(40,80,160,0.85);font-family:-apple-system,sans-serif;" +
    "pointer-events:none;white-space:nowrap;";
  overlay.appendChild(hint);
  containerEl.appendChild(overlay);
  return overlay;
}

// Cell metrics from the live xterm. Container coordinates only —
// works the same whether the renderer is WebGL or DOM. We re-measure
// on every match because font-size / resize can change cell height
// while a session is open.
function cellSize(xterm, containerEl) {
  var rect = containerEl.getBoundingClientRect();
  var cols = xterm.cols || 80;
  var rows = xterm.rows || 24;
  return {
    width: rect.width / cols,
    height: rect.height / rows,
    top: rect.top,
    left: rect.left,
  };
}

// Visual viewport row (0..rows-1) under the mouse, or -1 if outside
// the rendered grid.
function viewportRowAt(xterm, containerEl, clientY) {
  var dims = cellSize(xterm, containerEl);
  if (dims.height <= 0) return -1;
  var y = clientY - dims.top;
  if (y < 0) return -1;
  var row = Math.floor(y / dims.height);
  if (row < 0 || row >= xterm.rows) return -1;
  return row;
}

// Translate a viewport row into a buffer-absolute row (covers
// scrollback). xterm's buffer.active.viewportY is the buffer-row
// index of the top of the visible viewport.
function bufferRowFor(xterm, viewportRow) {
  var buf = xterm.buffer && xterm.buffer.active;
  if (!buf) return -1;
  return buf.viewportY + viewportRow;
}

function isBlankBufferRow(buf, row) {
  if (row < 0 || row >= buf.length) return true;
  var line = buf.getLine(row);
  if (!line) return true;
  var text = line.translateToString(true);
  return !text || /^\s*$/.test(text);
}

// Walk up/down from `row` while consecutive rows are non-blank. The
// returned [start, end] are both inclusive buffer-row indices that
// bound a single visual paragraph — the same chunk a human would
// double-click to "select all this."
function blockBounds(buf, row) {
  if (isBlankBufferRow(buf, row)) return null;
  var start = row;
  while (start > 0 && !isBlankBufferRow(buf, start - 1)) start--;
  var end = row;
  while (end < buf.length - 1 && !isBlankBufferRow(buf, end + 1)) end++;
  return { start: start, end: end };
}

// Reconstruct the block's text. isWrapped tells us when a buffer row
// continues the previous logical line (xterm broke it for terminal
// width) — those joins should not introduce a newline. Plain row
// transitions become newlines.
function blockText(buf, bounds) {
  var parts = [];
  for (var r = bounds.start; r <= bounds.end; r++) {
    var line = buf.getLine(r);
    if (!line) continue;
    var seg = line.translateToString(true);
    if (line.isWrapped) {
      parts.push(seg);
    } else {
      if (parts.length > 0) parts.push("\n");
      parts.push(seg);
    }
  }
  return parts.join("");
}

// Claude Code TUI decorates assistant messages with bullets / continuation
// markers that don't exist in the JSONL source. Strip the common ones
// before whitespace collapse so the substring match against matchKey
// actually hits.
//
//   ⏺   = start-of-message bullet
//   ⎿   = tool-result indent marker
//   ❯ ► = compact prompt indicators some themes use
//   >   = stale chevron from older claude versions
var TUI_BULLET_RE = /[⏺⎿❯►•>]+\s*/g;

function normalizeForMatch(s) {
  return String(s || "")
    .replace(TUI_BULLET_RE, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Look for ANY window of `text` that appears in `matchKey`. Walking
// the probe origin across the text in small steps lets us tolerate
// asymmetric prefixes (numbered list markers, leading bullets, etc.)
// that one side might keep and the other might strip. As soon as
// one window hits we know this is the right message.
var PROBE_STEP = 3;
function textContainedIn(matchKey, text, minLen) {
  if (!matchKey || !text || text.length < minLen) return false;
  var max = text.length - minLen;
  for (var offset = 0; offset <= max; offset += PROBE_STEP) {
    var probeLen = Math.min(PROBE_LEN, text.length - offset);
    if (probeLen < minLen) break;
    var probe = text.substring(offset, offset + probeLen);
    if (matchKey.indexOf(probe) !== -1) return true;
    // Also try a shorter window at this offset so we still hit when
    // the content run between markdown decorations is exactly minLen
    // long (e.g. a 14-char filename inside backticks).
    if (probeLen > minLen) {
      var shortProbe = text.substring(offset, offset + minLen);
      if (matchKey.indexOf(shortProbe) !== -1) return true;
    }
  }
  return false;
}

// Find the message whose matchKey accepts any probe window from the
// hovered block. If multiple match (rare — most assistant turns are
// distinct), prefer the latest one (latest in array order, since the
// server appends in JSONL order).
function findMatchingMessage(messages, normalized) {
  if (!messages || !normalized || normalized.length < MIN_MATCH_LEN) return null;
  var best = null;
  for (var i = 0; i < messages.length; i++) {
    var m = messages[i];
    if (m && m.matchKey && textContainedIn(m.matchKey, normalized, MIN_MATCH_LEN)) {
      best = m;
    }
  }
  return best;
}

// Does this single paragraph look like it's part of `message`? We
// reuse the multi-offset window probe so a paragraph that starts with
// a different decoration than the rest of the message still counts.
var MIN_PARA_MATCH = 10;
function paragraphBelongsToMessage(buf, bounds, message) {
  if (!bounds || !message || !message.matchKey) return false;
  var text = normalizeForMatch(blockText(buf, bounds));
  if (!text) return false;
  if (text.length >= MIN_PARA_MATCH) {
    return textContainedIn(message.matchKey, text, MIN_PARA_MATCH);
  }
  // Very short paragraphs only count if they appear verbatim and have
  // at least a couple characters — otherwise "OK" would absorb the
  // world.
  return text.length >= 3 && message.matchKey.indexOf(text) !== -1;
}

// Markdown assistant messages routinely contain blank lines between
// paragraphs. blockBounds() only knows about visual paragraphs, so the
// initial bounds cover one paragraph at most. Expand it to every
// adjacent paragraph that's also a substring of the same matchKey, so
// the overlay covers the whole assistant message a human would call
// "one block."
function expandToMessageBounds(buf, initialBounds, message) {
  var start = initialBounds.start;
  var end = initialBounds.end;

  // Walk up across blank rows looking for prior paragraphs that
  // belong to the same message. Stop at the first non-belonging one.
  var cursor = start - 1;
  while (cursor >= 0) {
    while (cursor >= 0 && isBlankBufferRow(buf, cursor)) cursor--;
    if (cursor < 0) break;
    var prevBounds = blockBounds(buf, cursor);
    if (!prevBounds || !paragraphBelongsToMessage(buf, prevBounds, message)) break;
    start = prevBounds.start;
    cursor = prevBounds.start - 1;
  }

  // Walk down similarly.
  cursor = end + 1;
  while (cursor < buf.length) {
    while (cursor < buf.length && isBlankBufferRow(buf, cursor)) cursor++;
    if (cursor >= buf.length) break;
    var nextBounds = blockBounds(buf, cursor);
    if (!nextBounds || !paragraphBelongsToMessage(buf, nextBounds, message)) break;
    end = nextBounds.end;
    cursor = nextBounds.end + 1;
  }

  return { start: start, end: end };
}

function hideOverlay() {
  if (!active || !active.overlayEl) return;
  active.overlayEl.style.display = "none";
  active.currentMatch = null;
  active.currentBounds = null;
}

function showOverlayForBlock(bounds, match) {
  if (!active) return;
  var xterm = active.xterm;
  var containerEl = active.containerEl;
  var dims = cellSize(xterm, containerEl);
  if (dims.height <= 0) return;
  var buf = xterm.buffer && xterm.buffer.active;
  if (!buf) return;
  var vpStart = bounds.start - buf.viewportY;
  var vpEnd = bounds.end - buf.viewportY;
  // Clip to viewport so the overlay never spills above/below the
  // visible terminal area.
  if (vpEnd < 0 || vpStart >= xterm.rows) { hideOverlay(); return; }
  if (vpStart < 0) vpStart = 0;
  if (vpEnd >= xterm.rows) vpEnd = xterm.rows - 1;
  var top = Math.round(vpStart * dims.height);
  var height = Math.round((vpEnd - vpStart + 1) * dims.height);
  active.overlayEl.style.top = top + "px";
  active.overlayEl.style.height = height + "px";
  active.overlayEl.style.display = "block";
  active.currentMatch = match;
  active.currentBounds = bounds;
}

function runMatch(clientX, clientY) {
  if (!active) return;
  var xterm = active.xterm;
  var containerEl = active.containerEl;
  var idx = indexBySession[active.localId];
  if (!idx || !idx.length) { hideOverlay(); return; }
  var vRow = viewportRowAt(xterm, containerEl, clientY);
  if (vRow < 0) { hideOverlay(); return; }
  var bRow = bufferRowFor(xterm, vRow);
  if (bRow < 0) { hideOverlay(); return; }
  var buf = xterm.buffer && xterm.buffer.active;
  if (!buf) { hideOverlay(); return; }
  // Same row as last time — don't redo the work (the overlay is
  // already correct for this row).
  if (active.lastBufferRow === bRow && active.currentMatch) return;
  active.lastBufferRow = bRow;
  var bounds = blockBounds(buf, bRow);
  if (!bounds) { hideOverlay(); return; }
  var text = blockText(buf, bounds);
  var normalized = normalizeForMatch(text);
  if (normalized.length < MIN_MATCH_LEN) { hideOverlay(); return; }
  var match = findMatchingMessage(idx, normalized);
  if (!match) { hideOverlay(); return; }
  // Initial bounds only cover the visual paragraph under the cursor.
  // Pull in adjacent paragraphs that also belong to the matched
  // message so the overlay covers the whole assistant block.
  var expanded = expandToMessageBounds(buf, bounds, match);
  showOverlayForBlock(expanded, match);
}

function flashOverlay() {
  if (!active || !active.overlayEl) return;
  var el = active.overlayEl;
  var prevBg = el.style.background;
  el.style.background = "rgba(120,200,140,0.30)";
  setTimeout(function () { if (el) el.style.background = prevBg; }, 220);
}

function onClick(e) {
  if (!active || !active.currentMatch) return;
  // Only consume the click when it lands inside the highlighted block.
  // Anything outside falls through to xterm's normal selection.
  var bounds = active.currentBounds;
  var buf = active.xterm.buffer && active.xterm.buffer.active;
  if (!bounds || !buf) return;
  var vRow = viewportRowAt(active.xterm, active.containerEl, e.clientY);
  if (vRow < 0) return;
  var bRow = bufferRowFor(active.xterm, vRow);
  if (bRow < bounds.start || bRow > bounds.end) return;
  e.preventDefault();
  e.stopPropagation();
  var match = active.currentMatch;
  copyToClipboard(match.text).then(function () {
    flashOverlay();
    showToast("Grabbed!", "success");
  }).catch(function () {
    showToast("Copy failed", "error");
  });
}

function requestTranscript(localId) {
  var ws = getWs();
  if (!ws || ws.readyState !== 1) return;
  try {
    ws.send(JSON.stringify({ type: "tui_transcript_request", id: localId }));
  } catch (e) {}
}

export function attachTuiGrab(xterm, containerEl, localId, opts) {
  if (!xterm || !containerEl || !localId) return;
  clearActive();
  // For non-claude vendors (e.g. Codex) we don't even bother — no
  // transcript exists on disk, so there's nothing to match against.
  if (opts && opts.vendor && opts.vendor !== "claude") return;

  var overlayEl = buildOverlay(containerEl);
  active = {
    xterm: xterm,
    containerEl: containerEl,
    localId: localId,
    overlayEl: overlayEl,
    debounceTimer: null,
    lastBufferRow: -1,
    currentMatch: null,
    currentBounds: null,
  };

  active.hoverHandler = function (e) {
    if (active.debounceTimer) clearTimeout(active.debounceTimer);
    var x = e.clientX, y = e.clientY;
    active.debounceTimer = setTimeout(function () { runMatch(x, y); }, HOVER_DEBOUNCE_MS);
  };
  active.leaveHandler = function () {
    if (active.debounceTimer) clearTimeout(active.debounceTimer);
    hideOverlay();
    active.lastBufferRow = -1;
  };
  active.clickHandler = onClick;

  containerEl.addEventListener("mousemove", active.hoverHandler);
  containerEl.addEventListener("mouseleave", active.leaveHandler);
  // Capture phase so we beat xterm's own click handler when the click
  // lands inside the highlighted block; outside the block we don't
  // call preventDefault, so xterm's selection behavior is preserved.
  containerEl.addEventListener("click", active.clickHandler, true);

  // If we already have a cached index for this session (came from a
  // prior request or a server-pushed update), don't refetch.
  if (!indexBySession[localId]) {
    requestTranscript(localId);
  }
}

export function detachTuiGrab() {
  clearActive();
}

// Called by app-messages when a tui_transcript_state arrives. Full
// replacement keyed by the session's localId.
export function handleTuiTranscriptState(msg) {
  if (!msg || !msg.id) return;
  indexBySession[msg.id] = Array.isArray(msg.messages) ? msg.messages : [];
  // If this update is for the currently active session, drop any
  // overlay state — the buffer row that used to map to a message may
  // not anymore (or vice versa). The next mousemove will recompute.
  if (active && active.localId === msg.id) {
    hideOverlay();
    active.lastBufferRow = -1;
  }
}

// Drop the cache entry for a session — call this when a session is
// deleted so we don't leak old indexes for sessions that no longer
// exist.
export function dropTuiTranscript(localId) {
  if (!localId) return;
  delete indexBySession[localId];
}

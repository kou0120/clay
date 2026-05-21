// session-tui-view.js
//
// Renders a Claude Code TUI inside the main session view area when the
// active session is a `mode: 'tui'` session. The PTY itself is managed by
// the server's terminal-manager (same infra that powers the bottom-panel
// shell tabs); this module is responsible only for the embedded xterm and
// for relaying input/output/resize for the bound terminal.
//
// Lifecycle (driven by app-messages.js on session_switched):
//   attachTuiView(terminalId)  - mount xterm, send term_attach
//   detachTuiView()            - send term_detach, dispose xterm
//
// PTY survives detach (server keeps the terminal alive). On `/exit` or
// claude exit the server's onExit hook deletes the session and broadcasts
// the new session list; this view tears itself down via handleTermExited.

import { getWs } from './ws-ref.js';

// Claude TUI sessions intentionally ignore Clay's dark/light theme and
// always render with a classic black terminal look. The bottom-panel
// shell terminal still follows the theme; this is specific to the TUI
// session view so `claude` renders consistently across themes.
var TUI_TERMINAL_THEME = {
  background: "#000000",
  foreground: "#e5e5e5",
  cursor: "#e5e5e5",
  cursorAccent: "#000000",
  selectionBackground: "#3a3a3a",
  black: "#000000",
  red: "#cd3131",
  green: "#0dbc79",
  yellow: "#e5e510",
  blue: "#2472c8",
  magenta: "#bc3fbc",
  cyan: "#11a8cd",
  white: "#e5e5e5",
  brightBlack: "#666666",
  brightRed: "#f14c4c",
  brightGreen: "#23d18b",
  brightYellow: "#f5f543",
  brightBlue: "#3b8eea",
  brightMagenta: "#d670d6",
  brightCyan: "#29b8db",
  brightWhite: "#ffffff",
};

var hostEl = null;       // container div mounted over #messages
var xtermContainerEl = null;
var policyInfoEl = null;
function openPolicyInfoModal(e) {
  if (e && e.stopPropagation) e.stopPropagation();
  if (!policyInfoEl) {
    policyInfoEl = document.createElement("div");
    policyInfoEl.className = "tui-policy-modal-backdrop";
    policyInfoEl.innerHTML = '' +
      '<div class="tui-policy-modal" role="dialog" aria-modal="true">' +
        '<div class="tui-policy-modal-header">' +
          '<h2>Why TUI mode?</h2>' +
          '<button type="button" class="tui-policy-modal-close" aria-label="Close">×</button>' +
        '</div>' +
        '<div class="tui-policy-modal-body">' +
          '<p><strong>2026-06-15 Anthropic billing change.</strong> Claude subscriptions split into two buckets:</p>' +
          '<ul>' +
            '<li><strong>Interactive</strong> &mdash; <code>claude.ai</code> chat, the terminal <code>claude</code> CLI, Claude Cowork. Uses your existing plan limits.</li>' +
            '<li><strong>Programmatic</strong> &mdash; Claude Agent SDK, <code>claude -p</code>, GitHub Actions, and third-party apps built on the SDK. Charged at full API rates against a small monthly credit (Pro $20 &middot; Max 5x $100 &middot; Max 20x $200), no rollover.</li>' +
          '</ul>' +
          '<p>Clay\'s original chat UI is SDK-driven, so every message lands in the Programmatic bucket. Heavy users would burn through the credit in days.</p>' +
          '<p><strong>TUI mode</strong> runs the real <code>claude</code> CLI inside an embedded terminal. Usage stays in the Interactive bucket, so it counts against your existing plan instead of the SDK credit.</p>' +
          '<h3>Want the SDK chat instead?</h3>' +
          '<p>Switch back to GUI mode anytime:</p>' +
          '<ol>' +
            '<li>Open your avatar &rarr; <strong>Settings</strong> at the bottom of the sidebar.</li>' +
            '<li>Find <strong>"Open Claude as terminal (TUI)"</strong> and toggle it <strong>off</strong>.</li>' +
          '</ol>' +
          '<div class="tui-policy-maintainer-note">' +
            '<h3>A note from the maintainer</h3>' +
            '<p>I believe GUIs are more humane than terminals. The decades we spent moving past fixed-width grids and cryptic command lines weren\'t accidental progress. They were design earning its keep, putting people at the center of the loop instead of the machine.</p>' +
            '<p>Would anyone seriously argue that the moment Steve Jobs pulled the Macintosh out of a bag in January 1984 wasn\'t a meaningful step forward for us? Compressed into that single scene was an agreement: humans shouldn\'t have to learn the language of machines; machines should bend toward human intuition.</p>' +
            '<p>The current AI moment seems to be quietly walking that agreement back. Should we really welcome a trend that pushes people back inside the machine\'s grid, trading human convenience for the model\'s because text is what the model parses best?</p>' +
            '<p>You could push back here: if language is the interface, isn\'t a GUI just in the way? Fair point. Nothing beats language for conveying intent. But the moment shifts when you\'re verifying what the model produced, or holding several strands of information side by side. Having a model re-read a 200-line diff to you is not the same experience as scanning a color-coded panel at a glance. Language and GUIs aren\'t substitutes for each other. They\'re complements playing different roles.</p>' +
            '<p>My read is that this whole moment is temporary, an artifact of multimodal models still being immature rather than any genuine return to first principles. What unsettles me is the conversation around it, which treats the terminal as if it had been the destination all along, as if the last forty years of GUI work hadn\'t been earning something better.</p>' +
            '<p>This billing change isn\'t the cause of that broader trend. But it did push things in one direction. By making third-party GUI clients built on its own SDK economically irrational, Anthropic quietly removed one of the channels through which Claude was reaching people as a GUI. Clay was one of them.</p>' +
            '<p>For my part, I\'ll keep doing what I can in open source: looking for ways people can stay most fully human while working alongside AI.</p>' +
            '<p>If the economics shift, Clay returns to the GUI as the default. Until then, this is the workaround, offered without enthusiasm.</p>' +
            '<p class="tui-policy-signature">Chad, Clay maintainer</p>' +
          '</div>' +
          '<p class="tui-policy-modal-links">' +
            '<a href="https://the-decoder.com/claude-subscriptions-get-separate-budgets-for-programmatic-use-billed-at-full-api-prices/" target="_blank" rel="noopener noreferrer">Coverage at The Decoder</a>' +
            ' &middot; ' +
            '<a href="https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan" target="_blank" rel="noopener noreferrer">Anthropic help center</a>' +
            ' &middot; ' +
            '<a href="https://github.com/chadbyte/clay" target="_blank" rel="noopener noreferrer">github.com/chadbyte/clay</a>' +
          '</p>' +
        '</div>' +
      '</div>';
    document.body.appendChild(policyInfoEl);
    policyInfoEl.querySelector(".tui-policy-modal-close").addEventListener("click", closePolicyInfoModal);
    policyInfoEl.addEventListener("click", function (ev) {
      if (ev.target === policyInfoEl) closePolicyInfoModal();
    });
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape" && policyInfoEl && !policyInfoEl.classList.contains("hidden")) {
        closePolicyInfoModal();
      }
    });
  }
  policyInfoEl.classList.remove("hidden");
}
function closePolicyInfoModal() {
  if (policyInfoEl) policyInfoEl.classList.add("hidden");
}
var xterm = null;        // xterm.js instance
var fitAddon = null;
var webglAddon = null;
var currentTermId = null;
var resizeObserver = null;
var windowResizeBound = false;
var resizeDebounce = null;
// Debounced fit+redraw: collapses a stream of resize events (60fps drag)
// into a single SIGWINCH/refresh pair at the end. Without this the TUI
// gets corrupted because claude starts redrawing at intermediate sizes
// before the user finishes resizing.
function scheduleResize() {
  if (currentTermId == null) return;
  if (resizeDebounce) clearTimeout(resizeDebounce);
  resizeDebounce = setTimeout(function () {
    resizeDebounce = null;
    fitNow();
    // Nudge xterm to repaint its entire viewport so any stale glyphs
    // from the previous size get overwritten by claude's fresh redraw.
    if (xterm) {
      try { xterm.refresh(0, xterm.rows - 1); } catch (e) {}
    }
  }, 120);
}
function onWindowResize() { scheduleResize(); }

function ensureHostEl() {
  if (hostEl) return hostEl;
  // Anchor the host to the chat content area (the bounding box of
  // #messages) rather than the viewport. Using `position: fixed` worked
  // visually but broke layout when the sidebar, header, or any side panel
  // was open - the xterm slid under them. Re-position on every show via
  // syncHostBounds() so resizes and panel toggles stay in sync.
  hostEl = document.createElement("div");
  hostEl.id = "tui-session-host";
  hostEl.style.position = "fixed";
  hostEl.style.display = "none";
  hostEl.style.flexDirection = "column";
  hostEl.style.background = "#000000";
  hostEl.style.zIndex = "5";
  hostEl.style.overflow = "hidden";
  hostEl.style.boxSizing = "border-box";
  // 4px inset on all sides so the terminal doesn't kiss the edges of the
  // content area. fitAddon computes against the xterm container's
  // clientWidth/clientHeight (which exclude padding + the policy banner),
  // so cols/rows stay correct.
  hostEl.style.padding = "4px";

  // Policy notice: explains why TUI mode exists (Anthropic split Agent
  // SDK usage into a separate billing bucket on 2026-06-15; running
  // `claude` in a real terminal keeps usage in the Interactive bucket).
  var noticeEl = document.createElement("div");
  noticeEl.className = "tui-policy-notice";
  noticeEl.innerHTML =
    '<span class="tui-policy-icon">●</span>' +
    '<span class="tui-policy-text">TUI is the default Claude mode in Clay because of Anthropic\'s new billing policy.</span>' +
    '<button type="button" class="tui-policy-learn-more">Learn more</button>' +
    '<button type="button" class="tui-policy-dismiss" aria-label="Dismiss this notice for the rest of the page">&times;</button>';
  noticeEl.querySelector(".tui-policy-learn-more").addEventListener("click", openPolicyInfoModal);
  noticeEl.querySelector(".tui-policy-dismiss").addEventListener("click", function () {
    // Session-only dismiss: hides the notice for the current page load.
    // Reloading restores it on purpose so the policy context doesn't
    // get lost forever - a user who comes back next month should be
    // re-reminded that TUI is a billing workaround.
    noticeEl.style.display = "none";
    if (typeof fitNow === "function") fitNow();
  });
  hostEl.appendChild(noticeEl);

  // Dedicated xterm container so the banner sits above the terminal
  // rather than xterm mounting at the host root (which would have it
  // side-by-side with the banner under flex layout).
  xtermContainerEl = document.createElement("div");
  xtermContainerEl.className = "tui-xterm-container";
  xtermContainerEl.style.flex = "1 1 auto";
  xtermContainerEl.style.minHeight = "0";
  xtermContainerEl.style.position = "relative";
  hostEl.appendChild(xtermContainerEl);

  document.body.appendChild(hostEl);
  return hostEl;
}

function syncHostBounds() {
  if (!hostEl) return;
  var messagesEl = document.getElementById("messages");
  if (!messagesEl) return;
  var r = messagesEl.getBoundingClientRect();
  // Extend down to the bottom of the viewport so the empty band that used
  // to sit below #messages (where #input-area lived before we hid it) gets
  // covered by the same terminal background instead of showing through.
  hostEl.style.top = r.top + "px";
  hostEl.style.left = r.left + "px";
  hostEl.style.width = r.width + "px";
  hostEl.style.height = (window.innerHeight - r.top) + "px";
}

function hideGuiChrome(hide) {
  var messagesEl = document.getElementById("messages");
  var inputArea = document.getElementById("input-area");
  if (messagesEl) messagesEl.style.visibility = hide ? "hidden" : "";
  if (inputArea) inputArea.style.display = hide ? "none" : "";
  var newMsgBtn = document.getElementById("new-msg-btn");
  if (newMsgBtn) newMsgBtn.style.display = hide ? "none" : "";
}

function fitNow() {
  if (!xterm || !fitAddon || !hostEl) return;
  syncHostBounds();
  try {
    fitAddon.fit();
    // Inform the server so its PTY's idea of cols/rows matches what xterm
    // just rendered. Without this, claude TUI redraws using stale dims.
    if (currentTermId != null && getWs() && getWs().readyState === 1) {
      getWs().send(JSON.stringify({
        type: "term_resize",
        id: currentTermId,
        cols: xterm.cols,
        rows: xterm.rows,
      }));
    }
  } catch (e) {}
}

function createXterm() {
  if (typeof Terminal === "undefined") return null;
  var theme = TUI_TERMINAL_THEME;
  // Match the host background to the xterm theme so any sub-cell gap
  // between the last rendered row and the host's bottom blends in.
  if (hostEl) hostEl.style.background = theme.background;
  var term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: "'SF Mono', Menlo, Monaco, 'Courier New', monospace",
    theme: theme,
    scrollback: 5000,
  });
  if (typeof FitAddon !== "undefined") {
    fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
  }
  if (typeof WebLinksAddon !== "undefined") {
    try { term.loadAddon(new WebLinksAddon.WebLinksAddon()); } catch (e) {}
  }
  term.open(xtermContainerEl || hostEl);
  if (typeof WebglAddon !== "undefined") {
    try {
      webglAddon = new WebglAddon.WebglAddon();
      webglAddon.onContextLoss(function () {
        try { webglAddon.dispose(); } catch (e) {}
        webglAddon = null;
      });
      term.loadAddon(webglAddon);
    } catch (e) {}
  }
  // Route keystrokes back to the PTY.
  term.onData(function (data) {
    if (currentTermId == null) return;
    var ws = getWs();
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: "term_input", id: currentTermId, data: data }));
    }
  });
  return term;
}

function teardownXterm() {
  if (webglAddon) {
    try { webglAddon.dispose(); } catch (e) {}
    webglAddon = null;
  }
  if (xterm) {
    try { xterm.dispose(); } catch (e) {}
    xterm = null;
  }
  fitAddon = null;
}

export function attachTuiView(terminalId) {
  if (typeof terminalId !== "number") return;
  // Re-attaching to the same terminal: just refit and refocus.
  if (currentTermId === terminalId && xterm) {
    if (hostEl) hostEl.style.display = "flex";
    hideGuiChrome(true);
    fitNow();
    try { xterm.focus(); } catch (e) {}
    return;
  }
  // Switching to a different TUI terminal: tear down the old one cleanly.
  if (currentTermId != null && currentTermId !== terminalId) {
    detachTuiView();
  }
  if (!ensureHostEl()) return;
  hostEl.style.display = "flex";
  hideGuiChrome(true);
  syncHostBounds();

  currentTermId = terminalId;
  if (!xterm) xterm = createXterm();
  if (!xterm) return;

  // Subscribe to the terminal's output stream on the server. The server
  // replays its scrollback buffer on attach so we never start blank.
  var ws = getWs();
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: "term_attach", id: terminalId }));
  }

  // First fit pass; defer a second pass for layout to settle.
  fitNow();
  setTimeout(fitNow, 50);
  try { xterm.focus(); } catch (e) {}

  if (!resizeObserver && typeof ResizeObserver !== "undefined") {
    // Watch the chat-content area, not the host: the host's size is
    // derived from #messages via syncHostBounds, so observing it would
    // miss the actual source of truth (sidebar toggles, panel opens, etc.)
    var msgEl = document.getElementById("messages");
    if (msgEl) {
      resizeObserver = new ResizeObserver(function () { scheduleResize(); });
      resizeObserver.observe(msgEl);
    }
  }
  if (!windowResizeBound) {
    window.addEventListener("resize", onWindowResize);
    windowResizeBound = true;
  }
}

export function detachTuiView() {
  if (resizeObserver) {
    try { resizeObserver.disconnect(); } catch (e) {}
    resizeObserver = null;
  }
  if (currentTermId != null) {
    var ws = getWs();
    if (ws && ws.readyState === 1) {
      try { ws.send(JSON.stringify({ type: "term_detach", id: currentTermId })); } catch (e) {}
    }
  }
  currentTermId = null;
  teardownXterm();
  if (hostEl) hostEl.style.display = "none";
  hideGuiChrome(false);
}

// Route a term_output frame to the embedded xterm if it belongs to the
// current TUI session. Returns true if consumed so app-messages can skip
// the bottom-panel handler.
export function tuiHandleTermOutput(msg) {
  if (!msg || msg.id !== currentTermId || !xterm || !msg.data) return false;
  xterm.write(msg.data);
  return true;
}

export function tuiHandleTermResized(msg) {
  if (!msg || msg.id !== currentTermId || !xterm) return false;
  if (msg.cols > 0 && msg.rows > 0) {
    try { xterm.resize(msg.cols, msg.rows); } catch (e) {}
  }
  return true;
}

export function tuiHandleTermExited(msg) {
  if (!msg || msg.id !== currentTermId) return false;
  if (xterm) {
    try { xterm.write("\r\n\x1b[90m[claude exited - session will close]\x1b[0m\r\n"); } catch (e) {}
  }
  // The server's onExit hook deletes the session record and broadcasts a
  // fresh session_list. The next session_switched (or empty state) will
  // call detachTuiView for us.
  return true;
}

export function tuiHandleTermClosed(msg) {
  if (!msg || msg.id !== currentTermId) return false;
  detachTuiView();
  return true;
}

export function getActiveTuiTerminalId() {
  return currentTermId;
}

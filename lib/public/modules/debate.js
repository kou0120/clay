import { mateAvatarUrl } from './avatar.js';
import { renderMarkdown, highlightCodeBlocks } from './markdown.js';
import { escapeHtml } from './utils.js';
import { iconHtml, refreshIcons } from './icons.js';

var ctx;

// --- State ---
var debateActive = false;
var debateTopic = "";
var debateRound = 0;
var debatePhase = "idle";  // idle | live | ended

// Current turn streaming state
var currentTurnEl = null;
var currentTurnMateId = null;
var turnFullText = "";
var turnStreamBuffer = "";
var turnDrainTimer = null;

// --- Init ---
export function initDebate(_ctx) {
  ctx = _ctx;
}

function buildAvatarUrl(meta) {
  return "https://api.dicebear.com/7.x/" + (meta.avatarStyle || "bottts") + "/svg?seed=" + encodeURIComponent(meta.avatarSeed || meta.mateId || "mate");
}

// --- Float info panel ---
function showDebateInfoFloat(msg) {
  var floatEl = document.getElementById("debate-info-float");
  if (!floatEl) return;

  var html = '<div class="debate-info-float-inner">';
  html += '<span class="debate-info-mod">' + iconHtml("mic") + ' ' + escapeHtml(msg.moderatorName || "Moderator") + '</span>';
  html += '<span class="debate-info-sep">|</span>';
  html += '<span class="debate-info-label">Panel:</span>';

  if (msg.panelists) {
    for (var i = 0; i < msg.panelists.length; i++) {
      var p = msg.panelists[i];
      if (i > 0) html += '<span class="debate-info-comma">,</span>';
      html += '<span class="debate-info-chip">';
      html += '<img class="debate-info-avatar" src="' + buildAvatarUrl(p) + '" width="14" height="14" />';
      html += '<span>' + escapeHtml(p.name || "") + '</span>';
      if (p.role) html += '<span class="debate-info-role">(' + escapeHtml(p.role) + ')</span>';
      html += '</span>';
    }
  }

  html += '</div>';
  floatEl.innerHTML = html;
  floatEl.classList.remove("hidden");
  refreshIcons();
}

function hideDebateInfoFloat() {
  var floatEl = document.getElementById("debate-info-float");
  if (floatEl) {
    floatEl.classList.add("hidden");
    floatEl.innerHTML = "";
  }
}

// --- Handlers ---

export function handleDebateResumed(msg) {
  debateActive = true;
  debatePhase = "live";
  if (msg.topic) debateTopic = msg.topic;
  if (msg.round) debateRound = msg.round;

  // Show float info panel again if we have it
  showDebateInfoFloat(msg);
}

export function handleDebateStarted(msg) {
  debateActive = true;
  debateTopic = msg.topic || "";
  debateRound = 1;
  debatePhase = "live";

  // Show float info panel
  showDebateInfoFloat(msg);

  if (ctx.scrollToBottom) ctx.scrollToBottom();
}

export function handleDebateTurn(msg) {
  debateRound = msg.round || debateRound;

  if (!ctx.messagesEl) return;

  var turnEl = document.createElement("div");
  turnEl.className = "debate-turn";

  // Speaker header
  var speakerRow = document.createElement("div");
  speakerRow.className = "debate-speaker";

  var avi = document.createElement("img");
  avi.className = "debate-speaker-avatar";
  avi.src = buildAvatarUrl(msg);
  avi.width = 24;
  avi.height = 24;
  speakerRow.appendChild(avi);

  var nameSpan = document.createElement("span");
  nameSpan.className = "debate-speaker-name";
  nameSpan.textContent = msg.mateName || "Speaker";
  speakerRow.appendChild(nameSpan);

  var roleSpan = document.createElement("span");
  roleSpan.className = "debate-speaker-role";
  roleSpan.textContent = msg.role || "";
  speakerRow.appendChild(roleSpan);

  turnEl.appendChild(speakerRow);

  // Activity indicator
  var activityDiv = document.createElement("div");
  activityDiv.className = "activity-inline debate-activity-bar";
  activityDiv.innerHTML =
    '<span class="activity-icon">' + iconHtml("sparkles") + '</span>' +
    '<span class="activity-text">Thinking...</span>';
  turnEl.appendChild(activityDiv);

  // Content area
  var contentDiv = document.createElement("div");
  contentDiv.className = "md-content debate-turn-content";
  contentDiv.dir = "auto";
  turnEl.appendChild(contentDiv);

  ctx.messagesEl.appendChild(turnEl);

  // Set as current streaming target
  currentTurnEl = turnEl;
  currentTurnMateId = msg.mateId;
  turnFullText = "";
  turnStreamBuffer = "";

  refreshIcons();
  if (ctx.scrollToBottom) ctx.scrollToBottom();
}

export function handleDebateActivity(msg) {
  if (!currentTurnEl || msg.mateId !== currentTurnMateId) return;

  var bar = currentTurnEl.querySelector(".debate-activity-bar");
  if (msg.activity) {
    if (!bar) {
      bar = document.createElement("div");
      bar.className = "activity-inline debate-activity-bar";
      bar.innerHTML =
        '<span class="activity-icon">' + iconHtml("sparkles") + '</span>' +
        '<span class="activity-text"></span>';
      var contentEl = currentTurnEl.querySelector(".debate-turn-content");
      if (contentEl) {
        currentTurnEl.insertBefore(bar, contentEl);
      } else {
        currentTurnEl.appendChild(bar);
      }
      refreshIcons();
    }
    var textEl = bar.querySelector(".activity-text");
    if (textEl) {
      textEl.textContent = msg.activity === "thinking" ? "Thinking..." : msg.activity;
    }
    bar.style.display = "";
  } else {
    if (bar) bar.style.display = "none";
  }
  if (ctx.scrollToBottom) ctx.scrollToBottom();
}

export function handleDebateStream(msg) {
  if (!currentTurnEl || msg.mateId !== currentTurnMateId) return;

  // Hide activity bar on first text
  var bar = currentTurnEl.querySelector(".debate-activity-bar");
  if (bar) bar.style.display = "none";

  turnStreamBuffer += msg.delta;
  if (!turnDrainTimer) {
    turnDrainTimer = requestAnimationFrame(drainTurnStream);
  }
}

function drainTurnStream() {
  turnDrainTimer = null;
  if (!currentTurnEl || turnStreamBuffer.length === 0) return;

  var len = turnStreamBuffer.length;
  var n;
  if (len > 200) n = Math.ceil(len / 4);
  else if (len > 80) n = 8;
  else if (len > 30) n = 5;
  else if (len > 10) n = 2;
  else n = 1;

  var chunk = turnStreamBuffer.slice(0, n);
  turnStreamBuffer = turnStreamBuffer.slice(n);
  turnFullText += chunk;

  var contentEl = currentTurnEl.querySelector(".debate-turn-content");
  if (contentEl) {
    contentEl.innerHTML = renderMarkdown(turnFullText);
    highlightCodeBlocks(contentEl);
  }

  if (ctx.scrollToBottom) ctx.scrollToBottom();

  if (turnStreamBuffer.length > 0) {
    turnDrainTimer = requestAnimationFrame(drainTurnStream);
  }
}

function flushTurnStream() {
  if (turnDrainTimer) {
    cancelAnimationFrame(turnDrainTimer);
    turnDrainTimer = null;
  }
  if (turnStreamBuffer.length > 0) {
    turnFullText += turnStreamBuffer;
    turnStreamBuffer = "";
  }
  if (currentTurnEl) {
    var contentEl = currentTurnEl.querySelector(".debate-turn-content");
    if (contentEl) {
      contentEl.innerHTML = renderMarkdown(turnFullText);
      highlightCodeBlocks(contentEl);
    }
  }
}

export function handleDebateTurnDone(msg) {
  flushTurnStream();

  if (currentTurnEl) {
    var bar = currentTurnEl.querySelector(".debate-activity-bar");
    if (bar) bar.style.display = "none";
    if (ctx.addCopyHandler && turnFullText) {
      ctx.addCopyHandler(currentTurnEl, turnFullText);
    }
  }

  currentTurnEl = null;
  currentTurnMateId = null;
  turnFullText = "";
  if (ctx.scrollToBottom) ctx.scrollToBottom();
}

export function handleDebateCommentQueued(msg) {
  if (!ctx.messagesEl) return;

  var commentEl = document.createElement("div");
  commentEl.className = "debate-user-comment";

  var label = document.createElement("span");
  label.className = "debate-comment-label";
  label.innerHTML = iconHtml("hand") + " You raised your hand:";

  var textEl = document.createElement("div");
  textEl.className = "debate-comment-text";
  textEl.textContent = msg.text || "";

  commentEl.appendChild(label);
  commentEl.appendChild(textEl);
  ctx.messagesEl.appendChild(commentEl);

  refreshIcons();
  if (ctx.scrollToBottom) ctx.scrollToBottom();
}

export function handleDebateCommentInjected(msg) {
  // Comment was delivered to moderator, no extra UI needed
}

export function handleDebateEnded(msg) {
  debateActive = false;
  debatePhase = "ended";

  flushTurnStream();
  currentTurnEl = null;
  currentTurnMateId = null;

  // Hide float info panel
  hideDebateInfoFloat();

  if (ctx.messagesEl) {
    renderEndedBanner(msg);
  }

  if (ctx.scrollToBottom) ctx.scrollToBottom();
}

function renderEndedBanner(entry) {
  if (!ctx.messagesEl) return;

  // Remove existing ended banner (prevent duplicates)
  var existing = ctx.messagesEl.querySelector(".debate-ended-banner");
  if (existing) existing.remove();

  var endBanner = document.createElement("div");
  endBanner.className = "debate-ended-banner";

  var reasonText = entry.reason === "natural" ? "Debate concluded" :
                   entry.reason === "user_stopped" ? "Debate stopped by user" :
                   "Debate ended due to error";

  var statusRow = document.createElement("div");
  statusRow.className = "debate-ended-status";
  statusRow.innerHTML = iconHtml("check-circle") + " " + escapeHtml(reasonText) + " (" + (entry.rounds || 0) + " rounds)";
  endBanner.appendChild(statusRow);

  // Resume row
  var resumeRow = document.createElement("div");
  resumeRow.className = "debate-ended-resume";

  var resumeInput = document.createElement("textarea");
  resumeInput.className = "debate-ended-resume-input";
  resumeInput.rows = 1;
  resumeInput.placeholder = "Continue with a new direction...";
  resumeRow.appendChild(resumeInput);

  var resumeBtn = document.createElement("button");
  resumeBtn.className = "debate-ended-resume-btn";
  resumeBtn.textContent = "Resume";
  resumeBtn.addEventListener("click", function () {
    var text = resumeInput.value.trim();
    if (ctx.ws && ctx.ws.readyState === 1) {
      ctx.ws.send(JSON.stringify({ type: "debate_conclude_response", action: "continue", text: text }));
    }
    endBanner.remove();
  });
  resumeRow.appendChild(resumeBtn);

  endBanner.appendChild(resumeRow);

  // Enter in textarea = resume
  resumeInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      resumeBtn.click();
    }
  });

  ctx.messagesEl.appendChild(endBanner);
  refreshIcons();
}

export function handleDebateError(msg) {
  if (ctx.messagesEl && debateActive) {
    var errEl = document.createElement("div");
    errEl.className = "debate-error";
    errEl.textContent = "Error: " + (msg.error || "Unknown error");
    ctx.messagesEl.appendChild(errEl);
    if (ctx.scrollToBottom) ctx.scrollToBottom();
  }
}

// --- History replay ---
export function renderDebateStarted(entry) {
  handleDebateStarted(entry);
}

export function renderDebateTurnDone(entry) {
  if (!ctx.messagesEl) return;

  var turnEl = document.createElement("div");
  turnEl.className = "debate-turn";

  var speakerRow = document.createElement("div");
  speakerRow.className = "debate-speaker";

  if (entry.avatarStyle || entry.avatarSeed || entry.mateId) {
    var avi = document.createElement("img");
    avi.className = "debate-speaker-avatar";
    avi.src = buildAvatarUrl(entry);
    avi.width = 24;
    avi.height = 24;
    speakerRow.appendChild(avi);
  }

  var nameSpan = document.createElement("span");
  nameSpan.className = "debate-speaker-name";
  nameSpan.textContent = entry.mateName || "Speaker";
  speakerRow.appendChild(nameSpan);

  var roleSpan = document.createElement("span");
  roleSpan.className = "debate-speaker-role";
  roleSpan.textContent = entry.role || "";
  speakerRow.appendChild(roleSpan);

  turnEl.appendChild(speakerRow);

  var contentDiv = document.createElement("div");
  contentDiv.className = "md-content debate-turn-content";
  contentDiv.dir = "auto";
  contentDiv.innerHTML = renderMarkdown(entry.text || "");
  highlightCodeBlocks(contentDiv);
  turnEl.appendChild(contentDiv);

  ctx.messagesEl.appendChild(turnEl);
}

export function renderDebateUserResume(entry) {
  if (!ctx.messagesEl) return;

  // Remove the ended banner since we're resuming
  var endedBanner = ctx.messagesEl.querySelector(".debate-ended-banner");
  if (endedBanner) endedBanner.remove();

  // Also remove conclude confirm if present
  var confirmEl = document.getElementById("debate-conclude-confirm");
  if (confirmEl) confirmEl.remove();

  var el = document.createElement("div");
  el.className = "debate-user-comment";

  var label = document.createElement("span");
  label.className = "debate-comment-label";
  label.innerHTML = iconHtml("play") + " Debate resumed:";

  var textEl = document.createElement("div");
  textEl.className = "debate-comment-text";
  textEl.textContent = entry.text || "";

  el.appendChild(label);
  el.appendChild(textEl);
  ctx.messagesEl.appendChild(el);
  refreshIcons();
  if (ctx.scrollToBottom) ctx.scrollToBottom();
}

export function renderDebateEnded(entry) {
  if (!ctx.messagesEl) return;

  hideDebateInfoFloat();
  renderEndedBanner(entry);
}

export function renderDebateCommentInjected(entry) {
  if (!ctx.messagesEl) return;

  var commentEl = document.createElement("div");
  commentEl.className = "debate-user-comment";

  var label = document.createElement("span");
  label.className = "debate-comment-label";
  label.innerHTML = iconHtml("hand") + " User comment:";

  var textEl = document.createElement("div");
  textEl.className = "debate-comment-text";
  textEl.textContent = entry.text || "";

  commentEl.appendChild(label);
  commentEl.appendChild(textEl);
  ctx.messagesEl.appendChild(commentEl);
  refreshIcons();
}

export function isDebateActive() {
  return debateActive;
}

// --- Debate modal ---
var modalEl = null;
var selectedPanelists = [];

export function openDebateModal() {
  modalEl = document.getElementById("debate-modal");
  if (!modalEl) return;

  modalEl.classList.remove("hidden");

  var topicInput = document.getElementById("debate-topic-input");
  if (topicInput) {
    topicInput.value = "";
    topicInput.focus();
  }

  // Populate panelist list from mates (exclude current mate = moderator)
  var panelList = document.getElementById("debate-panel-list");
  if (panelList) {
    panelList.innerHTML = "";
    selectedPanelists = [];
    var mates = ctx.matesList ? ctx.matesList() : [];
    var currentMateId = ctx.currentMateId ? ctx.currentMateId() : null;
    for (var i = 0; i < mates.length; i++) {
      var m = mates[i];
      if (m.status === "interviewing") continue;
      if (m.id === currentMateId) continue; // moderator, skip
      var item = createPanelItem(m);
      panelList.appendChild(item);
    }
  }

  // Close button
  var closeBtn = document.getElementById("debate-modal-close");
  if (closeBtn) {
    closeBtn.onclick = closeDebateModal;
  }
  var cancelBtn = document.getElementById("debate-modal-cancel");
  if (cancelBtn) {
    cancelBtn.onclick = closeDebateModal;
  }

  // Backdrop click to close
  var backdrop = modalEl.querySelector(".debate-modal-backdrop");
  if (backdrop) {
    backdrop.onclick = closeDebateModal;
  }

  // Start button
  var startBtn = document.getElementById("debate-modal-start");
  if (startBtn) {
    startBtn.onclick = function () {
      var topic = topicInput ? topicInput.value.trim() : "";
      if (!topic) {
        topicInput.focus();
        return;
      }
      if (selectedPanelists.length === 0) return;

      var currentMateId = ctx.currentMateId ? ctx.currentMateId() : null;
      if (!currentMateId) return;

      // Create a new session first, then send debate_start after switch
      if (ctx.ws) {
        var debatePayload = {
          type: "debate_start",
          moderatorId: currentMateId,
          topic: topic,
          panelists: selectedPanelists.map(function (id) {
            return { mateId: id, role: "", brief: "" };
          }),
        };

        // Listen for session_switched once, then send debate_start
        var onMessage = function (evt) {
          try {
            var data = JSON.parse(evt.data);
            if (data.type === "session_switched") {
              ctx.ws.removeEventListener("message", onMessage);
              ctx.ws.send(JSON.stringify(debatePayload));
            }
          } catch (e) {}
        };
        ctx.ws.addEventListener("message", onMessage);
        ctx.ws.send(JSON.stringify({ type: "new_session" }));
      }

      closeDebateModal();
    };
  }

  refreshIcons();
}

function createPanelItem(mate) {
  var item = document.createElement("div");
  item.className = "debate-panel-item";
  item.dataset.mateId = mate.id;

  var cb = document.createElement("input");
  cb.type = "checkbox";
  item.appendChild(cb);

  var avatarSrc = "https://api.dicebear.com/7.x/" +
    ((mate.profile && mate.profile.avatarStyle) || "bottts") +
    "/svg?seed=" + encodeURIComponent((mate.profile && mate.profile.avatarSeed) || mate.id);
  var avi = document.createElement("img");
  avi.className = "debate-panel-item-avatar";
  avi.src = avatarSrc;
  item.appendChild(avi);

  var info = document.createElement("div");
  info.className = "debate-panel-item-info";

  var nameSpan = document.createElement("div");
  nameSpan.className = "debate-panel-item-name";
  nameSpan.textContent = (mate.profile && mate.profile.displayName) || mate.name || "Mate";
  info.appendChild(nameSpan);

  if (mate.bio) {
    var bioSpan = document.createElement("div");
    bioSpan.className = "debate-panel-item-bio";
    bioSpan.textContent = mate.bio;
    info.appendChild(bioSpan);
  }

  item.appendChild(info);

  // Toggle selection
  function toggle() {
    var idx = selectedPanelists.indexOf(mate.id);
    if (idx === -1) {
      selectedPanelists.push(mate.id);
      item.classList.add("selected");
      cb.checked = true;
    } else {
      selectedPanelists.splice(idx, 1);
      item.classList.remove("selected");
      cb.checked = false;
    }
  }

  item.addEventListener("click", function (e) {
    if (e.target === cb) return; // let checkbox handle itself
    toggle();
  });
  cb.addEventListener("change", function () {
    var idx = selectedPanelists.indexOf(mate.id);
    if (cb.checked && idx === -1) {
      selectedPanelists.push(mate.id);
      item.classList.add("selected");
    } else if (!cb.checked && idx !== -1) {
      selectedPanelists.splice(idx, 1);
      item.classList.remove("selected");
    }
  });

  return item;
}

export function closeDebateModal() {
  if (modalEl) {
    modalEl.classList.add("hidden");
  }
  selectedPanelists = [];
}

var AiBot = require("@wecom/aibot-node-sdk");

function createWecomBot(opts) {
  var relay = opts.relay;
  var config = opts.config || {};
  var logger = opts.logger || console;
  var wsClient = null;
  var unsubscribers = {};
  var sessionState = {};

  function logInfo() {
    try { logger.log.apply(logger, arguments); } catch (e) { }
  }

  function logError() {
    try { logger.error.apply(logger, arguments); } catch (e) { }
  }

  function getProjectContext() {
    if (!relay || !config.projectSlug) return null;
    return relay.getProjectContext(config.projectSlug);
  }

  function getSessionKey(frame) {
    var body = frame && frame.body ? frame.body : {};
    var aibotid = body.aibotid || config.botId || "bot";
    var chatid = body.chatid || (body.from && body.from.userid) || "default";
    return "wecom:" + aibotid + ":" + chatid;
  }

  function getReplyTarget(frame) {
    var body = frame && frame.body ? frame.body : {};
    if (body.chattype === "group") return body.chatid || "";
    return (body.from && body.from.userid) || body.chatid || "";
  }

  function ensureSessionState(sessionKey) {
    if (!sessionState[sessionKey]) {
      sessionState[sessionKey] = {
        unsubscribe: null,
        activeFrame: null,
        replyTarget: "",
        textBuffer: "",
        streamId: null,
        streamOpened: false,
        askedToolIds: {},
        pendingToolId: null,
        pendingQuestionText: "",
      };
    }
    return sessionState[sessionKey];
  }

  function trimReplyText(text) {
    var normalized = String(text || "").replace(/\n{3,}/g, "\n\n").trim();
    if (!normalized) return "Claude 已处理完成，但没有返回文本内容。";
    if (normalized.length > 4000) {
      return normalized.substring(0, 3900) + "\n\n[内容过长，已截断]";
    }
    return normalized;
  }

  function sendTextReply(frame, text) {
    if (!wsClient || !frame) return Promise.resolve(null);
    return wsClient.replyStream(
      frame,
      "wecom-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10),
      trimReplyText(text),
      true
    );
  }

  function ensureStreamId(state) {
    if (!state.streamId) {
      state.streamId = "wecom-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10);
    }
    return state.streamId;
  }

  function resetStreamState(state) {
    state.streamId = null;
    state.streamOpened = false;
  }

  function sendStreamChunk(state, text, finish) {
    if (!wsClient || !state || !state.activeFrame) return Promise.resolve(null);
    var chunk = String(text || "");
    if (!chunk && !finish) return Promise.resolve(null);
    var streamId = ensureStreamId(state);
    var content = state.textBuffer;
    if (!content && chunk) {
      content = chunk;
    }
    if (!content && finish) {
      content = "Claude 已处理完成。";
    }
    if (content) {
      state.streamOpened = true;
    }
    return wsClient.replyStream(
      state.activeFrame,
      streamId,
      content,
      !!finish
    ).then(function (result) {
      if (finish) {
        resetStreamState(state);
      }
      return result;
    }).catch(function (err) {
      if (finish) {
        resetStreamState(state);
      }
      throw err;
    });
  }

  function updatePendingQuestion(sessionKey) {
    var ctx = getProjectContext();
    if (!ctx) return null;
    var state = ensureSessionState(sessionKey);
    var externalState = ctx.getExternalSessionState(sessionKey);
    var pendingQuestions = externalState.pendingQuestions || [];
    if (pendingQuestions.length === 0) {
      state.pendingToolId = null;
      state.pendingQuestionText = "";
      return null;
    }
    var question = pendingQuestions[0];
    var input = question.input || {};
    var text = "";
    if (Array.isArray(input.questions) && input.questions.length > 0) {
      text = input.questions[0].question || "";
    }
    if (!text && input.message) text = input.message;
    if (!text) text = "Claude 需要更多信息，请继续补充。";
    state.pendingToolId = question.toolId;
    state.pendingQuestionText = text;
    return question;
  }

  function subscribeSession(sessionKey) {
    var ctx = getProjectContext();
    if (!ctx) return;
    var state = ensureSessionState(sessionKey);
    if (state.unsubscribe) return;
    state.unsubscribe = ctx.subscribeExternalSession(sessionKey, function (event) {
      if (!event) return;
      if (event.type === "delta" && typeof event.text === "string") {
        state.textBuffer += event.text;
        sendStreamChunk(state, state.textBuffer, false).catch(function (err) {
          logError("[wecom-bot] send stream chunk failed:", err && err.message ? err.message : err);
        });
        return;
      }
      if (event.type === "ask_user_answered") {
        state.pendingToolId = null;
        state.pendingQuestionText = "";
        return;
      }
      if (event.type === "result") {
        return;
      }
      if (event.type === "error") {
        if (state.activeFrame) {
          if (state.streamOpened) {
            state.textBuffer += "\n\n" + (event.text || "Claude 处理失败。");
            sendStreamChunk(state, state.textBuffer, true).catch(function (err) {
              logError("[wecom-bot] send error stream failed:", err && err.message ? err.message : err);
            });
          } else {
            sendTextReply(state.activeFrame, event.text || "Claude 处理失败。").catch(function (err) {
              logError("[wecom-bot] send error reply failed:", err && err.message ? err.message : err);
            });
            resetStreamState(state);
          }
        }
        state.textBuffer = "";
        return;
      }
      if (event.type === "done") {
        var pending = updatePendingQuestion(sessionKey);
        if (pending && !state.askedToolIds[pending.toolId]) {
          state.askedToolIds[pending.toolId] = true;
          if (state.activeFrame) {
            if (state.streamOpened) {
              state.textBuffer += "\n\n" + state.pendingQuestionText;
              sendStreamChunk(state, state.textBuffer, true).catch(function (err) {
                logError("[wecom-bot] send ask-user stream failed:", err && err.message ? err.message : err);
              });
            } else {
              sendTextReply(state.activeFrame, state.pendingQuestionText).catch(function (err) {
                logError("[wecom-bot] send ask-user reply failed:", err && err.message ? err.message : err);
              });
              resetStreamState(state);
            }
          }
          state.textBuffer = "";
          return;
        }
        if (state.activeFrame) {
          if (state.streamOpened) {
            sendStreamChunk(state, "", true).catch(function (err) {
              logError("[wecom-bot] send final stream failed:", err && err.message ? err.message : err);
            });
          } else {
            var finalText = state.textBuffer || "Claude 已处理完成。";
            sendTextReply(state.activeFrame, finalText).catch(function (err) {
              logError("[wecom-bot] send final reply failed:", err && err.message ? err.message : err);
            });
            resetStreamState(state);
          }
        }
        state.textBuffer = "";
      }
    });
  }

  function handleEnterChat(frame) {
    if (!config.welcomeText) return;
    wsClient.replyWelcome(frame, {
      msgtype: "text",
      text: { content: config.welcomeText },
    }).catch(function (err) {
      logError("[wecom-bot] replyWelcome failed:", err && err.message ? err.message : err);
    });
  }

  function handleTextMessage(frame) {
    var ctx = getProjectContext();
    if (!ctx) {
      logError("[wecom-bot] project not found for slug:", config.projectSlug);
      return;
    }
    var body = frame && frame.body ? frame.body : {};
    var content = body.text && body.text.content ? String(body.text.content) : "";
    var sessionKey = getSessionKey(frame);
    var state = ensureSessionState(sessionKey);
    state.activeFrame = frame;
    state.replyTarget = getReplyTarget(frame);
    resetStreamState(state);
    subscribeSession(sessionKey);

    updatePendingQuestion(sessionKey);
    if (state.pendingToolId) {
      ctx.answerExternalAsk(sessionKey, state.pendingToolId, content);
      state.pendingToolId = null;
      state.pendingQuestionText = "";
      return;
    }

    state.textBuffer = "";
    state.askedToolIds = {};
    var result = ctx.submitExternalMessage(sessionKey, content);
    if (!result || !result.ok) {
      sendTextReply(frame, (result && result.error) || "消息发送失败").catch(function (err) {
        logError("[wecom-bot] send submit error failed:", err && err.message ? err.message : err);
      });
    }
  }

  function start() {
    if (!config.enabled) return null;
    if (!config.botId || !config.secret || !config.projectSlug) {
      logError("[wecom-bot] missing required config: botId/secret/projectSlug");
      return null;
    }

    wsClient = new AiBot.WSClient({
      botId: config.botId,
      secret: config.secret,
      reconnectInterval: config.reconnectInterval || 1000,
      maxReconnectAttempts: config.maxReconnectAttempts != null ? config.maxReconnectAttempts : -1,
      heartbeatInterval: config.heartbeatInterval || 30000,
    });

    wsClient.on("connected", function () {
      logInfo("[wecom-bot] connected");
    });
    wsClient.on("authenticated", function () {
      logInfo("[wecom-bot] authenticated for project", config.projectSlug);
    });
    wsClient.on("disconnected", function (reason) {
      logInfo("[wecom-bot] disconnected:", reason || "unknown");
    });
    wsClient.on("reconnecting", function (attempt) {
      logInfo("[wecom-bot] reconnecting attempt", attempt);
    });
    wsClient.on("error", function (err) {
      logError("[wecom-bot] error:", err && err.message ? err.message : err);
    });
    wsClient.on("event.enter_chat", handleEnterChat);
    wsClient.on("message.text", handleTextMessage);

    wsClient.connect();
    return wsClient;
  }

  function stop() {
    var keys = Object.keys(sessionState);
    for (var i = 0; i < keys.length; i++) {
      if (sessionState[keys[i]].unsubscribe) {
        try { sessionState[keys[i]].unsubscribe(); } catch (e) { }
      }
    }
    sessionState = {};
    if (wsClient) {
      try { wsClient.disconnect(); } catch (e) { }
      wsClient = null;
    }
  }

  return {
    start: start,
    stop: stop,
  };
}

module.exports = { createWecomBot: createWecomBot };

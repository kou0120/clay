var AiBot = require("@wecom/aibot-node-sdk");
var fs = require("fs");
var path = require("path");

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

  function hasExternalSessionApi(ctx) {
    return !!(ctx
      && typeof ctx.getExternalSessionState === "function"
      && typeof ctx.subscribeExternalSession === "function"
      && typeof ctx.submitExternalMessage === "function"
      && typeof ctx.answerExternalAsk === "function");
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
        pendingImages: [],
        toolInfo: {},
        seenImagePaths: {},
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
    if (!hasExternalSessionApi(ctx)) return null;
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

  var IMAGE_EXTS = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp" };

  function isImagePath(filePath) {
    if (!filePath) return false;
    var ext = path.extname(filePath).toLowerCase();
    return !!IMAGE_EXTS[ext];
  }

  function readLocalImage(filePath) {
    try {
      var buf = fs.readFileSync(filePath);
      if (!buf || buf.length === 0) return null;
      var detected = detectImageType(buf);
      var ext = path.extname(filePath).toLowerCase();
      var mediaType = detected || IMAGE_EXTS[ext] || "image/png";
      return { mediaType: mediaType, data: buf.toString("base64") };
    } catch (err) {
      logError("[wecom-bot] read local image failed:", filePath, err && err.message ? err.message : err);
      return null;
    }
  }

  function flushPendingImages(state) {
    var images = state.pendingImages;
    state.pendingImages = [];
    if (!images.length || !wsClient || !state.replyTarget) return;
    var target = state.replyTarget;
    var chain = Promise.resolve();
    for (var i = 0; i < images.length; i++) {
      (function (img) {
        chain = chain.then(function () {
          var buf = Buffer.from(img.data, "base64");
          var ext = "png";
          if (img.mediaType === "image/jpeg") ext = "jpg";
          else if (img.mediaType === "image/gif") ext = "gif";
          else if (img.mediaType === "image/webp") ext = "webp";
          else if (img.mediaType === "image/bmp") ext = "bmp";
          return wsClient.uploadMedia(buf, { type: "image", filename: "image." + ext }).then(function (res) {
            if (res && res.media_id) {
              return wsClient.sendMediaMessage(target, "image", res.media_id);
            }
          });
        }).catch(function (err) {
          logError("[wecom-bot] flush image failed:", err && err.message ? err.message : err);
        });
      })(images[i]);
    }
  }

  function subscribeSession(sessionKey) {
    var ctx = getProjectContext();
    if (!hasExternalSessionApi(ctx)) {
      logError("[wecom-bot] project context missing external session API for slug:", config.projectSlug);
      return;
    }
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
      if (event.type === "tool_executing" && event.id && event.name) {
        state.toolInfo[event.id] = { name: event.name, input: event.input || {} };
        return;
      }
      if (event.type === "tool_result") {
        var images = Array.isArray(event.images) ? event.images : [];
        var info = state.toolInfo[event.id];
        delete state.toolInfo[event.id];
        var filePath = info && info.input ? info.input.file_path : null;
        if (filePath && state.seenImagePaths[filePath]) {
          return;
        }
        if (images.length > 0) {
          if (filePath) state.seenImagePaths[filePath] = true;
          for (var ii = 0; ii < images.length; ii++) {
            state.pendingImages.push(images[ii]);
          }
        } else if (info && info.name === "Read" && filePath && isImagePath(filePath)) {
          state.seenImagePaths[filePath] = true;
          var img = readLocalImage(filePath);
          if (img) state.pendingImages.push(img);
        }
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
          flushPendingImages(state);
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
        flushPendingImages(state);
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

  function detectImageType(buf) {
    if (!buf || buf.length < 12) return null;
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return "image/png";
    if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return "image/jpeg";
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return "image/gif";
    if (buf[0] === 0x42 && buf[1] === 0x4D) return "image/bmp";
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
      && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return "image/webp";
    return null;
  }

  function downloadImage(body) {
    var image = body.image || {};
    var url = image.url;
    var aesKey = image.aeskey;
    if (!url || !wsClient) return Promise.resolve(null);
    return wsClient.downloadFile(url, aesKey).then(function (result) {
      var buf = result && result.buffer;
      if (!buf || buf.length === 0) return null;
      var mediaType = detectImageType(buf);
      if (!mediaType) {
        logError("[wecom-bot] unrecognized image format, first bytes:", buf.slice(0, 16).toString("hex"));
        return null;
      }
      var data = buf.toString("base64");
      return { mediaType: mediaType, data: data };
    }).catch(function (err) {
      logError("[wecom-bot] download image failed:", err && err.message ? err.message : err);
      return null;
    });
  }

  function submitMessageWithImages(frame, text, images) {
    var ctx = getProjectContext();
    if (!ctx) {
      logError("[wecom-bot] project not found for slug:", config.projectSlug);
      return;
    }
    if (!hasExternalSessionApi(ctx)) {
      logError("[wecom-bot] project context missing external session API for slug:", config.projectSlug);
      sendTextReply(frame, "项目上下文尚未就绪，请重启 clay-server 后重试。").catch(function (err) {
        logError("[wecom-bot] send context error failed:", err && err.message ? err.message : err);
      });
      return;
    }
    var sessionKey = getSessionKey(frame);
    var state = ensureSessionState(sessionKey);
    state.activeFrame = frame;
    state.replyTarget = getReplyTarget(frame);
    resetStreamState(state);
    subscribeSession(sessionKey);

    updatePendingQuestion(sessionKey);
    if (state.pendingToolId) {
      ctx.answerExternalAsk(sessionKey, state.pendingToolId, text || "(image)");
      state.pendingToolId = null;
      state.pendingQuestionText = "";
      return;
    }

    state.textBuffer = "";
    state.askedToolIds = {};
    state.seenImagePaths = {};
    var result = ctx.submitExternalMessage(sessionKey, text, images);
    if (!result || !result.ok) {
      sendTextReply(frame, (result && result.error) || "消息发送失败").catch(function (err) {
        logError("[wecom-bot] send submit error failed:", err && err.message ? err.message : err);
      });
    }
  }

  function handleTextMessage(frame) {
    var body = frame && frame.body ? frame.body : {};
    var content = body.text && body.text.content ? String(body.text.content) : "";
    submitMessageWithImages(frame, content, null);
  }

  function handleImageMessage(frame) {
    var body = frame && frame.body ? frame.body : {};
    downloadImage(body).then(function (img) {
      var images = img ? [img] : null;
      var text = images ? "" : "[无法下载图片]";
      submitMessageWithImages(frame, text, images);
    });
  }

  function handleMixedMessage(frame) {
    var body = frame && frame.body ? frame.body : {};
    var items = (body.mixed && body.mixed.msg_item) || [];
    var textParts = [];
    var imagePromises = [];
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (item.msgtype === "text" && item.text && item.text.content) {
        textParts.push(item.text.content);
      } else if (item.msgtype === "image" && item.image) {
        imagePromises.push(downloadImage({ image: item.image }));
      }
    }
    var text = textParts.join("\n");
    if (imagePromises.length === 0) {
      submitMessageWithImages(frame, text, null);
      return;
    }
    Promise.all(imagePromises).then(function (results) {
      var images = [];
      for (var j = 0; j < results.length; j++) {
        if (results[j]) images.push(results[j]);
      }
      submitMessageWithImages(frame, text, images.length > 0 ? images : null);
    });
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
    wsClient.on("message.image", handleImageMessage);
    wsClient.on("message.mixed", handleMixedMessage);

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

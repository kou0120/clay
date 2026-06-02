#!/usr/bin/env node

var crypto = require("crypto");

var args = process.argv.slice(2);

function usage() {
  console.error("Usage: node scripts/clay-external-message.js [--dev] [--wait] [--json] [--timeout <ms>] [--session-key <key>] <project-slug> <message...>");
  console.error("");
  console.error("Examples:");
  console.error("  node scripts/clay-external-message.js clay \"/skill oe-std-status 生成今日状态同步\"");
  console.error("  node scripts/clay-external-message.js --wait clay \"/skill oe-std-status 生成今日状态同步\"");
  console.error("  node scripts/clay-external-message.js --wait --json clay \"使用 oe-gitlab-repo 技能检查 MR\"");
  console.error("  node scripts/clay-external-message.js --dev clay \"使用 oe-gitlab-repo 技能检查 MR\"");
}

var devMode = false;
var waitMode = false;
var jsonMode = false;
var timeoutMs = 600000;
var sessionKey = null;
var positional = [];

for (var i = 0; i < args.length; i++) {
  if (args[i] === "--dev") {
    devMode = true;
  } else if (args[i] === "--wait") {
    waitMode = true;
  } else if (args[i] === "--json") {
    jsonMode = true;
  } else if (args[i] === "--timeout") {
    timeoutMs = parseInt(args[i + 1], 10);
    if (!timeoutMs || timeoutMs < 1) {
      console.error("Invalid timeout");
      process.exit(1);
    }
    i++;
  } else if (args[i] === "--session-key") {
    sessionKey = args[i + 1] || null;
    i++;
  } else if (args[i] === "-h" || args[i] === "--help") {
    usage();
    process.exit(0);
  } else {
    positional.push(args[i]);
  }
}

if (devMode) {
  process.env.CLAY_DEV = "1";
}

var config = require("../lib/config");
var ipc = require("../lib/ipc");

if (positional.length < 2) {
  usage();
  process.exit(1);
}

var slug = positional[0];
var text = positional.slice(1).join(" ").trim();

if (!sessionKey) {
  sessionKey = "automation:" + slug + ":" + Date.now() + ":" + crypto.randomBytes(4).toString("hex");
}

ipc.sendIPCCommand(config.socketPath(), {
  cmd: "external_message",
  slug: slug,
  sessionKey: sessionKey,
  text: text,
  wait: waitMode,
  timeoutMs: timeoutMs,
}, { timeoutMs: waitMode ? timeoutMs + 5000 : 3000 }).then(function (res) {
  if (!res || !res.ok) {
    if (jsonMode) {
      console.log(JSON.stringify(res || { ok: false, error: "unknown error" }, null, 2));
      process.exit(1);
    }
    if (res && res.text) process.stdout.write(res.text);
    console.error("Failed:", res && res.error ? res.error : "unknown error");
    process.exit(1);
  }
  if (jsonMode) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }
  if (waitMode) {
    process.stdout.write(res.text || "");
    if (res.text && res.text.charAt(res.text.length - 1) !== "\n") process.stdout.write("\n");
    return;
  }
  console.log("Submitted external message");
  console.log("Project:", res.slug);
  console.log("Session key:", res.sessionKey);
  console.log("Session id:", res.sessionId);
}).catch(function (err) {
  console.error("Failed:", err && err.message ? err.message : err);
  process.exit(1);
});

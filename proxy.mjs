#!/usr/bin/env node
//
// mimo-claude-proxy — Minimal proxy that maps Claude model names → Xiaomi MiMo models.
//
// Features:
//   - Web UI for managing API keys, plan/region, and model mapping
//   - Config persistence at ~/.mimo-proxy/config.json
//   - Supports Token Plan (subscription) and Pay-per-use endpoints
//   - Three regions: CN, Singapore, Europe (AMS)
//   - Multi-key fallback on 401/403/429
//   - SSE streaming with model name rewriting
//
// Usage:
//   node proxy.mjs
//   MIMO_PROXY_PORT=3334 node proxy.mjs

import http from "node:http";
import https from "node:https";
import {
  existsSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_DIR = join(homedir(), ".mimo-proxy");
const CONFIG_FILE = join(APP_DIR, "config.json");
const LOG_FILE = join(APP_DIR, "proxy.log");
const MAX_BODY = 10 * 1024 * 1024; // 10MB
const MAX_API_KEYS = 10;
const PROXY_VERSION = "0.2.0";

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  console.log(line.trimEnd());
  setImmediate(() => {
    try {
      if (!existsSync(APP_DIR)) mkdirSync(APP_DIR, { recursive: true });
      appendFileSync(LOG_FILE, line);
    } catch {}
  });
}

function logError(msg) {
  const line = `[${new Date().toISOString()}] ERROR ${msg}\n`;
  console.error(line.trimEnd());
  setImmediate(() => {
    try {
      if (!existsSync(APP_DIR)) mkdirSync(APP_DIR, { recursive: true });
      appendFileSync(LOG_FILE, line);
    } catch {}
  });
}

process.on("uncaughtException", (err) => {
  logError(`Uncaught: ${err.stack || err.message}`);
});
process.on("unhandledRejection", (reason) => {
  logError(`Unhandled rejection: ${reason}`);
});

// ---------------------------------------------------------------------------
// Endpoint resolution
// ---------------------------------------------------------------------------
//
// Token Plan (subscription)  — API Key: tp-xxxxx
//   Anthropic: https://token-plan-{cn,sgp,ams}.xiaomimimo.com/anthropic
//
// Pay-per-use (按量付费)     — API Key: sk-xxxxx
//   OpenAI:    https://api.xiaomimimo.com/v1
//   (No Anthropic-compatible endpoint as of 2026-05)

const REGION_HOSTS = {
  cn:  "token-plan-cn.xiaomimimo.com",
  sgp: "token-plan-sgp.xiaomimimo.com",
  ams: "token-plan-ams.xiaomimimo.com",
};

const PLAN_ENDPOINTS = {
  "token-plan": (region) =>
    `https://${REGION_HOSTS[region] || REGION_HOSTS.cn}/anthropic`,
  "pay-per-use": () =>
    "https://api.xiaomimimo.com/v1",
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG = {
  apiKeys: [],
  plan: "token-plan",
  region: "cn",
  anthropicModelMap: {},
};

function readConfig() {
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
    return { ...DEFAULT_CONFIG, ...cfg };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function writeConfig(next) {
  if (!existsSync(APP_DIR)) mkdirSync(APP_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2));
}

function getApiKeys() {
  const keys = [];
  const fromArg = process.argv[2];
  if (fromArg) keys.push(fromArg);
  const fromEnv = process.env.MIMO_API_KEY;
  if (fromEnv) keys.push(fromEnv);
  const cfg = readConfig();
  if (Array.isArray(cfg.apiKeys)) keys.push(...cfg.apiKeys);
  return [...new Set(keys.filter(Boolean))];
}

function resolveBaseURL() {
  if (process.env.MIMO_API_URL) {
    return process.env.MIMO_API_URL.replace(/\/$/, "");
  }
  const cfg = readConfig();
  const plan = cfg.plan || "token-plan";
  const region = cfg.region || "cn";
  const builder = PLAN_ENDPOINTS[plan];
  if (!builder) return PLAN_ENDPOINTS["token-plan"](region);
  return builder(region);
}

// ---------------------------------------------------------------------------
// Model mapping
// ---------------------------------------------------------------------------

const DEFAULT_MODEL_MAP = {
  // Opus tier → MiMo flagship
  "claude-opus-4-8":          "mimo-v2.5-pro",
  "claude-opus-4-7":          "mimo-v2.5-pro",
  "claude-opus-4-6":          "mimo-v2.5-pro",
  "claude-opus-4-5-20251101": "mimo-v2.5-pro",

  // Sonnet tier → MiMo flagship
  "claude-sonnet-4-7":          "mimo-v2.5-pro",
  "claude-sonnet-4-6":          "mimo-v2.5-pro",
  "claude-sonnet-4-5-20250929": "mimo-v2-pro",

  // Haiku tier → MiMo flash
  "claude-haiku-4-5-20251001": "mimo-v2-flash",

  // Explicit MiMo aliases
  "claude-mimo-v25-pro":  "mimo-v2.5-pro",
  "claude-mimo-v25":      "mimo-v2.5",
  "claude-mimo-v2-pro":   "mimo-v2-pro",
  "claude-mimo-v2-omni":  "mimo-v2-omni",
  "claude-mimo-v2-flash": "mimo-v2-flash",
};

/** Merge defaults with user overrides from config */
function getModelMap() {
  const cfg = readConfig();
  const userMap = cfg.anthropicModelMap || {};
  return { ...DEFAULT_MODEL_MAP, ...userMap };
}

function resolveModel(name) {
  return getModelMap()[name] || name;
}

// Available MiMo models for UI dropdowns
const MIMO_MODELS = [
  "mimo-v2.5-pro",
  "mimo-v2.5",
  "mimo-v2-pro",
  "mimo-v2-omni",
  "mimo-v2-flash",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function reEscape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function modelRegex(mapped) {
  return new RegExp(
    `("model"\\s*:\\s*")${reEscape(mapped)}(")`,
    "g",
  );
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function readBodyLimited(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error("Request too large"));
        req.destroy();
        return;
      }
      data += c;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/** Strip /anthropic prefix — base URL already includes /anthropic */
function normalizePath(raw) {
  return raw.replace(/^\/anthropic/, "") || raw;
}

// ---------------------------------------------------------------------------
// Proxy core — with multi-key fallback
// ---------------------------------------------------------------------------

function proxyMessages(rawBody, reqHeaders, rawPath, res) {
  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch (e) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        type: "error",
        error: { type: "invalid_request_error", message: e.message },
      }),
    );
    return;
  }

  const origModel = parsed.model || "claude-sonnet-4-6";
  const mapped = resolveModel(origModel);
  parsed.model = mapped;

  const payload = JSON.stringify(parsed);
  const path = normalizePath(rawPath);
  const MIMO_BASE = resolveBaseURL();
  const target = MIMO_BASE + path;

  const isStream = parsed.stream !== false;

  // Collect API keys (order: env > arg > config)
  const keys = getApiKeys();
  if (keys.length === 0) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        type: "error",
        error: { type: "authentication_error", message: "No API key configured. Add one via the Web UI at http://localhost:" + PORT },
      }),
    );
    return;
  }

  function tryRequest(keyIndex) {
    if (keyIndex >= keys.length) {
      if (!res.headersSent) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            type: "error",
            error: { type: "authentication_error", message: "All API keys failed" },
          }),
        );
      }
      return;
    }

    const key = keys[keyIndex];
    const fwd = { ...reqHeaders };
    delete fwd.host;
    delete fwd["content-length"];
    fwd["content-length"] = Buffer.byteLength(payload);
    // MiMo uses api-key header or Authorization: Bearer
    fwd["authorization"] = `Bearer ${key}`;

    log(
      `[PROXY] ${origModel} → ${mapped}  |  key=${keyIndex + 1}/${keys.length}  |  stream=${isStream}  |  messages=${parsed.messages?.length || 0}`,
    );

    const upstream = https.request(
      target,
      { method: "POST", headers: fwd },
      (upRes) => {
        // Key fallback on auth/rate-limit errors
        if (upRes.statusCode === 401 || upRes.statusCode === 403 || upRes.statusCode === 429) {
          upRes.resume(); // drain
          log(`[FALLBACK] Key ${keyIndex + 1} failed (${upRes.statusCode}), trying next...`);
          tryRequest(keyIndex + 1);
          return;
        }

        if (upRes.statusCode >= 400) {
          res.writeHead(upRes.statusCode, upRes.headers);
          upRes.pipe(res);
          return;
        }

        if (!isStream) {
          let buf = "";
          upRes.on("data", (c) => (buf += c));
          upRes.on("end", () => {
            try {
              const r = JSON.parse(buf);
              if (r.model) r.model = origModel;
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify(r));
            } catch {
              res.writeHead(200, upRes.headers);
              res.end(buf);
            }
          });
          return;
        }

        // Streaming: replace model name in SSE
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        if (mapped === origModel) {
          upRes.pipe(res);
          return;
        }

        const re = modelRegex(mapped);
        let leftover = "";

        upRes.on("data", (chunk) => {
          leftover += chunk.toString();
          const lines = leftover.split("\n");
          leftover = lines.pop() || "";
          for (const line of lines) {
            res.write(line.replace(re, `$1${origModel}$2`) + "\n");
          }
        });

        upRes.on("end", () => {
          if (leftover) {
            res.write(leftover.replace(re, `$1${origModel}$2`));
          }
          res.end();
        });
      },
    );

    upstream.on("error", (e) => {
      logError(`Upstream error: ${e.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            type: "error",
            error: { type: "api_error", message: e.message },
          }),
        );
      }
    });

    upstream.write(payload);
    upstream.end();
  }

  tryRequest(0);
}

// ---------------------------------------------------------------------------
// Web UI
// ---------------------------------------------------------------------------

const UI_HTML = `<!DOCTYPE html>
<html lang="ja">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MiMo Claude Proxy</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0a0a;color:#e0e0e0;min-height:100vh;display:flex;align-items:center;justify-content:center}
.card{background:#161616;border:1px solid #2a2a2a;border-radius:12px;padding:32px;max-width:560px;width:100%}
h1{font-size:20px;font-weight:600;margin-bottom:4px}
.subtitle{color:#888;font-size:13px;margin-bottom:24px}
label{display:block;font-size:13px;color:#aaa;margin-bottom:6px}
.key-row{display:flex;gap:8px;align-items:center;margin-bottom:8px}
.key-row input{flex:1}
.key-num{font-size:12px;color:#666;min-width:20px;text-align:center}
input{width:100%;padding:10px 12px;background:#1e1e1e;border:1px solid #333;border-radius:8px;color:#fff;font-size:14px;font-family:monospace;outline:none}
select{width:100%;padding:10px 12px;background:#1e1e1e;border:1px solid #333;border-radius:8px;color:#fff;font-size:14px;font-family:monospace;outline:none;appearance:none;-webkit-appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23888' d='M6 8L1 3h10z'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 12px center;cursor:pointer}
select:focus{border-color:#ff6900}
input:focus{border-color:#ff6900}
button{padding:10px 14px;background:#ff6900;border:0;border-radius:8px;color:#fff;font-size:14px;font-weight:600;cursor:pointer;white-space:nowrap}
button:hover{background:#e05e00}
button:disabled{opacity:.6;cursor:not-allowed}
.btn-remove{background:#dc2626;padding:8px 12px;font-size:12px}
.btn-remove:hover{background:#b91c1c}
.btn-add{background:#1e1e1e;border:1px dashed #444;color:#aaa;width:100%;margin-top:4px}
.btn-add:hover{border-color:#ff6900;color:#fff}
.btn-save{margin-top:16px}
.section{margin-top:20px;padding-top:16px;border-top:1px solid #2a2a2a}
.section h2{font-size:14px;font-weight:600;margin-bottom:12px;color:#ccc}
.row{display:flex;align-items:center;gap:10px;margin-bottom:10px}
.row-label{min-width:80px;font-size:13px;color:#aaa;font-weight:500}
.row select,.row input{flex:1}
.info{margin-top:20px;padding:12px;background:#1e1e1e;border-radius:8px;font-size:13px;line-height:1.8}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
.dot.on{background:#22c55e}
code{background:#252525;padding:2px 6px;border-radius:4px;font-size:12px}
.status{margin-top:12px;font-size:13px;color:#9ca3af;min-height:1.2em}
</style></head>
<body>
<div class="card">
  <h1>MiMo Claude Proxy</h1>
  <div class="subtitle">Xiaomi MiMo proxy for Claude Desktop / Claude Code</div>

  <label>API Keys (fallback order)</label>
  <div id="keys"></div>
  <button class="btn-add" id="addKey">+ Add Key</button>
  <button class="btn-save" id="save">Save</button>

  <div class="section">
    <h2>Endpoint</h2>
    <div class="row">
      <span class="row-label">Plan</span>
      <select id="selPlan">
        <option value="token-plan">Token Plan (Subscription)</option>
        <option value="pay-per-use">Pay-per-use</option>
      </select>
    </div>
    <div class="row" id="regionRow">
      <span class="row-label">Region</span>
      <select id="selRegion">
        <option value="cn">China (CN)</option>
        <option value="sgp">Singapore (SGP)</option>
        <option value="ams">Europe (AMS)</option>
      </select>
    </div>
  </div>

  <div class="section">
    <h2>Claude → MiMo Model Mapping</h2>
    <div class="row">
      <span class="row-label">Opus</span>
      <select id="mapOpus"></select>
    </div>
    <div class="row">
      <span class="row-label">Sonnet</span>
      <select id="mapSonnet"></select>
    </div>
    <div class="row">
      <span class="row-label">Haiku</span>
      <select id="mapHaiku"></select>
    </div>
  </div>

  <div class="info" id="info">Loading...</div>
  <div class="status" id="status"></div>
</div>
<script>
const MAX_KEYS=10;
const MIMO_MODELS=${JSON.stringify(MIMO_MODELS)};
let keysData=[];

const keysDiv=document.getElementById('keys');
const saveButton=document.getElementById('save');
const statusEl=document.getElementById('status');
const selPlan=document.getElementById('selPlan');
const selRegion=document.getElementById('selRegion');
const regionRow=document.getElementById('regionRow');
const mapOpus=document.getElementById('mapOpus');
const mapSonnet=document.getElementById('mapSonnet');
const mapHaiku=document.getElementById('mapHaiku');

const CLAUDE_MAP={
  opus:'claude-opus-4-8',
  sonnet:'claude-sonnet-4-6',
  haiku:'claude-haiku-4-5-20251001'
};

function populateSelect(sel,models,selected){
  sel.innerHTML='';
  models.forEach(m=>{
    const opt=document.createElement('option');
    opt.value=m;opt.textContent=m;
    if(m===selected)opt.selected=true;
    sel.appendChild(opt);
  });
}

function renderKeys(){
  keysDiv.innerHTML='';
  keysData.forEach((k,i)=>{
    const row=document.createElement('div');
    row.className='key-row';
    const num=document.createElement('span');
    num.className='key-num';
    num.textContent=(i+1).toString();
    const inp=document.createElement('input');
    inp.type='text';
    inp.placeholder='tp-xxxxx or sk-xxxxx';
    inp.dataset.idx=i.toString();
    inp.value=k;
    const btn=document.createElement('button');
    btn.className='btn-remove';
    btn.dataset.idx=i.toString();
    btn.textContent='\\u2715';
    row.appendChild(num);
    row.appendChild(inp);
    row.appendChild(btn);
    keysDiv.appendChild(row);
  });
  document.getElementById('addKey').style.display=keysData.length>=MAX_KEYS?'none':'';
  keysDiv.querySelectorAll('input').forEach(inp=>{
    inp.addEventListener('input',()=>{keysData[parseInt(inp.dataset.idx)]=inp.value});
  });
  keysDiv.querySelectorAll('.btn-remove').forEach(btn=>{
    btn.addEventListener('click',()=>{
      keysData.splice(parseInt(btn.dataset.idx),1);
      renderKeys();
    });
  });
}

document.getElementById('addKey').addEventListener('click',()=>{
  if(keysData.length<MAX_KEYS){keysData.push('');renderKeys();}
});

// Show/hide region based on plan
selPlan.addEventListener('change',()=>{
  regionRow.style.display=selPlan.value==='pay-per-use'?'none':'';
});

fetch('/api/config').then(r=>r.json()).then(d=>{
  keysData=d.apiKeys&&d.apiKeys.length?[...d.apiKeys]:[''];
  renderKeys();
  selPlan.value=d.plan||'token-plan';
  selRegion.value=d.region||'cn';
  regionRow.style.display=selPlan.value==='pay-per-use'?'none':'';
  const mmap=d.anthropicModelMap||{};
  populateSelect(mapOpus,MIMO_MODELS,mmap[CLAUDE_MAP.opus]||MIMO_MODELS[0]);
  populateSelect(mapSonnet,MIMO_MODELS,mmap[CLAUDE_MAP.sonnet]||MIMO_MODELS[0]);
  populateSelect(mapHaiku,MIMO_MODELS,mmap[CLAUDE_MAP.haiku]||MIMO_MODELS[4]||MIMO_MODELS[0]);
  const baseUrl=d.upstream||'';
  document.getElementById('info').innerHTML=
    '<span class="dot on"></span>Running on port '+d.port+'<br>'+
    'Upstream: <code>'+baseUrl+'</code><br>'+
    'Claude Desktop: <code>http://localhost:'+d.port+'/anthropic/</code><br>'+
    'Claude Code: <code>ANTHROPIC_BASE_URL=http://localhost:'+d.port+'</code>';
}).catch(()=>{document.getElementById('info').innerHTML='Failed to load config'});

saveButton.addEventListener('click',async()=>{
  const apiKeys=keysData.filter(k=>k.trim());
  if(apiKeys.length===0){statusEl.textContent='At least one API key is required.';return;}
  saveButton.disabled=true;
  statusEl.textContent='Saving...';
  const anthropicModelMap={};
  anthropicModelMap[CLAUDE_MAP.opus]=mapOpus.value;
  anthropicModelMap[CLAUDE_MAP.sonnet]=mapSonnet.value;
  anthropicModelMap[CLAUDE_MAP.haiku]=mapHaiku.value;
  try{
    const response=await fetch('/api/config',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        apiKeys,
        plan:selPlan.value,
        region:selRegion.value,
        anthropicModelMap
      })
    });
    if(!response.ok){
      const payload=await response.json().catch(()=>({}));
      throw new Error(payload.error?.message||'Failed to save config');
    }
    statusEl.textContent='Saved. ('+apiKeys.length+' key'+(apiKeys.length>1?'s':'')+')';
    // Refresh info display
    setTimeout(()=>location.reload(),800);
  }catch(error){
    statusEl.textContent=error.message;
  }finally{
    saveButton.disabled=false;
  }
});
</script>
</body></html>`;

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const PORT = process.env.MIMO_PROXY_PORT || 3335;
const MESSAGE_PATHS = new Set(["/v1/messages", "/anthropic/v1/messages"]);
const MODEL_PATHS = new Set(["/v1/models", "/anthropic/v1/models"]);

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const urlPath = req.url.split("?")[0];

  // ---- Web UI ----
  if (req.method === "GET" && (urlPath === "/" || urlPath === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(UI_HTML);
    return;
  }

  // ---- Config API ----
  if (req.method === "GET" && urlPath === "/api/config") {
    const cfg = readConfig();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        apiKeys: [...new Set((cfg.apiKeys || []).filter(Boolean))],
        plan: cfg.plan || "token-plan",
        region: cfg.region || "cn",
        anthropicModelMap: { ...DEFAULT_MODEL_MAP, ...cfg.anthropicModelMap },
        port: PORT,
        upstream: resolveBaseURL(),
        availableModels: MIMO_MODELS,
      }),
    );
    return;
  }

  if (req.method === "POST" && urlPath === "/api/config") {
    let body;
    try {
      body = await readBodyLimited(req, MAX_BODY);
    } catch {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Request too large" } }));
      return;
    }
    try {
      const parsed = JSON.parse(body || "{}");
      const current = readConfig();
      const next = { ...current };

      if (Array.isArray(parsed.apiKeys)) {
        next.apiKeys = parsed.apiKeys
          .map((k) => (typeof k === "string" ? k.trim() : ""))
          .filter(Boolean)
          .slice(0, MAX_API_KEYS);
      }
      if (typeof parsed.plan === "string") {
        next.plan = parsed.plan;
      }
      if (typeof parsed.region === "string") {
        next.region = parsed.region;
      }
      if (parsed.anthropicModelMap && typeof parsed.anthropicModelMap === "object") {
        next.anthropicModelMap = parsed.anthropicModelMap;
      }

      writeConfig(next);
      log("[CONFIG] Updated");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ error: { message: error.message, type: "invalid_request" } }),
      );
    }
    return;
  }

  // ---- Health ----
  if (req.method === "GET" && urlPath === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", upstream: resolveBaseURL() }));
    return;
  }

  // ---- Models ----
  if (req.method === "GET" && MODEL_PATHS.has(urlPath)) {
    const modelMap = getModelMap();
    const data = Object.keys(modelMap).map((id) => ({
      id,
      display_name: id,
      created_at: new Date().toISOString(),
    }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({ object: "list", data, first_id: data[0]?.id, has_more: false }),
    );
    return;
  }

  // ---- Messages (proxy) ----
  if (req.method === "POST" && MESSAGE_PATHS.has(urlPath)) {
    const body = await readBody(req);
    proxyMessages(body, req.headers, urlPath, res);
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

server.listen(PORT, () => {
  const cfg = readConfig();
  const plan = cfg.plan || "token-plan";
  const region = cfg.region || "cn";
  const upstream = resolveBaseURL();

  console.log(`\n  Xiaomi MiMo Claude Proxy v${PROXY_VERSION}`);
  console.log(`  Listening: http://localhost:${PORT}`);
  console.log(`  Web UI:    http://localhost:${PORT}/`);
  console.log(`  Plan:      ${plan}  |  Region: ${region}`);
  console.log(`  Upstream:  ${upstream}`);
  console.log(`\n  Model mapping:`);
  const modelMap = getModelMap();
  for (const [k, v] of Object.entries(modelMap)) {
    console.log(`    ${k.padEnd(32)} → ${v}`);
  }
  console.log(`\n  Config:    ${CONFIG_FILE}`);
  console.log(`  Log:       ${LOG_FILE}`);
  console.log(`\n  Claude Desktop:`);
  console.log(`    inferenceGatewayBaseUrl: http://localhost:${PORT}/anthropic/`);
  console.log(`    inferenceGatewayApiKey:  <MiMo API key>`);
  console.log(`\n  Claude Code ~/.claude/settings.json:`);
  console.log(`    { "env": {`);
  console.log(`        "ANTHROPIC_BASE_URL": "http://localhost:${PORT}",`);
  console.log(`        "ANTHROPIC_AUTH_TOKEN": "<MiMo API key>"`);
  console.log(`    } }\n`);
});

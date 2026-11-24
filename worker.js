const SESSION_COOKIE = "__Host-shorturl_session";
const SESSION_SECONDS = 12 * 60 * 60;
const MAX_BODY_BYTES = 8 * 1024;
const MAX_URL_LENGTH = 2048;
const MAX_CODE_LENGTH = 32;
const CACHE_TTL_SECONDS = 86400;
const RESERVED_CODES = new Set([
  "admin", "api", "assets", "favicon.ico", "robots.txt", "sitemap.xml"
]);

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff"
};

export default {
  async fetch(request, env, ctx) {
    try {
      if (!env.LINKS) return json({ error: "KV binding LINKS is missing" }, 500);
      const url = new URL(request.url);
      const path = url.pathname;

      if (path === "/api/health" && request.method === "GET") {
        return json({ ok: true, version: "3.0.0" });
      }
      if (path === "/" && request.method === "GET") return html(PUBLIC_HTML);
      if (path === "/admin" && request.method === "GET") return html(ADMIN_HTML);
      if (path === "/api/create" && request.method === "POST") {
        return createLink(request, env);
      }
      if (path === "/admin/api/login" && request.method === "POST") {
        return login(request, env);
      }
      if (path === "/admin/api/logout" && request.method === "POST") {
        const auth = await requireAdmin(request, env);
        if (auth instanceof Response) return auth;
        const csrf = checkCsrf(request, url, auth.csrf);
        if (csrf) return csrf;
        return new Response(null, {
          status: 204,
          headers: { "set-cookie": clearSessionCookie(), "cache-control": "no-store" }
        });
      }
      if (path.startsWith("/admin/api/")) {
        const auth = await requireAdmin(request, env);
        if (auth instanceof Response) return auth;
        const csrf = ["POST", "DELETE", "PUT", "PATCH"].includes(request.method)
          ? checkCsrf(request, url, auth.csrf) : null;
        if (csrf) return csrf;

        if (path === "/admin/api/session" && request.method === "GET") {
          return json({ authenticated: true, csrf: auth.csrf, expiresAt: auth.exp });
        }
        if (path === "/admin/api/links" && request.method === "GET") {
          return listLinks(env);
        }
        if (path.startsWith("/admin/api/links/") && request.method === "DELETE") {
          const code = decodeURIComponent(path.slice("/admin/api/links/".length));
          return deleteLink(code, env, request, ctx);
        }
        return json({ error: "Not found" }, 404);
      }

      if (path.length > 1 && !path.slice(1).includes("/")) {
        const code = path.slice(1);
        if (!validCode(code)) return text("Not found", 404);
        return redirectShortLink(request, env, ctx, code);
      }
      return text("Not found", 404);
    } catch (error) {
      console.error("Unhandled Worker error:", error);
      return json({ error: "Internal Server Error" }, 500);
    }
  }
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders }
  });
}
function text(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
      ...headers
    }
  });
}
function html(body) {
  return new Response(body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
    }
  });
}
function validCode(code) {
  return typeof code === "string" &&
    code.length >= 3 &&
    code.length <= MAX_CODE_LENGTH &&
    /^[A-Za-z0-9_-]+$/.test(code) &&
    !RESERVED_CODES.has(code.toLowerCase()) &&
    !code.startsWith("SYS_");
}
function normalizeUrl(value) {
  if (typeof value !== "string" || value.length > MAX_URL_LENGTH) return null;
  try {
    const u = new URL(value.trim());
    if (!["http:", "https:"].includes(u.protocol)) return null;
    if (u.username || u.password) return null;
    return u.toString();
  } catch {
    return null;
  }
}
async function readJson(request) {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return { error: "Content-Type must be application/json" };
  }
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_BODY_BYTES) return { error: "Request body is too large" };
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    return { error: "Request body is too large" };
  }
  try {
    return JSON.parse(raw);
  } catch {
    return { error: "Invalid JSON" };
  }
}
async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}
function randomCode(length = 7) {
  const chars = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map(b => chars[b % chars.length]).join("");
}
async function createLink(request, env) {
  const body = await readJson(request);
  if (body.error) return json({ error: body.error }, 400);

  const target = normalizeUrl(body.url);
  if (!target) return json({ error: "Please provide a valid http or https URL (max 2048 characters)." }, 400);

  const expiresIn = Number(body.expiresIn ?? 0);
  if (![0, 86400, 2592000].includes(expiresIn)) {
    return json({ error: "Invalid expiration option." }, 400);
  }

  const hash = await sha256Hex(target);
  const indexKey = `index:${hash}`;
  const existingCode = await env.LINKS.get(indexKey);
  if (existingCode) {
    const existing = await env.LINKS.get(`link:${existingCode}`, "json");
    if (existing && (!existing.expiresAt || existing.expiresAt > Date.now())) {
      return json({ ok: true, code: existingCode, shortUrl: new URL(`/${existingCode}`, request.url).toString(), duplicate: true });
    }
    await env.LINKS.delete(indexKey);
  }

  const customCode = body.customCode == null ? "" : String(body.customCode).trim();
  let code;
  if (customCode) {
    if (!validCode(customCode)) return json({ error: "Custom code must be 3–32 characters: letters, numbers, - or _." }, 400);
    if (await env.LINKS.get(`link:${customCode}`)) {
      return json({ error: "This short code is already in use." }, 409);
    }
    code = customCode;
  } else {
    for (let i = 0; i < 8; i++) {
      const candidate = randomCode();
      if (!(await env.LINKS.get(`link:${candidate}`))) {
        code = candidate;
        break;
      }
    }
    if (!code) return json({ error: "Could not allocate a short code. Please retry." }, 503);
  }

  const now = Date.now();
  const expiresAt = expiresIn ? now + expiresIn * 1000 : 0;
  const record = { url: target, createdAt: now, expiresAt };
  const options = expiresIn ? { expirationTtl: expiresIn } : undefined;

  // KV has no atomic create-if-absent operation. The pre-check prevents normal collisions,
  // but simultaneous writes to the same custom code can still race.
  if (await env.LINKS.get(`link:${code}`)) {
    return json({ error: "This short code is already in use. Choose another." }, 409);
  }
  await env.LINKS.put(`link:${code}`, JSON.stringify(record), options);
  await env.LINKS.put(indexKey, code, options);

  return json({
    ok: true,
    code,
    shortUrl: new URL(`/${code}`, request.url).toString(),
    duplicate: false,
    expiresAt
  }, 201);
}

async function redirectShortLink(request, env, ctx, code) {
  const cache = caches.default;
  const cacheKey = new Request(new URL(`/${code}`, request.url).toString(), { method: "GET" });
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const key = `link:${code}`;
  const record = await env.LINKS.get(key, "json");
  if (!record || typeof record.url !== "string") return text("Short link not found", 404);

  if (record.expiresAt && record.expiresAt <= Date.now()) {
    ctx.waitUntil(cleanExpiredRecord(env, code, record));
    return text("This short link has expired", 410);
  }

  const target = normalizeUrl(record.url);
  if (!target) return text("Invalid link record", 500);

  const remaining = record.expiresAt
    ? Math.max(1, Math.floor((record.expiresAt - Date.now()) / 1000))
    : CACHE_TTL_SECONDS;
  const ttl = Math.max(1, Math.min(CACHE_TTL_SECONDS, remaining));
  const response = new Response(null, {
    status: 302,
    headers: {
      location: target,
      "cache-control": `public, max-age=${ttl}`,
      "x-content-type-options": "nosniff"
    }
  });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}
async function cleanExpiredRecord(env, code, record) {
  await env.LINKS.delete(`link:${code}`);
  const hash = await sha256Hex(record.url);
  const indexKey = `index:${hash}`;
  if (await env.LINKS.get(indexKey) === code) await env.LINKS.delete(indexKey);
}
async function deleteLink(code, env, request, ctx) {
  if (!validCode(code)) return json({ error: "Invalid short code" }, 400);
  const key = `link:${code}`;
  const record = await env.LINKS.get(key, "json");
  if (!record) return json({ error: "Link not found" }, 404);

  await env.LINKS.delete(key);
  const hash = await sha256Hex(record.url);
  const indexKey = `index:${hash}`;
  if (await env.LINKS.get(indexKey) === code) await env.LINKS.delete(indexKey);

  // This removes the cache entry in the current Cloudflare data center.
  // Other data centers may retain their cache entry until its TTL expires.
  const cacheKey = new Request(new URL(`/${code}`, request.url).toString(), { method: "GET" });
  ctx.waitUntil(caches.default.delete(cacheKey));
  return json({ ok: true, deleted: code });
}
async function listLinks(env) {
  const output = [];
  let cursor;
  do {
    const page = await env.LINKS.list({ prefix: "link:", limit: 1000, cursor });
    for (const item of page.keys) {
      const code = item.name.slice(5);
      const record = await env.LINKS.get(item.name, "json");
      if (record && typeof record.url === "string") {
        output.push({
          code,
          url: record.url,
          createdAt: Number(record.createdAt || 0),
          expiresAt: Number(record.expiresAt || 0),
          expired: Boolean(record.expiresAt && record.expiresAt <= Date.now())
        });
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor && output.length < 5000);

  output.sort((a, b) => b.createdAt - a.createdAt);
  return json({ links: output, truncated: output.length >= 5000 });
}

async function login(request, env) {
  const loginOrigin = request.headers.get("origin");
  if (!loginOrigin || loginOrigin !== new URL(request.url).origin) return json({ error: "Invalid request origin." }, 403);
  if (!env.ADMIN_PASS) return json({ error: "ADMIN_PASS Worker Secret is not configured." }, 500);
  const body = await readJson(request);
  if (body.error) return json({ error: body.error }, 400);
  if (typeof body.password !== "string" || body.password.length > 1024) {
    return json({ error: "Invalid credentials." }, 401);
  }
  const supplied = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body.password));
  const expected = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.ADMIN_PASS));
  if (!constantTimeEqual(new Uint8Array(supplied), new Uint8Array(expected))) {
    return json({ error: "Invalid credentials." }, 401);
  }

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iat: now,
    exp: now + SESSION_SECONDS,
    csrf: base64url(crypto.getRandomValues(new Uint8Array(24)))
  };
  const token = await signSession(payload, env.ADMIN_PASS);
  return json({ ok: true, expiresAt: payload.exp }, 200, {
    "set-cookie": `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_SECONDS}`
  });
}
async function requireAdmin(request, env) {
  if (!env.ADMIN_PASS) return json({ error: "ADMIN_PASS Worker Secret is not configured." }, 500);
  const cookie = request.headers.get("cookie") || "";
  const match = cookie.split(";").map(v => v.trim()).find(v => v.startsWith(`${SESSION_COOKIE}=`));
  if (!match) return json({ error: "Unauthorized" }, 401);
  const token = match.slice(SESSION_COOKIE.length + 1);
  const payload = await verifySession(token, env.ADMIN_PASS);
  if (!payload || payload.exp <= Math.floor(Date.now() / 1000)) {
    return json({ error: "Session expired. Please sign in again." }, 401, { "set-cookie": clearSessionCookie() });
  }
  return payload;
}
function checkCsrf(request, url, expectedToken) {
  const origin = request.headers.get("origin");
  if (!origin || origin !== url.origin) return json({ error: "Invalid request origin." }, 403);
  const suppliedToken = request.headers.get("x-csrf-token");
  if (!expectedToken || !suppliedToken || suppliedToken !== expectedToken) return json({ error: "Invalid CSRF token." }, 403);
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && !["same-origin", "none"].includes(fetchSite)) {
    return json({ error: "Cross-site request blocked." }, 403);
  }
  return null;
}
async function signSession(payload, secret) {
  const data = base64url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return `${data}.${base64url(new Uint8Array(sig))}`;
}
async function verifySession(token, secret) {
  try {
    const [data, signature] = token.split(".");
    if (!data || !signature || token.length > 2048) return null;
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]
    );
    const sig = unbase64url(signature);
    const valid = await crypto.subtle.verify("HMAC", key, sig, new TextEncoder().encode(data));
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(unbase64url(data)));
    if (!payload || typeof payload.exp !== "number" || typeof payload.csrf !== "string") return null;
    return payload;
  } catch {
    return null;
  }
}
function base64url(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function unbase64url(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}
function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

const PUBLIC_HTML = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#101a33">
<title>Short URL · 智能短链接</title>
<style>
:root{color-scheme:light;--ink:#17233b;--muted:#71809a;--line:#e6ebf3;--blue:#4268ed;--blue2:#6b85ff;--bg:#f5f7fc}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:var(--ink);background:radial-gradient(ellipse at 12% 8%,#e6edff 0,transparent 34%),radial-gradient(ellipse at 92% 85%,#e8eaff 0,transparent 30%),var(--bg);display:flex;flex-direction:column}
header{width:min(1080px,calc(100% - 40px));margin:0 auto;padding:28px 0;display:flex;align-items:center;justify-content:space-between}
.brand{display:flex;align-items:center;gap:11px;font-weight:800;letter-spacing:.2px}.logo{width:38px;height:38px;border-radius:12px;background:linear-gradient(135deg,#4268ed,#7892ff);display:grid;place-items:center;color:#fff;box-shadow:0 7px 18px #4268ed40}.logo svg{width:21px;height:21px}
.tag{font-size:12px;color:#52658b;background:#e9efff;border:1px solid #dce5ff;border-radius:99px;padding:7px 11px}
main{width:min(1080px,calc(100% - 40px));margin:auto;flex:1;display:grid;grid-template-columns:1fr 1fr;align-items:center;gap:54px;padding:30px 0 70px}
.intro{padding:10px 0}.eyebrow{display:inline-flex;align-items:center;gap:8px;color:#4268ed;font-size:13px;font-weight:750;letter-spacing:1.1px;text-transform:uppercase}.dot{width:7px;height:7px;border-radius:50%;background:#4dca91;box-shadow:0 0 0 4px #4dca9120}
h1{font-size:clamp(38px,5vw,58px);line-height:1.13;letter-spacing:-1.8px;margin:20px 0 18px;color:#15213b}h1 span{color:#4268ed}.lead{font-size:16px;line-height:1.85;color:#687791;max-width:450px;margin:0}
.points{display:flex;gap:22px;flex-wrap:wrap;margin-top:34px}.point{display:flex;align-items:center;gap:8px;font-size:13px;color:#52617a}.point svg{width:17px;height:17px;color:#4268ed}
.panel{background:#fff;border:1px solid #e7ebf3;border-radius:22px;padding:30px;box-shadow:0 24px 70px #263d7012,0 3px 10px #263d7008}
.panel-head{margin-bottom:22px}.panel-head h2{font-size:20px;margin:0 0 7px}.panel-head p{font-size:13px;color:var(--muted);margin:0}
label{display:block;font-size:13px;font-weight:700;color:#35445e;margin:18px 0 8px}
.field{position:relative}.field input,.field select{width:100%;height:48px;border:1px solid #dfe5ef;border-radius:11px;background:#fbfcff;padding:0 14px;font:inherit;font-size:14px;color:#263650;outline:none;transition:border .18s,box-shadow .18s}.field input:focus,.field select:focus{border-color:#7892ff;box-shadow:0 0 0 4px #4268ed16;background:#fff}.field input::placeholder{color:#a3aec0}
.hint{font-size:11px;color:#98a3b5;margin:7px 2px 0}
.submit{width:100%;height:50px;margin-top:23px;border:0;border-radius:11px;background:linear-gradient(100deg,#4268ed,#647fff);color:white;font-size:15px;font-weight:750;cursor:pointer;box-shadow:0 9px 20px #4268ed30;transition:transform .15s,box-shadow .15s}.submit:hover{transform:translateY(-1px);box-shadow:0 12px 24px #4268ed3b}.submit:disabled{opacity:.65;cursor:wait;transform:none}
.error{font-size:13px;color:#bd3434;margin-top:12px;min-height:18px}
.result{display:none;margin-top:18px;border:1px solid #dce6ff;background:#f4f7ff;border-radius:13px;padding:15px}.result-title{font-size:13px;font-weight:750;color:#284aaf;display:flex;align-items:center;gap:7px}.result-link{display:block;margin:10px 0 13px;color:#315bd2;font-size:14px;overflow-wrap:anywhere;text-decoration:none}.result-actions{display:flex;gap:9px}.result-actions button{flex:1;height:39px;border-radius:9px;border:1px solid #d7e1fb;background:#fff;color:#3156b5;font-weight:700;cursor:pointer}.result-actions button.primary{background:#4268ed;color:#fff;border-color:#4268ed}
footer{padding:20px;text-align:center;color:#9aa5b7;font-size:12px}
@media(max-width:800px){main{grid-template-columns:1fr;gap:28px;max-width:560px;padding:28px 0 48px}.intro{text-align:center}.lead{margin:auto}.points{justify-content:center;margin-top:22px}h1{font-size:42px}.panel{padding:24px}}
@media(max-width:420px){header,main{width:calc(100% - 28px)}header{padding:18px 0}.tag{font-size:11px}.panel{padding:20px;border-radius:18px}h1{font-size:36px}.points{gap:13px}}
</style>
</head>
<body>
<header>
  <div class="brand"><span class="logo"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.07 0l3-3A5 5 0 0 0 13 2.93l-1.72 1.72"/><path d="M14 11a5 5 0 0 0-7.07 0l-3 3A5 5 0 0 0 11 21.07l1.72-1.72"/></svg></span>SHORT URL</div>
  <span class="tag">轻量 · 快速 · 简洁</span>
</header>
<main>
  <section class="intro">
    <div class="eyebrow"><span class="dot"></span> SIMPLE LINK. SMART SHARING.</div>
    <h1>让每一个链接<br><span>短一点，简单一点。</span></h1>
    <p class="lead">把冗长的网址转换成简洁短链接。支持自定义短码和有效期设置，生成后即可复制分享。</p>
    <div class="points">
      <div class="point"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m5 12 4 4L19 6"/></svg>一键生成</div>
      <div class="point"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m5 12 4 4L19 6"/></svg>自定义短码</div>
      <div class="point"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m5 12 4 4L19 6"/></svg>灵活设置有效期</div>
    </div>
  </section>
  <section class="panel">
    <div class="panel-head"><h2>创建短链接</h2><p>输入目标网址，几秒钟即可完成转换。</p></div>
    <form id="form">
      <label for="url">目标网址</label>
      <div class="field"><input id="url" type="url" placeholder="https://example.com/article" required maxlength="2048" autocomplete="url"></div>
      <label for="custom">自定义短码 <span style="font-weight:400;color:#98a3b5">· 可选</span></label>
      <div class="field"><input id="custom" placeholder="例如：my-link" maxlength="32" pattern="[A-Za-z0-9_-]{3,32}" autocomplete="off"></div>
      <p class="hint">3–32 位，仅支持英文字母、数字、连字符和下划线。</p>
      <label for="expiry">链接有效期</label>
      <div class="field"><select id="expiry"><option value="0">永久有效</option><option value="86400">1 天</option><option value="2592000">30 天</option></select></div>
      <button class="submit" id="submit" type="submit">生成短链接&nbsp; →</button>
    </form>
    <div id="error" class="error" role="alert" aria-live="polite"></div>
    <div id="result" class="result" aria-live="polite">
      <div class="result-title">✓ 短链接创建成功</div>
      <a id="short" class="result-link" target="_blank" rel="noopener"></a>
      <div class="result-actions"><button class="primary" type="button" id="copy">复制链接</button><button type="button" id="again">继续创建</button></div>
    </div>
  </section>
</main>
<footer>SHORT URL · 简单可靠的链接分享工具</footer>
<script>
const form=document.querySelector("#form");
const btn=document.querySelector("#submit");
const err=document.querySelector("#error");
const result=document.querySelector("#result");
const short=document.querySelector("#short");
const copy=document.querySelector("#copy");
form.addEventListener("submit",async function(e){
  e.preventDefault();err.textContent="";result.style.display="none";btn.disabled=true;btn.textContent="正在生成…";
  try{
    const response=await fetch("/api/create",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({url:document.querySelector("#url").value.trim(),customCode:document.querySelector("#custom").value.trim(),expiresIn:Number(document.querySelector("#expiry").value)})});
    const data=await response.json();
    if(!response.ok)throw new Error(data.error||"创建失败，请稍后重试。");
    short.href=data.shortUrl;short.textContent=data.shortUrl;
    result.style.display="block";copy.textContent="复制链接";
  }catch(error){err.textContent=error.message||"创建失败，请稍后重试。";}
  finally{btn.disabled=false;btn.textContent="生成短链接　→";}
});
copy.addEventListener("click",async function(){
  try{await navigator.clipboard.writeText(short.href);copy.textContent="已复制 ✓";}
  catch(error){err.textContent="复制失败，请点击短链接后手动复制。";}
});
document.querySelector("#again").addEventListener("click",function(){
  result.style.display="none";document.querySelector("#url").focus();
});
</script>
</body>
</html>`;
const ADMIN_HTML = String.raw`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>短链接管理</title><style>
:root{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#172033;background:#f4f6fa}*{box-sizing:border-box}
body{margin:0;padding:24px}main{max-width:1180px;margin:auto}.head{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
h1{font-size:24px;margin:0}.muted{color:#64748b;font-size:13px}.card{background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:18px;margin-top:18px}
input,button{font:inherit;border-radius:9px;padding:10px 12px;border:1px solid #d6deeb}input{min-width:0}button{cursor:pointer;background:#245fe8;color:#fff;border:0;font-weight:600}button.secondary{background:#edf2fb;color:#24334d}button.danger{background:#c93636}
.login{max-width:390px;margin:12vh auto}.login input{width:100%;margin:12px 0}.hidden{display:none!important}
.toolbar{display:flex;gap:10px;flex-wrap:wrap}.toolbar input{flex:1;min-width:200px}.table-wrap{overflow:auto;margin-top:14px}
table{border-collapse:collapse;width:100%;min-width:720px;font-size:14px}th,td{text-align:left;padding:12px 10px;border-bottom:1px solid #edf0f5;vertical-align:top}
th{color:#64748b;font-weight:600}.url{max-width:340px;overflow-wrap:anywhere}.code{font-weight:700;white-space:nowrap}
.actions{display:flex;gap:6px}.actions button{padding:7px 9px;font-size:12px}.status{font-size:12px;padding:4px 8px;border-radius:20px;background:#e9f7ef;color:#14713c}.expired{background:#fff0f0;color:#b42318}
#error{color:#b42318;margin-top:10px}.meta{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:12px}
@media(max-width:600px){body{padding:14px}.card{padding:14px}.head h1{font-size:21px}}
</style></head><body><main>
<section id="login" class="card login"><h1>管理后台登录</h1><p class="muted">使用 Worker Secret 中配置的管理员密码。</p>
<form id="loginForm"><input id="password" type="password" autocomplete="current-password" placeholder="管理员密码" required><button style="width:100%">登录</button></form><div id="loginError" role="alert"></div></section>
<section id="app" class="hidden"><div class="head"><div><h1>短链接管理</h1><p class="muted">Cloudflare Worker Short URL v3.0</p></div><button id="logout" class="secondary">退出登录</button></div>
<div class="card"><div class="toolbar"><input id="search" placeholder="搜索短码或目标 URL"><select id="filter"><option value="all">全部状态</option><option value="active">有效</option><option value="expired">已过期</option></select><select id="sort"><option value="new">最新创建</option><option value="old">最早创建</option><option value="code">短码排序</option></select><button id="refresh" class="secondary">刷新</button></div>
<div id="error" role="alert"></div><div class="table-wrap"><table><thead><tr><th>短码</th><th>目标 URL</th><th>创建时间</th><th>有效期</th><th>状态</th><th>操作</th></tr></thead><tbody id="rows"></tbody></table></div>
<div class="meta"><span id="count" class="muted"></span><span><button id="prev" class="secondary">上一页</button> <button id="next" class="secondary">下一页</button></span></div></div></section></main>
<script>
let csrf="",links=[],page=0;const pageSize=20;
const $=s=>document.querySelector(s);
function showLogin(){ $("#login").classList.remove("hidden");$("#app").classList.add("hidden"); }
function showApp(){ $("#login").classList.add("hidden");$("#app").classList.remove("hidden"); }
async function api(path,options={}){const headers={...(options.headers||{})};if(options.body)headers["Content-Type"]="application/json";if(csrf&&options.method&&options.method!=="GET")headers["X-CSRF-Token"]=csrf;
const r=await fetch(path,{...options,headers,credentials:"same-origin"});let d={};try{d=await r.json()}catch{}if(!r.ok)throw new Error(d.error||("HTTP "+r.status));return d;}
async function checkSession(){try{const d=await api("/admin/api/session");csrf=d.csrf;showApp();await loadLinks();}catch{showLogin();}}
$("#loginForm").addEventListener("submit",async e=>{e.preventDefault();$("#loginError").textContent="";try{await api("/admin/api/login",{method:"POST",body:JSON.stringify({password:$("#password").value})});$("#password").value="";await checkSession();}catch(e){$("#loginError").textContent=e.message;}});
$("#logout").addEventListener("click",async()=>{try{await api("/admin/api/logout",{method:"POST",body:"{}"});}catch{}csrf="";showLogin();});
async function loadLinks(){try{const d=await api("/admin/api/links");links=d.links||[];page=0;render();$("#error").textContent=d.truncated?"仅显示前 5000 条记录。":"";}catch(e){$("#error").textContent=e.message;if(e.message==="Unauthorized")showLogin();}}
function render(){const q=$("#search").value.trim().toLowerCase(),f=$("#filter").value,s=$("#sort").value;let arr=links.filter(x=>(!q||x.code.toLowerCase().includes(q)||x.url.toLowerCase().includes(q))&&(f==="all"||(f==="expired"?x.expired:!x.expired)));
arr.sort(s==="old"?(a,b)=>a.createdAt-b.createdAt:s==="code"?(a,b)=>a.code.localeCompare(b.code):(a,b)=>b.createdAt-a.createdAt);
const pages=Math.max(1,Math.ceil(arr.length/pageSize));page=Math.min(page,pages-1);const shown=arr.slice(page*pageSize,(page+1)*pageSize);const tbody=$("#rows");tbody.replaceChildren();
for(const item of shown){const tr=document.createElement("tr");const values=[item.code,item.url,item.createdAt?new Date(item.createdAt).toLocaleString():"未知",item.expiresAt?new Date(item.expiresAt).toLocaleString():"永久"];
values.forEach((v,i)=>{const td=document.createElement("td");td.textContent=v;if(i===0)td.className="code";if(i===1)td.className="url";tr.append(td);});
const status=document.createElement("td"),badge=document.createElement("span");badge.className=item.expired?"status expired":"status";badge.textContent=item.expired?"已过期":"有效";status.append(badge);tr.append(status);
const actions=document.createElement("td"),wrap=document.createElement("div");wrap.className="actions";
const open=document.createElement("button");open.textContent="打开";open.className="secondary";open.addEventListener("click",()=>window.open("/"+encodeURIComponent(item.code),"_blank","noopener"));
const copy=document.createElement("button");copy.textContent="复制";copy.className="secondary";copy.addEventListener("click",async()=>{await navigator.clipboard.writeText(location.origin+"/"+item.code);copy.textContent="已复制";});
const del=document.createElement("button");del.textContent="删除";del.className="danger";del.addEventListener("click",async()=>{if(!confirm("确定删除 /"+item.code+"？"))return;try{await api("/admin/api/links/"+encodeURIComponent(item.code),{method:"DELETE"});await loadLinks();}catch(e){$("#error").textContent=e.message;}});
wrap.append(open,copy,del);actions.append(wrap);tr.append(actions);tbody.append(tr);}
$("#count").textContent=arr.length+" 条 · 第 "+(page+1)+"/"+pages+" 页";$("#prev").disabled=page===0;$("#next").disabled=page>=pages-1;}
["search","filter","sort"].forEach(id=>$("#"+id).addEventListener(id==="search"?"input":"change",()=>{page=0;render();}));
$("#refresh").addEventListener("click",loadLinks);$("#prev").addEventListener("click",()=>{page=Math.max(0,page-1);render();});$("#next").addEventListener("click",()=>{page++;render();});
checkSession();
</script></body></html>`;

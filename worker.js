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
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>短链接</title><style>
:root{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#172033;background:#f4f6fa}*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:22px}.panel{width:min(100%,560px);background:white;border:1px solid #e4e8f0;border-radius:18px;padding:28px;box-shadow:0 12px 40px #1b2b4810}
h1{margin:0 0 8px;font-size:25px}.muted{color:#64748b;font-size:14px}label{display:block;font-size:14px;font-weight:600;margin:18px 0 7px}
input,select,button{font:inherit;width:100%;border-radius:10px;padding:12px;border:1px solid #d8deea}input:focus,select:focus{outline:2px solid #9bbcff;border-color:#5b8def}
button{border:0;background:#245fe8;color:#fff;font-weight:650;margin-top:18px;cursor:pointer}button:disabled{opacity:.6;cursor:wait}
.result{margin-top:18px;padding:14px;border-radius:10px;background:#f0f5ff;overflow-wrap:anywhere;display:none}.result a{color:#164fc7}.error{color:#b42318;margin-top:12px;font-size:14px}
.top{display:flex;justify-content:space-between;align-items:center}.top a{font-size:13px;color:#52627b;text-decoration:none}
</style></head><body><main class="panel"><div class="top"><h1>短链接</h1><a href="/admin">管理后台</a></div>
<p class="muted">快速创建简洁、可管理的短链接。</p>
<form id="form"><label for="url">目标网址</label><input id="url" type="url" placeholder="https://example.com/article" required maxlength="2048">
<label for="custom">自定义短码（可选）</label><input id="custom" placeholder="例如：my-link" maxlength="32" pattern="[A-Za-z0-9_-]{3,32}">
<label for="expiry">有效期</label><select id="expiry"><option value="0">永久有效</option><option value="86400">1 天</option><option value="2592000">30 天</option></select>
<button id="submit" type="submit">生成短链接</button></form><div id="error" class="error" role="alert"></div>
<div id="result" class="result"><strong>短链接已创建</strong><p><a id="short" target="_blank" rel="noopener"></a></p><button type="button" id="copy">复制链接</button></div></main>
<script>
const form=document.querySelector("#form"),btn=document.querySelector("#submit"),err=document.querySelector("#error"),result=document.querySelector("#result"),short=document.querySelector("#short");
form.addEventListener("submit",async e=>{e.preventDefault();err.textContent="";result.style.display="none";btn.disabled=true;
try{const r=await fetch("/api/create",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({url:document.querySelector("#url").value,customCode:document.querySelector("#custom").value,expiresIn:Number(document.querySelector("#expiry").value)})});const d=await r.json();if(!r.ok)throw new Error(d.error||"创建失败");short.href=d.shortUrl;short.textContent=d.shortUrl;result.style.display="block";}catch(e){err.textContent=e.message;}finally{btn.disabled=false;}});
document.querySelector("#copy").addEventListener("click",async()=>{try{await navigator.clipboard.writeText(short.href);document.querySelector("#copy").textContent="已复制";}catch{err.textContent="复制失败，请手动复制链接";}});
</script></body></html>`;

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

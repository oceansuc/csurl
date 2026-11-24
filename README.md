# Cloudflare Worker Short URL v3.1

一个基于 **Cloudflare Workers + Workers KV** 的轻量级短链接服务。提供公开短链接生成页面、短码跳转、有效期控制和独立的管理后台。项目采用单文件 Worker 实现，适合部署在 Cloudflare，无需自建服务器或维护独立数据库。

> **当前版本：** `3.1.0`  
> **部署方式：** Cloudflare Dashboard 在线编辑器  
> **运行依赖：** Cloudflare Workers、Workers KV  
> **数据兼容：** 延续 v3.0 的 KV 键结构和记录格式，不需要迁移已有数据。

---

## 简介

本项目用于将较长的 HTTP/HTTPS 地址转换为简短、便于分享的链接。用户可以直接通过首页创建短链接，也可以指定自定义短码，并选择链接有效期。

创建成功后，访问短链接会由 Worker 从 KV 中读取目标地址，并返回 HTTP 302 重定向。管理员可以通过独立的 `/admin` 页面登录，查看、搜索、筛选、排序和删除已创建的短链接。

项目面向个人或小规模使用场景，设计目标是：

- **部署简单：** 直接在 Cloudflare Dashboard 中粘贴 Worker 源码并部署，不依赖命令行构建工具。
- **维护简单：** 前端页面、API 和服务端逻辑集中在一个 `worker.js` 文件中。
- **数据延续：** 使用既有 `LINKS` KV Namespace，v3.0 数据结构保持不变。
- **后台独立：** 管理入口为 `/admin`，不在公开首页展示后台入口。
- **基础安全：** 管理会话使用 HMAC-SHA256 签名，配合 HttpOnly Cookie、CSRF Token 和 Origin 校验。
- **缓存可控：** 短链接跳转响应设置 `no-store`，降低删除或变更后仍被边缘缓存旧跳转结果的风险。

本项目不是带有用户体系、团队权限、访问统计、分析报表或复杂链接规则的商业化短链平台。相关能力不包含在当前版本中。

---

## 功能特性

### 1. 公开短链接创建

- 提供中文响应式首页，支持桌面和移动设备访问。
- 输入目标网址即可生成短链接。
- 仅接受 `http://` 和 `https://` 协议。
- 目标 URL 最长为 2048 个字符。
- 不接受 URL 中包含用户名或密码的地址。
- 自动生成 7 位短码。
- 支持用户自定义短码。
- 自定义短码长度为 3–32 位，仅允许英文字母、数字、连字符 `-` 和下划线 `_`。
- 自定义短码区分大小写；系统保留路径和 `SYS_` 前缀（不区分大小写）。
- 创建成功后可复制短链接。

### 2. 链接有效期

创建时可以选择以下有效期：

| 选项 | `expiresIn` | 说明 |
|---|---:|---|
| 永久有效 | `0` | 不设置过期时间 |
| 1 天 | `86400` | 24 小时后过期 |
| 30 天 | `2592000` | 30 天后过期 |

到期后访问短链接会返回 HTTP `410 Gone`。系统会尝试清理对应记录及去重索引，但清理操作受 Workers KV 的最终一致性特性影响。

### 3. 自动去重

- 自动生成短码时，会根据规范化后的目标 URL 计算 SHA-256。
- 如果去重索引指向一个仍然有效的相同目标链接，则返回已有短码，不重复创建记录。
- 用户主动填写自定义短码时，不执行 URL 去重，按用户指定的短码创建。
- 去重索引使用 `index:{sha256}` 键保存。

### 4. 短链接跳转

- 通过 `/{code}` 访问短链接。
- 使用 HTTP `302 Found` 跳转到目标 URL。
- 支持 `GET` 和 `HEAD` 请求；其他请求方法返回 `405`。
- 未找到短码时返回 `404`。
- 已过期短码返回 `410`。
- 跳转响应设置 `Cache-Control: no-store`、`CDN-Cache-Control: no-store` 和 `Cloudflare-CDN-Cache-Control: no-store`。
- 不使用 Workers Cache API 缓存跳转结果。

### 5. 管理后台

访问 `https://你的域名/admin` 进入管理页面。后台入口不会显示在公开首页，需要管理员手动访问。

后台功能包括：

- 使用 `ADMIN_PASS` Secret 中配置的密码登录。
- 查看短码、目标 URL、创建时间、有效期和状态。
- 按短码或目标 URL 搜索。
- 按全部、有效、已过期状态筛选。
- 按最新创建、最早创建或短码排序。
- 每页显示 20 条记录，支持翻页。
- 复制短链接、打开短链接和删除短链接。
- 会话过期或返回 HTTP 401 时，前端清除当前 CSRF Token 并返回登录界面。

后台列表最多读取并返回 5000 条记录；达到上限时会提示列表可能已截断。

### 6. 健康检查

`GET /api/health` 返回服务状态和版本号，可用于简单的可用性检查。

### 7. v3.1 维护修复

相较于 v3.0，本版本只进行小范围维护，不更换页面、不调整 KV 数据结构、不改变 Dashboard 部署方式：

1. **删除主记录更稳健：** 即使读取时因缓存或 KV 最终一致性而暂时读不到记录，也会继续对 `link:{code}` 发起删除操作；记录不可见时还会扫描并清理可能遗留的去重索引。
2. **KV 写入异常处理：** 创建短链接时捕获 KV 写入错误，尝试清理部分写入的主记录和索引，并向客户端返回 HTTP `503`，而不是让异常直接变成未处理错误。
3. **会话过期处理：** 管理后台识别 HTTP `401`，清除内存中的 CSRF Token 并显示登录界面。
4. **保留前缀检查：** `SYS_` 前缀检查改为不区分大小写。
5. **新窗口安全：** 后台打开短链接时显式设置新窗口的 `opener` 为空。
6. **跳转缓存控制：** 跳转响应添加三种 `no-store` 缓存控制头，并继续避免使用 Workers Cache API。

---

## 技术架构

### 1. 组件结构

```text
访问者浏览器
    │
    ├── GET /                 公开短链接页面
    ├── POST /api/create      创建短链接 API
    ├── GET /{code}           短链接跳转
    │
    └── /admin                管理后台页面
          │
          ├── POST /admin/api/login
          ├── POST /admin/api/logout
          ├── GET  /admin/api/session
          ├── GET  /admin/api/links
          └── DELETE /admin/api/links/{code}
                    │
                    ▼
             Cloudflare Worker
                    │
                    ▼
              Workers KV（LINKS）
```

### 2. 技术组成

| 组件 | 用途 |
|---|---|
| Cloudflare Workers | 执行路由、短链接创建、跳转、管理 API 和会话验证 |
| Workers KV | 保存短链接记录和 URL 去重索引 |
| 原生 JavaScript Web Crypto API | SHA-256、HMAC-SHA256、随机短码和会话签名 |
| HTML / CSS / JavaScript | 公开首页和管理后台界面，内嵌在 Worker 源码中 |
| Cloudflare Dashboard | 在线编辑、绑定 KV、配置 Secret 和部署 |

项目不依赖 Node.js、npm、Wrangler、第三方运行时库或外部数据库。浏览器端页面也不需要加载第三方 JavaScript CDN。

### 3. KV 数据结构

本版本沿用 v3.0 数据格式：

**短链接主记录**

```text
Key: link:{code}
Value:
{
  "url": "https://example.com/article",
  "createdAt": 1790000000000,
  "expiresAt": 0,
  "indexed": true
}
```

字段说明：

| 字段 | 类型 | 说明 |
|---|---|---|
| `url` | string | 规范化后的目标 URL |
| `createdAt` | number | 创建时间，Unix 毫秒时间戳 |
| `expiresAt` | number | 到期时间，Unix 毫秒时间戳；`0` 表示永久有效 |
| `indexed` | boolean | 是否建立自动去重索引 |

**URL 去重索引**

```text
Key: index:{sha256}
Value: {code}
```

其中 `{sha256}` 是规范化目标 URL 的 SHA-256 十六进制摘要，Value 为对应短码。

旧版 v3.0 记录即使没有 `indexed` 字段，v3.1 在删除时仍会按旧记录方式尝试清理去重索引。不要手动批量改名或删除现有 KV 键，否则可能破坏已有短链接。

### 4. 请求处理和跳转流程

1. Worker 根据请求路径和 HTTP 方法分发到页面、公开 API、管理 API 或短码跳转处理逻辑。
2. 创建 API 校验 JSON 请求、URL 协议、URL 长度、有效期选项和自定义短码格式。
3. 自动短码模式先查询 URL 去重索引；没有可复用记录时生成随机短码。
4. 将主记录写入 `link:{code}`；自动短码模式还会写入 `index:{sha256}`。
5. 访问短码时读取 `link:{code}`，校验记录和有效期后返回 302 响应。
6. 管理 API 在读取、删除等操作前验证管理员会话；有状态变更的请求还需要通过 CSRF 和 Origin 校验。

---

## 部署要求

### 1. Cloudflare 资源

部署前需要准备：

- 一个 Cloudflare 账户。
- 一个 Cloudflare Worker。
- 一个 Workers KV Namespace。
- 一个用于管理后台登录的强密码，保存为 Worker Secret。
- （可选）绑定到 Worker 的自定义域名或 Route。

本项目不要求独立 VPS、Docker、数据库、Node.js 或本地构建环境。

### 2. 必需绑定

在 Worker 的 **Settings → Bindings** 中配置以下 KV 绑定：

| 绑定类型 | 变量名称 | 必需 | 说明 |
|---|---|---|---|
| KV Namespace | `LINKS` | 是 | 保存短链接主记录和去重索引 |

在 **Settings → Variables and Secrets** 中配置：

| 类型 | 变量名称 | 必需 | 说明 |
|---|---|---|---|
| Secret | `ADMIN_PASS` | 是 | 管理后台登录密码，也是会话 HMAC 签名密钥 |

**重要：** 如果你已经部署 v3.0，请继续使用原来的 KV Namespace 和绑定名称 `LINKS`，不要新建空 Namespace 替换，也不要删除或清空原有 KV 数据。`ADMIN_PASS` 应继续作为 Secret 保存，不要写入源码。

以下变量或绑定在当前代码中均不需要：

- `CREATE_LIMITER`
- `ADMIN_LOGIN_LIMITER`
- `CF_PURGE_TOKEN`
- `CF_ZONE_ID`

### 3. 使用 Dashboard 在线部署

本项目支持直接通过 Cloudflare Dashboard 部署：

1. 下载并解压项目压缩包。
2. 打开项目中的 `worker.js`。
3. 登录 Cloudflare Dashboard。
4. 进入 **Workers & Pages**，打开现有 Worker。
5. 选择 **Edit code**。
6. 将编辑器中的旧代码完整替换为 v3.1 的 `worker.js`。
7. 保存并点击 **Deploy**。
8. 检查 **Settings → Bindings**，确认原有 KV 绑定名称仍为 `LINKS`。
9. 检查 **Settings → Variables and Secrets**，确认 `ADMIN_PASS` Secret 仍然存在。
10. 打开 `https://你的域名/api/health`，确认返回版本号 `3.1.0`。
11. 打开首页测试创建短链接，并访问 `/admin` 测试管理员登录、列表和删除功能。

部署 v3.1 不需要执行 KV 数据迁移。建议先下载备份当前 `worker.js`，并在升级前确认 KV Namespace 仍然绑定到原有数据。

### 4. 自定义域名和路由

可以使用 Cloudflare 提供的 Worker 域名，也可以按 Cloudflare 支持的方式将自定义域名或 Route 绑定到 Worker。短链接最终域名由访问 Worker 时使用的请求域名决定。

如果使用自定义域名，请确认 DNS 和 Worker 路由配置正确，并使用 HTTPS 访问管理后台。管理会话 Cookie 使用 `Secure` 属性，生产环境应通过 HTTPS 访问。

### 5. 部署后检查清单

- [ ] 首页 `/` 可以正常打开。
- [ ] `/api/health` 返回 `{"ok":true,"version":"3.1.0"}`。
- [ ] 可以创建自动短码。
- [ ] 可以创建自定义短码。
- [ ] 相同 URL 自动创建时可以复用有效短链接。
- [ ] 1 天和 30 天有效期选项可正常使用。
- [ ] `/admin` 可以使用 `ADMIN_PASS` 登录。
- [ ] 后台可以查看、搜索、筛选和删除链接。
- [ ] 原有 v3.0 短链接仍可正常访问。
- [ ] `LINKS` 绑定指向原有 KV Namespace。

---

## API 接口

所有 JSON API 使用 `Content-Type: application/json`。JSON 响应默认设置 `Cache-Control: no-store`。下列路径均相对于 Worker 所绑定的域名。

### 1. 健康检查

`GET /api/health`

成功响应：

```json
{
  "ok": true,
  "version": "3.1.0"
}
```

### 2. 创建短链接

`POST /api/create`

请求头：

```http
Content-Type: application/json
```

请求体：

```json
{
  "url": "https://example.com/article",
  "customCode": "my-link",
  "expiresIn": 86400
}
```

字段说明：

| 字段 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `url` | string | 是 | 目标 URL，必须是 HTTP 或 HTTPS，最多 2048 字符 |
| `customCode` | string | 否 | 自定义短码；不传或为空时自动生成 |
| `expiresIn` | number | 否 | `0`、`86400` 或 `2592000`；默认 `0` |

创建成功（HTTP `201`）：

```json
{
  "ok": true,
  "code": "my-link",
  "shortUrl": "https://short.example.com/my-link",
  "duplicate": false,
  "expiresAt": 1790000000000
}
```

如果自动生成模式命中已有有效去重记录，则返回 HTTP `200`，并将 `duplicate` 设为 `true`。`expiresAt` 为毫秒时间戳，永久有效时为 `0`。

常见错误：

| HTTP 状态 | 含义 |
|---:|---|
| `400` | JSON 格式、URL、有效期或自定义短码不合法 |
| `409` | 自定义短码已被使用 |
| `503` | 无法分配短码，或 KV 写入失败；可稍后重试 |
| `500` | Worker 内部错误或必需绑定缺失 |

### 3. 短链接跳转

`GET /{code}` 或 `HEAD /{code}`

例如：

```http
GET /my-link
```

有效链接返回：

```http
HTTP/1.1 302 Found
Location: https://example.com/article
Cache-Control: no-store
CDN-Cache-Control: no-store
Cloudflare-CDN-Cache-Control: no-store
```

其他响应：

| HTTP 状态 | 含义 |
|---:|---|
| `302` | 找到短链接，跳转到目标地址 |
| `404` | 短码不存在或记录不可用 |
| `405` | 不支持当前请求方法，仅允许 GET、HEAD |
| `410` | 短链接已过期 |
| `500` | KV 记录中的目标 URL 无效或发生内部错误 |

### 4. 管理员登录

`POST /admin/api/login`

请求必须携带与当前 Worker 域名一致的 `Origin` 请求头。

请求体：

```json
{
  "password": "你的管理员密码"
}
```

登录成功后，服务端通过 `Set-Cookie` 设置会话 Cookie。Cookie 属性包括：

- `HttpOnly`
- `Secure`
- `SameSite=Strict`
- `Path=/`
- `Max-Age=43200`（12 小时）

会话令牌不会作为 JSON 字段返回给前端。

### 5. 获取当前会话

`GET /admin/api/session`

请求需要携带浏览器中的会话 Cookie。

成功响应：

```json
{
  "authenticated": true,
  "csrf": "会话对应的CSRF令牌",
  "expiresAt": 1790000000
}
```

`expiresAt` 是 Unix 秒级时间戳。CSRF Token 由管理页面保存在当前页面内存中，并用于后续状态变更请求。

### 6. 管理员退出登录

`POST /admin/api/logout`

需要有效会话、正确的 `Origin` 和 `X-CSRF-Token` 请求头。成功时返回 HTTP `204`，并清除浏览器会话 Cookie。

### 7. 获取短链接列表

`GET /admin/api/links`

需要有效管理员会话。

成功响应结构：

```json
{
  "links": [
    {
      "code": "my-link",
      "url": "https://example.com/article",
      "createdAt": 1790000000000,
      "expiresAt": 0,
      "expired": false
    }
  ],
  "truncated": false
}
```

字段说明：

- `code`：短码。
- `url`：目标 URL。
- `createdAt`：创建时间，Unix 毫秒时间戳。
- `expiresAt`：到期时间，Unix 毫秒时间戳；`0` 表示永久有效。
- `expired`：当前是否已过期。
- `truncated`：是否达到 5000 条读取上限。

### 8. 删除短链接

`DELETE /admin/api/links/{code}`

需要有效管理员会话，并携带：

```http
Origin: https://short.example.com
X-CSRF-Token: 当前会话的CSRF令牌
```

成功响应示例：

```json
{
  "ok": true,
  "deleted": "my-link",
  "alreadyMissing": false,
  "removedOrphanIndexes": 0
}
```

删除操作会对 `link:{code}` 主记录发起删除；如果读取时主记录不可见，还会扫描去重索引以尝试清理孤立索引。KV 的全球同步并非实时，因此删除后不同 Cloudflare 位置的可见状态可能存在短暂差异。

---

## 已知限制

以下限制属于当前存储方案或本版本设计边界，并非部署错误。

### 1. Workers KV 最终一致性

Workers KV 不是强一致性数据库。写入或删除后，不同 Cloudflare 数据中心的读取结果可能不会立即同步。代码中的 `cacheTtl: 30` 是读取缓存设置，不代表全网数据一定在 30 秒内完成同步。

因此：

- 删除后短时间内，个别地区仍可能读到旧记录。
- 新建后，个别地区可能暂时无法读取刚写入的记录。
- 自动去重和短码占用检查在并发或跨地区情况下不能保证强一致。

### 2. 不支持事务和原子唯一性约束

Workers KV 不提供事务或原子的“仅当键不存在时写入”操作。两个并发请求同时申请相同自定义短码时，理论上可能发生竞争。

v3.1 在写入失败时会尝试回滚部分写入，但这只是尽力清理，不等同于数据库事务，也不能解决所有并发竞争。

### 3. 管理列表上限和浏览器端分页

后台列表最多读取 5000 条记录。搜索、筛选、排序和每页 20 条的分页由浏览器端完成，不是服务端分页。

当记录规模继续增长时，列表加载和浏览器处理成本会增加。要实现高效的服务端分页、全局排序和 URL 子串搜索，需要增加专门索引或改用更适合查询的数据存储；当前版本为保持 KV 结构和 UI 不变，没有引入这些改动。

### 4. 管理会话为无状态签名会话

管理会话使用 HMAC-SHA256 签名，有效期为 12 小时。服务端不保存独立会话列表。

退出登录会清除当前浏览器 Cookie，但不能主动撤销已经被复制的、仍在有效期内的会话令牌。修改 `ADMIN_PASS` 会使旧密钥签发的会话签名失效。

### 5. Worker 内没有内置全局限流

当前版本没有实现 Worker 内的全局创建限流或后台登录限流，也不要求配置 `CREATE_LIMITER`、`ADMIN_LOGIN_LIMITER`。建议在 Cloudflare Zone 层配置 WAF Rate Limiting 规则（见下文“安全建议”）。如果账户套餐或控制台没有提供相应规则，相关 API 不会因此自动获得限流保护。

### 6. 不含访问统计和高级管理能力

当前版本不记录短链接访问次数、来源 IP、Referer、地理位置或访问趋势，也不包含用户注册、多管理员角色、批量导入导出、链接编辑、黑名单、二维码和自定义跳转规则。

### 7. 不保证抵御所有滥用行为

公开创建接口允许访客创建短链接。URL 格式校验并不等同于恶意网站识别或钓鱼链接检测。部署者需要自行管理服务使用范围、滥用投诉和 Cloudflare 防护规则。

---

## 安全建议

### 1. 管理员密码

- 使用长度足够、不可复用的强密码。
- 将密码配置为 Cloudflare Worker Secret `ADMIN_PASS`，不要硬编码到 `worker.js`、README、Git 仓库或前端代码。
- 不要通过公开聊天、截图或工单泄露 Secret。
- 怀疑密码泄露时，立即在 Dashboard 中更换 `ADMIN_PASS`。更换后，使用旧密码签发的会话将无法通过签名验证。

### 2. 始终使用 HTTPS

管理 Cookie 设置了 `Secure`，应始终通过 HTTPS 访问管理后台。不要为了方便而移除 `Secure`、`HttpOnly` 或 `SameSite=Strict` 属性。

### 3. 配置 Cloudflare WAF 限流

建议在 Cloudflare Dashboard 的安全规则中，为公开创建接口和管理员登录接口分别配置 Rate Limiting。以下是可作为起点的规则表达式和阈值，实际菜单名称及可用能力取决于 Cloudflare 账户套餐：

**公开创建接口：**

```text
(http.request.method eq "POST" and http.request.uri.path eq "/api/create")
```

建议起始阈值：每个 IP 每 1 分钟 20 次，触发后阻止 1 分钟。

**管理员登录接口：**

```text
(http.request.method eq "POST" and http.request.uri.path eq "/admin/api/login")
```

建议起始阈值：每个 IP 每 10 分钟 10 次，触发后阻止 10 分钟。

这些阈值只是初始建议，应根据正常用户数量、共享出口 IP 情况和实际流量调整。限流规则是在 Cloudflare Zone 层配置，不是 Worker 源码内置功能。

### 4. 检查缓存规则

Worker 的短链接跳转响应已经设置：

- `Cache-Control: no-store`
- `CDN-Cache-Control: no-store`
- `Cloudflare-CDN-Cache-Control: no-store`

请检查 Cloudflare Cache Rules、Page Rules 或其他缓存策略，确保没有针对短码路径 `/{code}` 的规则强制缓存 302 响应，尤其不要使用忽略源站 Cache-Control 的 Edge Cache TTL 设置覆盖 `no-store`。

如果强制缓存短链接跳转，删除短链接后，缓存中的旧 302 可能仍会继续生效。

### 5. 保护 KV 数据

- 升级前确认 `LINKS` 指向原有 Namespace。
- 不要在升级过程中删除或清空 KV Namespace。
- 不要手动修改 `link:` 和 `index:` 键的命名规则。
- 重要数据应定期通过 Cloudflare 支持的方式备份或导出，并妥善保存备份。
- 不要将 KV Namespace 的管理权限授予不必要的人员或 API Token。

### 6. 控制公开服务的使用范围

如果服务仅供个人使用，可以考虑在 Cloudflare 层增加访问限制、WAF 规则或其他访问控制。不要把“知道 `/admin` 路径”当成安全措施；后台安全依赖密码、签名会话、Cookie、CSRF 和 Origin 校验共同实现。

### 7. 关注异常和运行状态

定期检查 Worker 日志和 Cloudflare 安全事件。v3.1 在 KV 写入失败、回滚失败或未处理异常时会记录服务端日志；不要把日志中的内部错误细节直接展示给普通访客。

---

## 许可证

**当前项目文件未声明具体开源许可证。** 在仓库或项目中添加明确的 `LICENSE` 文件之前，不应默认将本项目视为 MIT、Apache-2.0 或其他开源许可证，也不应仅凭公开可见就推定任何人都获得了再分发、修改或商用授权。

如果计划公开发布，建议项目维护者先选择适合的许可证，并在仓库根目录添加对应的完整 `LICENSE` 文件，同时在本节注明许可证名称和版权归属。若仅供个人自用，可以暂时保留本说明，但这不构成法律意见。

---

## 项目文件

```text
cloudflare-short-url-v3.1/
├── worker.js       # Cloudflare Worker 完整源码，Dashboard 部署使用
├── README.md       # 项目说明、部署和 API 文档
├── AUDIT.md        # v3.1 代码审查报告
└── test-v3.1.mjs   # 本地 Mock KV 测试脚本（可选）
```

部署时只需要将 `worker.js` 的完整内容粘贴到 Cloudflare Dashboard。`test-v3.1.mjs` 是可选的本地测试脚本，不是生产部署依赖；本项目不要求通过命令行构建或发布。

---

## 版本记录

### v3.1.0

- 修复删除操作在读取不到主记录时未必执行主键删除的问题。
- 增加 KV 写入失败捕获和尽力回滚逻辑。
- 修复管理会话过期后前端未正确返回登录状态的问题。
- `SYS_` 保留前缀检查改为大小写不敏感。
- 后台新窗口打开链接时增加 `window.opener = null` 保护。
- 短链接跳转增加多层 `no-store` 响应头。
- 保留 v3.0 页面、功能、KV 数据结构和 Dashboard 部署方式。

### v3.0

- 建立当前版本沿用的简化架构和 KV 键结构。
- 使用 `link:{code}` 保存短链接记录，使用 `index:{sha256}` 保存自动去重索引。
- 管理后台采用签名会话和 CSRF 防护。

---

## 免责声明

本项目按现状提供，不承诺适用于所有业务场景，也不保证 Workers KV 在所有地区即时一致。部署者应自行评估 Cloudflare 服务条款、数据合规、目标链接合法性、滥用风险和运营责任。请勿将本项目视为具备恶意网址检测、数据防丢失或强一致数据库能力的服务。

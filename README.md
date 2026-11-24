# Cloudflare Worker Short URL v3.0（Dashboard 纯网页部署版）

一个轻量的个人短链接服务，使用 **Cloudflare Workers + Workers KV**。本版本专为 Cloudflare 网页控制台部署设计：创建、配置、发布和后续修改都可以在浏览器中完成。

**不需要安装 Node.js、npm、Wrangler，不需要终端/SSH，不需要本地构建，也不需要配置 `wrangler.toml`。**

## 1. 功能

- 自动生成短码，也支持自定义短码
- 相同目标 URL 去重
- 永久、1 天、30 天有效期
- 公开短链接创建页面
- 管理后台：登录、搜索、筛选、排序、分页、复制、打开、删除
- 管理员 Session：HMAC-SHA256 签名，12 小时有效
- Cookie：HttpOnly、Secure、SameSite=Strict
- CSRF 防护：同源 Origin、CSRF Token、Fetch Metadata 校验
- URL、短码、JSON 请求体校验
- 302 跳转与最长 24 小时的 Workers Cache API 缓存
- 响应式管理界面
- 不包含 Turnstile，不读取旧版 `SYS_*` 配置

## 2. 项目文件

```text
cloudflare-short-url-v3.0/
├── worker.js   # 完整 Worker 程序，直接粘贴到 Cloudflare 网页编辑器
└── README.md   # 本部署说明
```

项目只保留部署真正需要的两个文件。没有 `package.json`、`wrangler.toml` 或构建脚本，因为 Dashboard 部署不需要它们。

## 3. 部署前准备

需要一个 Cloudflare 账号，并在该账号中创建一个新的 KV Namespace：

1. 登录 Cloudflare Dashboard。
2. 进入 **Workers & Pages → KV**（部分界面可能显示为 **Storage & databases → Workers KV**）。
3. 点击创建 Namespace。
4. 名称可填写：`SHORT_URL_V3_LINKS`。

建议使用全新的 KV Namespace，不要直接绑定旧版本短链接服务正在使用的 Namespace。v3.0 不迁移旧链接。

## 4. 创建 Worker 并粘贴代码

1. 进入 **Workers & Pages**。
2. 点击 **Create application / Create**，选择创建 **Worker**。
3. Worker 名称可填写：`short-url-v3`。
4. 创建完成后，打开该 Worker 的在线代码编辑器（**Edit code**）。
5. 删除编辑器中的示例代码。
6. 用文本编辑器打开本项目的 `worker.js`，复制全部内容，粘贴到 Cloudflare 在线编辑器。
7. 点击 **Deploy** 发布。

注意：只粘贴 `worker.js` 的全部 JavaScript 内容，不要把 README 内容粘进去。

## 5. 绑定 KV（必须）

1. 打开 Worker 的 **Settings → Bindings**。
2. 点击 **Add binding**。
3. 选择 **KV Namespace**。
4. Variable name 填写：`LINKS`（必须完全一致、大写）。
5. Namespace 选择刚才创建的 `SHORT_URL_V3_LINKS`。
6. 保存绑定；如果界面提示需要部署/重新部署，按提示执行。

代码通过 `env.LINKS` 读写短链接数据。变量名必须是 `LINKS`，不是 Namespace 的显示名称。

## 6. 设置管理员密码（必须）

1. 打开 Worker 的 **Settings → Variables and Secrets**（有些界面可能归在 **Settings → Variables**）。
2. 点击添加变量/Secret。
3. 类型选择 **Secret**，不要选择普通 Text。
4. Variable name 填写：`ADMIN_PASS`。
5. Value 填写你自己设置的高强度管理员密码。
6. 保存；如果界面提示需要部署/重新部署，按提示执行。

建议使用至少 20 位的随机密码。不要把密码写进 `worker.js`，也不要发给别人。

`ADMIN_PASS` 同时用于验证管理员登录和派生 Session 的 HMAC 签名密钥。修改这个 Secret 后，旧 Session 会失效，需要重新登录；KV 中的短链接不会被删除。

## 7. 完成部署与访问

确认已经完成 `LINKS` 和 `ADMIN_PASS` 两项配置后，访问 Worker 的默认 `workers.dev` 地址：

| 地址 | 用途 |
|---|---|
| `/` | 公开短链接创建页 |
| `/admin` | 管理后台 |
| `/api/health` | 健康检查 |

先访问 `/api/health`，正常时应返回类似：

```json
{"ok":true,"version":"3.0.0"}
```

再访问 `/` 创建一条测试短链接，测试跳转；然后访问 `/admin`，使用 `ADMIN_PASS` 登录，测试搜索和删除。

## 8. 绑定自己的域名（可选）

如果希望短链接使用自己的域名：

1. 打开 Worker 的 **Settings → Domains & Routes**。
2. 选择添加 **Custom Domain**。
3. 输入已接入当前 Cloudflare 账号的域名或子域名，例如 `s.example.com`。
4. 按 Cloudflare 页面提示完成绑定。

绑定后，创建出来的短链接会自动使用当前访问域名生成，不需要修改代码。

## 9. 只需要配置的两项

| 类型 | 变量名 | 是否必须 | 用途 |
|---|---|---:|---|
| KV Namespace binding | `LINKS` | 是 | 保存短链接和 URL 去重索引 |
| Worker Secret | `ADMIN_PASS` | 是 | 管理员密码及 Session 签名密钥 |

除此之外不需要配置其他变量或绑定。没有 Turnstile、`SYS_SS`、`SYS_CE`、`SYS_SK`、`TURNSTILE_SECRET`、`CF_PURGE_TOKEN`、`CF_ZONE_ID`，也没有可选限速绑定。

## 10. 数据结构与行为

KV 使用以下键：

```text
link:{code}       -> JSON 链接记录
index:{sha256}    -> 对应短码
```

链接记录示例：

```json
{
  "url": "https://example.com/path",
  "createdAt": 1795500000000,
  "expiresAt": 0
}
```

`expiresAt: 0` 表示永久有效。过期链接会返回 HTTP 410。设置有效期时，KV TTL 和记录中的过期时间都会生效。

## 11. 安全与限制说明

1. **管理员密码必须通过 Worker Secret 保存。** 不要把它硬编码到源码或公开仓库。
2. Session 使用 HMAC-SHA256 签名，Cookie 设置为 HttpOnly、Secure、SameSite=Strict，最长有效期 12 小时。
3. 管理后台写操作要求同源 Origin 和有效 CSRF Token，并检查 `Sec-Fetch-Site`（浏览器提供该请求头时）。
4. 本版本没有接入应用层 Rate Limiting binding。可按需在 Cloudflare 控制台配置 WAF / Rate Limiting 规则；这不是部署所需绑定。
5. **KV 不是事务数据库。** 自定义短码通过写入前检查避免常规冲突，但两个并发请求可能同时通过检查。若需要严格并发唯一性，应改用 D1 唯一约束或 Durable Objects 协调。
6. URL 去重索引受 KV 最终一致性影响；高并发时，同一 URL 可能短暂产生重复短码。
7. Workers Cache API 是数据中心本地缓存。删除链接会清理当前数据中心缓存，其他数据中心可能在缓存 TTL 到期前仍短暂保留旧跳转。缓存最长 24 小时；带有效期的链接缓存时间不会超过剩余有效期。
8. 建议先用测试域名验证创建、跳转、登录、删除和过期行为，再绑定正式域名。

## 12. 修改和更新代码

以后更新版本时，无需命令行：打开 Worker 的 **Edit code**，用新版本 `worker.js` 完整替换旧代码，然后点击 **Deploy**。只要继续使用相同的 `LINKS` KV Namespace 和 `ADMIN_PASS` Secret，现有 v3.0 数据和管理员密码就会保留。

## License

MIT

# Pay Reminder · 补款提醒

给「先付定金、后补尾款」的小生意用的一人份订单提醒工具。

商家在后台录一笔订单和补款日程 → 生成一个买家链接 / 二维码 → 买家打开后把日程**订阅**到手机自带日历 → 以后商家改日期、加日程，买家日历自动同步。无需下载 App、无需注册登录。

- 零依赖：单文件 Node.js HTTP 服务 + 一个 `data.json`
- 前端页面（后台 + 买家页）直接内嵌在 `server.js` 里
- 日历源是标准 iCalendar（`.ics`）订阅源，任何支持「按网址订阅」的日历客户端都能用

## 快速开始

```bash
node server.js          # 默认 http://0.0.0.0:3000
# 或
npm start
```

首次运行会自动创建空数据文件。想带示例数据：

```bash
cp data.example.json data.json
```

打开 `http://localhost:3000/` 进入商家后台，默认口令 `8888`（改 `server.js` 顶部的 `ADMIN_PIN`）。

## 使用流程

1. 后台点「新建订单」，填买家称呼、商品、定金金额与日期；
2. 给订单加补款日程（名称、金额、到期日、提前几天提醒）；
3. 把该订单的买家链接/二维码发给买家；
4. 买家订阅后，商家后续增删改日程都会反映到买家日历（客户端有 15 分钟~1 天的刷新延迟）。

## 路由

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` `/admin` | 商家后台（口令登录，Cookie 30 天） |
| POST | `/api/login` | `{pin}` → 设置 admin Cookie |
| GET/POST | `/api/orders` | 订单列表 / 新建订单 |
| DELETE | `/api/orders/:id` | 删除订单 |
| POST | `/api/orders/:id/reminders` | 新增日程 |
| PUT/DELETE | `/api/orders/:id/reminders/:rid` | 修改 / 删除日程 |
| GET | `/t/:token` | 买家页（公开，凭 token） |
| GET | `/api/public/order/:token` | 买家页读取的订单 JSON |
| GET | `/ics/:token.ics` | 日历订阅源（支持 GET/HEAD/OPTIONS） |
| GET | `/api/debug/log?key=…` | 最近请求诊断（排查客户端问题用） |

## 部署注意（重要）

- 服务必须监听 `process.env.PORT`、绑定 `0.0.0.0`。
- 若部署在需要「分享码」的托管平台（如 WorkBuddy 托管），**访问链接必须带 `?sharecode=…`**，且网关通常在访问后种 Cookie 放行；但 iOS 日历客户端与 Safari 不共享 Cookie，所以**订阅源 URL 本身必须带分享码**。
- 托管网关一般会把 `http` 强制 302 到 `https`，而 **iOS 订阅校验不跟随跳转**，表现为 `Validation failed`。给用户的链接一定要 `https://` 开头。
- 重新发布前先备份线上 `data.json`，否则会被本地数据覆盖。

## 日历兼容性

| 系统 / App | 能否按网址订阅 | 入口 |
|---|---|---|
| iOS / iPadOS 15+ | ✅ | 设置 → 日历 → 账户 → 添加账户 → 其他 → 添加已订阅的日历（务必 https） |
| macOS 日历 | ✅ | 文件 → 新建日历订阅 |
| Google 日历（网页版） | ✅ | calendar.google.com → 其他日历 + → 通过网址（手机 App 本身无入口，靠同步） |
| Outlook | ✅ | 添加日历 → 从 Web 订阅 |
| 小米 / 华为 / OPPO / vivo 自带日历 | ⚠️ 机型相关 | 日历设置 → 订阅日历 / 日历账户 → 通过网址 |
| 三星自带日历 | ❌ 不支持订阅 | 只能导入本地 .ics（一次性）；建议改用 Google 日历网页版订阅后同步 |
| 微信 / QQ / 支付宝内置浏览器 | ❌ | 需「在浏览器打开」 |

订阅刷新有延迟：iOS 可设 15 分钟~每小时，Google 约 12–24 小时；「下载 .ics 一次性导入」的数据永不更新。

## 安全说明

- 买家凭 token（16 位十六进制）访问，token 即凭证，不要公开传播。
- 后台默认口令 `8888` 仅供演示，正式使用请替换。
- `data.json` 含真实买家信息，已在 `.gitignore` 中排除，勿提交。

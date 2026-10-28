# DSH 客户端插件集成配方：浮层 + 状态轮询 + 按钮控制（v0.4）

> 目标：在 DSH 桌面/Web 里加一个**不吃麦克风**的浮层，只做两件事：
> 1. 轮询 Host 侧语音练习状态（`GET /voice-practice/state`）；
> 2. 用按钮控制 Host 侧已有的语音循环（`POST /voice-practice/control`：开始/结束/打断）。
>
> 麦克风采集、VAD、STT/TTS 都在 Host 侧（ffmpeg 等），本配方不碰录音 API，也不需要 `ctx.remote.speech`。
> 参考实现：`/tmp/dsh-voice-call`（Qi-95827/dsh-voice-call，MIT，v1.7.2，目标 DSH 0.2.x），下列行号均指该仓库文件。
> DSH 资料来源：0.2.1-rc.3 的 app.asar 解包产物（`/tmp/dsh-asar-extract`）。
>
> 标注：**【源码】**=从参考仓库/DSH 构建产物直接读到；**【README】**=包 README 明文；**【推断】**=实现合理但未实测。

---

## 0. 一页结论

| 事项 | 结论 |
|---|---|
| Host 路由 | `ctx.webServer.register({ kind:'prefix', path:'/voice-practice', handler:(req,res)=>… })`，返回 disposer，**必须包在 `ctx.effect` 里**；重复 (kind,path) 会抛错【源码】 |
| 鉴权 | webserver **不做认证**（README 明文）；voice-call 自己写 `sameOrigin()`（Origin 与 Host 同 host）+ 依赖服务只绑 loopback；客户端 fetch **不带 Authorization**【源码+README】 |
| Desktop 下相对 fetch | 桌面窗口加载 `dsh-app://app/`，非静态请求经 `protocol.handle` 转发到 loopback Host；转发时**删掉 origin/host/cookie，改设 Host 认证 cookie**，所以 Host 看到 **没有 Origin** ⇒ voice-call 的 sameOrigin 返回 true 放行【源码：Electron `lib/main.js`】 |
| 客户端入口 | `window.__ModuleLoader__.load({ id:'<包名>', factory:(require)=>{…} })`；`require('react')`；导出 `{name, inject:['slots'], apply(ctx)}`【源码】 |
| 浮层挂载 | `ctx.slots.inject('shell.overlay', () => ctx.slots.register({name:'shell.overlay', id, order:900}, Overlay))`；`shell.overlay` 是 `kind:'list', scope:'root'`（由 ui-layout 声明），渲染在绝对定位、`pointer-events:none` 的 overlay 层里，子元素自动 `pointer-events:auto`【源码：ui-layout】 |
| 当前 sessionId | `ctx.inject(['uiSession'], scoped => sessionCtx = scoped)`；`sessionCtx.uiSession.current.getSnapshot()?.key` 即 sessionId；另有 `.subscribe` 可响应切换【源码：ui-session】 |
| 单实例 | window 全局 ownership token：新实例 `apply` 时先 dispose 旧实例；`ctx.effect` 清理兜底；防止热重载后两个浮层同时轮询/双开【源码】 |
| 音频播放 | `new Audio(url)`（同源 `/voice-practice/audio/...` 或 blob URL），`preservesPitch/playbackRate` 可调，换句前 `pause()+src=''`，结束 `URL.revokeObjectURL`；Host 侧用 `res.writeHead(200,{content-type,content-length,cache-control:'no-store'})`+`res.end(buffer)` 返回 wav【源码】 |
| 最需要小心的 | `shell.overlay`/`uiSession.current` 形状是**构建产物内部契约**，官方 README 未逐条承诺；自定义路由是 loopback-trusted，不要把服务绑 0.0.0.0 |

---

## 1. 包结构（最小）

```text
dsh-voice-practice/
├── package.json
├── cordis.patch.yml       # 只插入一条 Host Loader 行
├── index.js               # Host 半：webServer 路由 + 状态
├── client.js              # 浏览器半：shell.overlay 浮层（手写，无需官方构建链）
├── locale/{zh,en}.json    # 插件管理页展示（meta.title/description）
└── icon.svg
```

`package.json`（字段语义与 voice-call 完全同款；`files` 记得把 client.js 列进去）：

```jsonc
{
  "name": "dsh-voice-practice",
  "version": "0.4.0",
  "description": "Voice practice overlay: polls host state and controls the voice loop.",
  "type": "module",
  "main": "index.js",
  "exports": {
    ".": "./index.js",
    "./client": "./client.js",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg",
    "./package.json": "./package.json"
  },
  "files": ["index.js", "client.js", "cordis.patch.yml", "locale/*.json", "icon.svg"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "immediately": true,                       // 启动即加载浮层（voice-call 同款）
      "inject": ["@deepseek-ai/dsh-client-ui-layout"]   // 先加载声明 shell.overlay 的包
    },
    "compatibility": { "dshReleases": { "0.2.1-rc.3": "unknown" } }
  }
}
```

`cordis.patch.yml`（与 voice-call 一致，只挂 Host 行；client 半由 `dsh.client` 自动发现）：

```yaml
# dsh-voice-practice bundle layer.
# One Host row owns /voice-practice HTTP routes. The Client half is discovered
# from package.json dsh.client and renders into the shell.overlay slot.
- insert:
    - id: dsh-voice-practice
      name: 'dsh-voice-practice'
```

安装（与 v0.4 其它步骤一致）：把本包放进 profile 的 `dsh.profile.bundles` 并装依赖（`link:` 本地开发 / 插件页安装），重启或按插件页提示生效。**不要**只改 `cordis.patch.yml` 而不装包——Host 行 import 会找不到包。

---

## 2. Host 半：webServer 路由

### 2.1 API 签名与匹配规则【源码】

```js
ctx.webServer.register({ kind: 'exact' | 'prefix', path: '/voice-practice', handler: (req, res) => {…} })
// → 返回 disposer（只删自己那一条）
```

- 源码：`dsh-host-webserver/lib/index.js:320-333`（`register`，重复 `(kind,path)` 抛错）、`:249-291`（服务与配置，**wildcard 地址直接拒绝**，`:255`）、`:107`（"Route handlers retain direct response ownership"——handler 自己负责响应）。
- prefix 匹配是**路径段级**：`pathname === prefix || pathname.startsWith(prefix + '/')`，所以 `/voice-practice` 命中 `/voice-practice/state`，但不命中 `/voice-practiceX`（`dsh-host-webserver/lib/index.js:494-505`）。
- **不要忘记**：注册写在 `ctx.effect(() => ctx.webServer.register(...), 'label')` 里，插件卸载/HMR 时自动移除路由（voice-call `index.js:282-442` 即如此）。

### 2.2 sameOrigin、鉴权到底靠什么【源码+README】

voice-call 的写法（`index.js:163-173`）：

```js
function sameOrigin(req) {
  const origin = req.headers?.origin;
  if (!origin) return true;                 // 同文档 fetch / 非浏览器 / Desktop 转发
  const host = req.headers?.host;
  if (!host) return false;
  try { return new URL(origin).host === host; } catch { return false; }
}
```

结论（这也是本配方与任务假设的修正）：

1. **webserver 不做认证，也不做来源策略**。README.zh.md:130 原文："不提供服务器级认证或来源策略：`dsh-client-connection` 等 route owner 会实施自己的请求策略。绑定非回环地址仍会向该网络公开未受保护的 route 与静态资源。"
2. voice-call 客户端 `fetch('/voice-call/...')` **没有 Authorization**；Web GUI 下浏览器会自动带自己的 cookie，但**自定义路由不会校验它**。真正的边界是：① 服务默认只绑 `127.0.0.1`（`:255` 拒绝 wildcard）；② `sameOrigin` 阻止**跨源浏览器页面**发起写操作；③ Desktop 转发路径自带 shell 的认证 cookie。
3. `sameOrigin` 允许**没有 Origin 的请求**（这是 Desktop 转发与非浏览器客户端的必要放行），所以**它不是强鉴权**。自定义路由应默认"本机受信"，不要返回密钥，不要做危险操作；要更强约束可校验 `referer`/自定义 header，但只能算 best-effort。
4. Desktop 实际路径（0.2.1-rc.3 app.asar `lib/main.js`，**【源码/构建产物】**）：
   - 主窗口加载 `dsh-app://app/`（`:12134`）；`protocol.handle` 把静态资源本地服务，其余请求 `forwardWebRequest(request, hostUrl, hostCookie)` 转发到 loopback Host（`:12406-12415`）；
   - `authenticateWebHost` 先用 Host 的 authenticatedUrl 换 `set-cookie`（`:8229-8236`），转发时删除 `host/origin/cookie/sec-fetch-site` 再设 `cookie`（`:8268-8282`）；
   - ⇒ Host 收到的请求 **没有 Origin 头**，`sameOrigin()` 直接返回 true；相对 URL `/voice-practice/state` 在 `dsh-app://app/` 下解析后被转发，**可以照抄 voice-call 的同源写法**。
   - 注意：dsh-host-webserver README.zh.md:12 写的是"Electron 通过 file:// 加载 dist，并经 IPC 桥接承载 fetch"，与 0.2.1-rc.3 实际实现（`dsh-app://` + HTTP 转发）**不一致**；以构建产物为准，跨版本需要回归验证（见 §6）。
5. Web GUI（浏览器直接访问 `http://127.0.0.1:<port>`）：浏览器会带 `Origin` 和 `Host`，同源比较通过。端口每次启动可能变化（本次运行时是 `127.0.0.1:49841`），客户端一律用相对路径。

### 2.3 readBody / JSON / 音频响应（可复制）

```js
async function readBody(req, limit = 16 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('request too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendAudio(res, buffer, contentType = 'audio/wav') {
  res.writeHead(200, {
    'content-type': contentType,
    'content-length': buffer.length,
    'cache-control': 'no-store',
  });
  res.end(buffer);
}
```

（voice-call 同款：`index.js:175-194, 425-431`；transcribe 走大 body 时把 limit 提到 64 MiB。音频响应**不需要** Range 支持也能播；要 seek 再加 206。）

### 2.4 Host 路由骨架（状态 + 控制 + 可选音频）

> 与语音循环的接线点用 `bindControl({...})` 暴露；v0.4 的 voice-core 在启动/结束时调用 `publish({phase:…})` 即可。

```js
// index.js —— Host 半（可复制骨架）
export const name = 'voice-practice';
export const inject = ['webServer'];   // 只用 HTTP 载体；语音/凭据服务按需 ctx.inject 可选注入

const state = {
  phase: 'idle',        // idle | listening | thinking | speaking | error
  sessionId: null,
  line: '',             // 最近一句（用户/助手均可，由语音循环 publish）
  error: null,
  since: Date.now(),
  updatedAt: 0,
  audioRev: 0,          // 客户端据此判断是否有新音频
};
let lastAudio = null;   // Buffer，不放进 JSON 状态
let control = { start: async () => {}, stop: async () => {}, interrupt: async () => {} };

/** 语音循环调用：更新对外状态（线程安全：Node 单线程，直接改即可）。 */
export function publish(patch) {
  Object.assign(state, patch, { updatedAt: Date.now() });
}
/** 语音循环调用：绑定控制动作。 */
export function bindControl(handlers) { control = { ...control, ...handlers }; }
/** 语音循环调用：登记一段待播放音频（例如 TTS wav）。 */
export function setAudio(buffer) {
  lastAudio = buffer; state.audioRev += 1; state.updatedAt = Date.now();
}

function sameOrigin(req) {
  const origin = req.headers?.origin;
  if (!origin) return true;                       // Desktop 转发 / 非浏览器
  const host = req.headers?.host;
  if (!host) return false;
  try { return new URL(origin).host === host; } catch { return false; }
}

async function readBody(req, limit = 16 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('request too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendAudio(res, buffer, contentType = 'audio/wav') {
  res.writeHead(200, {
    'content-type': contentType,
    'content-length': buffer.length,
    'cache-control': 'no-store',
  });
  res.end(buffer);
}

export function apply(ctx) {
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: '/voice-practice',
      handler: async (req, res) => {
        if (!sameOrigin(req)) return sendJson(res, 403, { error: 'cross-origin request refused' });
        const url = new URL(req.url || '/', 'http://localhost');
        const sub = url.pathname.replace(/^\/voice-practice/, '') || '/';
        try {
          if (req.method === 'GET' && sub === '/state') {
            return sendJson(res, 200, { ...state, serverTime: Date.now() });
          }

          if (req.method === 'POST' && sub === '/control') {
            const body = JSON.parse((await readBody(req)) || '{}');
            const action = String(body.action || '');
            const sessionId = typeof body.sessionId === 'string' ? body.sessionId : null;
            if (action === 'start') {
              if (!sessionId) return sendJson(res, 400, { error: 'sessionId required' });
              await control.start(sessionId);
            } else if (action === 'stop') {
              await control.stop();
            } else if (action === 'interrupt') {
              await control.interrupt();
            } else {
              return sendJson(res, 400, { error: 'unknown action' });
            }
            return sendJson(res, 200, { ok: true, phase: state.phase });
          }

          // 可选：让浏览器播放 Host 生成的最后一整段音频
          if (req.method === 'GET' && sub === '/audio/last.wav') {
            if (!lastAudio) return sendJson(res, 404, { error: 'no audio yet' });
            return sendAudio(res, lastAudio, 'audio/wav');
          }

          sendJson(res, 404, { error: 'not found' });
        } catch (err) {
          sendJson(res, 500, { error: String(err?.message || err) });
        }
      },
    }),
    'voice-practice: /voice-practice routes',
  );
}
```

要点：
- 状态里**永远不要**放 `Buffer`/函数/凭据；音频单独用 `audioRev` 通知客户端换 URL（`?rev=${audioRev}` 防缓存）。
- 控制接口是幂等的：`start` 重复调用由 control 内部忽略；`stop` 在 idle 时也应 200 返回，避免客户端按钮抖动报错。
- 多窗口同源时两个页面会同时轮询/控制：需要"谁在控制"就在 body 里带 `instance`（见 §3.4 的 token，发一个随机 id 即可），Host 可只接受最新 instance（voice-call 把 `instance/boots` 写进 `/transcribe` body 做诊断，`index.js:347-387`）。

---

## 3. Client 半：bundle、浮层、sessionId、ownership

### 3.1 ModuleLoader 包装（可复制；不要求官方构建链）【源码】

voice-call `client.js:16-21`：

```js
window.__ModuleLoader__.load({
  id: 'dsh-voice-practice',          // 必须 === package.json name
  factory: (require) => {
    const React = require('react');  // 唯一运行时依赖（基线外置）
    const { useEffect, useRef, useState } = React;
    const h = React.createElement;

    // …组件…

    return {
      name: 'voice-practice',
      inject: ['slots'],             // Cordis 客户端服务名；session 服务用 ctx.inject 选捕获
      apply(ctx) { /* 见 §3.2/§3.4 */ },
    };
  },
});
```

- 客户端模块导出契约：`{ name, inject: [服务名…], apply(ctx) }`（voice-call `client.js:2287-2342`）。`inject` 里只放**必需**服务；`sessions/uiSession` 这类可缺服务用 `ctx.inject` 捕获，缺失时降级而不是整个浮层不出现（voice-call 注释 `client.js:2288-2292`）。
- 自建构建：voice-call 的 `client.js` 是手写单文件（79 KB，未 minify，直接从源码维护），并提供无浏览器契约测试 `scripts/smoke-client.mjs`（见 §5）。**不需要** tsdown/官方 monorepo 构建链；如需打包也可用 esbuild，只要保留上面的 wrapper 和 `id`。
- `dsh.client.immediately: true`（voice-call `package.json:53-59`）让浮层随应用启动加载，而不是首次用到才物化（推断语义；字段本身由 client-modules 解析）。

### 3.2 shell.overlay 槽：声明与注册【源码】

- 槽由 `@deepseek-ai/dsh-client-ui-layout` 声明：`dsh-client-ui-layout/lib/client.js:643-646`
  ```js
  "shell.overlay": { kind: "list", scope: "root" },
  ```
  渲染位置在 AppFrame 的 overlay 层：`client.js:313` `renderSlot("shell.overlay", {})`，容器 `client.js:344-353` `className=overlayLayer data-shell-overlay`。
  该层 CSS（同文件 line 73 的 `AppFrame_module_css_default`）：`position:absolute; inset:0; z-index:20; pointer-events:none`，且 `>*{pointer-events:auto}`。
  ⇒ **浮层根节点用 `pointer-events:'none'`，只有可点区域设 `auto`**，否则会挡住整个应用（voice-call 的 smoke 测试专门断言了 wrapper `pointerEvents==='none'`、按钮 `'auto'`，`scripts/smoke-client.mjs:139-147`）。
- 注册写法（voice-call `client.js:2338-2340`）：
  ```js
  disposeSlot = ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register({ name: 'shell.overlay', id: 'dsh-voice-practice', order: 880 }, Overlay),
  );
  ```
  - 必须用 `slots.inject`（等槽声明就绪；卸载/声明折叠时移除、恢复后重新注册）。
  - `order` 与其它 overlay 条目（配额提示、Toast 等）一起排序；voice-call 用 900，我们 800–900 均可。
  - 注册前 `ctx.slots` 存在性由 `inject:['slots']` 保证。

### 3.3 当前 sessionId：uiSession.current【源码】

voice-call `client.js:1377-1384`：

```js
function currentSessionId() {
  try {
    const snapshot = (sessionCtx || pluginCtx)?.uiSession?.current?.getSnapshot?.();
    return snapshot?.key || snapshot?.sessionId || null;
  } catch { return null; }
}
```

- `uiSession` 是 `@deepseek-ai/dsh-client-ui-session` 提供的 Cordis 客户端服务（`super(ctx,"uiSession")`）。
- `uiSession.current` 是 `createBindingSource(value)` 产物，结构 `{ value, listeners, getSnapshot:()=>value, subscribe(fn) }`（`dsh-client-ui-session/lib/client.js:1050-1063`）；`value` 来自 `materialize(binding)`，字段 `{ key: binding.sessionId, ctx, hooks, keyedHooks, props }`（同文件 `:1012-1031`）。
  ⇒ **当前版本只有 `.key`**；voice-call 里 `.sessionId` 只是向后兼容的 fallback（当前构建不存在该字段，属于防御写法）。
- 捕获方式（voice-call `client.js:2329-2337`）：`ctx.inject(['sessions','uiSession'], scoped => { sessionCtx = scoped; scoped.effect(() => () => { if (sessionCtx===scoped) sessionCtx=null; }, 'release'); })`。本配方只需要 `uiSession`，`sessions` 可省（`sessions.retain` 用于订阅 Session 事件，v0.4 浮层不需要）。
- 需要在会话切换时刷新显示时，可以订阅 `uiSession.current.subscribe(cb)`（`subscribe` 在同源切换时会通知）；最简做法（本配方）是在轮询 tick 与按钮点击时重新 `currentSessionId()`。
- 服务缺失降级：voice-call 先检测 `api?.sessions?.retain || api?.uiSession`，缺失时提示"服务不可用"（`client.js:2263-2272`）。我们同样先判空。

### 3.4 单实例 ownership（热重载防重复挂载）【源码】

voice-call `client.js:2301-2328`：

```js
const self = { token: {}, dispose: null };
self.dispose = () => {
  try { disposeSlot?.(); } catch {}
  disposeSlot = null;
  if (window.__dshVoicePracticeOwner === self) window.__dshVoicePracticeOwner = null;
};
const previous = window.__dshVoicePracticeOwner;
if (previous && previous !== self && typeof previous.dispose === 'function') {
  try { previous.dispose(); } catch {}
}
window.__dshVoicePracticeOwner = self;
ctx.effect(() => () => self.dispose(), 'voice-practice: dispose overlay');
```

- 作用：HMR / 旧版本残留会再执行一次 `apply`；没有 token 时会出现两个浮层、双倍轮询、重复 POST。token 用对象身份而不是字符串，避免旧代码"认领"新实例。
- `ctx.effect` 的清理必须能重复调用（幂等）；`disposeSlot?.()`、清全局、清 interval/audio 都放里面。
- 不要往 `document.body` 上 `appendChild`（voice-call 头注释明确"Nothing is appended to document.body"）；浮层只活在 slot 里，slot 卸载时 React 自己清理 DOM。

### 3.5 轮询状态（可复制）

```js
function useHostState() {
  const [remote, setRemote] = useState({ phase: 'idle', sessionId: null, error: null });
  useEffect(() => {
    let stopped = false;
    let timer = null;
    const controller = new AbortController();
    const tick = async () => {
      try {
        const res = await fetch('/voice-practice/state', { signal: controller.signal, cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        if (!stopped) setRemote(await res.json());
      } catch (err) {
        if (!stopped && !controller.signal.aborted) setRemote(prev => ({ ...prev, error: String(err?.message || err) }));
      }
      if (!stopped) timer = setTimeout(tick, 800);     // 上一个请求结束后再排下一次，避免堆积
    };
    tick();
    return () => { stopped = true; clearTimeout(timer); controller.abort(); };
  }, []);
  return remote;
}
```

- 800–1000 ms 足够；不要 `setInterval` + 并发请求（慢请求会堆积）。
- 组件卸载必须 `clearTimeout + abort`；`ctx.effect` 里也可再做一层兜底清理（voice-call 把所有 timer/audio 都挂到 `ctx.effect`，`client.js:6-8, 2287-2342`）。
- 状态字段建议最小化：`{ phase, sessionId, line, error, audioRev, serverTime }`；客户端只信任本页 `sessionId` 与 `remote.sessionId` 是否一致来提示"会话已切换"。

### 3.6 音频播放（可选；v0.4 若 Host 直接 `say`/播放则不需要）【源码】

voice-call `client.js:682-694, 908-940` 的要点（同源 URL 或 blob 二选一）：

```js
let audioEl = null;

function stopAudio() {
  if (!audioEl) return;
  try { audioEl.pause(); audioEl.src = ''; } catch {}
  audioEl = null;
}

function playUrl(url, { rate = 1 } = {}) {
  stopAudio();
  const audio = new Audio(url);            // 同源 /voice-practice/audio/last.wav?rev=N
  audio.preservesPitch = true;             // 变速不变调
  audio.playbackRate = rate;
  audioEl = audio;
  audio.onended = () => { if (audioEl === audio) audioEl = null; };
  audio.onerror = () => { if (audioEl === audio) audioEl = null; };
  return audio.play().catch(() => stopAudio());
}

function playBlob(blob, { rate = 1 } = {}) {           // Host 返回音频字节时
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  audio.onended = audio.onerror = () => { URL.revokeObjectURL(url); };
  return playUrl(url, { rate });
}
```

- Host 返回音频的标准写法见 §2.3 `sendAudio`（`content-type: audio/wav` + `cache-control: no-store`）。
- 打断：`stopAudio()` + `POST /voice-practice/control {action:'interrupt'}`；voice-call 的语义是"只停朗读，不停 Agent"（`client.js:1545-1552` 注释）。
- 不要用 `<audio autoplay>` 依赖用户手势的策略问题；由用户点击"开始"后首次播放，之后的程序化 `play()` 一般可用（Electron 默认放行；**未实测**）。

---

## 4. 最小可用骨架：浮层 + 轮询 + 两个按钮

### 4.1 client.js（完整可跑骨架，纯手写、无 JSX、无构建）

```js
window.__ModuleLoader__.load({
  id: 'dsh-voice-practice',
  factory: (require) => {
    const React = require('react');
    const { useEffect, useRef, useState } = React;
    const h = React.createElement;

    const POLL_MS = 800;
    const INSTANCE = Math.random().toString(36).slice(2, 10);   // 本次页面实例 id，用于 Host 收敛多窗口
    let pluginCtx = null;
    let sessionCtx = null;
    let disposeSlot = null;

    function sessionIdNow() {
      try {
        const snapshot = (sessionCtx || pluginCtx)?.uiSession?.current?.getSnapshot?.();
        return snapshot?.key || snapshot?.sessionId || null;
      } catch { return null; }
    }

    function postControl(payload) {
      return fetch('/voice-practice/control', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        cache: 'no-store',
      }).then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || 'HTTP ' + res.status);
        return body;
      });
    }

    function Overlay() {
      const [remote, setRemote] = useState({ phase: 'idle', sessionId: null, error: null });
      const [busy, setBusy] = useState(false);
      const [notice, setNotice] = useState('');
      const audioRef = useRef(null);
      const lastAudioRev = useRef(0);

      // 轮询 Host 状态
      useEffect(() => {
        let stopped = false, timer = null;
        const controller = new AbortController();
        const tick = async () => {
          try {
            const res = await fetch('/voice-practice/state', { signal: controller.signal, cache: 'no-store' });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const next = await res.json();
            if (!stopped) {
              setRemote(next);
              // 有新音频就播（可选；Host 用 audioRev 标记）
              const rev = Number(next.audioRev || 0);
              if (rev > lastAudioRev.current && next.phase === 'speaking') {
                lastAudioRev.current = rev;
                if (audioRef.current) { try { audioRef.current.pause(); } catch {} }
                audioRef.current = new Audio('/voice-practice/audio/last.wav?rev=' + rev);
                audioRef.current.play().catch(() => {});
              }
            }
          } catch (err) {
            if (!stopped && !controller.signal.aborted) setRemote(p => ({ ...p, error: String(err?.message || err) }));
          }
          if (!stopped) timer = setTimeout(tick, POLL_MS);
        };
        tick();
        return () => {
          stopped = true; clearTimeout(timer); controller.abort();
          if (audioRef.current) { try { audioRef.current.pause(); } catch {} audioRef.current = null; }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      const sessionId = sessionIdNow();
      const phase = busy ? '忙碌…' : String(remote.phase || 'idle');
      const active = remote.phase && remote.phase !== 'idle';
      const mismatch = active && sessionId && remote.sessionId && sessionId !== remote.sessionId;

      const control = (action) => async () => {
        setBusy(true); setNotice('');
        try {
          await postControl({ action, sessionId: sessionId || undefined, instance: INSTANCE });
          setNotice('已发送 ' + action);
        } catch (err) {
          setNotice(String(err?.message || err));
        } finally { setBusy(false); }
      };

      return h('div', { style: S.wrap },                       // pointer-events: none 的整屏壳
        h('div', { style: S.card },                            // pointer-events: auto 的卡片
          h('div', { style: S.title }, '🗣 语音练习'),
          h('div', { style: S.row }, '状态：', h('b', null, phase)),
          h('div', { style: S.hint }, sessionId ? '会话：' + String(sessionId).slice(0, 12) : '未选择会话'),
          mismatch ? h('div', { style: S.warn }, '注意：正在进行的练习属于另一个会话') : null,
          remote.error ? h('div', { style: S.warn }, 'Host：' + remote.error) : null,
          notice ? h('div', { style: S.hint }, notice) : null,
          h('div', { style: S.buttons },
            active
              ? h('button', { type: 'button', style: S.danger, disabled: busy, onClick: control('stop') }, '结束')
              : h('button', { type: 'button', style: S.primary, disabled: busy || !sessionId, onClick: control('start') }, '开始'),
            h('button', { type: 'button', style: S.ghost, disabled: busy || !active, onClick: control('interrupt') }, '打断'),
          ),
        ),
      );
    }

    const S = {
      wrap: { position: 'fixed', right: 18, bottom: 84, zIndex: 30, pointerEvents: 'none', font: "12px/1.45 system-ui,-apple-system,'Segoe UI',sans-serif" },
      card: { pointerEvents: 'auto', width: 232, padding: '10px 12px', borderRadius: 12, background: 'var(--dsw-alias-bg-overlay,#FFFFFF)', border: '1px solid var(--dsw-alias-border-l2,#E5E9F2)', boxShadow: '0 8px 24px rgba(0,0,0,.16)', color: 'var(--dsw-alias-label-primary,#1F2937)' },
      title: { fontWeight: 600, marginBottom: 6 },
      row: { display: 'flex', gap: 6, alignItems: 'baseline' },
      hint: { color: 'var(--dsw-alias-label-secondary,#6B7280)', marginTop: 4 },
      warn: { color: 'var(--dsw-alias-state-warn-primary,#B45309)', marginTop: 4 },
      buttons: { display: 'flex', gap: 8, marginTop: 10 },
      primary: { flex: 1, padding: '6px 10px', borderRadius: 8, border: '0', cursor: 'pointer', background: 'var(--dsw-alias-button-primary-fill,#4D6BFE)', color: 'var(--dsw-alias-label-primary-foreground,#fff)' },
      danger: { flex: 1, padding: '6px 10px', borderRadius: 8, border: '0', cursor: 'pointer', background: '#DC2626', color: '#fff' },
      ghost: { flex: 1, padding: '6px 10px', borderRadius: 8, cursor: 'pointer', background: 'transparent', border: '1px solid var(--dsw-alias-border-l2,#E5E9F2)', color: 'inherit' },
    };

    return {
      name: 'voice-practice',
      inject: ['slots'],                       // shell.overlay 来自 slots；uiSession 用 ctx.inject 选捕获
      apply(ctx) {
        pluginCtx = ctx;

        // —— 单实例 ownership（防 HMR 重复挂载）——
        const self = { dispose: null };
        self.dispose = () => {
          try { disposeSlot?.(); } catch {}
          disposeSlot = null;
          if (window.__dshVoicePracticeOwner === self) window.__dshVoicePracticeOwner = null;
        };
        const previous = window.__dshVoicePracticeOwner;
        if (previous && previous !== self && typeof previous.dispose === 'function') {
          try { previous.dispose(); } catch {}
        }
        window.__dshVoicePracticeOwner = self;
        ctx.effect(() => () => self.dispose(), 'voice-practice: dispose overlay');

        // —— 捕获 uiSession（可缺；缺失时浮层显示"未选择会话"）——
        ctx.inject(['uiSession'], (scoped) => {
          sessionCtx = scoped;
          scoped.effect(() => () => { if (sessionCtx === scoped) sessionCtx = null; }, 'voice-practice: release uiSession');
        });

        // —— 注册浮层 ——
        disposeSlot = ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'dsh-voice-practice', order: 880 }, Overlay),
        );
      },
    };
  },
});
```

> 小细节：`pluginCtx`（apply 拿到的 Cordis ctx）放在 factory 闭包里由组件读取，与 voice-call 的写法一致；`INSTANCE` 每次页面加载随机生成，Host 可据此只接受最新窗口的控制请求。若 `uiSession` 一直等不到（浮层显示"未选择会话"），在 package.json 的 `dsh.client.inject` 里补上 `@deepseek-ai/dsh-client-ui-session`（voice-call 只写了 layout，因为基础 Web 组合总会先加载 ui-session）。

### 4.2 需要同步给 Host 契约的点

1. `GET /voice-practice/state` 返回 `{phase, sessionId, line, error, audioRev, serverTime}`，且 `cache-control: no-store`。
2. `POST /voice-practice/control` body `{action:'start'|'stop'|'interrupt', sessionId?, instance?}`，返回 `{ok, phase}` 或 `{error}`。
3. `start` 的 `sessionId` 来自客户端 `uiSession.current`；Host 校验该会话存在（`ctx.sessions.get(id)` / `ctx.agents.get(id)`），不存在返回 400。
4. 停止/结束时 Host 必须自己把 `phase` 置回 `idle` 并释放 ffmpeg/播放进程，客户端不负责资源回收。

---

## 5. 无浏览器契约自测（强烈建议复制）

voice-call 用两个 Node 脚本在**没有浏览器/没有 DSH** 的情况下验证包与客户端 bundle：

1. `scripts/check-package.mjs`（72 行）：检查 `package.json` 无 BOM、必填字段、`dsh.bundle.patch`、`dsh.client.platform==='web'`、`exports['./client']`、locale 的 `meta.title/description`、`client.js` 含 `window.__ModuleLoader__.load`（`check-package.mjs:18-38, 63-64`）。**一条 UTF-8 BOM 就能让 DSH 跳过整个 bundle**（脚本头注释）。
2. `scripts/smoke-client.mjs`（255 行）：stub `window.__ModuleLoader__`、`React`、`fetch`、`Audio`、`localStorage`，用 `new Function(source)()` 执行 bundle，然后：
   - 断言 `loaded.id`、`factory.length===1`、`plugin.apply/name/inject`（`smoke-client.mjs:49-61`）；
   - 用 stub `ctx`（`effect/inject/slots/sessions/uiSession`）调用 `plugin.apply`，断言只注册一次 `shell.overlay`、id/order 正确（`:63-98`）；
   - 用一个极简 `render()` 递归函数渲染组件树并查按钮/输入（`:100-135`）；
   - 断言 overlay wrapper `pointerEvents==='none'`、按钮 `'auto'`（`:139-147`）。
   这套 harness 可以直接改成我们的包：改 `id`、slot id、按钮文案、fetch stub 的 URL 即可。**建议 v0.4 先写这个测试，再接 Host**——浮层回归成本极低。

---

## 6. 未验证点 / 风险清单

1. **`shell.overlay` 是内部契约**：槽名、`kind:'list'/scope:'root'`、overlay 层 CSS 都来自 0.2.1-rc.3 构建产物（ui-layout client.js:73,313,344-353,643-646），官方 README 未逐条承诺；跨版本升级需回归（voice-call 也依赖它）。
2. **`uiSession.current.getSnapshot().key`** 是构建产物形状（ui-session client.js:1012-1031,1050-1063）；`.sessionId` fallback 当前不存在。若 DSH 改字段，sessionId 可能变 null（浮层应降级为"未选择会话"而不是崩溃）。
3. **Desktop 相对 fetch 路径**：以 0.2.1-rc.3 Electron `lib/main.js` 的 `dsh-app://` + `forwardWebRequest` 为准（`:12406-12415, 8268-8299`）；dsh-host-webserver README.zh.md:12 的 "file:// + IPC" 与实际不一致。**未实测**我们的 `/voice-practice/*` 在 Desktop 下是否 100% 走同一条转发（机制上同源相对 URL 应一致，但 slot/权限无差异才成立）。
4. **sameOrigin 不是鉴权**：无 Origin 的请求直接放行（Desktop 转发正是这样），自定义路由对 loopback 本机进程完全开放。不要返回密钥、不要执行破坏性操作；服务保持绑 `127.0.0.1`（webserver 本身拒绝 wildcard，`index.js:255`）。
5. **路由重复注册**：`register` 对相同 (kind,path) 抛错（`index.js:326-333`）；热重载若未先 dispose 旧路由会报错——ownership + `ctx.effect` 必须配套（参考实现把 register 放 effect 里，teardown 自动删）。
6. **`dsh.client.immediately` 的真实时序**：字段被 client-modules 解析（0.2.1-rc.3），但"启动即物化 vs 首次使用物化"的差异**未实测**；若浮层出现时机不对，去掉该字段用默认懒加载。
7. **多窗口/多页面**：两个 Web 页面同时打开时都会轮询和发控制；Host 需要按 `instance` 或"最后点击者优先"收敛（voice-call 只在 body 里记录 instance 用于诊断，未做互斥——我们要求做，否则会双开控制）。
8. **音频播放策略**：Electron/Chromium 对无用户手势的 `play()` 可能拒绝（本配方首次播放由"开始"按钮触发，通常没问题）；`audioRev` 轮询换 URL 时若上一段未播完需要 `pause()`。**未实测**。
9. **我们的 Host 半不能只靠本文件**：`bindControl/publish` 需要 voice-core 在 start/stop/phase 变化时调用（v0.4 其它任务的接口对齐点）；若 Host 侧用独立 worker/子进程，状态需跨进程同步到一个内存状态对象（本配方假设同进程）。
10. **安装后的加载顺序**：client 半由 Host Loader 条目发现（`dsh.client`），所以 `cordis.patch.yml` 的 Host 行必须存在且包在 profile bundles 里；只放 `client.js` 不会出现浮层。

---

## 7. 证据索引

| 结论 | 证据（仓库/DSH 解包） |
|---|---|
| ModuleLoader wrapper + 导出 | `/tmp/dsh-voice-call/client.js:16-21, 2287-2342` |
| shell.overlay 注册 + pointer-events | `client.js:2338-2340`；`dsh-client-ui-layout/lib/client.js:73, 313, 344-353, 643-646` |
| sessionId 获取 | `client.js:1377-1384, 2329-2337`；`dsh-client-ui-session/lib/client.js:1012-1031, 1050-1063` |
| ownership token | `client.js:2301-2328` |
| 轮询/音频播放 | `client.js:682-694, 718, 908-940`；Host 音频响应 `index.js:425-431` |
| webServer.register | `dsh-host-webserver/lib/index.js:107, 249-291, 320-333, 494-505` |
| 无服务器级鉴权 | `dsh-host-webserver/README.zh.md:130` |
| Desktop 转发/Origin 剥离 | app.asar `lib/main.js:12134, 12406-12415, 8229-8236, 8268-8282` |
| sameOrigin/readBody/sendJson | `/tmp/dsh-voice-call/index.js:163-194` |
| 无浏览器契约测试 | `scripts/smoke-client.mjs:23-98,139-147`；`scripts/check-package.mjs:18-38,63-64` |
| 安装/兼容声明 | `/tmp/dsh-voice-call/package.json:49-65`；`README.md:72-93, 214-227` |
# DSH 插件扩展落点调研笔记（英语口语语音对话插件）

> 调研对象：macOS 桌面版 DSH 0.2.1-rc.3（/Applications/DeepSeek Harness.app，Web GUI http://127.0.0.1:54302）。
> 方法：解包 app.asar（`/tmp/dsh-asar-extract`，data base=4748716）、读已安装包 README/package.json/lib 构建产物、读第三方插件 dsh-context 与 ds-bot。
> 标注约定：**【README】**=包 README 明文；**【构建产物】**=从 lib/*.js 打包代码推断（无公开文档）；**【未验证】**=本次未实测。
>
> 任务目标：用户说话→自动提交；助手回复→自动朗读；支持打断。插件目录：本 workspace。

---

## 0. 结论速览（TL;DR）

| 能力 | 落点 | 结论 | 依据/备注 |
|---|---|---|---|
| 录音 + 转写 | 客户端 | 复用 `ctx.remote.speech.transcribe`（语音输入 Bundle 已启用） | 请求 `{audioBase64, providerId?, language?}`，16kHz mono PCM16 WAV【构建产物】 |
| 自动提交一条用户消息 | **客户端（可行，无需 host）** | `inputActions.setDraft/insertText` → `inputActions.submit()` | actions 面含 `submit`【构建产物】；`inputActions` 是文档化的标准 prop【README】 |
| 候选：host 注入用户轮次 | host | `ctx.agents.get(id).followup(createUserMessage({content, source:{kind:'user'}}))` | 与 Remote `session.prompt` 同一路径【构建产物】 |
| 监听助手回复完成 | host 最稳 | `ctx.on("session/event",(session,event)=>…)`，取 `assistant/message`+`turn/end` | agent-loop 源码即此写法【构建产物】 |
| 自动朗读 | host 推荐（客户端备选） | host: `ctx.subprocess` 跑 macOS `say`；client: Web Speech API（未验证） | DSH 无内置 TTS【README】；subprocess 服务在 desktop 已启用【构建产物】 |
| 打断 | 取决于 TTS 落点 | host: `handle.terminate()` 杀 `say`；client: `speechSynthesis.cancel()` | 详见 §4 风险 |
| 最小可行形态 | 1 个 npm 包、两半 | host 行（可空 apply）+ `./client` bundle + `cordis.patch.yml` | 官方 voice-input 包即同构【构建产物】 |

**一句话**：自动提交与录音/转写可以纯客户端完成；"助手回复自动朗读"建议放 host（`session/event` + `subprocess say`，两项 API 都已验证），代价是"只读当前练习会话/打断"需要自己加过滤与一条 client→host 控制通道（见 §4.4）。**不要**指望现有 voice-input 自动发送——它明确不做【README】。

---

## 1. 本地插件包最小结构 & desktop profile 如何加载

### 1.1 最小包结构（一个包同时提供 host 半 + 浏览器半）

```text
练习口语/
├── package.json          # name/type/main/exports/./client/dsh.bundle/dsh.client
├── cordis.patch.yml      # bundle patch：insert 一条 host Loader 行（name=包名）
├── lib/
│   ├── index.js          # host 插件：export { name, inject?, Config?, apply }
│   └── client.js         # 浏览器 bundle：window.__ModuleLoader__.load({ id:'<包名>', factory })
├── icon.svg              # 可选，插件页展示
└── locale/*.json         # 可选，插件展示文案
```

`package.json` 关键字段（参照官方 `@deepseek-ai/dsh-experimental-client-ui-voice-input/package.json` 与第三方 dsh-context）：

```jsonc
{
  "name": "dsh-voice-practice",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": { "types": "./lib/index.d.ts", "default": "./lib/index.js" },
    "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" },
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": ["@deepseek-ai/dsh-api-remotes", "@deepseek-ai/dsh-client-ui-conversation"]
      // "external": ["包外模块请求"], "immediately": true 可选
    }
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "~4.0.5",       // 由 runtime resolution 提供，见 1.4
    "@deepseek-ai/dsh-llm": "0.2.1-rc.3",  // host 侧 createUserMessage 等
    "@deepseek-ai/dsh-session": "0.2.1-rc.3"
  }
}
```

**`dsh.client` 各字段语义（从解析器源码确认）**：`platform` 必填字符串；`inject` 字符串数组 = **"先于本 bundle 加载/注册的包 id 列表"**（client-modules 浏览器侧 `arriveGraphRow` 会先 `arrive` 这些包再 register 本行，因此它们提供 Cordis 客户端服务/模块；见 `dsh-client-modules/lib/client.js:776-794`）；`external` = 本 bundle 静态 `require` 的、**不在平台模块表内**的模块请求（<pkg>/client 会别名到该包 row；见 `lib/index.js:412-444` 的 `orderByModuleGraph`）；`immediately` 可选布尔。解析入口：`dsh-client-modules/lib/index.js:64-73`。dsh.client 本身**只有声明作用**，需要"该包是已启用的 Loader 条目"才会被扫描到（client-modules 扫描 Host Loader 条目）。

### 1.2 desktop profile 的加载方式（app-owned profile，不是 CLI profile）

- Desktop 主进程启动 host 时调用：`loadProfileDirectory("dsh", projectDir, installAnchor)` 再 `runProfile({profile:'desktop', resolvedProfile:{...}, patchFiles:[]})`【构建产物：`@deepseek-ai/dsh-desktop-host/lib/index.js:218-250`（`loadProfileDirectory` 在 224 行）】。
- app-boot 文档：profile 位于 `$DSH_HOME/profiles/<name>`，由"可安装组合包 + 自己的 cordis.patch.yml"组成；"由应用持有的 npm 项目（例如 Electron 保留的 Desktop profile）通过 `loadProfileDirectory` 加载已经初始化的目录"【README：`dsh-app-boot/README.zh.md:50`】。
- **CLI 明确拒绝 desktop profile**："`desktop` 名称保留给 Electron 持有的 profile，因此 CLI 会拒绝针对它的启动和配置 dump 请求。npm CLI 也会拒绝其插件管理请求；Desktop 内置命令可以使用该安装的运行时管理已初始化的 Desktop profile。"【README：`dsh/README.zh.md:20`】
   ⇒ 不要指望 `dsh plugin --profile desktop add`；用 **Web 侧栏"插件"页（plugin-manager，Desktop 内置 pnpm）** 或手工改 profile。

### 1.3 三条安装路径（推荐顺序）

1. **Web 插件管理页 / `plugin_manager` 工具**（最稳，热生效）：Desktop 里安装走内置 pnpm（desktop-host main 把 `packageManager` 传成 electron 内置 pnpm，见 `dsh-desktop-host/lib/index.js:241-248`）；安装成功后它会写 profile `package.json` 依赖、把 bundle 追加进 `dsh.profile.bundles`、并发布新 runtime resolution，HMR 下无需重启【README：`dsh-plugin-manager/README.zh.md:40,98,100`】。支持 registry 包、本地绝对路径、git、tarball；`file:`/`link:` 路径按 profile 目录解析【README 同文件 44 行】。
2. **手工本地开发（link）**：在 `~/.dsh/profiles/desktop/package.json` 加依赖并追加 bundle：
   ```jsonc
   {
     "dependencies": { "dsh-voice-practice": "link:/Users/eastbuy/Documents/梦想草稿/练习口语" },
     "dsh": { "profile": { "bundles": [ /* 原有… */, "dsh-voice-practice" ] } }
   }
   ```
   然后在 profile 目录 `pnpm install`（ds-bot README 的 dev 写法就是这样：`link:/path/to/ds-bot` + 加入 bundles + 在 profile 目录 `pnpm install` + 启动 dsh；【README：`~/.dsh/profiles/desktop/node_modules/ds-bot/README.md:42-50`】）。
   注意：本机 PATH 上的 pnpm 是 11.7.0 + node 24.18，而 Desktop 内置是 pnpm 11.28.5 + node 24.21（`runtime/versions.json`）；用系统 pnpm 可能改写 `pnpm-lock.yaml`，优先用 Desktop 插件页/内置运行时。**安装新包后建议重启 App**（首次要新建 runtime resolution；未验证仅改 manifest 能否免重启）。
3. tgz/npm 包：插件页安装即可（ds-bot README install 段）。

### 1.4 依赖如何解析（为什么本地包不用装 @deepseek-ai/*）

app-boot 在挂载 profile 条目前，会用"安装依赖图 + 有序 bundle 依赖图"算一份**不可变 runtime resolution** 并装进 Node ESM/CJS resolver；**链接目录**下的 importer 参与逐层 peer 查询，若包 `package.json` 的 peer 名存在于运行时表，就使用运行时包【README：`dsh-app-boot/README.zh.md:67,134`】。
⇒ 本地插件把 `@deepseek-ai/cordis`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-session` 写进 **peerDependencies** 即可，不必在插件目录装依赖；插件目录存在与否不影响，但 `pnpm install` 在 profile 侧要能建链。

### 1.5 cordis.patch.yml（bundle patch / profile patch）写法

- 包自带 patch（被 profile bundles 列出时按顺序叠加）：
  ```yaml
  - insert:
      - id: voice-practice          # Loader 条目 id（唯一）
        name: dsh-voice-practice    # 包标识符；也允许绝对路径 / file URL / 相对 patch 的 ./ 路径
  ```
  真实样例：dsh-context 的 `cordis.patch.yml` 只有一条 `- insert: [{id: dsh-context, name: dsh-context}]`；ds-bot 为 `- insert: [{id: bot, name: ds-bot}, ...]` 再配一条 `- id: web\n  config: {...}`。
- profile 自己的 `~/.dsh/profiles/desktop/cordis.patch.yml`（用户层，最后应用、优先级最高）：可 `insert`、按 id 覆盖 `config`、`disabled: true`；**按 id 定位的覆盖会替换整个配置字段，必须重述要保留的字段**；`!!js` 表达式可用；空文件/纯注释会启动失败（要禁用该层写 `[]`）【README：`dsh-app-boot/README.zh.md:61,204`】。
- 校验/调试：`dsh --dump-config`（profile 级；desktop 用 Desktop 内置命令）【README 同文件 72-79】。

### 1.6 热重载（patchReload）的真实现状 —— 用户给的 "patchReload: live" 未在本机得到证实

- 全量检索 app.asar 数据区：`patchReload` 出现 **0 次**；`~/.dsh/profiles/desktop/package.json` 也**没有**该字段（只有 `~/.dsh/profiles/web/package.json:11` 有 `"patchReload": "live"`）。
- 真正让 patch 热生效的是 base bundle 里的 HMR 行：
  ```yaml
  # @deepseek-ai/dsh-base/cordis.patch.yml:27-32
  - id: hmr
    name: '@deepseek-ai/dsh-hmr'
    disabled: !!js "!ctx.get('profileContext')"
    config:
      root: []
  ```
  Desktop 有 `profileContext` ⇒ HMR 启用；`root: []` ⇒ **只监听 profile manifest 与两份用户 patch 文件**（不监听源码模块）【README：`dsh-hmr/README.zh.md:27-36,59`；`dsh-app-boot/README.zh.md:63`】。
  ⇒ **改 `cordis.patch.yml` / profile `package.json` 的 bundles 列表可实时重组合，无需重启**（编辑后 Chokidar `awaitWriteFinish` 默认 2s 稳定窗）。
- 代码/客户端 bundle 更新：HMR 会替换 profile 目录内**已加载文件发生变化**的插件（含 node_modules 下已安装包与 link 目标），但发生在"下一次 profile 重新组合"时（HMR 监听到 patch/manifest 变化或 plugin-manager 操作）【README：`dsh-hmr/README.zh.md:49`】；浏览器侧 bundle 变更只能经 `rebuilt()`（HMR 钩子）进图【README：`dsh-client-modules/README.zh.md:77,79`】。**未验证**：本地 link 包的 lib/client.js 重建后是否需要刷新页面/重启（保守做法：改客户端半后刷新 Web GUI；首次安装后重启 App）。

---

## 2. 客户端 UI 插件契约

### 2.1 客户端 bundle 的入口格式（可自建构建链，不强制官方 monorepo）

**格式（两份真实产物完全一致）**：

```js
window.__ModuleLoader__.load({
  id: 'dsh-voice-practice',            // 必须等于包名（模块系统按包名做身份）
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    // ...require 平台模块、定义组件...
    return Object.defineProperty({ ...module.exports }, Symbol.toStringTag, { value: 'Module' })
  },
})
```

证据：
- `@deepseek-ai/dsh-experimental-client-ui-voice-input/lib/client.js:1-10`（官方 tsdown 产物）；
- `~/.dsh/profiles/desktop/node_modules/dsh-context/lib/client.js`（tsdown 产物，`window.__ModuleLoader__.load({id:'dsh-context',factory:e=>{...}})`，末尾导出 `{name,inject:['slots','locale'],apply}`）；
- `~/.dsh/profiles/desktop/node_modules/ds-bot/client.js` 第一行注释：`// Generated from src/client by `npm run build` (scripts/build-client.mjs). Do not edit by hand.` —— **第三方插件用自家 esbuild 脚本产出同格式 bundle**。
⇒ **可以不用官方 DSH 仓库构建链**：手写或用 esbuild 打成一个自包含 IIFE 包进 `window.__ModuleLoader__.load` 即可；CSS 用 `document.head.appendChild(<style>)` 注入（dsh-context 即如此）。

**导出契约**：客户端插件模块导出 `{ name, inject: ['slots','locale','remote',…], apply(ctx) }`（Cordis 客户端服务名，注意与 package.json 的 `dsh.client.inject` 包 id 列表不是一回事）。voice-input：`const inject = ["remote","slots","locale","pluginNavigation"]`（client.js:2869-2874）；dsh-context：`inject:["slots","locale"]`。

**可 require 的模块**：平台模块表（冻结的 seed 表）。`ds-bot` 的 `dsh.client` 只写 `{platform:'web'}`，却 require 了 `react`、`react-dom`、`@deepseek-ai/dsh-client-ui-primitives` ⇒ 这三者属于基线外置；voice-input 另外从 `@deepseek-ai/dsh-api-gateway/client` 取值并把该 specifier 写进 `dsh.client.external`（因为它在基线之外）。**安全做法**：客户端 bundle 只 require `react` / `react/jsx-runtime` / `@deepseek-ai/dsh-client-ui-primitives`；需要其它包时先查 `dsh-web/README` 的 PLATFORM_MODULES（本笔记未展开）或写进 `external`。

### 2.2 Slot 注册基本写法

```js
export const inject = ['slots', 'locale']
export function apply(ctx) {
  ctx.effect(() => ctx.locale.register('voice-practice', { en, zh }), 'dictionaries')
  // 必须用 slots.inject：等 slot 声明、声明折叠时移除、恢复后重新注册
  ctx.slots.inject('conversation.input.right', () =>
    ctx.slots.register({
      name: 'conversation.input.right',
      id: 'voice-practice.mic',
      order: 100,
      locale: 'voice-practice',
      inject: () => ({ startPractice }),   // 只注入投影后的数据/回调
    }, MicButton),
  )
}
```
【README：`dsh-client-ui-workspace/README.zh.md:110-171` 的完整示例；README 明确"即使 owner 通常已存在也必须用 `ctx.slots.inject()`"】。
实例：voice-input 注册 `conversation.input.activity`（单值 slot）与 `plugins.bundle.config/activation`（client.js:2919-2935）。

**slot 选择注意**：`conversation.input.activity` 是 `kind:"single"`（`dsh-client-ui-conversation/lib/client.js:20093-20112`），**已被官方 voice-input 占用**——若两个都启用会冲突。可选：
- `conversation.input.right` / `conversation.input.left`（`kind:"list"`，可追加按钮，scope=session）；
- 或禁用官方 voice-input bundle，由本插件接管 `conversation.input.activity`；
- 悬浮层可用 `shell.overlay`（ui-chat 即注册在 shell.overlay，README 可见）。

### 2.3 录音与 speech remote（现成 voice-input 的做法，可直接照抄）

- 录音实现（`dsh-experimental-client-ui-voice-input/lib/client.js`）：`getUserMedia`（1532 附近，带设备选择）→ `new MediaRecorder(stream)`（1573-1577）→ 停止时取最后一块、WebAudio 重采样 → `encodeWave(samples)` 生成 **16 kHz mono PCM16 WAV**（1471、1658）→ `audioBase64(audio)`（1501、1916）。浏览器麦克风需 HTTPS 或 loopback + 系统权限【README：该包 28 行】——desktop 加载 `http://127.0.0.1` 满足 loopback。
- 转写调用：`ctx.remote.speech.transcribe({ audioBase64, ...selection }, signal)`，返回 `{ ok, value: { text } }` / `{ ok:false, error }`（client.js:1915-1922、2905-2917）。
- 语音偏好/准备：`ctx.remote.speech.catalog()/follow(signal)/configure(patch)/prepare(id,opts)/cancelPreparation(id)`【构建产物：`dsh-experimental-api-speech-to-text/lib/types/index.js:78-138`】。

**`speech.transcribe` Remote 契约（host 侧实现，权威）**：
- 入参 `request = { audioBase64: string, providerId?: string, language?: string }`、`signal: AbortSignal`；
- 服务端先做 canonical base64 校验 + `maxAudioBytes`（默认 4 MiB）与 `maxDurationSeconds`（默认 120s）限制 + `validateWave`（16kHz mono PCM16 WAV）；
- 内部 `ctx.speechToText.resolve({audio, providerId?, language?})` → `transcribe(spec, signal)`；失败统一抛 `RemoteError('speech/transcription-failed')`；**不写 Session 事件、不是附件、不流式、无 TTS**。
- 证据：`dsh-experimental-api-speech-to-text/lib/types/index.js:114-138`【构建产物】；README 说明同样语义【README：`dsh-experimental-api-speech-to-text/README.zh.md:40-42`、`dsh-experimental-speech-to-text/README.zh.md:70`】。

### 2.4 聊天"发送消息/提交草稿"的确切客户端 API —— 自动提交可行

两条层次：

**(A) 推荐：Session 作用域 slot 组件的标准 prop `inputActions`**（voice-input 的 `VoiceInput` 组件就是从 props 拿到的）
- `uiSession.provide({hooks:['conversation','input'], props:['inputActions'], resolve: … props:{inputActions: shell.actions}})`【构建产物：`dsh-client-ui-conversation/lib/client.js:19897-19913`】；README 明确"通过 `ctx.uiSession` 提供 `useConversation`、`useInput` 和 `inputActions` 标准 props"【README：`dsh-client-ui-conversation/README.zh.md:14,87`】。
- `shell.actions` 的完整方法（构建产物，未文档化）：`captureInsertion()`、`insertText(text, span)`、`setDraft(text)`、`persistDraft()`、`addAttachments(ids)`、`removeAttachment(id)`、`pruneAttachments(ids)`、**`submit()`**【`client.js:14941-14967`】。
- `submit()` 无参 = `this.submit("queue")`；`submit(mode, source)` 会走提交状态机（plain→adjudicating→submitting），最终 `defaultSink` → `conversation.sendSession(session, text, attachmentIds, mode, signal)` → `session.beginSubmission(...)` + `session.prompt(content, mode, …)` → `remote.session.prompt({requestId, sessionId, mode, content, clientTimeZone}, signal)`【`client.js:15202-15256, 15939-15941, 4685-4740`；`dsh-api-session-controller/lib/client.js:2341-2376`】。
- ⇒ **自动提交写法**：录音期间 `span = inputActions.captureInsertion()`；转写成功后 `inputActions.insertText(text, span)`（voice-input 同款，失败返回 false 表示草稿已变，可退回"插入到当前光标"）→ 然后 `inputActions.submit()`。若想覆盖草稿：`inputActions.setDraft(text)` 再 `submit()`。
- 风险（未文档化 API）：`submit` 未写进 README，属构建产物推断；`insertText/setDraft` 后立即 `submit()` 是否已看到新草稿（编辑器状态是否同步发布）**未验证**——实现时加 `queueMicrotask`/一帧再提交并做兜底。
- 语义：空闲时 "queue" 直接进入 transcript（普通发送）；运行中则按 busy-Enter 策略排队（"queue"）而非 steer（`dsh-client-ui-conversation/README.zh.md:99-107` 描述了乐观提交与 Queue/Steer 行为）。

**(B) 更底层（不推荐给第三方）：`ctx.remote.session.prompt`**
- 请求体：`{ requestId, sessionId, mode: 'queue'|'steer', content: [{type:'text',text}], clientTimeZone? }`，返回 `RemoteResult<{accepted:true}>`；host 端会 `agent.followup(message)`（queue）或 `agent.steer(message)`（steer）【构建产物：`dsh-api-session-controller/lib/client.js:2350-2356`、`lib/index.js:925-966`】。但没有 `beginSubmission` 回显与草稿/附件编排，容易产生"消息已发但 UI 无回显/重复"问题。

---

## 3. host 侧能力

### 3.1 监听 assistant 消息完成（事件名/服务）

**最稳：`ctx.on("session/event", (session, event) => …)`**（dsh-session 持久化、agent-loop 内部都用它；README："持久存储由订阅 `session/event` 流的持久化插件叠加"【README：`dsh-session/README.zh.md:28`】）。

- 事件 `assistant/message`：`data = { turn, step, message, usage?, stream? }`，`message.role==='assistant'`，`message.content` 为 block 数组（`text` / `tool-call` 等）。追加位置【构建产物：`dsh-agent-loop/lib/index.js:1156-1162`；中断时 1098-1112 也追加，带 `interrupted:true`】。
- 事件 `turn/end`：`data = { turn, reason }`，`reason.kind` ∈ `completed` / `blocked` / `max-tokens` / `error`（含 error）/ `aborted`（含 reason）【`dsh-agent-loop/lib/index.js:1029-1032`，reason 赋值见 955-1025】。
- 另有派发事件 `agent/status`（`{status:'running'|'idle'}`，`dsh-agent-loop/lib/index.js:790-800`）、`agent/assistant-stream`（流式帧，1080）、`agent/inbox/inserted|claimed` 等。
- 监听写法在 agent-loop 自身出现：`ctx.on("session/event", (subject, event) => { if (subject !== session) return; … })`【319-334】；session projections 的注册表也只用一次 `session/event` 驱动【README：`dsh-session-projection/README.zh.md:83`】。
- 朗读取文本：收集本轮 `assistant/message` 里最后一条（或 `turn/end reason.kind==='completed'` 前最后一条），过滤 `content.filter(b=>b.type==='text').map(b=>b.text).join('\n')`；注意工具调用轮可能有多条 assistant/message，按 turn 聚合、只在 turn 结束朗读。

### 3.2 插件能否注入一条用户消息开启新一轮？——能（同一进程内）

- Agent 服务：`ctx.agents`（`AgentRegistry extends Service`，`super(ctx,"agents")`）【构建产物：`dsh-agent/lib/index.js:322-332`】；实际 Agent 由 `@deepseek-ai/dsh-agent-loop` 的 `AgentLoop` 创建（service `agentLoop`，1543-1572）。
- Agent 公开方法（`dsh-agent-loop/lib/index.js:790-816`）：
  ```js
  get status()                       // 'idle' | 'running'
  followup(input)                    // = send(input, 'next-turn', true)  唤醒新一轮
  steer(input)                       // = send(input, 'next-step', true)   打断当前步插入
  inject(input)                      // = send(input, 'next-step', false)  只入队不唤醒
  cancel(cause, {keepInbox?})
  ```
- 构造用户消息：`createUserMessage({ content, source })`（= `createMessage({...input, role:'user'})`，深冻结+新 id）【构建产物：`@deepseek-ai/dsh-llm/lib/types/message.js` 的 `createUserMessage`】；source 形状与 Remote 提交流一致：`{kind:'user', rpcId?, clientTimeZone?, principal?}`【`dsh-api-session-controller/lib/index.js:3249-3261` 的 `prompt()`，字段名实际为 `kind:'user'`】。
- 最小用法：
  ```js
  import { createUserMessage } from '@deepseek-ai/dsh-llm'
  const agent = ctx.agents.get(sessionId)        // 仅"已加载/有 live Agent"的会话
  if (agent) {
    agent.followup(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }))
  }
  ```
- 约束/风险：冷会话（未打开）没有 live Agent，需要先走 resume/create（API 在 AgentLoop/AgentRegistry 里，本次未细读，标记**未验证**）；直接用 followup 注入的消息没有 rpcId，UI 侧可能没有本地乐观回显（会等 Host 权威记录），不影响落库与模型。
- 结论：host 侧完全有能力"注入用户消息开启新一轮"；但对本插件而言，**用户语音输入走客户端自动提交更自然**（有草稿回显、可编辑），host 注入更适合"自动循环/定时提问"这类场景。

### 3.3 `ctx.speechToText` 接口签名（dsh-experimental-speech-to-text）

源文件 `lib/index.js`（201 行，Service `super(ctx,"speechToText")`；Config `{defaultProvider: string(必填, volatile), language: string 默认 'auto'(volatile)}`，第 6-11 行）：

| 方法 | 签名（行为） |
|---|---|
| `listProviders()` | → `provider.info[]`（id/languages/location/preparation 等） |
| `snapshot()` | → `{providers:[{...info, preparation:{phase,…}}], selection:{providerId,language}}`（104-115） |
| `follow(caller: AbortSignal)` | async generator，初始快照 + 变更快照；caller abort 结束（75-99） |
| `configure(patch {providerId?, language?})` | 写回本插件 profile 条目（需 settings 服务 + profile entry），再校验 language（121-131） |
| `prepare(id, options?)` | 启动/加入 provider 自己的准备任务（143-147） |
| `cancelPreparation(id)` | 取消准备并等 settlement（153-157） |
| `resolve(request {audio, providerId?, language?})` | → `{provider, audio, language}`；缺 provider/不支持语言抛错（163-171） |
| `transcribe(spec, signal)` | 只走已 resolve 的 provider，不 fallback；`AbortSignal.any([signal, registration.lifetime])`；取消语义 = 调用方 abort → provider 收到 aborted signal，注册移除也会取消+等待；返回 provider 的最终转写结果（178-198） |
| `register(provider)` | 注册识别器（provider: `{info:{id,languages,…}, preparation?, transcribe(input,signal)}`），返回幂等 disposer（35-59） |
| `remove(registration)` | 内部（52-59） |

补充：`prepare` 的 options 支持 `{downloadSource?}`（API 包 README 30 行）；`./wave` 子路径导出 `validateWave`（校验 16kHz mono PCM16 WAV）。语音服务**只有完整录音转写，没有流式识别或语音合成方法**【README：该包 70 行】。

host 插件直接用 `ctx.speechToText` 需自己从浏览器拿音频（没有现成 Remote 给第三方自定义插件用），因此**更实际的复用路径是客户端调 `ctx.remote.speech.transcribe`**（voice bundle 已启用，见 §1/§2.4）。custom Remote 需要 typert 生成产物 + `ctx.remote.$mount(contribution)`，绑定官方构建链，本次不作为推荐路线。

### 3.4 执行外部命令 & 播放音频（host）

- 服务：`ctx.subprocess`（desktop profile 已启用：base patch 的 `- id: subprocess\n  name: '@deepseek-ai/dsh-subprocess-local'`，`dsh-base/cordis.patch.yml:234-235`）。
- API【README：`dsh-subprocess/README.zh.md` "启动受管进程" 段】：
  ```js
  const exe = await ctx.subprocess.resolveExecutable('say')
  const handle = ctx.subprocess.spawn({
    argv: [exe, '-v', 'Samantha', text],          // argv 不经 shell
    cwd: '/',
    stdio: { stdin: 'ignore', stdout: 'ignore', stderr: { maxBytes: 8192 } },
    graceMs: 1000,
  })
  const { exitCode, signal } = await handle.done
  handle.terminate()      // 幂等；打断朗读 = terminate()（或传 abort signal）
  ```
  输出读取 `handle.collected.stdout?.readFrom(0)`；环境会先清洗凭据与 `DSH_*` 再叠加显式 `env`。
- 播放：macOS `say` 直接朗读（打断 = terminate 进程）；或 `say -o /tmp/x.aiff` 生成文件后 `afplay /tmp/x.aiff`（同样可 terminate）。也可用 `dsh-native-command` 的 open 类能力（本次未展开）。
- 风险：`say` 与 DSH 的**输出设备/音量不隔离**；TTS 声音会被麦克风回采（需要耳机或 AEC）；多会话/子代理同时回复会一起朗读（需要过滤，见 §4.4）。**未验证**：Desktop Host 子进程是否有额外沙箱/权限限制（subprocess service 文档未提限制；Host 插件代码不受 workspace 沙箱约束【README：`dsh-plugin-manager/README.zh.md:31`】）。

### 3.5 插件自定义 client↔host 通道（如需要）

- Host 可注册 HTTP 路由：`ctx.webServer.register({kind:'exact'|'prefix', path, handler})` / `registerUpgrade` / `collectIndexInjections`【README：`dsh-host-webserver/README.zh.md:59-67`】。
- 但 Desktop 的渲染进程是 `file://` 加载 dist + IPC fetch 桥（README 同文件 12 行）⇒ 从客户端 bundle 里 `fetch('/custom/route')` 的 URL 形态**未验证**；Web GUI（http://127.0.0.1:54302）下同源 fetch 应可行，但 Desktop shell 下不一定。
- 自定义 Remote：`ctx.remote.$mount(contribution)`（voice-input 就是这么挂 speech 的，client.js:2943-2961），但 contribution 来自 typert 生成的 `/remote` 产物，**绑定官方构建链**；api-remotes 的能力集合是构建期固定的（README：`dsh-api-remotes/README.zh.md:77-78`）。
- 简易控制通道（未验证但成本最低）：客户端写 Host settings/插件配置（如 `remote.settings` 或插件 Config），host 侧监听 settings 变更；延迟/可靠性不满足"打断"的实时性。

---

## 4. 结论：client-only 还是 host 插件？

### 4.1 自动提交 —— **客户端即可，无需 host 能力**

录音、转写、插草稿、`inputActions.submit()` 全在浏览器半完成；host 半只需一条空 `apply()` 的 Loader 行（让 client bundle 被扫描到）。这与官方 voice-input 完全同构，仅多一步 `submit()`。

### 4.2 自动朗读 —— 两条路线

**路线 A（推荐 MVP）：host 朗读**
- 文本：`ctx.on("session/event")` 取 `assistant/message` + `turn/end`（§3.1，已验证 API）；
- 播放：`ctx.subprocess` → macOS `say`（§3.4，已验证 API）；
- 打断：`handle.terminate()`；"用户开始说话时打断"需要 client→host 信号（见 4.4，未验证）；
- 优点：全部 API 有源码/文档依据，实现量最小（host 半 ~100 行）。
- 缺点：需要会话范围过滤（多会话/子代理会误读）；client↔host 控制通道有不确定性。

**路线 B：客户端朗读（Web Speech API `speechSynthesis`）**
- 优点：天然只读当前会话（组件在 Session scope）、打断 = `speechSynthesis.cancel()`、无需 host。
- 阻塞点：①客户端拿"最新 assistant 文本"没有现成公开 API——需要 `ctx.uiConversation.events.register` 自定义 Definition 消费 `assistant/message`（机制存在【README：`dsh-client-ui-conversation/README.zh.md:35-49`】，但契约细节未随包发布，**未验证**）或直接调 `ctx.remote.session.page`（内部路径，**未验证**）；②Electron 渲染进程 `speechSynthesis` 可用性/音色**未验证**。
- 结论：作为 Phase 2 的"真打断"方案候选。

**路线 C（折中，若用户接受"先说完再听"）**：host 朗读 + 客户端在 `api-session/status running=false` 后自动重启录音；打断退化为"再次按麦克风即提交新消息，host 收到新 user/message 时先 terminate 当前 TTS"。这样**完全不需要自定义通道**，只是 barge-in 延迟较高。

### 4.3 最小可行插件包清单

```text
dsh-voice-practice/
├── package.json               # §1.1
├── cordis.patch.yml           # - insert: [{id: voice-practice, name: dsh-voice-practice}]
├── icon.svg
├── locale/{en,zh}.json
└── lib/
    ├── index.js               # host: name/inject/Config/apply（监听 session/event + say + terminate）
    ├── index.d.ts             # 可选
    ├── client.js              # §2.1 ModuleLoader bundle（录音/转写/insertText/submit；可选 TTS 指示）
    └── types/client/index.d.ts
```

**host 半骨架**（`lib/index.js`，Cordis 插件格式参照 dsh-context：`export { name, inject, apply, Config? }`）：
```js
export const name = 'dsh-voice-practice'
export const inject = []                       // 用到 ctx.subprocess 时无需声明（Service 通过 ctx.get/inject）
let current = null
export function apply(ctx) {
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/end') { playReply(session, event.data.turn) }
  })
  ctx.effect(() => () => { current?.terminate() }, 'voice-practice: tts')
  async function playReply(session, turn) {
    // 收集本 turn 已落库 assistant/message（可在 turn/end 前用 map 记录，见 §3.1）
    const text = collect.get(session.id)?.get(turn)?.join('\n') ?? ''
    if (!text.trim()) return
    const exe = await ctx.subprocess.resolveExecutable('say')
    current = ctx.subprocess.spawn({
      argv: [exe, '-v', 'Samantha', text],
      cwd: '/', stdio: { stdin: 'ignore', stdout: 'ignore', stderr: { maxBytes: 4096 } }, graceMs: 1000,
    })
  }
}
```
（真实实现需按 `assistant/message` 累积 turn→text，并在 turn/end 时清理；还需"练习模式"开关与会话过滤。）

**client 半骨架**（`lib/client.js`，esbuild 打成单文件；核心逻辑）：
```js
window.__ModuleLoader__.load({
  id: 'dsh-voice-practice',
  factory: (require) => {
    const React = require('react')
    const NS = 'voice-practice'
    const inject = ['remote', 'slots', 'locale']
    function MicButton({ sessionId, inputActions, locked, t }) {
      // 用 getUserMedia+MediaRecorder 录音；停止时：
      // const res = await ctx.remote.speech.transcribe({ audioBase64 }, signal)
      // if (res.ok) { inputActions.setDraft(res.value.text); inputActions.submit() }
    }
    function apply(ctx) {
      ctx.slots.inject('conversation.input.right', () =>
        ctx.slots.register({ name: 'conversation.input.right', id: 'voice-practice.mic', order: 100, inject: () => ({}) }, MicButton))
    }
    return Object.defineProperty({ name: 'dsh-voice-practice', inject, apply }, Symbol.toStringTag, { value: 'Module' })
  },
})
```
（`ctx` 访问方式：组件通过 slot 的 `inject` face 或闭包拿服务；`remote` 作为客户端 Cordis 服务名在 apply 里 `ctx.get('remote')`/inject 使用；具体以 voice-input/client.js 的 `ctx.remote.speech.*` 写法为准。）

### 4.4 明确的风险与不确定点

1. **`inputActions.submit()` 非文档化**：README 只保证 `inputActions` 是标准 prop；`submit` 来自构建产物（client.js:14964）。取值/时序（insertText→submit）**未验证**。
2. **客户端拿 assistant 文本**：路线 B 依赖 `uiConversation.events.register` Definition 契约（未随包发布文档）或 `ctx.remote.session.page` 内部调用，**未验证**。
3. **host 朗读的会话范围**：host 只能看到所有 session 事件；子代理/其他会话的 assistant 消息会被一并朗读。过滤思路：`session.header.parentSession === undefined`（非子会话）+ "练习模式"开关（插件 Config 或 client 设置）+ 仅当最近一次 user/message 来自本插件激活后（需标记，**未验证**）。
4. **client↔host 控制通道**：自定义 webServer 路由在 Desktop（file:// + IPC fetch 桥）下的可用性**未验证**；自定义 Remote 需要 typert 官方构建链；settings 通道实时性不足。若 C 路线可接受，则不需要通道。
5. **客户端 bundle 构建**：可以自建 esbuild，但必须手写 `window.__ModuleLoader__.load` 外壳、`id` 必须等于包名、只能 require 平台模块或声明 `external`；source map 非必需（无 map 时 client-modules 生成 identity map，见 `dsh-client-modules/lib/index.js:281-294,343-387`，**推断**）。官方 tsdown 不是必须，但**手写 bundle 未经本次实测加载**。
6. **安装/热更新边界**：新包首次安装后建议重启 App；客户端 bundle 变化后建议刷新 Web GUI。HMR 对 link 包代码替换只发生在"profile 重新组合"时（改 patch/manifest 或 plugin-manager 操作）。
7. **麦克风权限**：Electron 渲染进程需要系统麦克风权限（官方 voice-input 已能用，说明 desktop 侧已具备；新插件复用同源 getUserMedia 应无额外配置，**未验证**）。
8. **TTS 音质/回采/延迟**：`say` 回采会触发识别；需要用耳机或 WebRTC AEC；TTS 与识别同时进行时建议先 terminate 再录音（打断语义）。
9. **官方 voice-input 的功能边界**：它明确"不提供自动发送、常开麦克风、唤醒词、流式字幕或语音合成"【README：`dsh-experimental-client-ui-voice-input/README.zh.md:68`】——自动提交/朗读全部要我们自己在外部实现（本笔记即为此给出落点）。
10. **desktop profile 手工修改**：`cordis.patch.yml` 由用户层 last-wins；plugin-manager 后续写入可能与你手改的行互相影响（同 id 覆盖），改动前备份。

---

## 5. 证据索引（包/文件/行号）

| 结论 | 证据 |
|---|---|
| Desktop host 加载 app-owned profile | `@deepseek-ai/dsh-desktop-host/lib/index.js:218-250`（`loadProfileDirectory` 224） |
| profile 结构与 patch 层级 / 条目可写绝对路径 | `dsh-app-boot/README.zh.md:48-69`（61、65 行） |
| runtime resolution / link 包 peer 解析 | `dsh-app-boot/README.zh.md:67,134` |
| CLI 拒绝 desktop profile | `dsh/README.zh.md:18-20` |
| plugin-manager 安装写 manifest/bundles、HMR 下发 | `dsh-plugin-manager/README.zh.md:31,40,44,98-100` |
| 本地 link 安装示例 | `~/.dsh/profiles/desktop/node_modules/ds-bot/README.md:42-50` |
| HMR 行（desktop live） | `@deepseek-ai/dsh-base/cordis.patch.yml:27-32` |
| HMR 监听清单/patch/替换 link 包 | `dsh-hmr/README.zh.md:27-36,49,59` |
| subprocess 行已启用 | `@deepseek-ai/dsh-base/cordis.patch.yml:234-235` |
| client bundle 格式 | voice-input `lib/client.js:1-10`；dsh-context `lib/client.js` 尾部；ds-bot `client.js` 头注释 |
| dsh.client 字段解析 | `dsh-client-modules/lib/index.js:64-73`；client.js:776-794（inject 先到）；index.js:412-444（external 排序） |
| client 导出 inject/apply 示例 | voice-input client.js:2869-2874；dsh-context client.js 尾部 |
| Slot 注册写法 | `dsh-client-ui-workspace/README.zh.md:110-171`；voice-input client.js:2919-2935 |
| inputActions 标准 prop | `dsh-client-ui-conversation/README.zh.md:14,87`；client.js:19897-19913 |
| actions 方法（submit 等） | `dsh-client-ui-conversation/lib/client.js:14941-14967` |
| submit→sendSession→remote.session.prompt | client.js:15202-15256、15939-15941、4685-4740；api-session-controller client.js:2341-2376 |
| voice-input 录音/转写 | voice-input client.js:1471,1501,1532,1573,1658,1915-1922,2905-2917 |
| speech Remote 契约 | `dsh-experimental-api-speech-to-text/lib/types/index.js:66-138`；README.zh:40-42 |
| host speechToText API | `dsh-experimental-speech-to-text/lib/index.js:6-11,35-59,75-198` |
| 无 TTS/无流式 | `dsh-experimental-speech-to-text/README.zh.md:70`；`dsh-experimental-client-ui-voice-input/README.zh.md:68` |
| 助手完成事件 | `dsh-agent-loop/lib/index.js:1029-1032,1156-1162,790-800`；监听样例 :319-334 |
| agent 注入方法 | `dsh-agent-loop/lib/index.js:790-816`；`dsh-agent/lib/index.js:322-332` |
| createUserMessage | `@deepseek-ai/dsh-llm/lib/types/message.js`（createMessage/createUserMessage） |
| Remote prompt 的 user source | `dsh-api-session-controller/lib/index.js:3249-3261` 与 925-966 |
| subprocess API | `dsh-subprocess/README.zh.md`（"启动受管进程"、"管理进程生命周期"） |
| webServer 自定义路由 | `dsh-host-webserver/README.zh.md:59-67`；Desktop file:// fetch 桥 12 行 |
| api-remotes 能力构建期固定 | `dsh-api-remotes/README.zh.md:43-47,77-78` |
| patchReload 不存在 | app.asar 全量字符串检索 0 次；`~/.dsh/profiles/desktop/package.json` 无该字段；仅 `~/.dsh/profiles/web/package.json:11` 有 |

### 附：复现解包（本次用）

```python
import struct, json, sys, os
p = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'
f = open(p, 'rb'); head = f.read(16)
sizes = struct.unpack('<II', head[8:16])
f.seek(16); h = f.read(sizes[1]); j = json.loads(h)
data_base = 16 + sizes[1]
if data_base % 4: data_base += 4 - data_base % 4   # == 4748716
def walk(node, prefix=''):
    for k, v in node.get('files', {}).items():
        path = prefix + '/' + k if prefix else k
        if 'files' in v: yield from walk(v, path)
        else: yield path, v
entries = dict(walk(j))
# 取文件：f.seek(data_base + int(entries[path]['offset'])); f.read(size)
```

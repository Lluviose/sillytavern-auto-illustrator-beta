# SillyTavern 插件/扩展开发规范（整理）

> 更新时间：2026-02-14  
> 适用范围：SillyTavern **UI 扩展（Extension）** 与 **Server Plugin（后端插件）**  
> 说明：本文根据官方文档与官方模板/示例仓库整理，目标是把“怎么写、怎么组织、哪些约束要遵守”讲清楚；细节以官方文档/源码为准。

## 1. 术语与边界

- **Extension（UI 扩展）**：运行在浏览器侧的前端脚本/样式/模板，通常以一个包含 `manifest.json` 的文件夹形式分发。
- **Server Plugin（后端插件）**：运行在 SillyTavern Node.js 服务端的插件模块，通过 Express Router 挂载后端接口或中间件。

很多社区口径会把 Extension 也称为“插件”。若你要做的功能只涉及 UI、事件监听、调用 ST 的前端上下文或向 ST 后端发请求，优先做 **Extension**；只有需要服务端能力（本地文件访问/代理/自定义后端接口等）才考虑 **Server Plugin**。

---

## 2. UI 扩展（Extension）开发规范

### 2.1 目录结构（推荐）

以下是“可维护、可发布”的常见布局（不要求完全一致，但建议保留核心约束）：

```
my-extension/
  manifest.json
  src/                # 可选：源码（TS/JS）
  dist/               # 可选：构建产物（manifest 指向这里）
  i18n/               # 可选：本地化 JSON
  templates/          # 可选：Handlebars 模板
  README.md
  LICENSE
```

规范建议：
- 必须有 `manifest.json`，并放在扩展根目录。
- `js` / `css` 指向的文件路径必须是**相对扩展根目录**的相对路径。
- 若使用打包（webpack/vite/rollup），建议将输出放到 `dist/`，避免污染根目录。

### 2.2 `manifest.json` 规范（字段与约束）

官方定义的常见字段如下（以官方文档为准）：

- `display_name`（必须）：扩展显示名；也用于依赖声明（`requires` / `optional`）。
- `version`（必须）：扩展版本号；建议使用语义化版本（SemVer）。
- `author`（建议）：作者标识。
- `js`（必须）：扩展入口脚本路径。
- `css`（可选）：扩展样式路径。
- `homePage`（建议）：扩展主页（通常是 GitHub 仓库）。
- `loading_order`（可选，整数）：控制加载顺序；也会影响多个 `generate_interceptor` 的调用顺序。
- `requires`（可选，数组）：必需依赖（按 **display_name** 填写）。
- `optional`（可选，数组）：可选依赖（按 **display_name** 填写）。
- `auto_update`（可选，布尔）：是否在 SillyTavern 包版本变化时自动更新（由 ST 的扩展管理逻辑使用）。
- `generate_interceptor`（可选，字符串）：生成请求拦截器函数名（见 2.7）。
- `i18n`（可选，对象）：语言文件映射（见 2.8）。

示例（仅示意）：

```json
{
  "display_name": "My Extension",
  "version": "0.1.0",
  "author": "you",
  "js": "dist/index.js",
  "css": "dist/style.css",
  "homePage": "https://github.com/you/my-extension",
  "loading_order": 100,
  "requires": [],
  "optional": []
}
```

### 2.3 资源路径与导入规范（非常重要）

官方说明：可下载的第三方扩展在 HTTP 服务中会被挂载到 `/scripts/extensions/third-party`。因此：

- 扩展内的模块导入必须使用**相对路径导入**（例如 `./utils.js`），避免假设绝对路径或本地文件系统路径。
- 不要依赖 SillyTavern 内部目录结构（例如直接从 ST 源码文件路径导入模块），因为更新会破坏你的扩展。

### 2.4 与 SillyTavern 交互：必须通过 `SillyTavern.getContext()`

扩展需要访问 ST 的上下文、事件系统、UI 辅助函数等时：

- 必须使用 `SillyTavern.getContext()` 获取上下文对象。
- 不建议直接 `import` SillyTavern 前端源码内部模块；官方明确该方式会“极不可靠”，更新也可能导致破坏性变更。

常用能力（节选）：

- `context.$`：jQuery 句柄。
- `context.toastr`：Toast 通知。
- `context.eventSource` / `context.event_types`：事件总线与事件枚举。
- `context.callPopup` / `context.POPUP_TYPE`：弹窗 API。
- `context.renderExtensionTemplateAsync`：渲染扩展模板（Handlebars）。
- `context.getRequestHeaders()`：获取向 ST 后端请求所需的 headers（例如鉴权/CSRF 等）。
- `context.extensionSettings`：全局扩展配置存储（所有用户共享）。
- `context.registerMacro()` / `context.unregisterMacro()`：注册/注销宏。
- `context.SlashCommandParser`：注册斜杠命令。
- `context.addOneMessage()`：向当前聊天插入消息。

### 2.5 数据与存储规范（配置、聊天元数据、角色卡）

**配置存储：**

- `context.extensionSettings`：写入 `settings.json`，对 **所有用户共享**。适合存扩展的全局配置/默认值。
- `context.settings`：每个用户单独持有（按用户隔离）。适合存“用户偏好”。

规范建议：
- 必须做**命名空间隔离**：例如 `extensionSettings.my_extension = extensionSettings.my_extension || { ... }`。
- 不要在前端配置里存放密钥/Token 等敏感信息（浏览器侧可被读取）。
- 对存储结构的变更要提供迁移逻辑（版本号/字段缺省处理）。

**聊天元数据：**
- 可使用 `context.chat_metadata` 在聊天维度持久化扩展信息；适合“对话级别状态”，例如本聊天是否启用某功能、上次处理到哪个 message id 等。

**角色卡/角色数据：**
- 避免直接修改 SillyTavern 私有数据结构；优先使用官方提供的上下文方法/事件进行交互。

### 2.6 事件系统规范（监听/解绑/性能）

扩展常通过事件与 ST 生命周期对齐。规范建议：

- 使用 `context.eventSource.on(context.event_types.X, handler)` 注册监听。
- 在扩展需要“卸载/重载”的场景里，必须成对解绑（避免重复注册导致多次触发、内存泄漏）。
- handler 内避免长时间阻塞；重计算/重渲染应做节流/防抖。
- 事件类型以 `event_types` 为准（随版本可能新增/调整）。

官方文档列举的部分事件（节选）：
- `CHAT_CHANGED`
- `MESSAGE_RECEIVED` / `MESSAGE_SENT` / `MESSAGE_EDITED` / `MESSAGE_DELETED`
- `GENERATION_STARTED` / `GENERATION_STOPPED`
- `STREAM_TOKEN_RECEIVED` / `OPENAI_STREAM_TOKEN_RECEIVED`
- `SETTINGS_UPDATED`
- `CHARACTER_EDITED` / `CHARACTER_DELETED`
- `GROUP_UPDATED`

### 2.7 生成请求拦截器（`generate_interceptor`）规范

若需要在“每次生成之前”修改 prompt、干预 dry-run 或调整 chat history，可在 `manifest.json` 声明：

```json
{
  "generate_interceptor": "customRequestInterceptor"
}
```

并在全局作用域提供同名函数（官方示例签名）：

```js
async function customRequestInterceptor(prompt, api_type, dry_run, chatHistory) {
  // 修改 prompt / dry_run / chatHistory（按你的需要）
  const dryRun = dry_run;
  return { prompt, dryRun, chatHistory };
}
```

规范建议：
- 拦截器应尽量保持**纯函数**特性：输入是什么、输出就是什么，避免依赖隐式全局状态。
- 必须考虑“多个扩展同时声明拦截器”的情况：调用顺序受 `loading_order` 影响。
- 任何修改都应可追踪、可回退（尤其是对 `chatHistory` 的结构性变更）。

### 2.8 本地化（i18n）规范

扩展可在 `manifest.json` 中声明 `i18n` 映射：

```json
{
  "i18n": {
    "en-us": "i18n/en-us.json",
    "zh-cn": "i18n/zh-cn.json"
  }
}
```

并在代码中使用翻译函数（官方说明支持 `globalThis.t('key')` 或 `SillyTavern.getContext().t('key')`）。

规范建议：
- 至少提供 `en-us`（作为默认/兜底）。
- key 命名建议使用稳定前缀（例如 `myext.setting.title`），避免与其它扩展冲突。
- UI 文本不得硬编码（除非仅用于开发调试）。

### 2.9 TypeScript（可选）规范

官方建议通过模块声明为 `SillyTavern.getContext()` 提供类型（根据扩展安装位置，声明路径不同）。示例（节选）：

```ts
declare module '../../../../../../SillyTavern/public/script.js' {
  export interface SillyTavernContext {
    extensionSettings: any;
  }
}
```

规范建议：
- 优先为你实际用到的 `context` 字段补类型，避免把整个 `context` 写成 `any`。
- 若使用构建工具输出到 `dist/`，确保 source map 可用，方便用户排错。

### 2.10 安全、兼容性与提交规范

**安全：**
- 不要在扩展内存储/收集敏感信息（尤其是 API Key）。
- 处理用户输入/模型输出的 HTML 时，必须做 XSS 风险控制（官方上下文也提供 `DOMPurify` 等库）。
- 避免 `eval`、动态脚本注入等高风险行为。

**兼容性：**
- 不依赖 ST 的私有内部实现；只用官方暴露 API（`getContext()`）或稳定事件。
- 所有网络请求尽量走 `context.getRequestHeaders()`，避免在不同鉴权策略下失效。
- 提供清晰的错误提示与降级策略（例如依赖扩展不存在时提示用户安装）。

**提交到官方内容仓库（SillyTavern-Content）基本要求（节选）：**
- 必须开源且提供许可证。
- 扩展不得“刻意或故意”带来危害或恶意行为。
- 不应要求安装 Server Plugin（如果必须，通常不接受）。
- 必须提供 README，包含安装、配置与使用说明。
- 必须可独立运行（不依赖作者私有环境）。

---

## 3. Server Plugin（后端插件）开发规范

### 3.1 形态与放置

Server Plugin 位于 SillyTavern 的 `plugins/` 目录下，可以是：
- 单文件模块：`plugins/my-plugin.js`
- 目录模块：`plugins/my-plugin/index.js`（以及其它文件）

### 3.2 导出规范：`info` 与 `init(router)`

一个 Server Plugin 模块必须导出：

- `info`：插件元信息对象（通常包含 `name` / `description` / `author` / `version`）。
- `init(router)`：初始化函数；参数 `router` 是 Express Router，用于注册路由。

示例（仅示意）：

```js
export const info = {
  name: 'My Plugin',
  description: '...',
  author: 'you',
  version: '0.1.0',
};

export async function init(router) {
  router.get('/health', (req, res) => res.json({ ok: true }));
}
```

规范建议：
- 路由路径要做命名空间隔离（例如以 `/my-plugin/...` 前缀开头）。
- 必须做输入校验与权限控制（尤其是读写文件、执行命令、转发请求等）。
- 任何可能阻塞事件循环的工作应使用异步 I/O 或放到 worker/子进程（按需）。

---

## 4. 官方与权威参考（建议优先阅读）

- 访问日期：2026-02-14
- SillyTavern 官方文档：UI Extensions（开发指南）  
  https://docs.sillytavern.app/for-contributors/writing-extensions/
- SillyTavern 官方文档：Server Plugins  
  https://docs.sillytavern.app/for-contributors/writing-extensions/server-plugins/
- SillyTavern 官方模板：Extension - Webpack  
  https://github.com/SillyTavern/Extension-WebpackTemplate
- SillyTavern 官方模板：Extension - React  
  https://github.com/SillyTavern/Extension-ReactTemplate
- SillyTavern 官方模板：Server Plugin - Webpack  
  https://github.com/SillyTavern/Plugin-WebpackTemplate
- SillyTavern 官方内容仓库：SillyTavern-Content（提交与分发规范）  
  https://github.com/SillyTavern/SillyTavern-Content
- 社区示例（可参考结构与注入方式，细节以官方文档为准）  
  https://github.com/city-unit/st-extension-example

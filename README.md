# dsh-billion-context-ruleshow

给 [billion-context 插件](https://www.npmjs.com/package/billion-context) 做一个配套的 DSH 插件：在**会话聊天页左侧的空白处**显示当前 `acp_rule` 规则列表。

## 依赖

- Host 侧需要 `billion-context` 插件在线——`acp_rule` 工具由它从 proxy manifest 注册进会话，规则的增删改查都以标准 `tool/call` + `tool/result` 事件写进会话日志。
- Client 侧在 `package.json` 的 `dsh.client.inject` 里声明了 `billion-context`，因此 billion-context 的 Client 模块会先加载。
- **只在 billion-context 插件启用时显示**：Host 读取 profile 的 `package.json`（`dsh.profile.bundles` / `dependencies` 是否包含 `billion-context`）与 `cordis.patch.yml`（是否对该插件行写了 `disabled: true`），结果以 `billionContextEnabled` 字段随 state 响应返回；为 false 时面板不渲染。

## 行为

- 面板位于聊天列左侧空白处，**紧贴聊天列右边缘**（留 16px 间距）；左侧多余空间保持空白。
- 宽度自适应：取聊天列的**真实几何**（含拖拽输出宽度后的列宽），不是按比例估算；最大 320px；左侧空白不足 180px 时整体隐藏；面板可显示宽度低于 140px 时也隐藏。
- 浅灰色小字，右对齐，自动换行（`pre-wrap` + `overflow-wrap: anywhere`），并跟随主题的 `--dsw-alias-label-tertiary` 色值。
- 面板 `pointer-events: none`，不遮挡、不阻挡下方聊天页的点击和滚动。
- 规则列表由 Host 端从会话日志折叠得出（`acp_rule` 的 call/result），Client 每 2 秒轮询同源路由 `GET /dsh-billion-context-ruleshow/state?sessionId=<id>`；会话切换、窗口缩放、拖拽聊天宽度、侧栏/右侧栏开合后布局自动重算（600ms 兜底 + ResizeObserver 即时响应）。

## 安装

在 DSH 里用 `plugin_manager`（`install_bundle`，target 为本目录的绝对路径），不要手写 profile 的 `package.json` / `cordis.patch.yml`。

## 文件

- `index.js`：Host 半。注册同源 JSON 路由；把会话里的 `acp_rule` 调用/结果折叠成规则列表。
- `client.js`：Client 半。注册 `shell.overlay` 槽条目并在左侧空白处渲染。
- `cordis.patch.yml`：插入 `billion-context-ruleshow` 插件行。
- `locale/{en,zh}.json`：插件管理器/设置页显示的标题与描述。
- `icon.svg`：插件图标。

## 卸载

用 `plugin_manager` 的 `remove_bundle` 移除 `dsh-billion-context-ruleshow`。

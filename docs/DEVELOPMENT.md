# dsh-obsidian 开发说明

面向维护者（包括 AI agent）。用户文档见 [README.md](../README.md)。

## 模块职责

| 文件 | 职责 |
| --- | --- |
| `lib/index.js` | 插件入口：读配置、建 vault 句柄、注册两个工具与系统提示段 |
| `lib/config.js` | 配置归一化；`vaultPath` 为空时从 `%APPDATA%\obsidian\obsidian.json` 探测最近 vault |
| `lib/vault.js` | 数据层：路径越界检查、frontmatter 解析/序列化、分区查重、索引重建、全文检索 |
| `lib/tools.js` | 两个工具定义（`obsidian_memory` / `obsidian_note`）与文本渲染 |
| `lib/prompt.js` | 系统提示段：固定规则 + 分区条目摘要缓存 |
| `test-local.mjs` | 数据层自测，在临时目录跑，不碰真实 vault |

## 设计取舍

- **零运行时依赖**：只用 `node:fs` / `node:path`。插件以本地目录（link）方式安装，ESM 从包的真实路径向上解析，拿不到 profile 里的 `@deepseek-ai/schemastery`，因此不导出 Cordis `Config`，配置在 `lib/config.js` 手动归一化。
- **不缓存记忆状态**：所有数据在文件系统里，Obsidian 里手改后下一次调用立即可见。
- **索引是派生数据**：`_index.md` 在每次 `save` / `forget` 后重建，可以随时删掉再生成。

## 本地开发

```powershell
# 改完代码后：重装 bundle 不会刷新 ESM 缓存，必须让 Loader 重新 import
plugin_manager set_plugin target="include:obsidian-memory" enabled=false
plugin_manager set_plugin target="include:obsidian-memory" enabled=true

# 数据层自测（临时目录，不碰真实 vault）
node test-local.mjs
```

只改 `cordis.patch.yml` 里的 `config` 时 Loader 会热更新，不需要重载。

## 工具契约要点

- `ToolDefinition.output.render(args, value)`：**第一个参数是工具入参，第二个才是 `execute` 的返回值**。签名写成 `render(value)` 会把 args 当结果，工具输出退化成 `{"action":"info"}`。
- `execute` 的返回值必须是 lossless JSON；`output.schema` 用 `{ type: "object" }` 即可。
- 注册用 `ctx.tools.register(definition)`，返回 disposer；放在 `ctx.effect` 里注册，并在清理函数中调用。

## 已知实现边界

- 系统提示段 `text` 是同步函数，只读缓存；摘要由 `setInterval` 异步刷新，不阻塞提示词组装。
- `summarize()` 跳过标题、表格、分隔线、引用块，避免索引摘要混入表格片段。
- 路径越界检查基于 `path.resolve` + `path.relative`；写入拒绝 `.obsidian/` 与 `.trash/`。

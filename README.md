# dsh-obsidian

把 DeepSeek Harness 的 Agent 长期记忆接到本机 **Obsidian vault** 上。

插件向模型提供两个工具，并在系统提示里注入记忆库的使用规则，让「长期记忆、项目记忆、全局记忆、学习笔记」真正落盘到 Obsidian，而不是留在某次会话的上下文里。

## 能力

| 工具 | 用途 |
| --- | --- |
| `obsidian_memory` | 结构化记忆：`save` / `recall` / `search` / `list` / `forget` / `reindex`，按 `scope` 分到 global、project、longterm、knowledge、workflow、daily 六个分区 |
| `obsidian_note` | 原始笔记文件：`read` / `write` / `append` / `search` / `list` / `recent` / `info` / `tree` |

配套行为：

- **自动目录结构**：首次加载时创建 `00-Inbox`、`10-Memory/{Global,Projects,LongTerm}`、`20-Knowledge`、`30-Workflows`、`40-Daily`、`90-Meta/templates`，并补齐各分区的 `_index.md`。
- **索引维护**：每次 `save` / `forget` 后重写该分区 `_index.md` 的表格（标题、更新时间、状态、标签），Obsidian 里直接可点。
- **系统提示注入**：说明 vault 路径、分区职责、什么时候该写、写之前先查重；并附带各分区的当前条目摘要（低频刷新，不阻塞提示词组装）。
- **安全边界**：所有相对路径都必须落在 vault 内；写入永远拒绝 `.obsidian/` 与 `.trash/`。

## 安装

```powershell
# 在 DSH 里（需要 danger-full-access 权限）
plugin_manager install_bundle target="<插件目录的绝对路径>"
```

`install_bundle` 会完成 profile 的依赖与 bundle 选择，不需要手工改 `package.json` / `cordis.patch.yml`。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖行配置即可（`install_bundle` 首次写入的默认值已经指向本机 vault）：

```yaml
- id: obsidian-memory
  name: dsh-obsidian
  config:
    vaultPath: 'D:\Notes\MyVault'
    promptSection: true
    maxSearchResults: 40
    maxReadChars: 40000
    digestRefreshMs: 120000
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `vaultPath` | 空 | vault 绝对路径；留空时从 `%APPDATA%\obsidian\obsidian.json` 里挑最近打开的 vault |
| `promptSection` | `true` | 是否注入系统提示段 |
| `maxSearchResults` | `40` | 单次检索返回的匹配行上限 |
| `maxReadChars` | `40000` | 单次读取/回显的字符上限 |
| `digestRefreshMs` | `120000` | 系统提示里条目摘要的刷新间隔 |

## vault 结构

```
DeepSeek/
├─ 00-Inbox/                 随手收集，定期整理
├─ 10-Memory/
│  ├─ Global/                身份、用户偏好、环境事实
│  ├─ Projects/              一个项目一篇
│  └─ LongTerm/              跨项目可复用的经验
├─ 20-Knowledge/             从网络与文档整理的知识
├─ 30-Workflows/             可复用流程、脚本、提示词
├─ 40-Daily/                 每日日志 YYYY-MM-DD.md
└─ 90-Meta/
   ├─ README.md              仓库说明
   ├─ MEMORY-PROTOCOL.md     记忆协议（写入与归类规则）
   ├─ INDEX.md               总索引
   └─ templates/             五个模板
```

每个笔记的 frontmatter 固定为 `type / scope / project / title / created / updated / tags / source / status`，插件读写时按这个顺序序列化，保证重写后 diff 稳定。

## 记忆语义

- `save` 时先按 **文件名 → frontmatter title → 项目名** 查重；命中就追加一节（`### YYYY-MM-DD HH:mm`），不命中才新建文件。
- `mode: replace` 才整篇替换正文。
- `forget` 只把 `status` 改成 `superseded` 并追加归档备注，不删文件，历史可追溯。
- `daily` 分区固定写 `40-Daily/<今天>.md`，同一天多次保存会追加。

## 已知边界

- 系统提示里的条目摘要是按固定间隔刷新的，刚写入的新条目最多延迟一个周期出现在摘要里；`obsidian_memory recall` 读的是实时文件，不受影响。
- `forget` 只改 `status`，不删除文件；物理清理请自己判断后手动做。
- 纯文件系统读写：Obsidian 开着也不会冲突，但同一文件不要同时手改。

## 开发

开发与维护说明见 [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md)。

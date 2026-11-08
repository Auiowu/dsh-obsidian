/**
 * 系统提示注入：告诉模型记忆库在哪、四类记忆怎么分、什么时候该读写。
 *
 * 每次请求组装提示词时都会调用 section 的 text 函数，因此这里只返回
 * 缓存好的摘要，构建工作放在 refresh() 里异步完成，绝不阻塞组装。
 */
import { SCOPES } from './vault.js'

function guide(root) {
  return [
    '## Obsidian 记忆库（跨会话长期记忆）',
    '',
    `你的长期记忆存放在本机 Obsidian vault：\`${root || '（未配置）'}\`。它跨会话、跨项目保留，是你在新会话里恢复上下文的唯一可靠来源。`,
    '',
    '分区：',
    '- 全局记忆 `10-Memory/Global/`：身份、用户偏好、环境事实。变动少，改动前先读。',
    '- 项目记忆 `10-Memory/Projects/`：项目上下文、关键决策、待办、踩过的坑。一个项目一篇。',
    '- 长期记忆 `10-Memory/LongTerm/`：跨项目可复用的经验与教训。',
    '- 知识库 `20-Knowledge/`：从网络、文档、源码整理的知识，注明来源链接。',
    '- 工作流 `30-Workflows/`：可复用的步骤、脚本、提示词。',
    '- 每日日志 `40-Daily/`：当天做过什么，按 `YYYY-MM-DD.md` 记录。',
    '',
    '规则：',
    '1. 用户透露稳定偏好、纠正过你、给出环境事实 → `obsidian_memory(scope=global)` 记录或更新。',
    '2. 做了架构或方案决策、遇到并解决的问题 → `obsidian_memory(scope=project)`。',
    '3. 得到可跨项目复用的方法论 → `obsidian_memory(scope=longterm)`。',
    '4. 从外部学到有价值的东西 → `obsidian_memory(scope=knowledge)`，附来源 URL。',
    '5. 写之前先 `search` 查重；同一主题用 `save` 追加（默认 append），不要新建重复文件。',
    '6. 回答「上次」「之前」「我们说好」这类问题前，先 `recall` 或 `search`，不要凭印象。',
    '7. 内容要具体：结论、理由、适用条件、日期。不要写空泛总结。',
  ].join('\n')
}

/**
 * 创建提示段。返回 { refresh, section }：
 * - refresh() 重新扫描各分区，更新条目摘要缓存；
 * - section() 返回可直接交给 systemPrompt.section() 的描述对象。
 */
export function createPromptSection(vault) {
  let digest = ''
  let building = null

  async function build() {
    const blocks = []
    for (const [scope, meta] of Object.entries(SCOPES)) {
      let rows = []
      try {
        rows = await vault.listMemory(scope)
      } catch {
        rows = []
      }
      const active = rows.filter((row) => row.status === 'active')
      if (active.length === 0) continue
      blocks.push(`- **${meta.label}**（${active.length} 条）`)
      for (const row of active.slice(0, 8)) {
        const summary = row.summary === '' ? '' : ` — ${row.summary.slice(0, 60)}`
        blocks.push(`  - [[${row.name}]] ${row.title}${summary}`)
      }
      if (active.length > 8) blocks.push(`  - …还有 ${active.length - 8} 条`)
    }
    digest = blocks.length === 0 ? '_记忆库暂无条目。_' : blocks.join('\n')
  }

  function refresh() {
    if (building !== null) return building
    building = build().finally(() => {
      building = null
    })
    return building
  }

  function text() {
    const head = guide(vault.root)
    if (digest === '') return head
    return `${head}\n\n当前记忆条目（自动生成；读全文用 obsidian_memory recall）：\n${digest}`
  }

  function section() {
    return {
      name: 'obsidian-memory',
      order: 860,
      text,
    }
  }

  return { refresh, section }
}

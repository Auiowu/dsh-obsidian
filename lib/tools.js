/**
 * 两个面向模型的工具：obsidian_memory（结构化记忆）与 obsidian_note（原始笔记文件）。
 *
 * 设计原则：
 * - 记忆工具承担分类语义，模型只需要选 scope 和写内容；
 * - 笔记工具做原始读写，用于整理、批量修改、读任意笔记；
 * - 所有写路径都经过 vault 的越界检查，绝不触碰 .obsidian。
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { SCOPES, truncate } from './vault.js'

const OUTPUT_SCHEMA = { type: 'object' }

function textResult(text, extra = {}) {
  return { text: String(text ?? ''), ...extra }
}

function renderText(_args, value) {
  if (value !== null && typeof value === 'object' && typeof value.text === 'string') {
    return [{ type: 'text', text: value.text }]
  }
  return [{ type: 'text', text: JSON.stringify(value) }]
}

function requireString(value, name) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') throw new Error(`${name} 不能为空`)
  return text
}

function scopeOptions() {
  return Object.keys(SCOPES)
}

function scopeLabel(scope) {
  return SCOPES[scope]?.label ?? scope
}

async function listDirectory(vault, relPath) {
  const abs = vault.absOf(relPath)
  const entries = await fs.readdir(abs, { withFileTypes: true })
  return entries
    .filter((entry) => !entry.name.startsWith('.'))
    .map((entry) => ({
      name: entry.name,
      kind: entry.isDirectory() ? 'dir' : 'file',
      path: vault.relOf(join(abs, entry.name)),
    }))
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1))
}

async function treeLines(vault, relPath, depth, indent) {
  if (depth <= 0) return []
  let entries
  try {
    entries = await listDirectory(vault, relPath)
  } catch {
    return []
  }
  const lines = []
  for (const entry of entries) {
    if (entry.kind === 'dir') {
      lines.push(`${indent}${entry.name}/`)
      lines.push(...(await treeLines(vault, entry.path, depth - 1, `${indent}  `)))
    } else {
      lines.push(`${indent}${entry.name}`)
    }
  }
  return lines
}

/** 构造 obsidian_memory 工具。 */
function memoryTool(vault) {
  return {
    name: 'obsidian_memory',
    description: [
      '读写本机 Obsidian 记忆库（跨会话长期保留）。按 scope 分区：global=身份/用户偏好/环境事实，project=单个项目的上下文与决策，longterm=跨项目可复用的经验教训，knowledge=从网络与文档整理的知识，workflow=可复用流程，daily=当天日志。',
      'action=save：写入一条记忆。同名文件（同标题 / 同项目）已存在时默认追加一节，mode=replace 才整篇替换正文；写入后自动重建该分区索引。',
      'action=recall：读取记忆。给 title/project 读单篇；都不给则返回该分区最近若干篇的正文。',
      'action=search：全文检索（可限定 scope），返回 文件:行号。',
      'action=list：列出分区条目（标题、更新时间、状态、摘要）。',
      'action=forget：把条目标记为 superseded（不删文件，保留历史）。',
      'action=reindex：重建 _index.md 索引表格。',
      '用法约定：写之前先 search 查重；回答"上次/之前/我们说好"这类问题前先 recall；内容要写具体结论、理由与日期，不要空泛总结。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['save', 'recall', 'search', 'list', 'forget', 'reindex'],
          description: '要执行的操作。',
        },
        scope: {
          type: 'string',
          enum: scopeOptions(),
          description: '记忆分区。save/recall/list/forget 必填；search 可选（限定搜索范围）。',
        },
        project: {
          type: 'string',
          description: 'scope=project 时的项目名，例如 dsh-obsidian。',
        },
        title: {
          type: 'string',
          description: '条目标题。global/longterm/knowledge/workflow 用它决定文件名与查重。',
        },
        content: {
          type: 'string',
          description: '要写入的正文（Markdown）。save 必填。',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: '标签，会合并进 frontmatter 的 tags。',
        },
        query: {
          type: 'string',
          description: 'search 的关键词（不区分大小写）。',
        },
        limit: {
          type: 'number',
          description: 'recall/list/search 返回条数上限，默认 8 / 全部 / 40。',
        },
        mode: {
          type: 'string',
          enum: ['append', 'replace'],
          description: 'save 的写入方式：append（默认，追加一节）或 replace（整篇替换正文）。',
        },
        reason: {
          type: 'string',
          description: 'forget 时的归档原因，会写进正文备注。',
        },
      },
      required: ['action'],
    },
    output: { schema: OUTPUT_SCHEMA, render: renderText },
    async execute(args) {
      const input = args !== null && typeof args === 'object' ? args : {}
      const action = String(input.action ?? '')
      const scope = typeof input.scope === 'string' ? input.scope : ''

      if (action === 'reindex') {
        const targets = scope !== '' ? [scope] : Object.keys(SCOPES)
        const lines = []
        for (const target of targets) {
          if (SCOPES[target] === undefined) throw new Error(`未知记忆分区：${target}`)
          const result = await vault.rebuildIndex(target)
          lines.push(`- ${result.path}（${result.count} 条）`)
        }
        return textResult(`已重建索引：\n${lines.join('\n')}`)
      }

      if (action === 'search') {
        const query = requireString(input.query, 'query')
        const scoped = scope !== '' && SCOPES[scope] !== undefined
        const result = await vault.search(query, { scope: scoped ? scope : undefined, limit: input.limit })
        if (result.results.length === 0) {
          const where = scoped ? `在 ${scopeLabel(scope)} 中` : '在 vault 中'
          return textResult(`${where}未找到包含「${query}」的内容。`)
        }
        const lines = [`共 ${result.total} 处匹配${result.truncated ? '（已截断）' : ''}：`]
        for (const file of result.results) {
          lines.push('', `## ${file.path}`)
          for (const hit of file.hits) lines.push(`${hit.line}: ${hit.text}`)
        }
        return textResult(lines.join('\n'))
      }

      if (scope === '') throw new Error(`action=${action} 需要 scope（${scopeOptions().join(' / ')}）`)
      if (SCOPES[scope] === undefined) throw new Error(`未知记忆分区：${scope}`)

      if (action === 'save') {
        const result = await vault.saveMemory({
          scope,
          project: input.project,
          title: input.title,
          content: input.content,
          tags: input.tags,
          mode: input.mode,
        })
        const verb = result.created ? '已新建' : result.replaced ? '已整篇替换' : '已追加'
        return textResult(`✅ ${verb}：${result.path}\n\n${result.preview}`)
      }

      if (action === 'recall') {
        const result = await vault.recallMemory({
          scope,
          title: input.title,
          project: input.project,
          limit: input.limit,
        })
        return textResult(result.text)
      }

      if (action === 'list') {
        const rows = await vault.listMemory(scope)
        if (rows.length === 0) return textResult(`${scopeLabel(scope)}暂无条目。`)
        const lines = [
          `# ${scopeLabel(scope)}（${rows.length} 条）`,
          '',
          '| 条目 | 标题 | 更新时间 | 状态 | 摘要 |',
          '| --- | --- | --- | --- | --- |',
        ]
        for (const row of rows) {
          lines.push(`| ${row.name} | ${row.title} | ${row.updated} | ${row.status} | ${row.summary} |`)
        }
        return textResult(lines.join('\n'))
      }

      if (action === 'forget') {
        const result = await vault.forgetMemory({
          scope,
          title: input.title,
          project: input.project,
          reason: input.reason,
        })
        return textResult(result.text)
      }

      throw new Error(`未知 action：${action}（可选：save / recall / search / list / forget / reindex）`)
    },
  }
}

/** 构造 obsidian_note 工具。 */
function noteTool(vault) {
  return {
    name: 'obsidian_note',
    description: [
      '直接读写本机 Obsidian vault 里的笔记文件（原始 Markdown，不解析记忆语义）。',
      'action=read：读一个文件；write：覆盖写；append：追加；search：全 vault 全文检索；list：列目录；recent：最近修改的笔记；info：vault 概览；tree：目录树。',
      'path 是相对 vault 根目录的路径，例如 "90-Meta/MEMORY-PROTOCOL.md"。',
      '需要结构化长期记忆时优先用 obsidian_memory；这个工具用于整理、读文档、批量维护。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['read', 'write', 'append', 'search', 'list', 'recent', 'info', 'tree'],
          description: '要执行的操作。',
        },
        path: {
          type: 'string',
          description: '相对 vault 的路径（read/write/append/list/tree 使用）。',
        },
        content: {
          type: 'string',
          description: 'write/append 的内容。',
        },
        query: {
          type: 'string',
          description: 'search 的关键词。',
        },
        limit: {
          type: 'number',
          description: 'recent 返回的条数上限，默认 12。',
        },
        depth: {
          type: 'number',
          description: 'tree 的展开深度，默认 2。',
        },
      },
      required: ['action'],
    },
    output: { schema: OUTPUT_SCHEMA, render: renderText },
    async execute(args) {
      const input = args !== null && typeof args === 'object' ? args : {}
      const action = String(input.action ?? '')

      if (action === 'info') {
        const stats = await vault.stats()
        const lines = [
          '# Obsidian vault',
          '',
          `- 路径：\`${stats.root}\``,
          `- 存在：${stats.exists ? '是' : '否（请检查配置）'}`,
          `- Markdown 文件总数：${stats.totalFiles}`,
          `- 最近更新：${stats.latestUpdate ?? '（无）'}`,
          '',
          '| 分区 | 目录 | 条目数 |',
          '| --- | --- | --- |',
        ]
        for (const area of stats.areas) {
          lines.push(`| ${area.label} | ${area.dir} | ${area.count} |`)
        }
        return textResult(lines.join('\n'))
      }

      if (action === 'search') {
        const query = requireString(input.query, 'query')
        const result = await vault.search(query, { limit: input.limit })
        if (result.results.length === 0) return textResult(`未找到包含「${query}」的内容。`)
        const lines = [`共 ${result.total} 处匹配${result.truncated ? '（已截断）' : ''}：`]
        for (const file of result.results) {
          lines.push('', `## ${file.path}`)
          for (const hit of file.hits) lines.push(`${hit.line}: ${hit.text}`)
        }
        return textResult(lines.join('\n'))
      }

      if (action === 'recent') {
        const limit = Number.isFinite(input.limit) ? Math.max(1, Math.min(100, input.limit)) : 12
        const files = (await vault.listMarkdown('', { depth: 99 }))
          .sort((a, b) => b.mtimeMs - a.mtimeMs)
          .slice(0, limit)
        if (files.length === 0) return textResult('vault 里还没有 Markdown 文件。')
        const lines = ['最近修改的笔记：', '']
        for (const file of files) {
          lines.push(`- ${file.rel}（${new Date(file.mtimeMs).toISOString().slice(0, 16).replace('T', ' ')}，${file.size} B）`)
        }
        return textResult(lines.join('\n'))
      }

      if (action === 'tree') {
        const depth = Number.isFinite(input.depth) ? Math.max(1, Math.min(8, input.depth)) : 2
        const relPath = typeof input.path === 'string' ? input.path : ''
        const lines = [`${relPath === '' ? vault.root : relPath}/`]
        lines.push(...(await treeLines(vault, relPath, depth, '  ')))
        return textResult(lines.join('\n'))
      }

      if (action === 'list') {
        const relPath = typeof input.path === 'string' ? input.path : ''
        const entries = await listDirectory(vault, relPath)
        if (entries.length === 0) return textResult('目录为空。')
        const lines = [`${relPath === '' ? '/' : relPath}/ 下有 ${entries.length} 项：`, '']
        for (const entry of entries) {
          lines.push(`- ${entry.kind === 'dir' ? '📁' : '📄'} ${entry.path}`)
        }
        return textResult(lines.join('\n'))
      }

      const path = requireString(input.path, 'path')

      if (action === 'read') {
        const text = await vault.read(path)
        const lineCount = text.split(/\r?\n/).length
        return textResult(`# ${path}（${lineCount} 行）\n\n${truncate(text, vault.maxRead)}`)
      }

      if (action === 'write') {
        const content = typeof input.content === 'string' ? input.content : ''
        if (content === '') throw new Error('content 不能为空')
        const abs = vault.absOf(path)
        const existed = await vault.exists(abs)
        await vault.write(path, content)
        return textResult(`✅ 已${existed ? '覆盖' : '创建'} ${path}（${content.length} 字符）`)
      }

      if (action === 'append') {
        const content = typeof input.content === 'string' ? input.content : ''
        if (content === '') throw new Error('content 不能为空')
        const abs = vault.absOf(path)
        const existed = await vault.exists(abs)
        const previous = existed ? await vault.read(path) : ''
        const merged = existed ? `${previous.replace(/\s+$/, '')}\n\n${content}\n` : `${content}\n`
        await vault.write(path, merged)
        return textResult(`✅ 已追加到 ${path}（+${content.length} 字符）`)
      }

      throw new Error(`未知 action：${action}（可选：read / write / append / search / list / recent / info / tree）`)
    },
  }
}

/** 生成当前 vault 对应的全部工具定义。 */
export function buildToolDefinitions(vault) {
  return [memoryTool(vault), noteTool(vault)]
}

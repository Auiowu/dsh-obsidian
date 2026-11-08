/**
 * Vault 数据层：路径解析、文件读写、frontmatter、记忆分区语义、全文检索、索引重建。
 *
 * 安全边界：所有对外接受的相对路径都必须解析到 vault 根目录内；
 * 写入永远拒绝 .obsidian / .trash，避免破坏 Obsidian 自身状态。
 */
import { promises as fs } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** 遍历时直接跳过的目录名。 */
const HIDDEN_DIRS = new Set(['.obsidian', '.trash', '.git', 'node_modules'])
/** 永远不允许写入的顶层目录。 */
const SYSTEM_DIRS = new Set(['.obsidian', '.trash'])

/** 记忆分区：scope 名 → 目录与展示名。 */
export const SCOPES = {
  global: { dir: '10-Memory/Global', label: '全局记忆' },
  project: { dir: '10-Memory/Projects', label: '项目记忆' },
  longterm: { dir: '10-Memory/LongTerm', label: '长期记忆' },
  knowledge: { dir: '20-Knowledge', label: '知识库' },
  workflow: { dir: '30-Workflows', label: '工作流' },
  daily: { dir: '40-Daily', label: '每日日志' },
}

/** 插件启动时保证存在的目录。 */
export const STRUCTURE = [
  '00-Inbox',
  '10-Memory/Global',
  '10-Memory/Projects',
  '10-Memory/LongTerm',
  '20-Knowledge',
  '30-Workflows',
  '40-Daily',
  '90-Meta/templates',
]

const FIELD_ORDER = ['type', 'scope', 'project', 'title', 'created', 'updated', 'tags', 'source', 'status']

function pad(value) {
  return String(value).padStart(2, '0')
}

/** 生成带本地时区偏移的 ISO 时间，例如 2026-11-08T14:42:58+08:00。 */
export function nowIso(date = new Date()) {
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

/** YYYY-MM-DD。 */
export function today(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 把 ISO 时间压缩成 2026-11-08 14:42 这样的展示串。 */
export function formatStamp(iso) {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(String(iso ?? ''))
  return match ? `${match[1]} ${match[2]}` : String(iso ?? '')
}

/** 把任意标题变成安全的文件名片段。 */
export function sanitizeName(input, fallback = 'untitled') {
  const text = String(input ?? '')
    .replace(/[\\/:*?"<>|\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (text === '') return fallback
  return text.slice(0, 80)
}

/** 按字符数截断，超长时留下明确标记。 */
export function truncate(text, max) {
  const value = String(text ?? '')
  if (value.length <= max) return value
  return `${value.slice(0, max)}\n\n…（已截断，原文 ${value.length} 字符）`
}

/** 解析 frontmatter 的 YAML 子集：标量、行内数组、单双引号。 */
export function parseFrontmatter(text) {
  const source = String(text ?? '')
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source)
  if (match === null) return { data: {}, body: source }
  const data = {}
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const index = line.indexOf(':')
    if (index <= 0) continue
    const key = line.slice(0, index).trim()
    let value = line.slice(index + 1).trim()
    if (value.startsWith('[') && value.endsWith(']')) {
      const inner = value.slice(1, -1).trim()
      value =
        inner === ''
          ? []
          : inner
              .split(',')
              .map((item) => item.trim().replace(/^["']|["']$/g, ''))
              .filter((item) => item !== '')
    } else if (/^".*"$/.test(value) || /^'.*'$/.test(value)) {
      value = value.slice(1, -1)
    }
    data[key] = value
  }
  return { data, body: source.slice(match[0].length) }
}

/** 按固定字段顺序序列化 frontmatter，保证重写时 diff 稳定。 */
export function buildFrontmatter(data, body) {
  const lines = ['---']
  for (const key of FIELD_ORDER) {
    const value = data?.[key]
    if (value === undefined || value === null || value === '') continue
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.join(', ')}]`)
      continue
    }
    lines.push(`${key}: ${String(value).replace(/\r?\n/g, ' ')}`)
  }
  lines.push('---', '')
  const head = lines.join('\n')
  const tail = String(body ?? '').replace(/^\s+/, '')
  return tail === '' ? `${head}\n` : `${head}\n${tail}`
}

/** 取正文里第一段有信息量的文字做摘要；标题、表格、分隔线、引用块都跳过。 */
export function summarize(body, length = 90) {
  const parts = []
  for (const raw of String(body ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '') continue
    if (line.startsWith('#')) continue
    if (line.startsWith('|')) continue
    if (line.startsWith('```')) continue
    if (line.startsWith('<!--')) continue
    if (line.startsWith('>')) continue
    if (/^[-=_*]{3,}$/.test(line)) continue
    parts.push(line)
  }
  const text = parts
    .join(' ')
    .replace(/\[\[([^\]|]+)\|?[^\]]*\]\]/g, '$1')
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.slice(0, length)
}

function preview(text, length = 320) {
  return String(text ?? '').trim().slice(0, length)
}

/**
 * 创建一个 vault 句柄。所有方法都是异步的，内部不缓存文件内容，
 * 保证 Obsidian 里手工改动立即对下一次调用可见。
 */
export function createVault(config) {
  const configured = typeof config.vaultPath === 'string' && config.vaultPath.trim() !== ''
  const root = configured ? resolve(config.vaultPath) : ''
  const maxRead = config.maxReadChars ?? 40000
  const maxHits = config.maxSearchResults ?? 40

  function assertConfigured() {
    if (root === '') {
      throw new Error('尚未配置 Obsidian vault 路径：请在插件配置 config.vaultPath 中设置绝对路径')
    }
  }

  function relOf(abs) {
    assertConfigured()
    return relative(root, abs).split(sep).join('/')
  }

  function absOf(relPath) {
    assertConfigured()
    const clean = String(relPath ?? '').replace(/^[\\/]+/, '')
    const abs = resolve(root, clean)
    const rel = relative(root, abs)
    if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel))) {
      throw new Error(`路径越界：${relPath} 不在 vault（${root}）内`)
    }
    return abs
  }

  function assertWritable(abs) {
    const rel = relOf(abs)
    if (rel === '') return
    const top = rel.split('/')[0]
    if (SYSTEM_DIRS.has(top)) throw new Error(`拒绝写入 Obsidian 系统目录：${rel}`)
  }

  async function exists(abs) {
    try {
      await fs.access(abs)
      return true
    } catch {
      return false
    }
  }

  async function read(relPath) {
    return fs.readFile(absOf(relPath), 'utf8')
  }

  async function write(relPath, text) {
    const abs = absOf(relPath)
    assertWritable(abs)
    await fs.mkdir(dirname(abs), { recursive: true })
    await fs.writeFile(abs, String(text ?? ''), 'utf8')
    return relOf(abs)
  }

  /** 递归列出 markdown 文件；depth=1 只看当前目录。 */
  async function listMarkdown(dirRel = '', options = {}) {
    const depth = Number.isFinite(options.depth) ? options.depth : 99
    const base = absOf(dirRel)
    const out = []
    async function walk(dir, level) {
      if (level > depth) return
      let entries
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.') || HIDDEN_DIRS.has(entry.name)) continue
        const abs = join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(abs, level + 1)
          continue
        }
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue
        const stat = await fs.stat(abs).catch(() => null)
        if (stat === null) continue
        out.push({ abs, rel: relOf(abs), name: entry.name, mtimeMs: stat.mtimeMs, size: stat.size })
      }
    }
    await walk(base, 1)
    return out
  }

  /** 建立目录骨架与缺失的分区索引；已存在的文件不覆盖。 */
  async function ensureStructure() {
    for (const dir of STRUCTURE) await fs.mkdir(join(root, dir), { recursive: true })
    for (const [scope, meta] of Object.entries(SCOPES)) {
      const rel = `${meta.dir}/_index.md`
      if (await exists(join(root, rel))) continue
      const stamp = nowIso()
      await write(
        rel,
        buildFrontmatter(
          {
            type: 'index',
            scope,
            title: `${meta.label}索引`,
            created: stamp,
            updated: stamp,
            tags: [],
            source: 'conversation',
            status: 'active',
          },
          `# ${meta.label}索引\n\n> 由 \`dsh-obsidian\` 按需重建：表格会覆盖，正文说明可以保留。\n`,
        ),
      )
    }
  }

  async function getIndex(scope) {
    const meta = SCOPES[scope]
    if (meta === undefined) throw new Error(`未知记忆分区：${scope}`)
    try {
      return await read(`${meta.dir}/_index.md`)
    } catch {
      return ''
    }
  }

  /** 扫描分区目录，重建 _index.md 的表格。 */
  async function rebuildIndex(scope) {
    const meta = SCOPES[scope]
    if (meta === undefined) throw new Error(`未知记忆分区：${scope}`)
    const files = (await listMarkdown(meta.dir, { depth: 1 })).filter(
      (file) => file.name.toLowerCase() !== '_index.md',
    )
    const rows = []
    for (const file of files) {
      let text = ''
      try {
        text = await read(file.rel)
      } catch {
        continue
      }
      const { data, body } = parseFrontmatter(text)
      const name = basename(file.rel, '.md')
      rows.push({
        name,
        title: String(data.title ?? name),
        updated: String(data.updated ?? new Date(file.mtimeMs).toISOString()).slice(0, 10),
        status: String(data.status ?? 'active'),
        tags: Array.isArray(data.tags) ? data.tags.join('、') : String(data.tags ?? ''),
        summary: summarize(body),
      })
    }
    rows.sort((a, b) => b.updated.localeCompare(a.updated))

    const indexRel = `${meta.dir}/_index.md`
    let created = nowIso()
    try {
      const previous = parseFrontmatter(await read(indexRel))
      if (previous.data.created) created = String(previous.data.created)
    } catch {
      // 第一次生成
    }

    const lines = [
      `# ${meta.label}索引`,
      '',
      '> 由 `dsh-obsidian` 重建。表格会在下次重建时覆盖，表格之外的正文可以保留手工说明。',
      '',
    ]
    if (rows.length === 0) {
      lines.push('_暂无条目。_')
    } else {
      lines.push('| 条目 | 标题 | 更新时间 | 状态 | 标签 |', '| --- | --- | --- | --- | --- |')
      for (const row of rows) {
        lines.push(`| [[${row.name}]] | ${row.title} | ${row.updated} | ${row.status} | ${row.tags} |`)
      }
    }

    await write(
      indexRel,
      buildFrontmatter(
        {
          type: 'index',
          scope,
          title: `${meta.label}索引`,
          created,
          updated: nowIso(),
          tags: [],
          source: 'conversation',
          status: 'active',
        },
        `${lines.join('\n')}\n`,
      ),
    )
    return { path: indexRel, count: rows.length }
  }

  /** 找一个已存在的记忆文件：daily 按日期，project 按项目名，其它按标题或文件名。 */
  async function findExisting(scope, options = {}) {
    const meta = SCOPES[scope]
    if (meta === undefined) throw new Error(`未知记忆分区：${scope}`)
    if (scope === 'daily') {
      const rel = `${meta.dir}/${today()}.md`
      if (await exists(join(root, rel))) return { rel, text: await read(rel) }
      return null
    }
    const files = (await listMarkdown(meta.dir, { depth: 1 })).filter(
      (file) => file.name.toLowerCase() !== '_index.md',
    )
    if (scope === 'project') {
      const target = sanitizeName(options.project ?? options.title ?? '').toLowerCase()
      if (target === '') return null
      for (const file of files) {
        if (basename(file.rel, '.md').toLowerCase() === target) {
          return { rel: file.rel, text: await read(file.rel) }
        }
      }
      for (const file of files) {
        const text = await read(file.rel)
        const { data } = parseFrontmatter(text)
        if (typeof data.project === 'string' && data.project.toLowerCase() === target) {
          return { rel: file.rel, text }
        }
      }
      return null
    }
    const slug = sanitizeName(options.title ?? '').toLowerCase()
    if (slug === '') return null
    for (const file of files) {
      if (basename(file.rel, '.md').toLowerCase() === slug) {
        return { rel: file.rel, text: await read(file.rel) }
      }
    }
    for (const file of files) {
      const text = await read(file.rel)
      const { data } = parseFrontmatter(text)
      if (typeof data.title === 'string' && data.title.toLowerCase() === slug) {
        return { rel: file.rel, text }
      }
    }
    return null
  }

  function memoryPath(scope, options = {}) {
    const meta = SCOPES[scope]
    if (scope === 'daily') return `${meta.dir}/${today()}.md`
    if (scope === 'project') {
      return `${meta.dir}/${sanitizeName(options.project ?? options.title ?? 'project')}.md`
    }
    return `${meta.dir}/${sanitizeName(options.title ?? 'untitled')}.md`
  }

  /**
   * 写入一条记忆。同名/同项目文件存在时默认追加，mode=replace 时整篇替换正文。
   * 写入后立即重建该分区索引。
   */
  async function saveMemory(options = {}) {
    const scope = options.scope
    const meta = SCOPES[scope]
    if (meta === undefined) {
      throw new Error(`未知记忆分区：${scope}（可选：${Object.keys(SCOPES).join(' / ')}）`)
    }
    if (scope === 'project' && !options.project && !options.title) {
      throw new Error('scope=project 时必须提供 project 或 title')
    }
    const content = String(options.content ?? '').trim()
    if (content === '') throw new Error('content 不能为空')
    const tags = Array.isArray(options.tags)
      ? options.tags.filter((tag) => typeof tag === 'string' && tag.trim() !== '')
      : []
    const stamp = nowIso()
    const existing = await findExisting(scope, { title: options.title, project: options.project })

    if (existing !== null) {
      const { data, body } = parseFrontmatter(existing.text)
      const mergedTags = Array.isArray(data.tags) ? [...data.tags] : []
      for (const tag of tags) if (!mergedTags.includes(tag)) mergedTags.push(tag)
      const next = {
        ...data,
        type: data.type || 'memory',
        scope,
        project: scope === 'project' ? data.project || options.project : data.project,
        title: data.title || options.title || basename(existing.rel, '.md'),
        created: data.created || stamp,
        updated: stamp,
        tags: mergedTags,
        source: data.source || 'conversation',
        status: 'active',
      }
      if (options.mode === 'replace') {
        const bodyText = `# ${next.title}\n\n${content}\n`
        await write(existing.rel, buildFrontmatter(next, bodyText))
        await rebuildIndex(scope)
        return { path: existing.rel, created: false, replaced: true, preview: preview(content) }
      }
      const appended = `${body.replace(/\s+$/, '')}\n\n---\n\n### ${formatStamp(stamp)}\n\n${content}\n`
      await write(existing.rel, buildFrontmatter(next, appended))
      await rebuildIndex(scope)
      return { path: existing.rel, created: false, replaced: false, preview: preview(content) }
    }

    const rel = memoryPath(scope, { title: options.title, project: options.project })
    const title =
      options.title || (scope === 'project' ? options.project ?? '' : '') || basename(rel, '.md')
    const typeByScope = { knowledge: 'knowledge', workflow: 'workflow', daily: 'daily' }
    const data = {
      type: typeByScope[scope] ?? 'memory',
      scope,
      project: scope === 'project' ? options.project || title : undefined,
      title,
      created: stamp,
      updated: stamp,
      tags,
      source: 'conversation',
      status: 'active',
    }
    await write(rel, buildFrontmatter(data, `# ${title}\n\n${content}\n`))
    await rebuildIndex(scope)
    return { path: rel, created: true, replaced: false, preview: preview(content) }
  }

  /** 读取记忆：给 title/project 时读单篇，否则按更新时间取最近若干篇。 */
  async function recallMemory(options = {}) {
    const scope = options.scope
    const meta = SCOPES[scope]
    if (meta === undefined) {
      throw new Error(`未知记忆分区：${scope}（可选：${Object.keys(SCOPES).join(' / ')}）`)
    }
    const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(50, options.limit)) : 8

    if (options.title || options.project) {
      const existing = await findExisting(scope, { title: options.title, project: options.project })
      if (existing === null) return { found: false, text: `未找到匹配条目（scope=${scope}）。` }
      return { found: true, path: existing.rel, text: truncate(existing.text, maxRead) }
    }

    const files = (await listMarkdown(meta.dir, { depth: 1 }))
      .filter((file) => file.name.toLowerCase() !== '_index.md')
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
    if (files.length === 0) return { found: false, text: `${meta.label}还是空的。` }

    const picked = files.slice(0, limit)
    const parts = []
    for (const file of picked) {
      const text = await read(file.rel)
      const { data, body } = parseFrontmatter(text)
      const name = basename(file.rel, '.md')
      parts.push(`### [[${name}]] · ${data.title ?? name}\n\n${truncate(body.trim(), 1200)}`)
    }
    const rest = files.length > picked.length ? `\n\n…还有 ${files.length - picked.length} 个条目，用 list 查看。` : ''
    return {
      found: true,
      path: meta.dir,
      text: `# ${meta.label}（共 ${files.length} 条，显示最近 ${picked.length} 条）\n\n${parts.join('\n\n')}${rest}`,
    }
  }

  /** 结构化列出一个分区的条目。 */
  async function listMemory(scope) {
    const meta = SCOPES[scope]
    if (meta === undefined) {
      throw new Error(`未知记忆分区：${scope}（可选：${Object.keys(SCOPES).join(' / ')}）`)
    }
    const files = (await listMarkdown(meta.dir, { depth: 1 }))
      .filter((file) => file.name.toLowerCase() !== '_index.md')
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
    const rows = []
    for (const file of files) {
      const { data, body } = parseFrontmatter(await read(file.rel))
      const name = basename(file.rel, '.md')
      rows.push({
        name,
        path: file.rel,
        title: String(data.title ?? name),
        status: String(data.status ?? 'active'),
        updated: String(data.updated ?? new Date(file.mtimeMs).toISOString()).slice(0, 16).replace('T', ' '),
        tags: Array.isArray(data.tags) ? data.tags : [],
        summary: summarize(body),
      })
    }
    return rows
  }

  /** 归档一条记忆：只把 status 改成 superseded，不删文件。 */
  async function forgetMemory(options = {}) {
    const scope = options.scope
    if (SCOPES[scope] === undefined) {
      throw new Error(`未知记忆分区：${scope}（可选：${Object.keys(SCOPES).join(' / ')}）`)
    }
    const existing = await findExisting(scope, { title: options.title, project: options.project })
    if (existing === null) return { ok: false, text: '未找到匹配条目。' }
    const { data, body } = parseFrontmatter(existing.text)
    const stamp = nowIso()
    const next = { ...data, type: data.type || 'memory', scope, updated: stamp, status: 'superseded' }
    const reason = String(options.reason ?? '').trim()
    const note = `\n\n> 归档于 ${formatStamp(stamp)}${reason === '' ? '。' : `：${reason}`}`
    await write(existing.rel, buildFrontmatter(next, `${body.replace(/\s+$/, '')}${note}\n`))
    await rebuildIndex(scope)
    return { ok: true, path: existing.rel, text: `已把「${data.title ?? existing.rel}」标记为 superseded（文件保留）。` }
  }

  /** 全文检索 markdown；scope 给定时只搜该分区。 */
  async function search(query, options = {}) {
    const needle = String(query ?? '').trim().toLowerCase()
    if (needle === '') throw new Error('query 不能为空')
    const scope = options.scope
    const dirRel = scope !== undefined && SCOPES[scope] !== undefined ? SCOPES[scope].dir : ''
    const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(200, options.limit)) : maxHits
    const files = await listMarkdown(dirRel, { depth: 99 })
    const results = []
    let total = 0
    for (const file of files) {
      let text = ''
      try {
        text = await read(file.rel)
      } catch {
        continue
      }
      const lines = text.split(/\r?\n/)
      const hits = []
      for (let index = 0; index < lines.length; index += 1) {
        if (!lines[index].toLowerCase().includes(needle)) continue
        hits.push({ line: index + 1, text: lines[index].trim().slice(0, 200) })
        total += 1
        if (total >= limit) break
      }
      if (hits.length > 0) results.push({ path: file.rel, hits })
      if (total >= limit) break
    }
    return { results, total, truncated: total >= limit }
  }

  /** vault 概览统计。 */
  async function stats() {
    if (root === '') {
      return {
        root: '',
        vaultPath: '',
        configured: false,
        exists: false,
        totalFiles: 0,
        areas: [],
        latestUpdate: null,
      }
    }
    const areas = []
    let totalFiles = 0
    let latest = 0
    for (const [scope, meta] of Object.entries(SCOPES)) {
      const files = await listMarkdown(meta.dir, { depth: 2 })
      totalFiles += files.length
      for (const file of files) if (file.mtimeMs > latest) latest = file.mtimeMs
      areas.push({ scope, label: meta.label, dir: meta.dir, count: files.length })
    }
    return {
      root,
      vaultPath: root,
      configured,
      exists: await exists(root),
      totalFiles,
      areas,
      latestUpdate: latest > 0 ? new Date(latest).toISOString() : null,
    }
  }

  return {
    root,
    configured,
    maxRead,
    maxHits,
    absOf,
    relOf,
    exists,
    read,
    write,
    listMarkdown,
    ensureStructure,
    getIndex,
    rebuildIndex,
    findExisting,
    saveMemory,
    recallMemory,
    listMemory,
    forgetMemory,
    search,
    stats,
  }
}

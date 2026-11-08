/**
 * 本地逻辑自测：在临时目录里跑一遍 vault 数据层，不碰真实 vault。
 * 运行：node test-local.mjs
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createVault, parseFrontmatter, SCOPES } from './lib/vault.js'

const root = join(tmpdir(), `dsh-obsidian-test-${Date.now()}`)
const failures = []

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${name}`)
  } else {
    failures.push(`${name} ${detail}`)
    console.log(`  FAIL ${name} ${detail}`)
  }
}

async function main() {
  await fs.mkdir(root, { recursive: true })
  const vault = createVault({
    vaultPath: root,
    maxSearchResults: 20,
    maxReadChars: 4000,
  })

  console.log('[1] ensureStructure')
  await vault.ensureStructure()
  for (const dir of ['10-Memory/Global', '10-Memory/Projects', '10-Memory/LongTerm', '20-Knowledge', '30-Workflows', '40-Daily', '90-Meta/templates']) {
    check(`目录 ${dir}`, await vault.exists(join(root, dir)))
  }
  check('Global/_index.md', await vault.exists(join(root, '10-Memory/Global/_index.md')))

  console.log('[2] saveMemory global（新建 + 追加）')
  const first = await vault.saveMemory({
    scope: 'global',
    title: '用户偏好',
    content: '用户使用中文交流，要求内部推理也用中文。',
    tags: ['语言'],
  })
  check('新建 global 条目', first.created === true, JSON.stringify(first))
  check('文件存在', await vault.exists(join(root, first.path)))
  const second = await vault.saveMemory({
    scope: 'global',
    title: '用户偏好',
    content: '下载优先走本机 Rayburst RPC。',
    tags: ['下载'],
  })
  check('同名追加而非新建', second.created === false, JSON.stringify(second))
  const raw = await vault.read(first.path)
  const parsed = parseFrontmatter(raw)
  check('frontmatter scope', parsed.data.scope === 'global', String(parsed.data.scope))
  check('tags 合并', Array.isArray(parsed.data.tags) && parsed.data.tags.length === 2, JSON.stringify(parsed.data.tags))
  check('两次内容都在', parsed.body.includes('中文交流') && parsed.body.includes('Rayburst'))

  console.log('[3] saveMemory project')
  const project = await vault.saveMemory({
    scope: 'project',
    project: 'dsh-obsidian',
    content: '插件零运行时依赖，不导出 Config。',
    tags: ['架构'],
  })
  check('项目文件路径', project.path === '10-Memory/Projects/dsh-obsidian.md', project.path)
  const projectAgain = await vault.saveMemory({
    scope: 'project',
    project: 'dsh-obsidian',
    content: '第二版加了系统提示注入。',
  })
  check('同项目追加', projectAgain.created === false)

  console.log('[4] daily')
  const daily = await vault.saveMemory({ scope: 'daily', content: '今天做了 Obsidian 插件。' })
  check('daily 按日期', /^40-Daily\/\d{4}-\d{2}-\d{2}\.md$/.test(daily.path), daily.path)

  console.log('[5] replace 模式')
  await vault.saveMemory({
    scope: 'longterm',
    title: '踩坑记录',
    content: '旧内容。',
  })
  const replaced = await vault.saveMemory({
    scope: 'longterm',
    title: '踩坑记录',
    content: '新内容，只剩这一条。',
    mode: 'replace',
  })
  const replacedText = await vault.read(replaced.path)
  check('replace 生效', replacedText.includes('新内容') && !replacedText.includes('旧内容'))

  console.log('[6] recall / list / search')
  const recalled = await vault.recallMemory({ scope: 'global' })
  check('recall 返回正文', recalled.found === true && recalled.text.includes('Rayburst'))
  const single = await vault.recallMemory({ scope: 'project', project: 'dsh-obsidian' })
  check('recall 单篇', single.found === true && single.text.includes('零运行时依赖'))
  const rows = await vault.listMemory('global')
  check('list 有条目', rows.length >= 1, String(rows.length))
  const hits = await vault.search('Rayburst')
  check('search 命中', hits.total >= 1, JSON.stringify(hits))
  const scopedHits = await vault.search('Rayburst', { scope: 'knowledge' })
  check('search 限定分区为空', scopedHits.total === 0, String(scopedHits.total))

  console.log('[7] 索引重建')
  const index = await vault.rebuildIndex('global')
  const indexText = await vault.read(index.path)
  check('索引含表格', indexText.includes('| [[用户偏好]] |'), indexText.slice(0, 200))
  check('索引条目数', index.count === 1, String(index.count))

  console.log('[8] forget')
  const forgotten = await vault.forgetMemory({ scope: 'longterm', title: '踩坑记录', reason: '被新方案取代' })
  check('forget ok', forgotten.ok === true)
  const archived = await vault.read(forgotten.path)
  check('status=superseded', archived.includes('status: superseded'))
  check('保留归档原因', archived.includes('被新方案取代'))

  console.log('[9] 越界与系统目录保护')
  let blocked = false
  try {
    vault.absOf('../../outside.md')
  } catch {
    blocked = true
  }
  check('阻止 ../../ 越界', blocked)
  blocked = false
  try {
    await vault.write('.obsidian/app.json', '{}')
  } catch {
    blocked = true
  }
  check('阻止写 .obsidian', blocked)

  console.log('[10] note 写入与概览')
  await vault.write('90-Meta/README.md', '# 测试\n')
  check('note 写文件', (await vault.read('90-Meta/README.md')).includes('测试'))
  const stats = await vault.stats()
  check('stats 总文件数 > 0', stats.totalFiles > 0, String(stats.totalFiles))
  check('stats 覆盖六个分区', stats.areas.length === Object.keys(SCOPES).length, String(stats.areas.length))

  await fs.rm(root, { recursive: true, force: true })

  console.log('')
  if (failures.length === 0) {
    console.log('ALL PASS')
  } else {
    console.log(`FAILURES: ${failures.length}`)
    for (const failure of failures) console.log(` - ${failure}`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error('测试异常：', error)
  process.exitCode = 1
})

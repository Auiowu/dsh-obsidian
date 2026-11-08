/**
 * 插件配置解析。
 *
 * 本插件刻意不导出 Cordis `Config`：包是本地 bundle，不声明任何 npm 依赖，
 * 因此拿不到 `@deepseek-ai/schemastery`。Loader 会把 cordis.patch.yml 里
 * 的原始 config 对象直接传给 apply()，这里负责补默认值并做宽松校验。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const DEFAULTS = {
  /** Obsidian vault 的绝对路径；留空则自动探测。 */
  vaultPath: '',
  /** 是否把记忆库使用规则注入系统提示。 */
  promptSection: true,
  /** 全文检索最多返回的匹配行数。 */
  maxSearchResults: 40,
  /** 单次读取/注入的最大字符数。 */
  maxReadChars: 40000,
  /** 系统提示里记忆摘要的缓存刷新间隔（毫秒）。 */
  digestRefreshMs: 120000,
}

/**
 * 读取 Obsidian 的 obsidian.json，挑出最近打开过的 vault。
 * 读不到就返回空串，让调用方给出「未配置」的明确提示。
 */
export function detectVault() {
  try {
    const appData = process.env.APPDATA
    if (typeof appData !== 'string' || appData === '') return ''
    const raw = readFileSync(join(appData, 'obsidian', 'obsidian.json'), 'utf8')
    const parsed = JSON.parse(raw)
    const vaults = parsed?.vaults
    if (vaults === null || typeof vaults !== 'object') return ''
    const candidates = Object.values(vaults)
      .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.path === 'string')
      .sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0))
    return candidates.length > 0 ? candidates[0].path : ''
  } catch {
    return ''
  }
}

/** 把 Loader 传来的原始 config 归一化成插件内部使用的配置对象。 */
export function resolveConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const rawPath = typeof input.vaultPath === 'string' ? input.vaultPath.trim() : ''
  const num = (value, fallback) =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return {
    vaultPath: rawPath !== '' ? rawPath : detectVault(),
    promptSection: input.promptSection !== false,
    maxSearchResults: Math.max(1, Math.min(500, num(input.maxSearchResults, DEFAULTS.maxSearchResults))),
    maxReadChars: Math.max(2000, Math.min(400000, num(input.maxReadChars, DEFAULTS.maxReadChars))),
    digestRefreshMs: Math.max(10000, num(input.digestRefreshMs, DEFAULTS.digestRefreshMs)),
  }
}

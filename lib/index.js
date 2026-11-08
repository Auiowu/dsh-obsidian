/**
 * dsh-obsidian 宿主插件入口。
 *
 * 零运行时依赖：只用 Node 内置模块，因此本地目录安装（link）后
 * 不会因为解析不到 @deepseek-ai/* 而加载失败。
 */
import { resolveConfig } from './config.js'
import { createVault } from './vault.js'
import { buildToolDefinitions } from './tools.js'
import { createPromptSection } from './prompt.js'

/** Loader 诊断名，与 cordis.patch.yml 的行 id 对应。 */
export const name = 'dsh-obsidian'

/** 工具注册表是硬依赖：没有它插件没有意义。 */
export const inject = ['tools']

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const vault = createVault(config)
  const logger = typeof ctx.logger === 'function' ? ctx.logger('dsh-obsidian') : null
  const warn = (message) => {
    try {
      logger?.warn?.(message)
    } catch {
      // 日志失败不能影响插件加载
    }
  }

  if (vault.root === '') {
    warn('未配置 Obsidian vault 路径（config.vaultPath），obsidian_memory / obsidian_note 调用会报错。')
  } else {
    vault.ensureStructure().catch((error) => warn(`初始化 vault 结构失败：${String(error)}`))
  }

  const tools = ctx.tools
  ctx.effect(() => {
    const disposers = buildToolDefinitions(vault).map((definition) => tools.register(definition))
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // 重复卸载无害
        }
      }
    }
  }, 'dsh-obsidian: tools')

  const systemPrompt = ctx.get('systemPrompt')
  if (config.promptSection && systemPrompt !== undefined && systemPrompt !== null) {
    ctx.effect(() => {
      const prompt = createPromptSection(vault)
      let dispose = null
      try {
        dispose = systemPrompt.section(prompt.section())
      } catch (error) {
        warn(`注册系统提示段失败：${String(error)}`)
        return () => {}
      }
      prompt.refresh().catch(() => {})
      const timer = setInterval(() => {
        prompt.refresh().catch(() => {})
      }, config.digestRefreshMs)
      if (typeof timer.unref === 'function') timer.unref()
      return () => {
        try {
          dispose()
        } catch {
          // 重复卸载无害
        }
        clearInterval(timer)
      }
    }, 'dsh-obsidian: prompt')
  }
}

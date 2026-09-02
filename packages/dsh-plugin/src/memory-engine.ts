import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MemoryPattern } from './types.js'

/**
 * MemoryEngine：AI Agent 长期思维记忆与配置模式沉淀
 */
export class MemoryEngine {
  private memoryFile: string

  constructor(memoryDir: string) {
    mkdirSync(memoryDir, { recursive: true })
    this.memoryFile = join(memoryDir, 'godsh-patterns.json')
  }

  /**
   * 记录环境演进或调试模式
   */
  recordPattern(pattern: Omit<MemoryPattern, 'id' | 'timestamp'>): MemoryPattern {
    const list = this.getAllPatterns()
    const full: MemoryPattern = {
      ...pattern,
      id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
    }
    list.unshift(full)
    const trimmed = list.slice(0, 200)
    writeFileSync(this.memoryFile, JSON.stringify(trimmed, null, 2), 'utf8')
    return full
  }

  /**
   * 获取历史记忆列表
   */
  getAllPatterns(profile?: string): MemoryPattern[] {
    if (!existsSync(this.memoryFile)) return []
    try {
      const raw = JSON.parse(readFileSync(this.memoryFile, 'utf8')) as MemoryPattern[]
      if (!Array.isArray(raw)) return []
      return profile ? raw.filter((p) => p.profile === profile) : raw
    } catch {
      return []
    }
  }

  /**
   * 提取注入到 System Prompt 或 Context 的环境健康与历史模式摘要
   */
  buildContextInjection(profile: string): string {
    const patterns = this.getAllPatterns(profile).slice(0, 5)
    if (patterns.length === 0) return ''
    const items = patterns.map((p) => `- [${p.type}] ${p.summary}`).join('\n')
    return `\n[godsh 长期环境记忆 / Profile: ${profile}]\n${items}\n`
  }
}

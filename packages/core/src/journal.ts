import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './paths.js'

export interface JournalEntry {
  timestamp: number
  isoTime: string
  level: 'info' | 'warn' | 'error'
  category: 'snapshot' | 'rollback' | 'vault' | 'repair' | 'desktop-launch' | 'system'
  profile?: string
  action: string
  status: 'success' | 'failed' | 'pending'
  details?: string
  operator?: 'user' | 'agent' | 'system'
}

export class JournalManager {
  private logDir: string
  private jsonlPath: string
  private textLogPath: string

  constructor(dataDir: string = DATA_DIR) {
    this.logDir = join(dataDir, 'logs')
    mkdirSync(this.logDir, { recursive: true })
    this.jsonlPath = join(this.logDir, 'godsh-journal.jsonl')
    this.textLogPath = join(this.logDir, 'godsh-journal.log')
  }

  log(entry: Omit<JournalEntry, 'timestamp' | 'isoTime'>): JournalEntry {
    const now = Date.now()
    const fullEntry: JournalEntry = {
      ...entry,
      timestamp: now,
      isoTime: new Date(now).toISOString(),
    }

    // 1. JSONL 追加
    try {
      appendFileSync(this.jsonlPath, JSON.stringify(fullEntry) + '\n', 'utf8')
    } catch {}

    // 2. 人类可读文本日志追加
    try {
      const line = `[${fullEntry.isoTime}] [${fullEntry.level.toUpperCase()}] [${fullEntry.category}]${
        fullEntry.profile ? ` [profile:${fullEntry.profile}]` : ''
      } ${fullEntry.action} -> ${fullEntry.status}${fullEntry.details ? ` (${fullEntry.details})` : ''}\n`
      appendFileSync(this.textLogPath, line, 'utf8')
    } catch {}

    return fullEntry
  }

  getEntries(limit = 100, profile?: string, category?: string): JournalEntry[] {
    if (!existsSync(this.jsonlPath)) return []
    try {
      const lines = readFileSync(this.jsonlPath, 'utf8').trim().split(/\r?\n/)
      const entries: JournalEntry[] = []
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]?.trim()
        if (!line) continue
        try {
          const parsed = JSON.parse(line) as JournalEntry
          if (profile && parsed.profile !== profile) continue
          if (category && parsed.category !== category) continue
          entries.push(parsed)
          if (entries.length >= limit) break
        } catch {}
      }
      return entries
    } catch {
      return []
    }
  }

  clear(): void {
    try {
      writeFileSync(this.jsonlPath, '', 'utf8')
      writeFileSync(this.textLogPath, '', 'utf8')
    } catch {}
  }
}

export const defaultJournal = new JournalManager()

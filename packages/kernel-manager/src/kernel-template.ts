import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { KernelTemplate } from './types.js'

/** 读取 kernels/templates 下每个模板的 template.json，得到内核模板列表。 */
export function listTemplates(templatesDir: string): KernelTemplate[] {
  if (!existsSync(templatesDir)) return []
  const entries = readdirSync(templatesDir, { withFileTypes: true })
  const templates: KernelTemplate[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const file = join(templatesDir, entry.name, 'template.json')
    if (!existsSync(file)) continue
    try {
      templates.push(JSON.parse(readFileSync(file, 'utf8')) as KernelTemplate)
    } catch {
      // 跳过损坏的模板文件
    }
  }

  return templates.sort((a, b) => a.id.localeCompare(b.id))
}

export function findTemplate(templatesDir: string, id: string): KernelTemplate | null {
  return listTemplates(templatesDir).find((t) => t.id === id) ?? null
}

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { AuditFinding, PluginAuditReport, SecurityLevel } from './types.js'

interface SecurityRule {
  id: string
  name: string
  severity: 'info' | 'warning' | 'danger'
  regex: RegExp
  message: string
  classify?: (match: RegExpExecArray, content: string) => { severity: 'info' | 'warning' | 'danger'; message: string }
}

const SECURITY_RULES: SecurityRule[] = [
  {
    id: 'SEC-ENV-HARVEST',
    name: '环境变量全量提取',
    severity: 'danger',
    regex: /(?:Object\.(?:keys|values|entries)\s*\(\s*process\.env\s*\)|JSON\.stringify\s*\(\s*process\.env\s*\)|for\s*\([^)]*\bin\b\s*process\.env)/g,
    message: '检测到遍历或全量导出系统环境变量 (process.env)，存在 API Key/凭据外泄风险',
  },
  {
    id: 'SEC-SENSITIVE-PATH',
    name: '敏感凭证与系统文件探测',
    severity: 'danger',
    regex: /(?:id_rsa|id_ed25519|id_dsa|\.ssh[\\/]+|\.credentials(?:\.ya?ml)?|\.aws[\\/]+credentials|etc[\\/]+passwd|system32[\\/]+config[\\/]+sam)/gi,
    message: '检测到包含敏感身份凭据路径或系统关键文件引用',
  },
  {
    id: 'SEC-SHELL-EXEC',
    name: '命令外壳执行',
    severity: 'warning',
    regex: /(?:child_process|\bexecSync|\bspawnSync|\bexec|\bspawn)\s*\(\s*['"`]([^'"`]+)['"`]/g,
    message: '插件调用了系统外壳执行命令',
    classify: (match) => {
      const cmd = (match[1] || '').toLowerCase()
      if (
        (cmd.includes('powershell') && (cmd.includes('-enc') || cmd.includes('-w hidden') || cmd.includes('-ep bypass'))) ||
        (cmd.includes('cmd.exe') && cmd.includes('/c')) ||
        cmd.includes('bash -i') ||
        cmd.includes('nc -e') ||
        (cmd.includes('curl ') && cmd.includes('|')) ||
        cmd.includes('rm -rf /')
      ) {
        return {
          severity: 'danger',
          message: `检测到高风险隐藏窗口或反弹命令: "${match[1]}"`,
        }
      }
      return {
        severity: 'warning',
        message: `插件调用了外部系统命令: "${match[1]}"`,
      }
    },
  },
  {
    id: 'SEC-DYNAMIC-EVAL',
    name: '动态代码求值',
    severity: 'warning',
    regex: /\b(?:eval|Function)\s*\(([^)]*)\)/g,
    message: '检测到动态代码求值 (eval / new Function)',
    classify: (_match, content) => {
      if (/Buffer\.from\([^)]*['"]base64['"]\)/.test(content) || /atob\s*\(/.test(content)) {
        return {
          severity: 'danger',
          message: '检测到 Base64 编码与动态求值组合，疑似混淆反弹代码',
        }
      }
      return {
        severity: 'warning',
        message: '检测到动态代码求值 (eval / new Function)，请确认实现必要性',
      }
    },
  },
  {
    id: 'SEC-RAW-SOCKET',
    name: '底层网络套接字监听',
    severity: 'warning',
    regex: /\b(?:net\.createConnection|net\.createServer|dgram\.createSocket)\s*\(/g,
    message: '检测到底层 Raw Socket / UDP 套接字连接，需审查其网络端点',
  },
]

/**
 * 递归收集插件目录下待审计的代码文件（限制最大文件数以保证毫秒级审计）
 */
function collectAuditFiles(dir: string, maxFiles = 60): string[] {
  const result: string[] = []

  function walk(current: string) {
    if (result.length >= maxFiles) return
    let entries: string[] = []
    try {
      entries = readdirSync(current)
    } catch {
      return
    }

    for (const name of entries) {
      if (result.length >= maxFiles) break
      if (name === 'node_modules' || name === '.git' || (name === 'dist' && current !== dir)) {
        continue
      }
      const full = join(current, name)
      try {
        const stat = statSync(full)
        if (stat.isDirectory()) {
          walk(full)
        } else if (
          stat.isFile() &&
          /\.(?:[cm]?js|ts|json)$/i.test(name) &&
          stat.size < 1024 * 1024
        ) {
          result.push(full)
        }
      } catch {}
    }
  }

  walk(dir)
  return result
}

/**
 * 执行静态代码安全审计
 */
export async function auditPackage(
  dirPath: string,
  pluginMeta?: { id?: string; name?: string; version?: string }
): Promise<PluginAuditReport> {
  const pluginName = pluginMeta?.name || 'unknown-plugin'
  const version = pluginMeta?.version || '1.0.0'
  const pluginId = pluginMeta?.id || `vault-${pluginName}`

  const isOfficial = pluginName.startsWith('@deepseek-ai/') || pluginName.startsWith('@godsh/')

  if (!existsSync(dirPath)) {
    return {
      pluginId,
      pluginName,
      version,
      level: isOfficial ? 'official' : 'safe',
      score: 100,
      findings: [],
      scannedFiles: 0,
      auditedAt: Date.now(),
    }
  }

  const files = collectAuditFiles(dirPath)
  const findings: AuditFinding[] = []

  for (const file of files) {
    let content = ''
    try {
      content = readFileSync(file, 'utf8')
    } catch {
      continue
    }

    const relPath = relative(dirPath, file).replace(/\\/g, '/')
    const lines = content.split(/\r?\n/)

    for (const rule of SECURITY_RULES) {
      rule.regex.lastIndex = 0
      let match: RegExpExecArray | null

      while ((match = rule.regex.exec(content)) !== null) {
        const matchIndex = match.index
        let currentLen = 0
        let lineNo = 1
        for (let i = 0; i < lines.length; i++) {
          const lineLength = lines[i]!.length + 1
          if (currentLen + lineLength > matchIndex) {
            lineNo = i + 1
            break
          }
          currentLen += lineLength
        }

        const snippet = (lines[lineNo - 1] || '').trim().slice(0, 140)
        let severity = rule.severity
        let message = rule.message

        if (rule.classify) {
          const classified = rule.classify(match, content)
          severity = classified.severity
          message = classified.message
        }

        findings.push({
          ruleId: rule.id,
          severity,
          file: relPath,
          line: lineNo,
          snippet,
          message,
        })

        if (findings.length > 50) break
      }
    }
  }

  let dangerCount = 0
  let warningCount = 0
  for (const f of findings) {
    if (f.severity === 'danger') dangerCount++
    if (f.severity === 'warning') warningCount++
  }

  let score = Math.max(0, 100 - dangerCount * 35 - warningCount * 10)
  if (isOfficial) {
    score = Math.max(90, score)
  }

  let level: SecurityLevel = 'safe'
  if (isOfficial) {
    level = 'official'
  } else if (dangerCount > 0) {
    level = 'danger'
  } else if (warningCount > 0) {
    level = 'warning'
  } else {
    level = 'safe'
  }

  return {
    pluginId,
    pluginName,
    version,
    level,
    score,
    findings,
    scannedFiles: files.length,
    auditedAt: Date.now(),
  }
}

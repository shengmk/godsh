import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 设计令牌作用域回归（对应方案 §9.6 的 U1 / U2）。
 *
 * 为什么这个测试放在 packages/core 而不是 apps/shell-web：
 *  - 根 tsconfig 明确 `exclude: ["apps/shell-web"]`，前端只由它自己的 tsconfig 检查（面向浏览器、
 *    没有 node 类型）；把读文件的测试放进去会平白给前端引入 node 依赖。
 *  - 这里读仓库内文件的方式与 `version.ts` 读根 package.json 一致，属本仓已有约定。
 *
 * 背景（缺陷 U1）：`:root` 与 `[data-theme='light']` 的特异性相同（都是 0,1,0），
 * 所以「先出现主题块、后出现同名令牌的 :root」会让主题块被静默覆盖。
 * 该缺陷曾让浅色主题下的 `--vault-*` 用上为深色调的值（已在浏览器中实测确认并修复）。
 */

const here = dirname(fileURLToPath(import.meta.url))
const cssPath = resolve(here, '..', '..', '..', 'apps', 'shell-web', 'src', 'styles.css')
const css = readFileSync(cssPath, 'utf8')
const lines = css.split(/\r?\n/)

interface TokenScope {
  selector: string
  line: number
  props: Map<string, number>
}

/** 解析出「令牌作用域」块（:root 与 [data-theme=...]）及其自定义属性定义行号。 */
function readTokenScopes(): TokenScope[] {
  const scopes: TokenScope[] = []
  let i = 0
  while (i < lines.length) {
    const m = /^([^\s{][^{]*)\{\s*$/.exec(lines[i] ?? '')
    if (!m) {
      i++
      continue
    }
    const selector = (m[1] ?? '').trim()
    const line = i + 1
    const props = new Map<string, number>()
    let depth = 1
    let j = i + 1
    while (j < lines.length && depth > 0) {
      const text = lines[j] ?? ''
      depth += (text.match(/\{/g) ?? []).length
      depth -= (text.match(/\}/g) ?? []).length
      if (depth > 0) {
        const p = /^\s*(--[A-Za-z0-9-]+)\s*:/.exec(text)
        const name = p?.[1]
        if (name && !props.has(name)) props.set(name, j + 1)
      }
      j++
    }
    if (/^:root$/.test(selector) || /^\[data-theme=/.test(selector)) scopes.push({ selector, line, props })
    i = j
  }
  return scopes
}

const scopes = readTokenScopes()
const baseScopes = scopes.filter((s) => s.selector === ':root')
const themeScopes = scopes.filter((s) => /^\[data-theme=/.test(s.selector))

test('设计令牌：基座 :root 只能有一个（U2 单一真源）', () => {
  assert.equal(
    baseScopes.length,
    1,
    `styles.css 里出现了 ${baseScopes.length} 个 :root 令牌块（行 ${baseScopes.map((s) => s.line).join(', ')}）——` +
      `U1 就是第二个 :root 造成的，请把令牌合并回文件顶部那一个`
  )
})

test('设计令牌：主题作用域不得被更靠后的 :root 覆盖（U1 级联回归）', () => {
  const baseLine = baseScopes[0]!.line
  const offenders: string[] = []
  for (const theme of themeScopes) {
    for (const [name, line] of theme.props) {
      if (line < baseLine) offenders.push(`${name}（主题块 L${line} 在基座 L${baseLine} 之前）`)
      const laterRoot = baseScopes.find((s) => s.line > line)
      if (laterRoot) offenders.push(`${name}: L${line} ${theme.selector} 被更靠后的 :root(L${laterRoot.line}) 覆盖`)
    }
  }
  assert.deepEqual(offenders, [], `存在被静默覆盖的令牌：\n  ${offenders.join('\n  ')}`)
})

test('设计令牌：每个主题作用域只能有一个令牌块（U2 单一真源，深色也不例外）', () => {
  for (const selector of ["[data-theme='light']", "[data-theme='dark']"]) {
    const found = themeScopes.filter((s) => s.selector === selector)
    assert.equal(
      found.length,
      1,
      `${selector} 出现了 ${found.length} 个令牌块（行 ${found.map((s) => s.line).join(', ')}）——` +
        `令牌分散在多个同名块里正是 U2 描述的漏改来源，请合并为一处`
    )
  }
})

test('设计令牌：--vault-* 在基座/浅色/深色三处各定义一次，且浅色与深色取值不同', () => {
  const names = ['--vault-1', '--vault-2', '--vault-bg', '--vault-border']
  const blocksOf = (selector: string): TokenScope[] => themeScopes.filter((s) => s.selector === selector)
  const light = blocksOf("[data-theme='light']")
  const dark = blocksOf("[data-theme='dark']")
  assert.ok(light.length && dark.length, '未找到浅色/深色令牌块')

  // 同一主题可能由多个块拼成（历史包袱），所以按「全部同名块里恰好命中一次」来断言
  const valueOf = (blocks: TokenScope[], name: string): string => {
    const hits = blocks.filter((b) => b.props.has(name))
    assert.equal(hits.length, 1, `${name} 在该主题作用域中应恰好定义一次，实际 ${hits.length} 次`)
    const at = hits[0]!.props.get(name)!
    const text = lines[at - 1] ?? ''
    const value = /:\s*([^;]+);/.exec(text)?.[1]?.trim() ?? ''
    assert.ok(value, `${name} 在第 ${at} 行没有解析出取值：${text}`)
    return value
  }

  for (const name of names) {
    // 三处都要有值，且浅色不能沿用深色/基座的值（这正是 U1 的表现）
    const base = valueOf(baseScopes, name)
    const lightValue = valueOf(light, name)
    const darkValue = valueOf(dark, name)
    assert.notEqual(lightValue, darkValue, `${name} 的浅色值不应等于深色值`)
    assert.equal(
      [base, lightValue, darkValue].filter((v) => v.length > 0).length,
      3,
      `${name} 必须在基座 / 浅色 / 深色三处都有取值`
    )
  }
})

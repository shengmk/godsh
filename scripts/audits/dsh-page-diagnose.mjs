/**
 * 诊断载荷：dsh web 首页在无头浏览器里到底渲染了什么。
 * 语句体格式（probe-browser 会包成 async 函数体），必须 return。
 */
const text = (document.body?.innerText ?? '').slice(0, 600)
const html = (document.documentElement?.outerHTML ?? '').slice(0, 1200)
const scripts = [...document.querySelectorAll('script')].map((s) => ({
  src: s.getAttribute('src'),
  inlineChars: (s.textContent ?? '').length,
}))
const links = [...document.querySelectorAll('link')].map((l) => l.getAttribute('href'))
return {
  href: location.href,
  title: document.title,
  bodyText: text,
  bodyChars: (document.body?.innerText ?? '').length,
  rootChildren: [...(document.body?.children ?? [])].map((c) => `${c.tagName}.${c.className}`).slice(0, 20),
  scripts: scripts.slice(0, 20),
  links: links.slice(0, 20),
  hasModuleLoader: typeof window.__ModuleLoader__ !== 'undefined',
  hasBoot: typeof window.__DSH_BOOT__ !== 'undefined',
  htmlHead: html.slice(0, 700),
}

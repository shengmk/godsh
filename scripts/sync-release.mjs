import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const projectRoot = process.cwd()
const distServer = join(projectRoot, 'apps', 'launcher', 'dist', 'server.mjs')
const distWeb = join(projectRoot, 'apps', 'shell-web', 'dist')
const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'))

const targets = [
  join(projectRoot, 'release', `godsh-${pkg.version}-x64`, 'resources'),
]

const localAppData = process.env.LOCALAPPDATA
if (localAppData) {
  const appDataGodsh = join(localAppData, 'godsh', 'resources')
  if (existsSync(appDataGodsh)) {
    targets.push(appDataGodsh)
  }
}

for (const target of targets) {
  console.log(`Syncing to ${target}...`)
  mkdirSync(target, { recursive: true })
  if (existsSync(distServer)) {
    cpSync(distServer, join(target, 'server.mjs'))
    console.log(`  ✓ Synced server.mjs`)
  }
  if (existsSync(distWeb)) {
    const webTarget = join(target, 'shell-web')
    mkdirSync(webTarget, { recursive: true })
    cpSync(distWeb, webTarget, { recursive: true })
    console.log(`  ✓ Synced shell-web assets`)
  }
}

console.log('All release resources synchronized successfully!')

import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const projectRoot = process.cwd()
const distServer = join(projectRoot, 'apps', 'launcher', 'dist', 'server.mjs')
const distWeb = join(projectRoot, 'apps', 'shell-web', 'dist')

const targets = [
  join(projectRoot, 'release', 'godsh-0.5.1-x64', 'resources'),
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

import { existsSync, rmSync, renameSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const dshHome = join(homedir(), '.dsh')
const profilesDir = join(dshHome, 'profiles')
const backupsDir = join(dshHome, 'backups')

console.log('--- Step 1: Cleaning Profiles in', profilesDir)

const targetsToDelete = ['manage', 'test-profile', 'plugin_bag']
for (const name of targetsToDelete) {
  const p = join(profilesDir, name)
  if (existsSync(p)) {
    console.log(`Deleting profile: ${name} (${p})`)
    rmSync(p, { recursive: true, force: true })
    console.log(`Deleted: ${name}`)
  } else {
    console.log(`Profile not found (already clean): ${name}`)
  }
}

// Move dsh-update-checker-backups to ~/.dsh/backups
const backupSrc = join(profilesDir, 'dsh-update-checker-backups')
if (existsSync(backupSrc)) {
  mkdirSync(backupsDir, { recursive: true })
  const backupDest = join(backupsDir, 'dsh-update-checker-backups')
  if (existsSync(backupDest)) {
    rmSync(backupDest, { recursive: true, force: true })
  }
  renameSync(backupSrc, backupDest)
  console.log(`Moved dsh-update-checker-backups to: ${backupDest}`)
}

// Clean stray log/state files in profiles dir if any
const strayFiles = [
  'dsh-update-checker-ops.log',
  'dsh-update-checker-state.json',
  'dsh-update-checker-update-progress.json',
]
for (const file of strayFiles) {
  const fp = join(profilesDir, file)
  if (existsSync(fp)) {
    const dest = join(dshHome, 'logs', file)
    try {
      renameSync(fp, dest)
      console.log(`Moved stray file ${file} -> logs`)
    } catch {
      rmSync(fp, { force: true })
      console.log(`Removed stray file: ${file}`)
    }
  }
}

// Clean vault.json installedProfiles
const vaultPaths = [
  join(process.cwd(), 'data', 'vault.json'),
  join(homedir(), 'AppData', 'Roaming', 'godsh', 'data', 'vault.json'),
]

for (const vp of vaultPaths) {
  if (existsSync(vp)) {
    try {
      const data = JSON.parse(readFileSync(vp, 'utf8'))
      if (Array.isArray(data.plugins)) {
        let cleaned = 0
        for (const p of data.plugins) {
          if (Array.isArray(p.installedProfiles)) {
            const origLen = p.installedProfiles.length
            p.installedProfiles = p.installedProfiles.filter(
              (prof) => !targetsToDelete.includes(prof)
            )
            if (p.installedProfiles.length !== origLen) cleaned++
          }
        }
        writeFileSync(vp, JSON.stringify(data, null, 2), 'utf8')
        console.log(`Cleaned ${cleaned} entries in ${vp}`)
      }
    } catch (e) {
      console.error(`Error cleaning ${vp}:`, e)
    }
  }
}

console.log('--- Step 1 Finished successfully! ---')

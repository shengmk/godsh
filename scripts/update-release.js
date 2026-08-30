// godsh GitHub Release 更新脚本（Node，UTF-8 安全）
// 用法: node scripts/update-release.js <version> [--body <body文件>] [--upload <目录>]
// 功能: 更新指定 tag 的 Release body；若 --upload 指定目录，则删除该 Release 上旧的同名资产并重新上传目录中所有文件
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const args = process.argv.slice(2);
const version = args[0];
if (!version) { console.error('用法: node scripts/update-release.js <version> [--body <file>] [--upload <dir>]'); process.exit(1); }
const bodyIdx = args.indexOf('--body');
const bodyFile = bodyIdx >= 0 ? args[bodyIdx + 1] : null;
const upIdx = args.indexOf('--upload');
const uploadDir = upIdx >= 0 ? args[upIdx + 1] : null;

const REPO = 'shengmk/godsh';
const TAG = `v${version}`;

function gitCred() {
  const out = execFileSync('git', ['credential', 'fill'], {
    input: `protocol=https\nhost=github.com\n\n`,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const token = out.split('\n').find(l => l.startsWith('password='))?.slice(9);
  if (!token) { console.error('无法从 git credential 获取 token'); process.exit(1); }
  return token.trim();
}

async function main() {
  const token = gitCred();
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  // 1) 找 Release
  const relRes = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${TAG}`, { headers });
  if (!relRes.ok) { console.error(`获取 Release 失败: ${relRes.status} ${await relRes.text()}`); process.exit(1); }
  const rel = await relRes.json();
  console.log(`找到 Release: ${rel.name} (id=${rel.id})`);

  // 2) 更新 body
  if (bodyFile) {
    const body = fs.readFileSync(bodyFile, 'utf8');
    const upd = await fetch(`https://api.github.com/repos/${REPO}/releases/${rel.id}`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
    if (!upd.ok) { console.error(`更新 body 失败: ${upd.status} ${await upd.text()}`); process.exit(1); }
    console.log('Release body 已更新');
  }

  // 3) 上传资产（先删旧的同名；只处理当前版本相关文件 + SHA256SUMS.txt）
  if (uploadDir) {
    const prefix = `godsh-${version}-`;
    const files = fs.readdirSync(uploadDir)
      .filter(f => fs.statSync(path.join(uploadDir, f)).isFile())
      .filter(f => f === 'SHA256SUMS.txt' || f.startsWith(prefix));
    for (const asset of rel.assets) {
      const same = files.some(f => f === asset.name);
      if (same) {
        const del = await fetch(`https://api.github.com/repos/${REPO}/releases/assets/${asset.id}`, { method: 'DELETE', headers });
        if (!del.ok && del.status !== 404) { console.error(`删除旧资产 ${asset.name} 失败: ${del.status}`); process.exit(1); }
        console.log(`已删除旧资产: ${asset.name}`);
      }
    }
    for (const f of files) {
      const full = path.join(uploadDir, f);
      const buf = fs.readFileSync(full);
      const up = await fetch(`https://uploads.github.com/repos/${REPO}/releases/${rel.id}/assets?name=${encodeURIComponent(f)}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': String(buf.length) },
        body: buf,
      });
      if (!up.ok) { console.error(`上传 ${f} 失败: ${up.status} ${await up.text()}`); process.exit(1); }
      console.log(`已上传: ${f} (${(buf.length / 1024 / 1024).toFixed(2)} MB)`);
    }
  }

  console.log('完成');
}

main().catch(e => { console.error(e); process.exit(1); });

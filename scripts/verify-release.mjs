import { execFileSync } from 'child_process';

function gitCred() {
  const out = execFileSync('git', ['credential', 'fill'], {
    input: `protocol=https\nhost=github.com\n\n`,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return out.split('\n').find(l => l.startsWith('password='))?.slice(9).trim();
}

const token = gitCred();
const version = process.argv[2] ?? '0.2.9';
const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };
const rel = await (await fetch(`https://api.github.com/repos/shengmk/godsh/releases/tags/v${version}`, { headers })).json();
console.log(`Release: ${rel.name} | tag: ${rel.tag_name} | draft: ${rel.draft} | prerelease: ${rel.prerelease}`);
for (const a of rel.assets) console.log(`资产: ${a.name}  ${(a.size / 1024 / 1024).toFixed(2)}MB  updated: ${a.updated_at}`);
console.log('--- body 前 20 行 ---');
console.log(rel.body.split('\n').slice(0, 20).join('\n'));

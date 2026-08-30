// GitHub API push(git 协议被墙时的替代):用 git database API 把本地未推送提交同步到远程
// 用法: node api-push.mjs <远端分支名=main> [--tag v0.3.1]
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const REPO = 'shengmk/godsh';
const BRANCH = process.argv[2] ?? 'main';
const TAG = process.argv.find((a) => a.startsWith('--tag='))?.slice(6);
// git 命令在项目根运行
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', cwd: PROJECT_ROOT, ...opts }).trim();
}
function gitCred() {
  const out = execFileSync('git', ['credential', 'fill'], {
    input: `protocol=https\nhost=github.com\n\n`, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  });
  return out.split('\n').find((l) => l.startsWith('password='))?.slice(9).trim();
}
const token = gitCred();
const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' };
const api = async (path, opts = {}) => {
  const res = await fetch(`https://api.github.com${path}`, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path}: ${res.status} ${JSON.stringify(data).slice(0, 200)}`);
  return data;
};

const localHead = git(['rev-parse', BRANCH]);
const remoteRef = await api(`/repos/${REPO}/git/ref/heads/${BRANCH}`).catch(() => null);
let remoteHead = remoteRef?.object?.sha ?? null;
console.log(`本地 ${BRANCH}: ${localHead}`);
console.log(`远程 ${BRANCH}: ${remoteHead ?? '(不存在)'}`);

// 需要推送的提交(本地有、远程没有)
let commits;
if (remoteHead) {
  try {
    commits = git(['rev-list', `${remoteHead}..${localHead}`]).split('\n').filter(Boolean).reverse();
  } catch {
    // 远程 head 是 API push 创建的对象(本地 git 无法比较) → 仅更新 tag
    commits = [];
    console.log(`远程 head ${remoteHead.slice(0, 7)} 不在本地对象库，跳过提交推送（仅处理 tag）`)
  }
} else {
  commits = [localHead];
}
if (commits.length === 0 && !TAG) {
  console.log('无需推送');
  process.exit(0);
}
console.log(`待推送提交(${commits.length}): ${commits.join(', ')}`);

// blob 上传缓存: path -> sha
const blobCache = new Map();
async function uploadBlob(content, mode, path) {
  if (blobCache.has(path)) return blobCache.get(path);
  const b = await api(`/repos/${REPO}/git/blobs`, {
    method: 'POST', body: JSON.stringify({ content: content.toString('base64'), encoding: 'base64' }),
  });
  blobCache.set(path, b.sha);
  return b.sha;
}

// 处理每个提交: 依赖前一个(本地或远程)作为 parent
let parentCommit = remoteHead;
let parentTree = parentCommit
  ? (await api(`/repos/${REPO}/git/commits/${parentCommit}`)).tree.sha
  : null;

for (const commit of commits) {
  console.log(`\n=== 处理 ${commit} ===`);
  const msg = git(['log', '-1', '--format=%B', commit]);
  // 变更文件列表(非 -z,每行 `:mode mode old new status\tpath`)
  const changes = git(['diff-tree', '-r', '--no-commit-id', '--raw', commit]).split('\n').filter(Boolean);
  const treeItems = [];
  for (const line of changes) {
    const tabIdx = line.indexOf('\t')
    const meta = tabIdx >= 0 ? line.slice(0, tabIdx) : line
    const path = tabIdx >= 0 ? line.slice(tabIdx + 1) : ''
    const m = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([AMD])[RT]?$/.exec(meta)
    if (!m || !path) continue
    const [, , , , newSha, status] = m
    if (status === 'D') {
      // 删除文件: 传 null sha 从 base_tree 移除
      treeItems.push({ path, mode: '100644', type: 'blob', sha: null })
      console.log(`  - ${path}`)
      continue
    }
    const content = Buffer.from(git(['cat-file', 'blob', newSha]), 'utf8')
    const mode = m[2] === '100755' ? '100755' : '100644'
    const sha = await uploadBlob(content, mode, path)
    treeItems.push({ path, mode, type: 'blob', sha })
    console.log(`  + ${path} (${sha.slice(0, 7)})`)
  }
  // 基于 base_tree 构建新 tree
  const tree = await api(`/repos/${REPO}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({ base_tree: parentTree, tree: treeItems }),
  });
  parentTree = tree.sha;
  // 创建 commit
  const c = await api(`/repos/${REPO}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({ message: msg || ' ', tree: tree.sha, parents: parentCommit ? [parentCommit] : [] }),
  });
  console.log(`  commit 创建: ${c.sha.slice(0, 7)} (tree ${tree.sha.slice(0, 7)})`);
  parentCommit = c.sha;
}

// 更新分支 ref
await api(`/repos/${REPO}/git/refs/heads/${BRANCH}`, {
  method: 'PATCH', body: JSON.stringify({ sha: parentCommit, force: true }),
});
console.log(`\n分支 ${BRANCH} 已更新到 ${parentCommit.slice(0, 7)}`);

// 更新 tag(若指定): 指向刚推送的远程 head(API push 的 commit SHA 与本地不同,必须用远程 SHA)
if (TAG) {
  const localTag = git(['rev-parse', TAG]);
  try {
    const tagObj = await api(`/repos/${REPO}/git/tags`, {
      method: 'POST',
      body: JSON.stringify({ tag: TAG, message: ' ', object: parentCommit, type: 'commit', tagger: { name: 'godsh', email: 'godsh@local', date: new Date().toISOString() } }),
    });
    const existing = await api(`/repos/${REPO}/git/ref/tags/${TAG}`).catch(() => null);
    if (existing) {
      await api(`/repos/${REPO}/git/refs/tags/${TAG}`, { method: 'PATCH', body: JSON.stringify({ sha: tagObj.sha, force: true }) });
    } else {
      await api(`/repos/${REPO}/git/refs`, { method: 'POST', body: JSON.stringify({ ref: `refs/tags/${TAG}`, sha: tagObj.sha }) });
    }
    console.log(`tag ${TAG} 已指向 ${parentCommit.slice(0, 7)}（本地对象为 ${localTag.slice(0, 7)}）`);
  } catch (e) {
    console.warn(`tag 更新失败: ${e.message}`);
  }
}
console.log('API push 完成');

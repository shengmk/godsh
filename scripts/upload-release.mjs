import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { execSync } from 'node:child_process';

const credOut = execSync('git credential fill', {
  input: 'protocol=https\nhost=github.com\n\n',
  encoding: 'utf8'
});
const token = credOut.match(/password=(.+)/)[1].trim();

const owner = 'shengmk';
const repo = 'godsh';
const version = process.argv[2] || '0.6.0';
const tag = `v${version}`;
const releaseName = `godsh v${version} — 全局 UI/UX 电影级重构与无控制台启动`;
const releaseNotes = fs.readFileSync(path.resolve('release/RELEASE_NOTES.md'), 'utf8');

function request(options, data = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, headers: res.headers, data: body ? JSON.parse(body) : null });
        } catch {
          resolve({ statusCode: res.statusCode, headers: res.headers, data: body });
        }
      });
    });
    req.on('error', reject);
    if (data) {
      if (Buffer.isBuffer(data)) {
        req.write(data);
      } else if (typeof data === 'string') {
        req.write(data);
      } else {
        req.write(JSON.stringify(data));
      }
    }
    req.end();
  });
}

async function run() {
  console.log('==> 检查现有 Release...');
  let res = await request({
    hostname: 'api.github.com',
    path: `/repos/${owner}/${repo}/releases/tags/${tag}`,
    method: 'GET',
    headers: {
      'User-Agent': 'godsh-uploader',
      'Authorization': `Bearer ${token}`
    }
  });

  let release = null;
  if (res.statusCode === 200) {
    console.log(`==> 发现已有 Release (id: ${res.data.id})`);
    release = res.data;
  } else {
    console.log('==> 创建 Release...');
    const createRes = await request({
      hostname: 'api.github.com',
      path: `/repos/${owner}/${repo}/releases`,
      method: 'POST',
      headers: {
        'User-Agent': 'godsh-uploader',
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    }, {
      tag_name: tag,
      name: releaseName,
      body: releaseNotes,
      draft: false,
      prerelease: false
    });

    if (createRes.statusCode !== 201) {
      console.error('创建 Release 失败:', createRes.statusCode, createRes.data);
      process.exit(1);
    }
    release = createRes.data;
    console.log(`==> Release 创建成功 (id: ${release.id})`);
  }

  const files = [
    `godsh-${version}-x64-setup.exe`,
    `godsh-${version}-x64.zip`,
    'SHA256SUMS.txt'
  ];

  for (const fileName of files) {
    const filePath = path.resolve('release', fileName);
    if (!fs.existsSync(filePath)) {
      console.warn(`文件不存在，跳过: ${filePath}`);
      continue;
    }

    // 检查是否已存在同名资产
    const existing = (release.assets || []).find(a => a.name === fileName);
    if (existing) {
      console.log(`==> 资产 ${fileName} 已存在，正在删除旧版本 (id: ${existing.id})...`);
      await request({
        hostname: 'api.github.com',
        path: `/repos/${owner}/${repo}/releases/assets/${existing.id}`,
        method: 'DELETE',
        headers: {
          'User-Agent': 'godsh-uploader',
          'Authorization': `Bearer ${token}`
        }
      });
    }

    console.log(`==> 正在上传 ${fileName} (${(fs.statSync(filePath).size / 1024 / 1024).toFixed(2)} MB)...`);
    const fileBuffer = fs.readFileSync(filePath);
    const contentType = fileName.endsWith('.exe')
      ? 'application/vnd.microsoft.portable-executable'
      : fileName.endsWith('.zip')
      ? 'application/zip'
      : 'text/plain';

    const uploadRes = await request({
      hostname: 'uploads.github.com',
      path: `/repos/${owner}/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(fileName)}`,
      method: 'POST',
      headers: {
        'User-Agent': 'godsh-uploader',
        'Authorization': `Bearer ${token}`,
        'Content-Type': contentType,
        'Content-Length': fileBuffer.length
      }
    }, fileBuffer);

    if (uploadRes.statusCode === 201) {
      console.log(`✓ 成功上传: ${fileName}`);
    } else {
      console.error(`✗ 上传失败: ${fileName}`, uploadRes.statusCode, uploadRes.data);
    }
  }

  console.log(`\n🎉 全部 Release 产物上传完毕！URL: ${release.html_url}`);
}

run().catch(console.error);

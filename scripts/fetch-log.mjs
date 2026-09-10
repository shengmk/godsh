import { execFileSync } from 'child_process';

const out = execFileSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8' });
const token = out.split('\n').find(l => l.startsWith('password='))?.slice(9).trim();

async function getLogs() {
  const headers = { 'User-Agent': 'godsh-ci', 'Authorization': 'token ' + token };
  // run id 不再硬编码：用 GODSH_RUN_ID 环境变量或第一个参数传入
  const runId = process.env.GODSH_RUN_ID || process.argv[2];
  if (!runId) {
    console.error('用法: GODSH_RUN_ID=<runId> node scripts/fetch-log.mjs  （或 node scripts/fetch-log.mjs <runId>）');
    process.exit(1);
  }
  const res = await fetch(`https://api.github.com/repos/shengmk/godsh/actions/runs/${runId}/jobs`, { headers });
  const data = await res.json();
  const jobId = data.jobs[0].id;
  console.log('Job ID:', jobId);

  const logRes = await fetch(`https://api.github.com/repos/shengmk/godsh/actions/jobs/${jobId}/logs`, { headers });
  const logText = await logRes.text();
  const lines = logText.split('\n');
  const installDepsIdx = lines.findIndex(l => l.includes('Install deps'));
  console.log('Install deps start line:', installDepsIdx);
  if (installDepsIdx !== -1) {
    lines.slice(installDepsIdx, installDepsIdx + 45).forEach(l => console.log(l));
  } else {
    lines.slice(-45).forEach(l => console.log(l));
  }
}

getLogs().catch(console.error);

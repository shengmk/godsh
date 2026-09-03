import { execFileSync } from 'child_process';

const out = execFileSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8' });
const token = out.split('\n').find(l => l.startsWith('password='))?.slice(9).trim();

async function getLogs() {
  const headers = { 'User-Agent': 'godsh-ci', 'Authorization': 'token ' + token };
  const res = await fetch('https://api.github.com/repos/shengmk/godsh/actions/runs/33773743087/jobs', { headers });
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

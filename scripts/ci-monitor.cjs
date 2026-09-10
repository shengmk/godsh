const fs = require('fs');

async function monitor() {
  const headers = { 'User-Agent': 'godsh-ci' };
  // run id 不再硬编码：用 GODSH_RUN_ID 环境变量或第一个参数传入
  const runId = process.env.GODSH_RUN_ID || process.argv[2];
  if (!runId) {
    console.error('用法: GODSH_RUN_ID=<runId> node scripts/ci-monitor.cjs  （或 node scripts/ci-monitor.cjs <runId>）');
    process.exit(1);
  }
  const repo = 'shengmk/godsh';
  // 版本号取唯一真源（根 package.json），不再硬编码某一版
  const version = JSON.parse(fs.readFileSync(require('path').join(__dirname, '..', 'package.json'), 'utf8')).version;

  console.log(`[Monitor] Tracking Run #${runId}...`);

  while (true) {
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}/actions/runs/${runId}`, { headers });
      const run = await res.json();
      
      const jRes = await fetch(`https://api.github.com/repos/${repo}/actions/runs/${runId}/jobs`, { headers });
      const jData = await jRes.json();
      if (jData.jobs && jData.jobs[0]) {
        const j = jData.jobs[0];
        const activeStep = j.steps.find(s => s.status === 'in_progress');
        const failedStep = j.steps.find(s => s.conclusion === 'failure');
        if (activeStep) {
          console.log(`[Progress] Job: ${j.status} | Step in progress: ${activeStep.name}`);
        } else if (failedStep) {
          console.log(`[Failed Step] ${failedStep.name}`);
        } else {
          console.log(`[Status] ${run.status} | conclusion: ${run.conclusion}`);
        }
      }

      if (run.status === 'completed') {
        console.log(`[Completed] Result: ${run.conclusion}`);
        console.log(`URL: ${run.html_url}`);
        
        if (run.conclusion === 'success') {
          console.log('\n--- Release Assets ---');
          const relRes = await fetch(`https://api.github.com/repos/${repo}/releases/tags/v${version}`, { headers });
          const rel = await relRes.json();
          if (rel.assets) {
            for (const a of rel.assets) {
              console.log(`- ${a.name} (${(a.size / 1024 / 1024).toFixed(2)} MB)`);
            }
          }
        }
        break;
      }
    } catch (e) {
      console.error('[Error]', e.message);
    }

    await new Promise(r => setTimeout(r, 20000));
  }
}

monitor();

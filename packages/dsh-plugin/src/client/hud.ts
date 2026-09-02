/**
 * In-DSH 右下角常驻全局任务 HUD 胶囊 (GodshTaskHud)
 * 挂载至 DSH global.overlay，实现流式任务日志与进度监控
 */
export class GodshTaskHud {
  renderHtml(taskName = '就绪', progress = 100, isRunning = false): string {
    return `
      <div id="godsh-hud-capsule" style="position: fixed; bottom: 20px; right: 20px; z-index: 9999; background: #161b22; border: 1px solid #30363d; border-radius: 20px; padding: 6px 14px; box-shadow: 0 8px 24px rgba(0,0,0,0.5); display: flex; align-items: center; gap: 8px; font-family: sans-serif; font-size: 12px; color: #c9d1d9; cursor: pointer;">
        <span style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: ${isRunning ? '#58a6ff' : '#2ea043'};"></span>
        <span style="font-weight: 600;">godsh:</span>
        <span>${taskName}</span>
        ${isRunning ? `<span style="color: #58a6ff; font-weight: bold;">${progress}%</span>` : ''}
      </div>
    `
  }
}

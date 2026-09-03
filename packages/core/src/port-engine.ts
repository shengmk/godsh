import net from 'node:net'
import { findPidByPort } from './process-manager.js'

/**
 * 探测指定端口当前是否真正空闲（双重检验：系统级 netstat 进程探活 + Socket 独占性绑定测试）
 */
export async function isPortAvailable(port: number, host = '127.0.0.1'): Promise<boolean> {
  // 1. 系统级占用检测（通过 netstat 反查 PID）
  const pid = findPidByPort(port)
  if (pid !== null) return false

  // 2. 原生 Socket 绑定测试
  return new Promise((resolve) => {
    const server = net.createServer()
    server.unref()
    server.on('error', () => resolve(false))
    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => resolve(true))
    })
  })
}

/**
 * 动态安全端口协商：
 * - 若指定了 preferredPort 且当前未被占用，优先返回该端口；
 * - 若未指定（或已被占用），在 safeRange（默认 3200~3999）内随机分配一个空闲端口。
 */
export async function resolveSafePort(
  preferredPort?: number,
  host = '127.0.0.1',
  safeRange: [number, number] = [3200, 3999],
  maxRetries = 25,
): Promise<number> {
  if (preferredPort && preferredPort > 0) {
    const available = await isPortAvailable(preferredPort, host)
    if (available) return preferredPort
  }

  const [min, max] = safeRange
  for (let i = 0; i < maxRetries; i++) {
    const candidate = Math.floor(Math.random() * (max - min + 1)) + min
    const available = await isPortAvailable(candidate, host)
    if (available) return candidate
  }

  // 极限回退：由操作系统内核自动分配临时未占用端口
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, host, () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') {
        const port = addr.port
        server.close(() => resolve(port))
      } else {
        server.close(() => reject(new Error('无法分配系统动态空闲端口')))
      }
    })
  })
}

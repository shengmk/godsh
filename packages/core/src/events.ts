export type Listener<T> = (payload: T) => void
export type Unsubscribe = () => void

/** 极简类型安全事件总线，用于 Launcher 各模块解耦。 */
export class EventBus<Events extends object = Record<string, never>> {
  private listeners = new Map<keyof Events, Set<(payload: never) => void>>()

  on<K extends keyof Events>(event: K, fn: Listener<Events[K]>): Unsubscribe {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(fn as (payload: never) => void)
    return () => set.delete(fn as (payload: never) => void)
  }

  once<K extends keyof Events>(event: K, fn: Listener<Events[K]>): Unsubscribe {
    const off = this.on(event, (payload) => {
      off()
      fn(payload)
    })
    return off
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.listeners.get(event)
    if (!set) return
    for (const fn of [...set]) (fn as Listener<Events[K]>)(payload)
  }

  clear(): void {
    this.listeners.clear()
  }
}

/** Launcher 全局事件类型。 */
export interface LauncherEvents {
  'process:started': { profile: string; port: number; pid: number }
  'process:stopped': { profile: string; port: number }
  'profile:changed': { name: string }
  'plugin:changed': { profile: string; plugin: string }
}

export type LauncherBus = EventBus<LauncherEvents>

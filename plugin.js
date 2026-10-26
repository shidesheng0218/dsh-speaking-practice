/**
 * dsh-speaking-practice — stable dev shell installed into the desktop profile.
 *
 * This file is intentionally tiny and rarely changes. It mounts the real plugin
 * implementation (./src/index.js) as a child Cordis plugin and can remount it
 * without restarting DeepSeek Harness:
 *   - "/voice-reload" command forces a remount
 *   - a filesystem watcher remounts when files under ./src change (dev only)
 *
 * Log: <packageRoot>/logs/voice-loader.log
 */
import { appendFileSync, mkdirSync, watch } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const CHILD_URL = new URL('./src/index.js', import.meta.url)
const LOG_PATH = join(ROOT, 'logs', 'voice-loader.log')

export const name = 'dsh-speaking-practice'
export const inject = ['commands']

function log(line) {
  const text = `[${new Date().toISOString()}] ${line}\n`
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true })
    appendFileSync(LOG_PATH, text)
  } catch {
    // logging must never break plugin loading
  }
  try {
    console.log('[voice-practice]', line.trim())
  } catch {}
}

export function apply(ctx, config) {
  let fiber = null
  let mounting = false
  let remountQueued = false
  let watcher = null
  let disposed = false
  let debounce = null

  async function mount(reason) {
    if (disposed) return
    if (mounting) {
      remountQueued = true
      return
    }
    mounting = true
    try {
      do {
        remountQueued = false
        if (fiber !== null) {
          try {
            await fiber.dispose()
          } catch (error) {
            log(`dispose failed: ${String(error?.stack ?? error)}`)
          }
          fiber = null
        }
        if (disposed) return
        const t = Date.now()
        try {
          const child = await import(`${CHILD_URL.href}?t=${t}`)
          fiber = ctx.plugin(child, config)
          await fiber
          log(`mounted (${reason}) t=${t}`)
        } catch (error) {
          fiber = null
          log(`mount failed (${reason}): ${String(error?.stack ?? error)}`)
        }
      } while (remountQueued && !disposed)
    } finally {
      mounting = false
    }
  }

  ctx.effect(() => {
    const disposeWatcher = () => {
      if (debounce !== null) clearTimeout(debounce)
      debounce = null
      try {
        watcher?.close()
      } catch {}
      watcher = null
    }
    try {
      watcher = watch(join(ROOT, 'src'), { recursive: true }, () => {
        if (disposed) return
        if (debounce !== null) clearTimeout(debounce)
        debounce = setTimeout(() => {
          debounce = null
          void mount('watcher')
        }, 600)
      })
      log('watching ./src for dev reloads')
    } catch (error) {
      log(`watcher unavailable: ${String(error?.message ?? error)}`)
    }
    return async () => {
      disposed = true
      disposeWatcher()
      if (fiber !== null) {
        try {
          await fiber.dispose()
        } catch (error) {
          log(`dispose on teardown failed: ${String(error?.stack ?? error)}`)
        }
        fiber = null
      }
      log('shell disposed')
    }
  }, 'dsh-speaking-practice: dev shell')

  ctx.commands.register({
    name: 'voice-reload',
    description: 'Reload the speaking-practice plugin code (dev helper)',
    handler: async () => {
      await mount('command')
      return { kind: 'success', text: 'voice-practice reloaded' }
    },
  })

  void mount('startup')
}

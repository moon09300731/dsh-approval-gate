/**
 * 复现 `[dsh-approval-gate] permissionPresets.current failed` 的根因。
 *
 * 结论：`Session` 类没有 `events` 属性（只有 `snapshotEvents()` 方法）。
 * 插件把 `session.events`（undefined）当成 Session 传给
 * `permissionPresets.current()`，最终在
 * `dsh-session-projection` 的 `cellFor()` 里读取 `session.header` 时崩溃。
 *
 * 本脚本用**真实的** cordis + dsh-session-projection + dsh-session 包驱动，
 * 不使用 dsh-approval-gate 的任何代码，因此可作为独立证据。
 *
 * 运行：node test/repro-permission-presets-crash.mjs
 */

import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** 定位 npx 缓存里的 @deepseek-ai 包根目录（可用 DSH_NPX_CACHE 覆盖）。 */
function resolveScope() {
  const candidates = [
    process.env.DSH_NPX_CACHE,
    process.env.DSH_CHECKOUT,
    '/Users/yuzhimin/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai',
  ].filter(Boolean)
  for (const dir of candidates) {
    if (dir && existsSync(join(dir, 'dsh-session-projection'))) return dir
  }
  throw new Error('找不到 @deepseek-ai 包目录；请设置 DSH_NPX_CACHE 指向 .../node_modules/@deepseek-ai')
}

const SCOPE = resolveScope()
const load = (rel) => import(pathToFileURL(join(SCOPE, rel)).href)

const { Context } = await load('cordis/lib/index.js')
const { SessionProjectionRegistry } = await load('dsh-session-projection/lib/index.js')
const { Session, SessionId } = await load('dsh-session/lib/index.js')

let failures = 0
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

// ── 证据 1：真实 Session 实例上没有 `events` / `cwd` ─────────────────────────
const session = Session.create(SessionId('sess_repro'), [])

console.log('— 真实 Session 实例（@deepseek-ai/dsh-session） —')
check('session.events === undefined（插件正是把它传给了 current()）', session.events === undefined)
check('session.cwd === undefined（cwd 实际在 session.header.cwd 上）', session.cwd === undefined)
check('session.header 存在（cellFor 崩溃点读取的就是它）', session.header !== undefined)
check('session.snapshotEvents() 存在且返回数组（正确的事件读取 API）',
  typeof session.snapshotEvents === 'function' && Array.isArray(session.snapshotEvents()))
console.log(`  实例自有属性 = ${Object.keys(session).sort().join(', ')}`)

// ── 证据 2：用真实的 SessionProjectionRegistry 复现崩溃帧链 ──────────────────
// 只注册一个形如 dsh-permission-presets 的 `permissions` 单元，
// 然后完全按 permissionState → stateOf → materializeCells → cellFor 调用。
const ctx = new Context()
const registry = new SessionProjectionRegistry(ctx)
registry.register({
  key: 'permissions',
  stateVersion: 0,
  init: () => ({ preset: null, sandbox: null, approval: null, seeded: false }),
  apply: (state) => state,
})

console.log('\n— 崩溃路径：把 session.events（undefined）当 Session 传入 —')
try {
  registry.stateOf(session.events, 'permissions')
  check('stateOf(undefined) 应当抛错', false, '没有抛错')
} catch (error) {
  const hit = error instanceof TypeError && /reading 'header'/.test(error.message)
  check('抛出 TypeError: Cannot read properties of undefined (reading \'header\')', hit, error.message)
  const frame = (error.stack || '').split('\n').find((l) => l.includes('cellFor'))
  check('崩溃点在 cellFor 内', Boolean(frame), frame?.trim())
}

console.log('\n— 正确路径：传入真正的 Session（等价于 current(session)） —')
try {
  const state = registry.stateOf(session, 'permissions')
  check('stateOf(session, "permissions") 正常返回折叠状态', state?.preset === null, JSON.stringify(state))
} catch (error) {
  check('stateOf(session) 不应抛错', false, error.message)
}

console.log(`\n${failures === 0 ? '全部通过：根因确认为「把 session.events 当成 session 传入」' : `${failures} 项断言失败`}`)
process.exitCode = failures === 0 ? 0 : 1

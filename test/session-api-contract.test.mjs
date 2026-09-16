/**
 * 回归护栏：dsh-approval-gate 只能使用真实存在的 Session API。
 *
 * 背景（v0.5.0 / v0.5.2 的真实事故）：插件曾调用
 * `permissionPresets.current(session.events)`，但 `Session`
 * （@deepseek-ai/dsh-session）**没有** `events` 属性，只有 `snapshotEvents()`。
 * 于是 `undefined` 被当作 Session 一路传进
 * `dsh-session-projection` 的 `cellFor()`，在读取 `session.header` 时抛
 * `TypeError: Cannot read properties of undefined (reading 'header')`，
 * 被 catch 后静默 `next()` —— 审批门控完全失效，且每个审批请求刷一条同样的错误日志。
 *
 * 同类错误：`session.cwd` 也不存在（cwd 在 `session.header.cwd` 上）。
 *
 * 运行：node test/session-api-contract.test.mjs
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(ROOT, 'src/index.mjs'), 'utf8')

// 只检查真实代码：先剥掉块注释与行注释，避免注释里提到的错误写法造成误报。
// （`[^:]` 前缀用于保留 `https://` 这类字符串内容。）
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/.*$/gm, '$1')

let failures = 0
const check = (label, ok, hint) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !hint ? '' : `\n      → ${hint}`}`)
  if (!ok) failures++
}

// 1) 禁止读取不存在的 Session 属性。
check(
  '源码中不再出现 `session.events`（应为 session.snapshotEvents()）',
  !/\bsession\.events\b/.test(code),
  'Session 无 events 属性；请改用 session.snapshotEvents()',
)
check(
  '源码中不再出现 `session.cwd`（应为 session.header.cwd）',
  !/\bsession\.cwd\b/.test(code),
  'cwd 位于 SessionHeader 上；请改用 session.header.cwd',
)

// 2) current() 必须收到 Session 本身，而不是它的某个字段。
check(
  '`permissionPresets.current()` 传入的是 Session 本身',
  /permissionPresets\.current\(\s*session\s*\)/.test(code),
  'current() 需要完整的 Session（会用到 header / seq / snapshotEvents()）',
)
check(
  '`permissionPresets.current()` 未传入任何 `.events` / `.snapshotEvents()` 结果',
  !/permissionPresets\.current\(\s*session\.(events|snapshotEvents)/.test(code),
)

// 3) 正向要求：确实用到了正确的 API。
check('使用了 `session.snapshotEvents()` 读取事件', /session\.snapshotEvents\(\)/.test(code))
check('从 `session.header.cwd` 读取工作目录', /session\.header[.\[]/.test(code))

console.log(
  failures === 0
    ? '\nSession API 契约检查通过'
    : `\n${failures} 项 Session API 契约检查失败`,
)
process.exitCode = failures === 0 ? 0 : 1

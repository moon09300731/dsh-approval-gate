/**
 * 判定器 reasoning effort 降级回归测试（无测试框架，`node tests/judge-effort-fallback.mjs` 直接运行）。
 *
 * 复现的事故（2026-09 实测）：判定模型取「当前默认模型」，而部分路由（如 GLM-5.3）
 * 不支持 reasoning effort "off"，适配器在解析阶段直接抛 UNSUPPORTED_REASONING_EFFORT
 * （无网络往返）。旧实现硬编码 reasoningEffort:'off' 且重试 2 次同样失败，
 * 于是所有越界请求一律 fail-safe 转人工——审计里 flash-safe 永远为 0。
 *
 * 断言：
 *   ① 路由不支持 'off' 时：自动降级为「不带 effort」并正常判定（不转人工）
 *   ② 同一路由后续调用不再白撞 'off'（只发 1 次请求）
 *   ③ 与 effort 无关的失败不降级，仍按 fail-safe 转人工，且原因写入事件
 *   ④ 支持 'off' 的路由不受影响：仍然带 'off' 调用一次
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// DSH_HOME 必须在 import 插件之前设置（插件在模块顶层解析数据目录）
const home = mkdtempSync(join(tmpdir(), 'approval-gate-test-'))
process.env.DSH_HOME = home
const dataDir = join(home, 'auto-approve')
mkdirSync(dataDir, { recursive: true })
const allowlistPath = join(dataDir, 'allowlist.json')
const eventsPath = join(dataDir, 'events.jsonl')

/** 写一份最小配置：不放行规则、不拒绝关键词，让每个请求都走到判定层 */
function writeConfig(extra = {}) {
  writeFileSync(allowlistPath, JSON.stringify({
    version: 3,
    denyKeywords: [],
    allowRules: [],
    denyRules: [],
    hardCategories: ['deletion', 'credential', 'remote', 'system', 'bulk'],
    riskyThreshold: 3,
    judgeTimeoutMs: 20000,
    learning: { enabled: false },
    ...extra
  }, null, 2), 'utf8')
}

writeConfig()

const plugin = (await import('../src/index.mjs')).default

const UNSUPPORTED = {
  code: 'UNSUPPORTED_REASONING_EFFORT',
  message: 'provider "modlens-zai-coding-cn" model "GLM-5.3" does not support reasoning effort "off"'
}

/** 构造假 DSH 宿主：捕获审批处理器、记录每次 llm.stream 的入参 */
function makeHost(handler) {
  const calls = []
  let approvalHandler = null
  const ctx = {
    llm: {
      stream(options) {
        calls.push(options)
        const step = handler(options)
        return (async function* () {
          for (const chunk of step) yield chunk
        })()
      }
    },
    permissionPresets: { current: () => 'auto-approve' },
    get: (name) => name === 'agentDefaultModel'
      ? { currentSelection: () => ({ provider: 'modlens-zai-coding-cn', model: 'GLM-5.3' }) }
      : undefined,
    // 定时器：unref 避免 20s 超时定时器拖住测试进程
    timeout: (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); if (t.unref) t.unref() }),
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    on: (event, h) => { if (event === 'approval/request') approvalHandler = h; return () => {} },
    logger: { info() {}, warn() {}, error() {} }
  }
  plugin.apply(ctx)
  if (!approvalHandler) throw new Error('插件未注册 approval/request 处理器')
  return {
    calls,
    request: (callId) => approvalHandler({
      agent: { session: { id: 'session-test', cwd: process.cwd(), events: [] } },
      toolName: 'write',
      reason: 'escalate sandbox to danger-full-access: 改动工作区外项目的业务代码',
      callId
    }, async () => 'allowed-once')
  }
}

const safe = [
  { type: 'text-delta', text: 'SAFE' },
  { type: 'finish', reason: { kind: 'stop' } }
]
const failWith = (failure) => [{ type: 'finish', reason: { kind: 'error', failure } }]

let failed = 0
const check = (name, cond, detail) => {
  if (cond) { console.log(`  ✓ ${name}`) } else { failed++; console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`) }
}

// ---- ① + ② 路由不支持 'off'：降级后自动放行，且后续请求不再白撞 'off' ----
console.log('① 路由不支持 effort "off" → 降级为默认档并自动放行')
{
  writeConfig()
  const host = makeHost((options) => options.reasoningEffort === 'off' ? failWith(UNSUPPORTED) : safe)
  const first = await host.request('call-1')
  check('审批结果 = allowed-once（判定器判 SAFE，未转人工）', first === 'allowed-once', `实际 ${first}`)
  check('首次调用带 effort "off" 并撞到不支持', host.calls[0]?.reasoningEffort === 'off')
  check('降级调用不带 reasoningEffort', host.calls[1] && host.calls[1].reasoningEffort === undefined,
    `实际 ${JSON.stringify(host.calls[1]?.reasoningEffort)}`)

  const callsBefore = host.calls.length
  const second = await host.request('call-2')
  check('第二次审批同样放行', second === 'allowed-once', `实际 ${second}`)
  check('同路由不再重试 "off"（只发 1 次请求）', host.calls.length - callsBefore === 1,
    `实际多发 ${host.calls.length - callsBefore} 次`)
  check('第二次请求直接不带 effort', host.calls[callsBefore]?.reasoningEffort === undefined)
}

// ---- ③ 无关错误不降级：仍 fail-safe 转人工，原因写入事件 ----
console.log('② 与 effort 无关的失败不降级，仍转人工且记录原因')
{
  writeConfig()
  rmSync(eventsPath, { force: true })
  const missingKey = { code: 'MISSING_CREDENTIAL', message: 'no API key for provider route "deepseek-official"' }
  const host = makeHost(() => failWith(missingKey))
  const out = await host.request('call-3')
  check('审批结果 = allowed-once（由人工批准的下游返回）', out === 'allowed-once')
  check('两次尝试都保留 effort "off"（未误降级）', host.calls.length === 2 && host.calls.every((c) => c.reasoningEffort === 'off'),
    `调用 ${host.calls.length} 次, efforts=${JSON.stringify(host.calls.map((c) => c.reasoningEffort))}`)
  const lines = readFileSync(eventsPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const pending = lines.find((e) => e.kind === 'manual-pending')
  check('事件记录 path=flash-failed', pending?.path === 'flash-failed', JSON.stringify(pending?.path))
  check('事件记录 judgeError 原文（判定器不可用可见）', /MISSING_CREDENTIAL/.test(pending?.judgeError || ''),
    JSON.stringify(pending?.judgeError))
}

// ---- ④ 支持 'off' 的路由不受影响 ----
console.log('③ 支持 effort "off" 的路由保持原行为')
{
  writeConfig()
  const host = makeHost(() => safe)
  const out = await host.request('call-4')
  check('审批结果 = allowed-once', out === 'allowed-once')
  check('只发 1 次请求且带 effort "off"', host.calls.length === 1 && host.calls[0]?.reasoningEffort === 'off',
    `${host.calls.length} 次, effort=${JSON.stringify(host.calls[0]?.reasoningEffort)}`)
}

// ---- ⑤ judgeModel 固定判定模型（不随日常切模型漂移） ----
console.log('④ judgeModel 配置钉住判定路由')
{
  writeConfig({ judgeModel: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } })
  const host = makeHost(() => safe)
  await host.request('call-5')
  check('使用了 judgeModel 指定的 provider/model',
    host.calls[0]?.provider === 'deepseek-official' && host.calls[0]?.model === 'deepseek-v4-flash',
    `${host.calls[0]?.provider}/${host.calls[0]?.model}`)
}

rmSync(home, { recursive: true, force: true })
if (failed > 0) {
  console.error(`\n${failed} 项断言失败`)
  process.exit(1)
}
console.log('\n全部断言通过')

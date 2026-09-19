# dsh-approval-gate 完整指南

> 首页：[简体中文](../README.md) · [English](../README.en.md) · 指南：[中文](GUIDE.md) · [English](GUIDE.en.md)

DeepSeek Harness 自动审批门控插件 v0.5.0：**最小人工介入，只把必须人工确认的操作转人工（fail-safe）**。

当会话的权限预设为 `auto-approve`（自动审批（Flash））时，每次审批请求（沙箱越界）按管道判定：

```
DENY（不可逆危险词）→ 白名单（确定性规则）→ denyRules（裁决拒绝升级）→ flash（SAFE / 硬类别 / 中立确认）→ 学习沉淀
```

- **① DENY 层**：`rm -rf` / `drop table` / `force push` / 格式化等不可逆危险词命中 → 转人工（**最高优先，fail-safe**）
- **② 白名单层**：命中规则 → 直接放行（确定性，不过 LLM）。默认规则 `{mode:"workspace-write"}` —— 工作区写入（可回补）自动放行；也支持 `tool/mode/category/contains` 组合规则（含学习沉淀的规则）
- **③ denyRules 层**：此前用户**裁决拒绝**过的「工具+模式+类别」→ 永久转人工（不会自动放行用户明确拒绝过的操作）
- **④ flash 判定**（仅越界请求）：输出 `SAFE` 或 `RISKY:<category>`
  - `SAFE` → 自动放行
  - 硬风险类别（`deletion` 删除 / `credential` 凭据 / `remote` 远程生产 / `system` 系统路径 / `bulk` 批量不可回补）→ **直接转人工**（必须人工确认，不计数、不学习）
  - `neutral`（中立，无硬风险特征）→ **人工确认制**：前 N-1 次转人工确认，之后进入阈值状态
- **⑤ 学习沉淀**（neutral 类别，N=3 时：前 2 次人工确认，之后进入阈值状态）
  - 阈值前：一律人工确认，**批准** → 计数 +1 并记录**操作样本**（指纹 + 操作背景/目的）；**拒绝** → 升级 denyRules
  - 阈值后（计数 ≥ N-1）三种分流：
    1. **指纹确定性命中**（本次操作在确认样本中）→ 自动放行 + 沉淀 `{tool, mode, category, contains}` 规则
    2. **指纹未命中但有确认样本** → 把本次操作的背景/目的 + 用户确认过的样本交给 flash **第三方同类验证**：判 `SAME`（与已确认样本同类）→ 自动放行（有指纹则沉淀）；判 `DIFFERENT`/验证失败 → 人工确认
    3. **无确认样本** → 人工确认
  - 用户**拒绝** → 升级进 denyRules（带指纹；提取不到指纹则拦全部同类，拒绝从严）
  - 取消/不可用 → 不计数（用户未表态，下次仍人工确认）
  - 硬类别/DENY/验证失败永远人工，同类验证只作用于 neutral 阈值状态

## 安装

```sh
# 方式一：npm 安装（推荐）
dsh plugin --profile web add dsh-approval-gate

# 方式二：GitHub 安装
dsh plugin --profile web add "github:moon09300731/dsh-approval-gate#main"
```

## ⚠️ 安装后必须手动配置权限预设（关键步骤）

插件无法向权限预设表添加选项（预设表在配置构造时冻结），需要手动在 profile 的 `cordis.patch.yml` 中补一条 preset：

编辑 `~/.dsh/profiles/web/cordis.patch.yml`，追加（或合并进已有的 `permission` 行——**loader 的 patch 会整体替换目标行的 config，若已有该行必须重述全部预设**）：

```yaml
- id: permission
  name: '@deepseek-ai/dsh-permission-presets'
  config:
    presets:
      read-only:
        sandbox: read-only
        approval: ask
      workspace-write:
        sandbox: workspace-write
        approval: ask
      danger-full-access:
        sandbox: danger-full-access
        approval: never
      auto-approve:
        sandbox: workspace-write
        approval: ask
        name: 自动审批（Flash）
        description: 多级判定：工作区写入自动放行，危险操作转人工审批。
```

重启 `dsh web` 后，权限下拉菜单会出现「自动审批（Flash）」选项。

## 配置（可选）

数据文件统一放在 `$DSH_HOME/auto-approve/`（默认 `~/.dsh/auto-approve/`）：

| 文件 | 说明 |
|------|------|
| `allowlist.json` | 白名单/黑名单/阈值配置（首次运行自动生成默认值，旧版自动迁移，修改即时生效无需重启） |
| `learning.json` | 学习状态（自动维护，跨会话持久化） |
| `audit.log` | 审计日志（追加式） |
| `events.jsonl` | 自动放行事件（供审查 UI 展示，按会话隔离） |
| `snapshots/` | 自动放行文件的改动前快照（按事件 ID 命名，供 diff 对比与撤销参考） |

`allowlist.json` 结构（v3）：

```json
{
  "version": 3,
  "denyKeywords": ["rm -rf", "drop table", "force push", "格式化"],
  "allowRules": [
    { "mode": "workspace-write", "description": "工作区写入自动放行" },
    { "tool": "bash", "mode": "workspace-write", "contains": "git add", "description": "特定工具+模式+关键词" }
  ],
  "denyRules": [],
  "hardCategories": ["deletion", "credential", "remote", "system", "bulk"],
  "riskyThreshold": 3,
  "judgeTimeoutMs": 20000,
  "judgeModel": { "provider": "deepseek-official", "model": "deepseek-v4-flash" },
  "learning": { "enabled": true }
}
```

- `denyKeywords`：命中即转人工（不可逆危险操作）
- `allowRules`：每条规则 `tool` / `mode` / `category` / `contains` 均满足才放行（缺省表示任意）。学习沉淀的规则也会写入这里
- `denyRules`：用户裁决拒绝后自动写入，命中即转人工（不学习）
- `hardCategories`：flash 判 RISKY 且命中这些类别 → 直接转人工（不计数、不学习）
- `riskyThreshold`：中立类别的人工确认阈值（默认 3）——同一「工具+模式+类别」被人工确认 N-1 次后，第 N 次起自动放行并沉淀规则
- `judgeTimeoutMs`：单次 flash 判断超时（默认 20000ms，超时自动重试 1 次，仍超时转人工）
- `judgeModel`：**判定模型**（v0.5.3+，可选）。缺省时判定器跟随「当前默认模型」；填 `{provider, model}` 则固定用该路由判定。**推荐固定**：判定器是安全组件，不应随日常切换模型而漂移——默认模型一旦切到不支持 reasoning effort `off` 的路由（如 GLM-5.3），判定器会整体不可用（详见下节排查）

## 使用

在会话的权限下拉（`/permission` 弹窗或设置页）选中**「自动审批（Flash）」**，该会话即启用自动审批；其他会话不受影响（按会话预设门控）。

## 设置页（v0.4.2+）

DSH 设置面板新增「自动审批」分区（settings.section，样式与 DSH 原生设置一致），按管道顺序提供可视化规则管理，每张卡片标注管道阶段：

- **初始化卡片**：检测 `cordis.patch.yml` 是否已含 auto-approve 权限预设；未配置时点「一键配置」自动写入（文本级修改，保留注释格式），重启后生效
- **管道总览**：判定链路 + 生效的硬风险类别徽标
- **① DENY 层 · 黑名单**（denyKeywords）：查看/添加/删除危险词（删除预置词有确认提示）
- **② 白名单层 · 白名单**（allowRules）：查看（预置/学习沉淀/用户 来源标签）/添加（tool/mode/category/contains 表单）/删除 —— 例：`tool=edit, mode=danger-full-access` → 工作区外 edit 自动放行
- **③ denyRules 层 · 永久人工**：拒绝升级的规则，查看/移除
- **④ Flash 判定 · 阈值与超时**：`riskyThreshold`（学习满 N 次后第 N+1 次自动放行）/ `judgeTimeoutMs` 直接修改
- **⑤ 学习沉淀 · 正在学习**：展示确认计数（n/N）与样本；**「终止」按钮可介入删除**（删除计数与样本，重新学习）

所有修改通过 `POST /api/auto-approve/rules` 写入 `allowlist.json`，**热更新即时生效**（无需重启）；`POST /api/auto-approve/setup` 负责一键初始化。

## 人工审查 UI（v0.4.2+）

每次命令被自动放行或转人工审批时，提供审查入口（严格按 DSH 设计语言，`--dsw-alias-*` tokens）：

1. **提示条**（输入框上方独立一行，`conversation.input.dock` order=30，不随流式对话滚动）：
   - 自动放行 → 绿色 ✅：工具 + 摘要 + 判定路径（白名单规则 / Flash 判定安全 / 沉淀规则 / 已确认操作 / Flash 同类验证），8 秒收起
   - **转人工审批 → 橙黄色**（`--dsw-alias-state-warn-*`）：显示「等待人工审批：<操作>」，**不自动收起**，直到你确认
   - 人工通过 → 橙黄「学习 n/N，满 N 次后自动放行」（5 秒收起）；拒绝 → 红「已拒绝 · 升级永久人工」
   - 打开会话时不弹历史提示（静默同步游标）
2. **「审批」历史视图**：会话视图切换条「轨迹」右侧的「审批」tab（`conversation.view` order=20）。当前会话记录（**最新在上**）：自动放行（绿 ✅）、人工通过（橙黄 + 学习计数 n/N）、人工拒绝（红）
3. **文件改动对比与撤销**（v0.5.0+）：自动放行且涉及文件时，host 在审批（写入前）保存文件**改动前快照**；历史视图中对应事件的**文件标签变为可点击**（蓝色描边），点击弹出 diff 面板：
   - **只看变更行**：绿底 `+` 为新增行、红底 `-` 为删除行（经典 diff 语义），头部显示 +N / -M 行统计与「未变行」数；文件当前已不存在会提示
   - **撤销此改动**：向当前会话投递一条撤销指令（含操作说明、涉及文件、事件时间、快照目录位置），AI 据此把文件恢复为审批前状态
   - **diff 快照管理**：视图顶部显示「diff 快照 占用 · 条数」；「清除 diff 记录」按钮可一键删除全部快照（仅删除对比数据，不影响审批记录本身；删除后历史文件不可再查看对比）
   - 限制：仅文本文件（单文件 ≤256KB、每事件 ≤5 个文件）会保存快照，二进制/超限文件不可点击

数据链路：host 每次判定追加结构化事件到 `~/.dsh/auto-approve/events.jsonl`（`kind`: auto / manual-pending / manual-approved / manual-rejected，含 sessionId/tool/mode/reason/justification/verdict/files/learningCount/threshold），浏览器通过 `GET /api/auto-approve/events?sessionId=&since=` 轮询（2s 增量 / 视图 5s 全量）。

## 文件改动对比与撤销 API（v0.5.0+）

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/auto-approve/diff?eventId=&path=` | GET | 返回指定事件/文件的变更行（`changedLines`，add/del）与统计（`stats`），只读该事件快照中列出的路径 |
| `/api/auto-approve/revert` | POST | `{sessionId, eventId}` → 组装撤销指令投递到对应会话（typertGateway 优先，agent.followup 兜底） |
| `/api/auto-approve/snapshots-stats` | GET | 快照占用统计 `{count, bytes, ids}`（ids = 仍有快照的事件列表，用于判定哪些文件可点击） |
| `/api/auto-approve/snapshots-clear` | POST | 删除全部快照文件（仅限 `snapshots/` 目录内 `.json`） |

## 学习语义（v0.4.2+）

中立操作确认制：同一「工具|模式|类别」每被人工批准一次计数 +1；**确认满 N 次（默认 3）后，第 N+1 次起自动放行**并沉淀带指纹规则。阈值状态内：指纹命中直接放行；未命中由 Flash 对照确认样本做语义同类验证（SAME 放行 / DIFFERENT 人工）；拒绝升级 denyRules 永久人工；「正在学习」可在设置页终止。

## 安全设计

1. **DENY 层最高优先**：不可逆危险词命中即转人工，不消耗模型调用、无误判
2. **硬风险类别永远人工**：`deletion`/`credential`/`remote`/`system`/`bulk` 不计数、不学习、不可被沉淀规则覆盖
3. **学习规则带类别 + 操作指纹**：沉淀的是 `{tool, mode, category, contains}`（contains = 用户确认过的操作指纹），只放行同一指纹的操作；指纹未命中时由 flash **语义级同类验证**（基于用户确认样本判断操作意图是否同类），判 DIFFERENT/验证失败一律人工；拒绝过的操作升级 denyRules（带指纹，提取不到则拦全部同类），永不自动放行
4. **fail-safe**：flash 调用失败、超时（20s×2 次尝试）、输出无法解析 → 一律按中立降级或转人工，绝不自动放行硬风险
5. **可回补优先**：`workspace-write`（写工作区）默认放行，越界才走 flash
6. **按会话门控**：只有显式选中「自动审批（Flash）」预设的会话才介入
7. **只预判、不执行**：插件只返回允许/转人工决策，不修改审批流程的其他环节

> 警告：自动审批会显著降低人工介入频率。**仅供可信环境使用**，涉及生产数据、远程系统、支付扣费等高风险场景请保持 `ask` 预设。

## 技术说明

- 挂载于 `approval/request` 瀑布最前（`prepend: true`，先于 web answerer 接单）
- 门控：`permissionPresets.current(session.events) === 'auto-approve'`
- DSH 审批触发点是沙箱越界，`reason` 固定为 `escalate sandbox to <mode>: <justification>`，`mode` 仅 `workspace-write` / `danger-full-access` 两级
- flash 判定：优先 `reasoningEffort: 'off'`（不思考、结论最干净）+ `maxTokens: 256`，输出 `SAFE` 或 `RISKY:<category>`；**路由不支持 `off` 档时自动降级为「不带 effort」调用一次并记住该路由**（v0.5.3+），不会因此整体不可用
- 超时兜底：`AbortController` 传入 `llm.stream` 的 signal（可取消底层请求），`Promise.race` + `ctx.timeout(judgeTimeoutMs)`，超时 abort 并重试 1 次
- 同类验证：把当前操作背景/目的 + 用户确认样本交给 flash 语义判断（`SAME`/`DIFFERENT`），失败按 DIFFERENT 处理
- 学习闭环：通过 waterfall 的 `next()` 返回值捕获人工裁决结果（`allowed-once` 沉淀 / `rejected` 升级）
- 审查 UI：host 写 `events.jsonl` + `GET /api/auto-approve/events`（按 sessionId 过滤 + since 增量）；client 轮询展示
- 快照与 diff：审批发生在写入前，自动放行事件落盘时保存 `snapshots/<eventId>.json`（仅文本 ≤256KB、每事件 ≤5 个文件）；diff 用近似逐行匹配只返回变更行（上限 500 行）
- 撤销投递：`sendToSession` 优先 `typertGateway.invoke({namespace:'session', method:'prompt'})`（queue 模式），失败回退 `agent.followup`

## 排查：选了「自动审批」却仍在弹人工

判定器（Flash）不可用时一律 fail-safe 转人工，所以**症状统一是「全都在弹人工」**，界面不报错。按顺序查：

1. `~/.dsh/auto-approve/audit.log`：出现 `FAILED ... | 判定器不可用: <原因>` 即判定器在报错（v0.5.3+ 把原因写进审计；更早版本只写 console，外部完全看不见）
2. `~/.dsh/auto-approve/events.jsonl`：对应事件带 `judgeError` 字段，审查视图读取同一份数据
3. 常见原因：
   - `... does not support reasoning effort "off"`：当前默认模型路由不支持 `off` 档（v0.5.3 起自动降级为默认档；仍建议用 `judgeModel` 固定判定路由）
   - `MISSING_CREDENTIAL` / 鉴权失败：判定路由没有可用 API key
   - 两次超时：`judgeTimeoutMs` 偏小或路由过慢
4. 判据：审计里**只有 `FAILED` 没有 `ALLOW ... (flash-safe)`** → 判定器从未成功过，查第 1 条的原文

固定判定模型（热更新，无需重启）：

```bash
curl -X POST http://127.0.0.1:3080/api/auto-approve/rules \
  -H 'content-type: application/json' \
  -d '{"op":"set","kind":"judgeModel","value":{"provider":"deepseek-official","model":"deepseek-v4-flash"}}'
```

传 `"value": {}` 可清除固定，回到「跟随当前默认模型」。

## License

MIT

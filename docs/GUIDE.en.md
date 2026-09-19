# dsh-approval-gate — Full Guide

> Home: [English](../README.en.md) · [简体中文](../README.md) · Guide: [English](GUIDE.en.md) · [中文](GUIDE.md)

DeepSeek Harness auto-approval gate plugin v0.5.0: **minimal human intervention — only operations that must be confirmed go to a human (fail-safe)**.

When a session's permission preset is `auto-approve` (Auto Approval (Flash)), every approval request (sandbox escalation) is judged through this pipeline:

```
DENY (irreversible keywords) → allowlist (deterministic rules) → denyRules (rejected upgrades) → flash (SAFE / hard categories / neutral confirmation) → learned persistence
```

- **① DENY layer**: irreversible keywords (`rm -rf`, `drop table`, `force push`, formatting, …) → human (**highest priority, fail-safe**)
- **② Allowlist layer**: a matching rule → auto-approve (deterministic, no LLM). Default rule `{mode:"workspace-write"}` — workspace writes (recoverable) auto-approve; `tool/mode/category/contains` combinations are supported (including learned rules)
- **③ denyRules layer**: `tool+mode+category` pairs the user has **explicitly rejected** → permanently human (never auto-approve what the user refused)
- **④ flash judgment** (escalations only): outputs `SAFE` or `RISKY:<category>`
  - `SAFE` → auto-approve
  - Hard-risk categories (`deletion` / `credential` / `remote` / `system` / `bulk`) → **directly human** (must confirm; no counting, no learning)
  - `neutral` (no hard-risk traits) → **confirmation mode**: first N-1 occurrences go to human, then the threshold state begins
- **⑤ Learned persistence** (neutral, N=3: confirm twice, then threshold state)
  - Before threshold: every occurrence goes to human; **approve** → count +1 and record an **operation sample** (fingerprint + context); **reject** → upgrade to denyRules
  - At threshold (count ≥ N-1), three branches:
    1. **Fingerprint hit** (this operation is in the confirmed samples) → auto-approve + persist a `{tool, mode, category, contains}` rule
    2. **No fingerprint hit but samples exist** → hand the current operation's context plus the confirmed samples to flash for **third-party similarity verification**: `SAME` (same kind as a confirmed sample) → auto-approve (persist when a fingerprint exists); `DIFFERENT` / verification failure → human
    3. **No samples** → human
  - **Reject** → upgraded to denyRules (with fingerprint; without one, block the whole kind — rejection is always strict)
  - Cancel/unavailable → not counted (no verdict from the user; next time still goes to human)
  - Hard categories / DENY / verification failures are always human; similarity verification only applies to the neutral threshold state

## Install

```sh
# Option 1: npm (recommended)
dsh plugin --profile web add dsh-approval-gate

# Option 2: GitHub
dsh plugin --profile web add "github:moon09300731/dsh-approval-gate#main"
```

## ⚠️ Manual permission preset (required after install)

The plugin cannot extend the frozen permission-preset table; add the preset manually to the profile's `cordis.patch.yml`:

Edit `~/.dsh/profiles/web/cordis.patch.yml` and append (or merge into the existing `permission` row — **the loader patch replaces the whole row's config, so restate every preset**):

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
        name: Auto Approval (Flash)
        description: Multi-stage judgment: workspace writes auto-approve, risky operations go to human.
```

Restart `dsh web`; the permission dropdown then offers "Auto Approval (Flash)".

## Configuration (optional)

Data files live under `$DSH_HOME/auto-approve/` (default `~/.dsh/auto-approve/`):

| File | Purpose |
|------|---------|
| `allowlist.json` | Allow/deny lists, thresholds (auto-generated on first run, old versions auto-migrate, edits take effect immediately — hot reload) |
| `learning.json` | Learning state (auto-maintained, persists across sessions) |
| `audit.log` | Audit log (append-only) |
| `events.jsonl` | Auto-approval events (for the review UI, per-session isolation) |
| `snapshots/` | Pre-change snapshots of auto-approved files (named by event ID; used for diff and revert) |

`allowlist.json` structure (v3):

```json
{
  "version": 3,
  "denyKeywords": ["rm -rf", "drop table", "force push", "format"],
  "allowRules": [
    { "mode": "workspace-write", "description": "Workspace writes auto-approve" },
    { "tool": "bash", "mode": "workspace-write", "contains": "git add", "description": "Tool+mode+keyword rule" }
  ],
  "denyRules": [],
  "hardCategories": ["deletion", "credential", "remote", "system", "bulk"],
  "riskyThreshold": 3,
  "judgeTimeoutMs": 20000,
  "judgeModel": { "provider": "deepseek-official", "model": "deepseek-v4-flash" },
  "learning": { "enabled": true }
}
```

- `denyKeywords`: a hit sends the request to human (irreversible operations)
- `allowRules`: each rule matches on `tool` / `mode` / `category` / `contains` (omitted fields match anything). Learned rules are also written here
- `denyRules`: written automatically after a human rejection; a hit goes to human (no learning)
- `hardCategories`: flash `RISKY` in these categories → directly human (no counting, no learning)
- `riskyThreshold`: neutral confirmation threshold (default 3) — after N-1 human confirmations of the same tool+mode+category, the Nth occurrence auto-approves and persists a rule
- `judgeTimeoutMs`: single flash judgment timeout (default 20000ms; auto-retries once, then goes to human)
- `judgeModel`: **the judging route** (v0.5.3+, optional). Unset, the judge follows the current default model; set to `{provider, model}` to pin one route. **Pinning is recommended**: the judge is a safety component and should not drift with everyday model switching — a default model whose route rejects reasoning effort `off` (e.g. GLM-5.3) disables the judge entirely (see troubleshooting below)

## Usage

Select **"Auto Approval (Flash)"** in the session's permission dropdown (`/permission` dialog or settings). Other sessions are unaffected (gated per session preset).

## Settings Page (v0.4.2+)

A new "Auto Approval" section in the DSH settings panel (`settings.section`, styled like native DSH settings) provides visual rule management, cards ordered by pipeline stage:

- **Setup card**: detects whether the `auto-approve` permission preset exists in `cordis.patch.yml`; if missing, click "Configure" to write it automatically (text-level edit, comments preserved), effective after restart
- **Pipeline overview**: judgment pipeline + active hard-risk category badges
- **① DENY · deny list** (`denyKeywords`): view/add/remove dangerous keywords (removing a predefined keyword asks for confirmation)
- **② Allow list** (`allowRules`): view (tagged predefined / learned / user) / add (tool/mode/category/contains form) / remove — e.g. `tool=edit, mode=danger-full-access` auto-approves out-of-workspace edits
- **③ denyRules · always-human**: rejection-upgraded rules, view/remove
- **④ Flash · thresholds & timeout**: edit `riskyThreshold` (auto-approve starts at N+1th occurrence after N confirmations) / `judgeTimeoutMs` directly
- **⑤ Learning · in progress**: confirmation counts (n/N) + samples with a **"Stop" button** to intervene (removes count and samples, restarts learning)

All changes go through `POST /api/auto-approve/rules` into `allowlist.json` — **hot-reloaded immediately** (no restart); `POST /api/auto-approve/setup` handles one-click setup.

## Human Review UI (v0.4.2+)

Review entry points appear on auto-approval or human-approval (strict DSH design language, `--dsw-alias-*` tokens):

1. **Notice strip** (a dedicated row above the composer, `conversation.input.dock` order=30, does not scroll with the conversation):
   - Auto-approval → green ✅: tool + summary + verdict label (allowlist / flash-safe / learned / confirmed / flash-same), auto-dismisses after 8s
   - **Escalated to human → amber** (`--dsw-alias-state-warn-*`): "Waiting for human approval: <operation>", **stays until you decide**
   - Human approved → amber "Learning n/N, auto-approves after N" (5s); rejected → red "Rejected · upgraded to always-human"
   - No history notice when opening a session (cursor silently synchronized)
2. **"Approval" history view**: the tab right of "Trajectory" (`conversation.view`, order=20). Current session records (**newest first**): auto-approved (green ✅), human-approved (amber + learning count n/N), human-rejected (red)
3. **File diff & revert** (v0.5.0+): when an auto-approval involves files, the host saves a **pre-change snapshot** at approval time (before the write). In the history view the corresponding event's **file chips become clickable** (blue outline) and open a diff panel:
   - **Changed lines only**: green `+` rows are additions, red `-` rows are deletions (classic diff semantics); the header shows +N / -M stats and unchanged-line count; a missing file is flagged
   - **Revert this change**: posts a revert instruction to the conversation (operation, files, event time, snapshot directory) so the AI restores the files to their pre-approval state
   - **Snapshot management**: the view header shows "diff snapshots <size> · <count>"; a "Clear diff history" button deletes all snapshots (data only — approval records stay; after clearing, historical files can no longer be diffed)
   - Limits: only text files (≤256KB each, ≤5 per event) get snapshots; binary/oversized files are not clickable

Data flow: the host appends a structured event to `~/.dsh/auto-approve/events.jsonl` per judgment (`kind`: auto / manual-pending / manual-approved / manual-rejected, plus sessionId/tool/mode/reason/justification/verdict/files/learningCount/threshold); the browser polls `GET /api/auto-approve/events?sessionId=&since=` (2s incremental / 5s full refresh in the view).

## File Diff & Revert API (v0.5.0+)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/auto-approve/diff?eventId=&path=` | GET | Changed lines (`changedLines`, add/del) and stats for an event/file; reads only paths listed in that event's snapshot |
| `/api/auto-approve/revert` | POST | `{sessionId, eventId}` → assembles a revert instruction and delivers it to the session (typertGateway first, `agent.followup` fallback) |
| `/api/auto-approve/snapshots-stats` | GET | Snapshot usage `{count, bytes, ids}` (ids = events that still have snapshots; drives chip clickability) |
| `/api/auto-approve/snapshots-clear` | POST | Deletes all snapshot files (only `.json` inside `snapshots/`) |

## Learning Semantics (v0.4.2+)

Neutral confirmation learning: each human approval of the same tool|mode|category increments the count; after **N confirmations (default 3), the N+1th occurrence auto-approves** and persists a fingerprinted rule. In the threshold state: fingerprint hit auto-approves; otherwise Flash semantically verifies against confirmed samples (SAME approves / DIFFERENT goes to human); rejections upgrade to denyRules (always human); in-progress learning can be stopped from the settings page.

## Security Design

1. **DENY layer highest priority**: irreversible keywords go to human with zero model calls and zero false negatives
2. **Hard-risk categories are always human**: `deletion`/`credential`/`remote`/`system`/`bulk` are never counted, learned, or covered by persisted rules
3. **Learned rules carry category + operation fingerprint**: persisted rules are `{tool, mode, category, contains}` (contains = a fingerprint you confirmed); only the same fingerprint auto-approves. When the fingerprint misses, flash does **semantic similarity verification** against your confirmed samples — DIFFERENT or verification failure always goes to human; rejected operations upgrade to denyRules (with fingerprint; without one, the whole kind is blocked), never auto-approved
4. **Fail-safe**: flash failure, timeout (20s × 2 attempts), or unparseable output → neutral degradation or human; hard risks are never auto-approved
5. **Recoverable first**: `workspace-write` (workspace writes) auto-approve by default; flash runs only for escalations
6. **Per-session gating**: only sessions that explicitly selected the "Auto Approval (Flash)" preset are intercepted
7. **Judge only, never execute**: the plugin returns an allow/forward decision; it does not modify the rest of the approval flow

> Warning: auto-approval dramatically lowers human intervention. **Trusted environments only** — keep the `ask` preset for production data, remote systems, payments, and other high-risk scenarios.

## Technical Notes

- Mounted at the front of the `approval/request` waterfall (`prepend: true`, before the web answerer)
- Gate: `permissionPresets.current(session.events) === 'auto-approve'`
- DSH approval fires on sandbox escalation; `reason` is always `escalate sandbox to <mode>: <justification>`, with `mode` in `workspace-write` / `danger-full-access`
- flash judgment: `reasoningEffort: 'off'` first (no thinking, cleanest verdict) + `maxTokens: 256`, outputs `SAFE` or `RISKY:<category>`; when the route rejects the `off` effort the judge **falls back to a call without any effort once and remembers that route** (v0.5.3+), so it can never be disabled by an effort mismatch
- Timeout: `AbortController` signal into `llm.stream` (cancellable), `Promise.race` + `ctx.timeout(judgeTimeoutMs)`, abort + one retry
- Similarity verification: current operation context + confirmed samples to flash (`SAME`/`DIFFERENT`); failure counts as DIFFERENT
- Learning loop: captures human verdicts through the waterfall `next()` return (`allowed-once` persists / `rejected` upgrades)
- Review UI: host writes `events.jsonl` + `GET /api/auto-approve/events` (sessionId filter + since cursor); client polls and renders
- Snapshots & diff: approval happens before the write, so the auto-approval event saves `snapshots/<eventId>.json` at record time (text only, ≤256KB per file, ≤5 per event); diff uses approximate line matching and returns changed lines only (up to 500)
- Revert delivery: `sendToSession` prefers `typertGateway.invoke({namespace:'session', method:'prompt'})` (queue mode), falling back to `agent.followup`

## Troubleshooting: "Auto Approval" selected but everything still asks a human

When the judge (Flash) is unusable it always fail-safes to a human, so **the symptom is always "everything asks a human"** with no visible error. Check in order:

1. `~/.dsh/auto-approve/audit.log`: a line `FAILED ... | 判定器不可用: <reason>` means the judge is erroring (v0.5.3+ writes the reason to the audit log; earlier versions only wrote console output, invisible from outside)
2. `~/.dsh/auto-approve/events.jsonl`: the matching event carries a `judgeError` field — the same data the review UI reads
3. Common causes:
   - `... does not support reasoning effort "off"`: the current default model route rejects the `off` effort (v0.5.3+ degrades automatically; pinning `judgeModel` is still recommended)
   - `MISSING_CREDENTIAL` / auth failure: no usable API key for the judging route
   - two timeouts: `judgeTimeoutMs` too small, or the route too slow
4. Tell-tale sign: the audit log has **only `FAILED` and no `ALLOW ... (flash-safe)`** → the judge has never succeeded; read the reason from step 1

Pin the judging route (hot-reloaded, no restart):

```bash
curl -X POST http://127.0.0.1:3080/api/auto-approve/rules \
  -H 'content-type: application/json' \
  -d '{"op":"set","kind":"judgeModel","value":{"provider":"deepseek-official","model":"deepseek-v4-flash"}}'
```

Pass `"value": {}` to clear the pin and follow the current default model again.

## License

MIT

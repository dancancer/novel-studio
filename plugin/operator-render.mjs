import { renderGateResult } from './gates.mjs'
import { renderRootCauses } from './diagnosis.mjs'

export function phaseResultText(v) {
  const lines = []
  if (v.next) lines.push(`**下一步**：${v.next}`)
  const gate = v.gate || v.plotGate || v.planningGate
  if (gate) lines.push('', renderGateResult(gate))
  if (v.verdict) {
    lines.push('', `**HR 验收**：${v.verdict === 'PROMOTE' ? '✅ 晋升' : '❌ 驳回'}${v.version ? ` → v${v.version}` : ''}`, ...v.reasons.map(r => `- [${r.type}] ${r.detail}`))
  }
  if (v.reworkInstructions) {
    lines.push('', '**返工指令**：', ...v.reworkInstructions.map(l => `- ${l}`))
  }
  if (v.rootCauses) {
    lines.push('', '**根因归属**：', renderRootCauses(v.rootCauses))
  }
  for (const k of ['gateSummary', 'evidenceCount', 'topics', 'volumes', 'contracts', 'chapters', 'instances', 'problems', 'candidates', 'agent']) {
    if (v[k] !== undefined) lines.push(`- ${k}: ${Array.isArray(v[k]) ? v[k].join(', ') || '（空）' : v[k]}`)
  }
  return lines.join('\n')
}

export function statusText(snapshot) {
  const p = snapshot
  const lines = [
    `# ${p.project.title}（${p.project.projectId}）`,
    '',
    `**工作流状态**：\`${p.workflow.state}\`｜周期 ${p.cycle.current}｜生产批次 ${p.counters.batches}`,
    `累计：Issue ${p.counters.issues}，Gate ${p.counters.gates}，返工 ${p.counters.reworks}`,
    '',
    '## Artifacts',
    '| id | v | 状态 | 审批 |', '|---|---|---|---|',
    ...p.artifacts.map(a => `| ${a.id} | ${a.version} | ${a.status} | ${a.approvedBy || '—'} |`),
    '',
    `## 章节状态（${p.chapters.length}）`,
    ...Object.entries(groupBy(p.chapters, c => c.status)).map(([st, list]) => `- **${st}**：${list.map(c => c.chapter).join(', ')}`),
    '',
    p.staleNodes.length ? `## ⚠️ STALE 节点\n${p.staleNodes.map(n => `- ${n.id}: ${n.reason}`).join('\n')}` : '## STALE：无',
    '',
    `## 未关闭 Issue（${(p.openIssues || []).length}）`,
    ...((p.openIssues || []).length
      ? p.openIssues.slice(-12).map(issue => `- [${issue.issue_id}] ${issue.severity || 'unknown'} / ${issue.dimension || 'unknown'}${issue.chapter ? ` / 第${issue.chapter}章` : ''}：${String(issue.evidence || '').slice(0, 120)}`)
      : ['- 无']),
    '',
    '## KPI',
    `- 一次通过率 ${fmtPct(p.kpi.work.oncePassRate)}｜平均返工/章 ${p.kpi.work.avgReworksPerChapter}`,
    `- 伏笔回收率 ${fmtPct(p.kpi.work.foreshadowRecoveryRate)}｜近期到期伏笔 ${p.kpi.work.pendingForeshadowingDueSoon}`,
    `- Canon 冲突 ${p.kpi.work.canonConflicts}｜人物漂移 ${p.kpi.work.characterDrift}`,
    `- 最近 Reader：${p.kpi.work.reader ? `${p.kpi.work.reader.label} ${p.kpi.work.reader.pass ? 'PASS' : 'FAIL'}（${p.kpi.work.reader.score}）` : '未运行'}`,
  ]
  return lines.join('\n')
}

function groupBy(arr, keyFn) {
  const out = {}
  for (const it of arr) {
    const k = keyFn(it)
    ;(out[k] = out[k] || []).push(it)
  }
  return out
}

function fmtPct(v) {
  return v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`
}

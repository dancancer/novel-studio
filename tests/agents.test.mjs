/** Agent schema 与运行时 persona 装配测试。 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as agents from '../plugin/agents.mjs'
import {
  CHAPTER_GATE_DIMENSIONS,
  REVIEWER_DIMENSIONS,
  getGateRequirements,
  normalizeGateDimension,
} from '../plugin/gates.mjs'

test('Reviewer schema 支持 chapter，且所有专业维度都可映射到 Chapter Gate', () => {
  const schema = agents.ROLE_PERSONAS.reviewer.outputSchema.properties.issues.items
  assert.ok(schema.required.includes('chapter'))
  assert.deepEqual(schema.properties.chapter, { type: 'number' })
  assert.deepEqual(schema.properties.dimension.enum, REVIEWER_DIMENSIONS)
  const chapterVetoDimensions = getGateRequirements('chapter').vetoOnlyDimensions
  for (const dimension of REVIEWER_DIMENSIONS) {
    const normalized = normalizeGateDimension('chapter', dimension)
    assert.ok(CHAPTER_GATE_DIMENSIONS.includes(normalized) || chapterVetoDimensions.includes(normalized))
  }
})

test('人物 schema 要求并声明 pressurePoints 与 relations', () => {
  const schema = agents.ROLE_PERSONAS['character-growth-expert'].outputSchema.properties.characters.items
  assert.ok(schema.required.includes('pressurePoints'))
  assert.ok(schema.required.includes('relations'))
  assert.equal(schema.properties.pressurePoints.type, 'array')
  assert.equal(schema.properties.relations.type, 'object')
})

test('Plot Contract schema 强制三个可为空的结构化数组', () => {
  const schema = agents.ROLE_PERSONAS['plot-architect'].outputSchema.properties.contracts.items
  for (const field of ['characters', 'foreshadowing', 'forbidden_changes']) {
    assert.ok(schema.required.includes(field))
    assert.equal(schema.properties[field].type, 'array')
  }
})

test('研究角色可调用 web_search，且结构化输出保留来源字段', () => {
  const market = agents.ROLE_PERSONAS['deep-researcher']
  const research = agents.ROLE_PERSONAS['research-assistant']

  assert.ok(market.tools.allow.includes('web_search'))
  assert.ok(research.tools.allow.includes('web_search'))
  assert.ok(market.outputSchema.required.includes('sources'))
  assert.ok(market.outputSchema.properties.sources.items.required.includes('url'))
  assert.equal(research.outputSchema.properties.evidence.items.properties.sourceUrl.type, 'string')
  assert.equal(agents.ROLE_PERSONAS.writer.tools.allow.includes('web_search'), false)
  assert.ok(agents.ROLE_PERSONAS.writer.tools.allow.includes('skill'))
  assert.match(agents.ROLE_PERSONAS.writer.persona, /humanizer-zh/)
})

test('composeRolePersona 注入五类已晋升内容且不修改基础 persona', () => {
  assert.equal(typeof agents.composeRolePersona, 'function')
  const original = agents.ROLE_PERSONAS.writer.persona
  const profile = {
    promotedImprovements: [
      { kind: 'prompt', title: '提示改进', content: 'PROMPT-CONTENT' },
      { kind: 'skill', title: '技能改进', content: 'SKILL-CONTENT' },
      { kind: 'memory', title: '记忆改进', content: 'MEMORY-CONTENT' },
      { kind: 'sop', title: '流程改进', content: 'SOP-CONTENT' },
      { kind: 'fewshot', title: '范例改进', content: 'FEWSHOT-CONTENT' },
    ],
  }
  const composed = agents.composeRolePersona('writer', profile)
  for (const marker of ['PROMPT', 'SKILL', 'MEMORY', 'SOP', 'FEWSHOT']) {
    assert.ok(composed.includes(`${marker}-CONTENT`))
  }
  assert.ok(composed.startsWith(original))
  assert.equal(agents.ROLE_PERSONAS.writer.persona, original)
})

test('composeRolePersona 忽略无效、空白及非五类改进', () => {
  const base = agents.ROLE_PERSONAS.writer.persona
  assert.equal(agents.composeRolePersona('writer'), base)
  assert.equal(agents.composeRolePersona('writer', {
    promotedImprovements: [
      { kind: 'prompt', content: '   ' },
      { kind: 'unknown', content: 'SHOULD-NOT-APPEAR' },
      null,
    ],
  }), base)
  assert.throws(() => agents.composeRolePersona('not-a-role', {}), /未知角色/)
})

test('spawnRoleAgent 将 profile 的已晋升改进装配进实际 persona', async () => {
  let captured
  const ctx = {
    get(name) {
      assert.equal(name, 'subagents')
      return {
        async start(provider, request) {
          captured = { provider, request }
          return {
            id: 'run-1',
            result: Promise.resolve({ output: [], structured: { ok: true } }),
            async dispose() {},
          }
        },
      }
    },
  }
  await agents.spawnRoleAgent(ctx, { agent: { id: 'parent' } }, {
    role: 'writer',
    prompt: '写作任务',
    profile: {
      promotedImprovements: [{ kind: 'memory', title: '已晋升记忆', content: 'RUNTIME-INJECTION' }],
    },
  })
  assert.equal(captured.provider, 'spawn')
  assert.ok(captured.request.persona.includes('RUNTIME-INJECTION'))
})

test('personaOverride 只替换基础 persona，不绕过已晋升改进', async () => {
  let persona
  const ctx = {
    get() {
      return {
        async start(_provider, request) {
          persona = request.persona
          return { result: Promise.resolve({ output: [] }), async dispose() {} }
        },
      }
    },
  }
  await agents.spawnRoleAgent(ctx, { agent: {} }, {
    role: 'writer',
    prompt: '写作任务',
    personaOverride: 'OVERRIDE-BASE',
    profile: {
      promotedImprovements: [{ kind: 'skill', content: 'OVERRIDE-INJECTION' }],
    },
  })
  assert.ok(persona.startsWith('OVERRIDE-BASE'))
  assert.ok(persona.includes('OVERRIDE-INJECTION'))
})

test('spawnRoleAgent 将非 completed 终态作为失败抛出', async () => {
  const ctx = {
    get() {
      return {
        async start() {
          return {
            result: Promise.resolve({ output: [], stopReason: 'max-tokens', diagnostic: '预算耗尽' }),
            async dispose() {},
          }
        },
      }
    },
  }
  await assert.rejects(
    agents.spawnRoleAgent(ctx, { agent: {} }, { role: 'writer', prompt: '写作任务' }),
    /max-tokens.*预算耗尽/,
  )
})

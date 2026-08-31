import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_WRITING_STYLE,
  DEFAULT_SERIAL_STRATEGY,
  normalizeSerialStrategy,
  normalizeWritingStyle,
  renderSerialStrategy,
  renderWritingStyle,
  SERIAL_NARRATIVE_METHOD,
  WRITING_CORE_METHOD,
} from '../plugin/writing-methodology.mjs'

test('文风配置对旧项目使用稳定默认值', () => {
  const style = normalizeWritingStyle({})
  assert.equal(style.baseStyle, DEFAULT_WRITING_STYLE.baseStyle)
  assert.equal(style.pacingMode, 'balanced')
  assert.deepEqual(style.descriptionFocus, ['动作', '对白', '环境'])
})

test('文风配置支持 nested 与扁平字段并清理空值', () => {
  const style = normalizeWritingStyle({
    baseStyle: '不应覆盖 nested',
    writingStyle: {
      baseStyle: '干练朦胧',
      descriptionFocus: ['动作', ' ', '心理'],
      bannedWords: ['套话', ''],
    },
  })
  assert.equal(style.baseStyle, '干练朦胧')
  assert.deepEqual(style.descriptionFocus, ['动作', '心理'])
  assert.deepEqual(style.bannedWords, ['套话'])
  assert.match(renderWritingStyle({ writingStyle: style }), /基础文风（只取一个主方案）：干练朦胧/)
})

test('核心正文方法不包含附件中的互动角色占位符', () => {
  assert.doesNotMatch(WRITING_CORE_METHOD, /\{user\}/i)
  assert.doesNotMatch(WRITING_CORE_METHOD, /用户角色控制/)
})

test('连载策略兼容旧项目，并按短篇总字数收缩前期规划窗口', () => {
  const legacy = normalizeSerialStrategy({})
  assert.equal(legacy.mode, DEFAULT_SERIAL_STRATEGY.mode)
  assert.equal(legacy.openingPerspective, 'follow_project_style')

  const short = normalizeSerialStrategy({ targetWords: 30000 })
  assert.equal(short.planningHorizonWords, 30000)
})

test('连载策略可独立配置，不强制覆盖项目视角', () => {
  const strategy = normalizeSerialStrategy({
    serialStrategy: {
      mode: 'commercial_serial',
      coreEmotionalPromise: '专业能力被验证',
      secondaryEmotionalPromises: ['关系升温'],
      readerExpectations: ['职业细节'],
      readerAvoidances: ['无效震惊'],
      payoffCadence: '每3章一次局部兑现',
      planningHorizonWords: 50000,
      openingPerspective: 'close_third_person',
    },
  })
  assert.equal(strategy.mode, 'commercial_serial')
  assert.equal(strategy.planningHorizonWords, 50000)
  assert.match(renderSerialStrategy({ serialStrategy: strategy }), /专业能力被验证/)
  assert.match(renderSerialStrategy({ serialStrategy: strategy }), /贴近主角的第三人称/)
  assert.match(SERIAL_NARRATIVE_METHOD, /行动反馈/)
})

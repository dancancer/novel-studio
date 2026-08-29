/**
 * novel-studio / 插件入口
 * ------------------------------------------------------------------
 * AI 小说工作室 —— DeepSeek Harness 主机侧插件。
 *
 * 接入方式：在 `~/.dsh/profiles/web/cordis.patch.yml`（用户补丁层，热重载）加入：
 *
 *   - id: novel-studio
 *     name: '/Users/xupeng/mybase/novel-studio/plugin/index.mjs'
 *
 * 注册 24 个 novel_* 工具，供 GUI 中的 Agent（Planner 角色）调用。
 * 多角色子代理通过 ctx.subagents 派发，模型跟随面板选择（“不写死”）。
 */

import { registerNovelTools } from './operators.mjs'
import { appendFileSync } from 'node:fs'

export const name = 'dsh-novel-studio'
export const inject = ['tools']

export function apply(ctx) {
  registerNovelTools(ctx)
  // 启动标记：便于确认 GUI 热加载生效（/tmp 下）
  try {
    appendFileSync('/tmp/novel-studio-boot.log', `${new Date().toISOString()} novel-studio v1 loaded\n`, 'utf8')
  } catch { /* 无害 */ }
  // 自检：延迟读取注册表，验证工具是否真的可见（排查“加载成功但请求层看不到”）
  const selfCheck = (tag) => {
    try {
      const schemas = ctx.get('tools')?.schemas?.() || []
      const novel = schemas.filter(s => String(s.name).startsWith('novel_'))
      appendFileSync('/tmp/novel-studio-boot.log', `${new Date().toISOString()} SELFCHECK ${tag}: tools=${schemas.length} novel=${novel.length} names=${novel.map(s => s.name).join(',')}\n`, 'utf8')
    } catch (e) {
      appendFileSync('/tmp/novel-studio-boot.log', `${new Date().toISOString()} SELFCHECK ${tag}: ERROR ${String(e.message)}\n`, 'utf8')
    }
  }
  try {
    const timer = ctx.get('timer')
    if (timer) {
      timer.setTimeout(() => selfCheck('t+5s'), 5000)
      timer.setTimeout(() => selfCheck('t+60s'), 60000)
    } else {
      setTimeout(() => selfCheck('t+5s'), 5000)
      setTimeout(() => selfCheck('t+60s'), 60000)
    }
  } catch { /* 无害 */ }
  ctx.logger?.info?.('[novel-studio] 24 个 novel_* 工具已注册')
}

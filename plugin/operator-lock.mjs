import {
  existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { hostname, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

const projectMutationQueues = new Map()
const MUTATION_LOCK_ROOT = join(tmpdir(), 'novel-studio-mutation-locks')

function positiveEnvNumber(name, fallback) {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function mutationLockOptions() {
  return {
    timeoutMs: positiveEnvNumber('NOVEL_STUDIO_LOCK_TIMEOUT_MS', 300_000),
    retryMs: positiveEnvNumber('NOVEL_STUDIO_LOCK_RETRY_MS', 50),
    heartbeatMs: positiveEnvNumber('NOVEL_STUDIO_LOCK_HEARTBEAT_MS', 2_000),
    orphanGraceMs: positiveEnvNumber('NOVEL_STUDIO_LOCK_ORPHAN_GRACE_MS', 10_000),
    staleHeartbeatMs: positiveEnvNumber('NOVEL_STUDIO_LOCK_STALE_HEARTBEAT_MS', 30_000),
  }
}

function mutationLockPaths(key) {
  const digest = createHash('sha256').update(key).digest('hex')
  const lockDir = join(MUTATION_LOCK_ROOT, digest)
  return { lockDir, ownerPath: join(lockDir, 'owner.json'), reapDir: `${lockDir}.reap` }
}

function readLockOwner(ownerPath) {
  try { return JSON.parse(readFileSync(ownerPath, 'utf8')) } catch { return null }
}

function lockPathAgeMs(path) {
  try { return Math.max(0, Date.now() - statSync(path).mtimeMs) } catch { return 0 }
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    if (error?.code === 'EPERM') return true
    return null
  }
}

function ownerIsAbandoned(owner, path, options) {
  const fallbackAge = lockPathAgeMs(path)
  if (!owner) return fallbackAge > options.orphanGraceMs
  if (owner.host !== hostname()) {
    const heartbeatAt = Date.parse(owner.heartbeatAt || owner.acquiredAt || '')
    const heartbeatAge = Number.isFinite(heartbeatAt) ? Date.now() - heartbeatAt : fallbackAge
    return heartbeatAge > options.staleHeartbeatMs
  }
  const alive = processIsAlive(Number(owner.pid))
  if (alive !== null) return !alive
  const heartbeatAt = Date.parse(owner.heartbeatAt || owner.acquiredAt || '')
  const heartbeatAge = Number.isFinite(heartbeatAt) ? Date.now() - heartbeatAt : fallbackAge
  return heartbeatAge > options.staleHeartbeatMs
}

function writeLockOwner(lockDir, owner) {
  const ownerPath = join(lockDir, 'owner.json')
  const temporary = join(lockDir, `.owner-${owner.token}.tmp`)
  writeFileSync(temporary, `${JSON.stringify(owner)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(temporary, ownerPath)
}

function removeOwnedLock(lockDir, token) {
  const owner = readLockOwner(join(lockDir, 'owner.json'))
  if (owner?.token !== token) return false
  rmSync(lockDir, { recursive: true, force: true })
  return true
}

function recoverAbandonedReaper(reapDir, options) {
  const owner = readLockOwner(join(reapDir, 'owner.json'))
  if (!ownerIsAbandoned(owner, reapDir, options)) return false
  if (!owner && lockPathAgeMs(reapDir) <= options.orphanGraceMs) return false
  const quarantine = `${reapDir}.abandoned-${process.pid}-${randomUUID()}`
  try {
    renameSync(reapDir, quarantine)
  } catch (error) {
    if (['ENOENT', 'EEXIST', 'ENOTEMPTY'].includes(error?.code)) return false
    throw error
  }
  rmSync(quarantine, { recursive: true, force: true })
  return true
}

function tryRecoverAbandonedLock(paths, options) {
  const observed = readLockOwner(paths.ownerPath)
  if (!ownerIsAbandoned(observed, paths.lockDir, options)) return false
  if (!observed && lockPathAgeMs(paths.lockDir) <= options.orphanGraceMs) return false

  const reaper = {
    token: randomUUID(), pid: process.pid, host: hostname(),
    acquiredAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(),
  }
  try {
    mkdirSync(paths.reapDir, { mode: 0o700 })
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    recoverAbandonedReaper(paths.reapDir, options)
    return false
  }

  try {
    writeLockOwner(paths.reapDir, reaper)
    const owner = readLockOwner(paths.ownerPath)
    if (!ownerIsAbandoned(owner, paths.lockDir, options)) return false
    if (!owner && lockPathAgeMs(paths.lockDir) <= options.orphanGraceMs) return false

    // 持有独立 reaper 锁后再复核并删除，避免多个等待者同时清理同一遗留锁。
    const confirmed = readLockOwner(paths.ownerPath)
    if (owner?.token && confirmed?.token !== owner.token) return false
    if (!ownerIsAbandoned(confirmed, paths.lockDir, options)) return false
    rmSync(paths.lockDir, { recursive: true, force: true })
    return true
  } finally {
    removeOwnedLock(paths.reapDir, reaper.token)
  }
}

function waitForMutationLock(ms) {
  return new Promise(resolveWait => setTimeout(resolveWait, ms))
}

async function acquireCrossProcessMutationLock(key) {
  mkdirSync(MUTATION_LOCK_ROOT, { recursive: true, mode: 0o700 })
  const options = mutationLockOptions()
  const paths = mutationLockPaths(key)
  const startedAt = Date.now()
  const owner = {
    token: randomUUID(), pid: process.pid, host: hostname(), key,
    acquiredAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(),
  }

  while (true) {
    let created = false
    try {
      mkdirSync(paths.lockDir, { mode: 0o700 })
      created = true
      writeLockOwner(paths.lockDir, owner)
      const heartbeat = setInterval(() => {
        const current = readLockOwner(paths.ownerPath)
        if (current?.token !== owner.token) return
        owner.heartbeatAt = new Date().toISOString()
        try { writeLockOwner(paths.lockDir, owner) } catch { /* 锁已释放或被人工移除 */ }
      }, options.heartbeatMs)
      heartbeat.unref?.()

      return () => {
        clearInterval(heartbeat)
        removeOwnedLock(paths.lockDir, owner.token)
      }
    } catch (error) {
      if (created) {
        rmSync(paths.lockDir, { recursive: true, force: true })
        throw error
      }
      if (error?.code !== 'EEXIST') {
        throw error
      }
    }

    if (tryRecoverAbandonedLock(paths, options)) continue
    const waitedMs = Date.now() - startedAt
    if (waitedMs >= options.timeoutMs) {
      const holder = readLockOwner(paths.ownerPath)
      const holderText = holder?.pid ? `；当前持有者 pid=${holder.pid}` : ''
      throw new Error(`novel-studio: 等待项目跨进程写锁超时（${options.timeoutMs}ms）：${key}${holderText}。另一个进程可能仍在执行长任务，请稍后重试`)
    }
    await waitForMutationLock(Math.min(options.retryMs, options.timeoutMs - waitedMs))
  }
}

export async function withProjectMutationLock(key, task) {
  const previous = projectMutationQueues.get(key) || Promise.resolve()
  const current = previous.catch(() => undefined).then(async () => {
    const release = await acquireCrossProcessMutationLock(key)
    try { return await task() } finally { release() }
  })
  projectMutationQueues.set(key, current)
  try {
    return await current
  } finally {
    if (projectMutationQueues.get(key) === current) projectMutationQueues.delete(key)
  }
}

export function canonicalMutationKey(path) {
  const absolute = resolve(String(path))
  const suffix = []
  let existing = absolute
  while (!existsSync(existing)) {
    const parent = dirname(existing)
    if (parent === existing) return absolute
    suffix.unshift(basename(existing))
    existing = parent
  }
  try { return resolve(realpathSync(existing), ...suffix) } catch { return absolute }
}

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { TaskExecutionLock, TaskExecutionLocks } from '@unilab/services'

import { ReleaseOccupancyCard, releasePlan, type ReleaseState } from './ReleaseOccupancyCard'

const LOCK: TaskExecutionLock = {
  uuid: 'lease-1', jobUuid: 'j-1', state: 'running', materialUuid: 'm-right', claimUuid: 'claim-1',
  fencingToken: 3, jobStatus: 'canceled', claimState: 'running', canRelease: true, releaseBlockReason: null
}

function locks(overrides: Partial<TaskExecutionLocks> = {}): TaskExecutionLocks {
  return { taskUuid: 't-1', taskStatus: 'canceled', locks: [LOCK], activeDeviceTenancyCount: 0, ...overrides }
}

describe('release plan', () => {
  it('releases a finished job whose result is certain', () => {
    expect(releasePlan(locks(), 'j-1')).toEqual({ kind: 'release', lock: LOCK })
  })

  it('settles an uncertain job as canceled instead of releasing its lock', () => {
    const uncertain = { ...LOCK, state: 'uncertain', canRelease: false, releaseBlockReason: '锁处于结果不确定状态，禁止人工释放' }
    expect(releasePlan(locks({ taskStatus: 'running', locks: [uncertain] }), 'j-1')).toEqual({ kind: 'settle', jobUuid: 'j-1' })
  })

  it('explains why an active task cannot be released and points to cancel', () => {
    const active = { ...LOCK, jobStatus: 'running', canRelease: false, releaseBlockReason: '任务尚未进入失败、取消或超时终态' }
    const plan = releasePlan(locks({ taskStatus: 'running', locks: [active] }), 'j-1')
    expect(plan).toMatchObject({ kind: 'blocked' })
    expect(plan.kind === 'blocked' && plan.reason).toContain('请先取消任务')
  })

  it('reports an occupancy that is already gone, or held as device tenancy', () => {
    expect(releasePlan(locks({ locks: [] }), 'j-1')).toEqual({ kind: 'none' })
    expect(releasePlan(locks({ locks: [], activeDeviceTenancyCount: 1 }), 'j-1')).toMatchObject({ kind: 'blocked' })
    expect(releasePlan(locks(), 'other-job')).toEqual({ kind: 'none' })  // 只看这个作业的锁
  })
})

function render(state: Partial<ReleaseState>): string {
  return renderToStaticMarkup(
    <ReleaseOccupancyCard
      state={{
        target: { taskUuid: 'b59354a1-0f73', jobUuid: 'j-1', holder: '左开关盖机构 · 关盖', device: '左开关盖机构' },
        plan: { kind: 'release', lock: LOCK },
        loadError: null, reason: '', confirmed: false, sending: false, result: null, error: null,
        ...state
      }}
      onReasonChange={() => undefined}
      onConfirmChange={() => undefined}
      onSubmit={() => undefined}
      onClose={() => undefined}
    />
  )
}

describe('release card', () => {
  it('requires a reason and the site confirmation before releasing', () => {
    const blank = render({})
    expect(blank).toContain('核对后解除占用：左开关盖机构')
    expect(blank).toContain('占用者：左开关盖机构 · 关盖（任务 b59354a1）')
    expect(blank).toMatch(/<button[^>]*disabled=""[^>]*>解除占用<\/button>/)
    expect(render({ reason: '现场已核对', confirmed: false })).toMatch(/disabled=""[^>]*>解除占用</)
    expect(render({ reason: '现场已核对', confirmed: true })).not.toMatch(/disabled=""[^>]*>解除占用</)
  })

  it('offers settling as canceled for an uncertain job', () => {
    const markup = render({ plan: { kind: 'settle', jobUuid: 'j-1' }, reason: '设备已停止', confirmed: true })
    expect(markup).toContain('OS 不知道这次动作有没有在设备上执行完')
    expect(markup).toContain('按已取消结算</button>')
  })

  it('shows loading, blocked reasons and results without an action button', () => {
    expect(render({ plan: null })).toContain('正在读取执行锁与释放资格')
    const blocked = render({ plan: { kind: 'blocked', reason: '任务还在执行，请先取消任务' } })
    expect(blocked).toContain('现在不能解除：任务还在执行，请先取消任务')
    expect(blocked).not.toContain('解除占用</button>')
    const done = render({ result: '已解除占用，排队的任务会继续调度。' })
    expect(done).toContain('已解除占用，排队的任务会继续调度。')
    expect(done).toContain('>完成</button>')
    expect(done).not.toContain('解除占用</button>')
  })
})

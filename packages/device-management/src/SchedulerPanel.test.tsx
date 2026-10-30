import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type {
  DeviceCatalogItem,
  SchedulerSnapshot,
  SchedulerTask,
  StationControl
} from '@unilab/services'

import { SchedulerBoard, type CommandPhase } from './SchedulerPanel'
import {
  attentionReason,
  formatDuration,
  groupSchedulerTasks,
  queueReason,
  schedulerNames,
  taskStatusLabel,
  taskTitle
} from './schedulerPresentation'

const NOW = Date.parse('2026-10-30T02:00:00Z')

function task(overrides: Partial<SchedulerTask> & { uuid: string }): SchedulerTask {
  return {
    kind: 'ad_hoc_device_action',
    workflowName: null,
    status: 'running',
    controlStatus: 'active',
    cleanupStatus: 'none',
    createdAt: '2026-10-30T01:55:00Z',
    startedAt: '2026-10-30T01:55:00Z',
    finishedAt: null,
    waitReason: null,
    steps: [{
      nodeUuid: 'n', name: null, deviceKey: 'organic_right_capper', actionName: 'open_caps',
      jobUuid: 'j', jobStatus: 'running', startedAt: '2026-10-30T01:56:30Z', uncertaintyReason: null
    }],
    ...overrides
  }
}

const RUNNING = task({ uuid: 'run-0001' })
const QUEUED = task({
  uuid: 'wait-0001',
  status: 'pending',
  startedAt: null,
  createdAt: '2026-10-30T01:59:00Z',
  steps: [{ ...RUNNING.steps[0]!, actionName: 'close_caps', jobUuid: null, jobStatus: null, startedAt: null }],
  waitReason: { message: '执行资源正在被其他作业使用', resources: ['右开关盖机构'], blockingTaskUuid: 'run-0001', since: '2026-10-30T01:59:30Z' }
})
const FAILED_WAITING = task({ uuid: 'err-0001', controlStatus: 'error_waiting' })
const DONE = task({ uuid: 'done-0001', status: 'succeeded', finishedAt: '2026-10-30T01:50:00Z', startedAt: '2026-10-30T01:42:16Z' })
const OLDER = task({ uuid: 'done-0002', status: 'canceled', finishedAt: '2026-10-30T01:40:00Z' })

const CATALOG: DeviceCatalogItem[] = [{
  deviceId: 'm-right', materialUuid: 'm-right', deviceTypeId: 't', deviceKey: 'organic_right_capper',
  namespace: 'edge', label: '右开关盖机构', online: true,
  actions: [
    { actionName: 'open_caps', actionRef: 'm-right.open_caps', label: '开盖', typeName: 'x', inputSchema: {}, outputSchema: {}, riskLevel: 'normal', isBusy: true },
    { actionName: 'close_caps', actionRef: 'm-right.close_caps', label: '关盖', typeName: 'x', inputSchema: {}, outputSchema: {}, riskLevel: 'normal', isBusy: false }
  ]
}, {
  deviceId: 'm-left', materialUuid: 'm-left', deviceTypeId: 't', deviceKey: 'organic_left_capper',
  namespace: 'edge', label: '左开关盖机构', online: true, actions: []
}] as unknown as DeviceCatalogItem[]

const RUNNING_STATION: StationControl = {
  stationId: 'local', mode: 'RUNNING', stationVersion: 16, errorEpoch: 4, snapshotId: 'local:16:4',
  activeSessionId: null, errors: [], pendingCommands: 0
}

describe('scheduler presentation', () => {
  it('groups tasks into running, queued, attention and recent', () => {
    const groups = groupSchedulerTasks([OLDER, DONE, QUEUED, FAILED_WAITING, RUNNING])
    expect(groups.running.map((item) => item.uuid)).toEqual(['run-0001'])
    expect(groups.queued.map((item) => item.uuid)).toEqual(['wait-0001'])
    expect(groups.attention.map((item) => item.uuid)).toEqual(['err-0001'])
    expect(groups.recent.map((item) => item.uuid)).toEqual(['done-0001', 'done-0002'])  // 新的在前
  })

  it('names tasks by device and action display names, falling back to ids', () => {
    expect(taskTitle(RUNNING, schedulerNames(CATALOG))).toBe('右开关盖机构 · 开盖')
    expect(taskTitle(RUNNING, schedulerNames([]))).toBe('organic_right_capper · open_caps')
    expect(taskTitle({ ...RUNNING, kind: 'workflow', workflowName: '开关盖流程' }, schedulerNames(CATALOG)))
      .toBe('开关盖流程：右开关盖机构 · 开盖')
  })

  it('explains why a queued task has not started', () => {
    const titleOf = (uuid: string) => (uuid === 'run-0001' ? '右开关盖机构 · 开盖' : null)
    expect(queueReason(QUEUED, RUNNING_STATION, titleOf)).toBe('等待 右开关盖机构 释放（正被「右开关盖机构 · 开盖」使用）')
    expect(queueReason(QUEUED, { ...RUNNING_STATION, mode: 'PAUSED' }, titleOf)).toBe('工站调度已暂停，恢复调度后才会派发')
    expect(queueReason({ ...QUEUED, waitReason: null }, RUNNING_STATION, titleOf)).toBe('等待调度器派发')
  })

  it('labels states that need a person', () => {
    expect(taskStatusLabel(FAILED_WAITING)).toEqual({ label: '出错待处置', tone: 'danger' })
    expect(taskStatusLabel({ ...RUNNING, status: 'canceling' }).label).toBe('正在取消')
    expect(attentionReason(FAILED_WAITING)).toContain('工站调度已暂停')
    expect(attentionReason({ ...DONE, cleanupStatus: 'requires_attention' })).toBe('任务已结束，但执行占用没有释放')
  })

  it('formats elapsed time', () => {
    expect(formatDuration('2026-10-30T01:56:30Z', NOW)).toBe('3:30')
    expect(formatDuration('2026-10-30T00:58:05Z', NOW)).toBe('1:01:55')
    expect(formatDuration(null, NOW)).toBe('—')
  })
})

function render(commands: Record<string, CommandPhase> = {}, station = RUNNING_STATION): string {
  const snapshot: SchedulerSnapshot = {
    tasks: [RUNNING, QUEUED, DONE],
    occupancies: [{
      kind: 'execution_lock', state: 'running', scope: 'device', materialUuid: 'm-right',
      taskUuid: 'run-0001', jobUuid: 'j', since: '2026-10-30T01:56:30Z'
    }]
  }
  return renderToStaticMarkup(
    <SchedulerBoard
      station={{
        control: station, readError: null, confirmed: false, pending: false, commandError: null,
        setConfirmed: () => undefined, cancelError: () => undefined, resume: () => undefined
      }}
      snapshot={snapshot}
      catalog={CATALOG}
      statuses={{ 'm-right': { status: 'Running' }, 'm-left': { status: 'Idle' } }}
      readError={null}
      updatedAt="2026-10-30T02:00:00Z"
      commands={commands}
      now={NOW}
      onRefresh={() => undefined}
      onCancel={() => undefined}
    />
  )
}

describe('scheduler board', () => {
  it('shows the station gate, running and queued tasks with reasons, and device occupancy', () => {
    const markup = render()
    expect(markup).toContain('工站调度中')
    expect(markup).toMatch(/执行中 <strong>1<\/strong> · 排队 <strong>1<\/strong> · 需处理 <strong>0<\/strong>/)
    expect(markup).toContain('右开关盖机构 · 开盖')
    expect(markup).toContain('已运行 3:30')
    expect(markup).toContain('等待 右开关盖机构 释放（正被「右开关盖机构 · 开盖」使用）')
    expect(markup).toMatch(/右开关盖机构<\/strong>.*运行中 Running.*执行中<\/span>右开关盖机构 · 开盖 · 3:30/s)
    expect(markup).toContain('空闲，未被占用')  // 左开关盖
    expect(markup).toContain('用时 7:44')  // 最近结束
  })

  it('asks for a second click before cancelling and shows the sent state', () => {
    expect(render()).toMatch(/data-task-uuid="run-0001"[\s\S]*?<button[^>]*>取消<\/button>/)
    expect(render({ 'run-0001': { phase: 'confirm' } })).toContain('确认取消')
    const sent = render({ 'run-0001': { phase: 'sent' } })
    expect(sent).toContain('已发送取消，等待设备停下…')
    expect(sent).toMatch(/<button[^>]*disabled=""[^>]*>已发送<\/button>/)
    expect(render({ 'run-0001': { phase: 'error', message: '任务已结束' } })).toContain('取消失败：任务已结束')
  })

  it('offers release only for occupancy held by a task that is no longer running or queued', () => {
    const stuck = renderToStaticMarkup(
      <SchedulerBoard
        station={{
          control: RUNNING_STATION, readError: null, confirmed: false, pending: false, commandError: null,
          setConfirmed: () => undefined, cancelError: () => undefined, resume: () => undefined
        }}
        snapshot={{
          tasks: [DONE],
          occupancies: [{
            kind: 'execution_lock', state: 'running', scope: 'device', materialUuid: 'm-right',
            taskUuid: 'done-0001', jobUuid: 'j', since: '2026-10-30T01:50:00Z'
          }]
        }}
        catalog={CATALOG}
        statuses={{}}
        readError={null}
        updatedAt={null}
        commands={{}}
        now={NOW}
        onRefresh={() => undefined}
        onCancel={() => undefined}
      />
    )
    expect(stuck).toContain('核对后解除</button>')
    expect(render()).not.toContain('核对后解除')  // 执行中的任务占着设备：用取消，不用解除
  })

  it('shows the release card above the task columns', () => {
    const markup = renderToStaticMarkup(
      <SchedulerBoard
        station={{
          control: RUNNING_STATION, readError: null, confirmed: false, pending: false, commandError: null,
          setConfirmed: () => undefined, cancelError: () => undefined, resume: () => undefined
        }}
        snapshot={{ tasks: [], occupancies: [] }}
        catalog={CATALOG}
        statuses={{}}
        readError={null}
        updatedAt={null}
        commands={{}}
        now={NOW}
        onRefresh={() => undefined}
        onCancel={() => undefined}
        release={{
          target: { taskUuid: 'done-0001', jobUuid: 'j', holder: '右开关盖机构 · 开盖', device: '右开关盖机构' },
          plan: null, loadError: null, reason: '', confirmed: false, sending: false, result: null, error: null
        }}
      />
    )
    expect(markup.indexOf('核对后解除占用：右开关盖机构')).toBeLessThan(markup.indexOf('执行中</h3>'))
  })

  it('shows the paused station card with its errors', () => {
    const markup = render({}, {
      ...RUNNING_STATION,
      mode: 'PAUSED',
      errors: [{ decisionId: 'd', decisionVersion: 1, taskUuid: 'err-0001', message: 'PLC 报告故障：右开关盖', cancelable: true }]
    })
    expect(markup).toContain('工站调度已暂停')
    expect(markup).toContain('PLC 报告故障：右开关盖')
    expect(markup).toContain('工站调度已暂停，恢复调度后才会派发')  // 排队原因随之改变
  })
})

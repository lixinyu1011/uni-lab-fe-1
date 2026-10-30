import type {
  DeviceCatalogItem,
  SchedulerOccupancy,
  SchedulerStep,
  SchedulerTask,
  StationControl
} from '@unilab/services'

/** 设备与动作的显示名；目录未读到时回退为组态图里的 id。 */
export interface SchedulerNames {
  device: (deviceKey: string | null) => string
  deviceByMaterial: (materialUuid: string | null) => string
  action: (deviceKey: string | null, actionName: string | null) => string
}

/** 由设备目录（含动作显示名）建立名称表。 */
export function schedulerNames(catalog: DeviceCatalogItem[]): SchedulerNames {
  const devices = new Map(catalog.map((item) => [item.deviceKey, item.label]))
  const materials = new Map(catalog.map((item) => [item.materialUuid, item.label]))
  const actions = new Map(catalog.flatMap((item) =>
    item.actions.map((action) => [`${item.deviceKey}.${action.actionName}`, action.label] as const)))
  return {
    device: (key) => (key && devices.get(key)) || key || '未知设备',
    deviceByMaterial: (uuid) => (uuid && materials.get(uuid)) || (uuid ? shortId(uuid) : '未知资源'),
    action: (deviceKey, actionName) =>
      (actionName && actions.get(`${deviceKey}.${actionName}`)) || actionName || '未知动作'
  }
}

export interface SchedulerGroups {
  /** 正在执行或正在取消。 */
  running: SchedulerTask[]
  /** 排队等待派发，先来先排。 */
  queued: SchedulerTask[]
  /** 出错待处置、结果待核对或占用未释放，需要人处理。 */
  attention: SchedulerTask[]
  /** 最近结束，新的在前。 */
  recent: SchedulerTask[]
}

const TERMINAL = new Set(['succeeded', 'failed', 'canceled', 'timeout'])
const FINISHED_JOB = new Set(['succeeded', 'failed', 'canceled', 'timeout', 'skipped'])

/** 任务是否需要人处理（而不是等调度器自己推进）。 */
export function needsAttention(task: SchedulerTask): boolean {
  return task.cleanupStatus === 'requires_attention' ||
    task.controlStatus === 'error_waiting' ||
    task.controlStatus === 'waiting_reconciliation' ||
    task.steps.some((step) => step.uncertaintyReason !== null)
}

/** 把调度快照里的任务分成执行中、排队、需处理、最近结束四组。 */
export function groupSchedulerTasks(tasks: SchedulerTask[]): SchedulerGroups {
  const groups: SchedulerGroups = { running: [], queued: [], attention: [], recent: [] }
  for (const task of tasks) {
    if (needsAttention(task)) groups.attention.push(task)
    else if (task.status === 'pending') groups.queued.push(task)
    else if (task.status === 'running' || task.status === 'canceling') groups.running.push(task)
    else if (TERMINAL.has(task.status)) groups.recent.push(task)
  }
  const byStart = (task: SchedulerTask) => task.startedAt ?? task.createdAt
  groups.running.sort((left, right) => byStart(left).localeCompare(byStart(right)))
  groups.queued.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  groups.attention.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  groups.recent.sort((left, right) =>
    (right.finishedAt ?? right.createdAt).localeCompare(left.finishedAt ?? left.createdAt))
  return groups
}

/** 任务当前所在的节点：正在执行的作业优先，其次第一个还没结束的节点。 */
export function currentStep(task: SchedulerTask): SchedulerStep | null {
  return task.steps.find((step) => step.jobStatus !== null && !FINISHED_JOB.has(step.jobStatus)) ??
    task.steps.find((step) => step.jobStatus === null) ??
    task.steps[task.steps.length - 1] ??
    null
}

/** 列表上显示的任务名：设备 · 动作；工作流任务前面加工作流名。 */
export function taskTitle(task: SchedulerTask, names: SchedulerNames): string {
  const step = currentStep(task)
  const action = step ? `${names.device(step.deviceKey)} · ${names.action(step.deviceKey, step.actionName)}` : ''
  if (task.kind === 'workflow') {
    const workflow = task.workflowName ?? '工作流任务'
    return action ? `${workflow}：${action}` : workflow
  }
  return action || '设备动作'
}

export type SchedulerTone = 'running' | 'pending' | 'success' | 'danger' | 'muted' | 'warning'

/** 任务状态的中文标签和颜色。 */
export function taskStatusLabel(task: SchedulerTask): { label: string; tone: SchedulerTone } {
  if (task.status === 'canceling') return { label: '正在取消', tone: 'warning' }
  if (task.controlStatus === 'error_waiting') return { label: '出错待处置', tone: 'danger' }
  if (task.controlStatus === 'waiting_reconciliation') return { label: '结果待核对', tone: 'warning' }
  if (task.cleanupStatus === 'requires_attention') return { label: '占用未释放', tone: 'danger' }
  switch (task.status) {
    case 'running': return { label: '执行中', tone: 'running' }
    case 'pending': return { label: task.controlStatus === 'paused' ? '已暂停' : '排队中', tone: 'pending' }
    case 'succeeded': return { label: '成功', tone: 'success' }
    case 'failed': return { label: '失败', tone: 'danger' }
    case 'canceled': return { label: '已取消', tone: 'muted' }
    case 'timeout': return { label: '超时', tone: 'danger' }
    default: return { label: task.status || '未知', tone: 'muted' }
  }
}

/** 排队任务为什么还没开始。 */
export function queueReason(
  task: SchedulerTask,
  control: StationControl | null,
  titleOf: (taskUuid: string) => string | null
): string {
  if (control?.mode === 'PAUSED') return '工站调度已暂停，恢复调度后才会派发'
  if (task.controlStatus === 'paused') return '任务已暂停'
  const reason = task.waitReason
  if (!reason) return '等待调度器派发'
  const holder = reason.blockingTaskUuid ? titleOf(reason.blockingTaskUuid) : null
  const resources = reason.resources.length ? reason.resources.join('、') : '执行资源'
  return `等待 ${resources} 释放${holder ? `（正被「${holder}」使用）` : ''}`
}

/** 需处理的任务卡在哪里。 */
export function attentionReason(task: SchedulerTask): string {
  if (task.controlStatus === 'error_waiting') return '节点执行失败，等待处置；工站调度已暂停'
  if (task.controlStatus === 'waiting_reconciliation') return '执行结果待核对，核对前不会继续派发'
  const uncertain = task.steps.find((step) => step.uncertaintyReason)
  if (uncertain) return `执行结果不确定（${uncertain.uncertaintyReason}），设备占用未释放`
  return '任务已结束，但执行占用没有释放'
}

/** 占用状态的中文说明。 */
export function occupancyStateLabel(occupancy: SchedulerOccupancy): { label: string; tone: SchedulerTone } {
  switch (occupancy.state) {
    case 'reserved': return { label: '已预占', tone: 'pending' }
    case 'running': return { label: '执行中', tone: 'running' }
    case 'uncertain': return { label: '结果不确定，未释放', tone: 'danger' }
    case 'active': return { label: '任务独占', tone: 'running' }
    default: return { label: occupancy.state || '未知', tone: 'muted' }
  }
}

/** 任务能否从调度面板取消：已结束、正在取消的不能再取消。 */
export function canCancelTask(task: SchedulerTask): boolean {
  return task.status === 'pending' || task.status === 'running'
}

/** 从 fromIso 到 now 的时长：m:ss，超过一小时 h:mm:ss。 */
export function formatDuration(fromIso: string | null, now: number): string {
  const started = fromIso ? Date.parse(fromIso) : Number.NaN
  if (Number.isNaN(started)) return '—'
  const seconds = Math.max(0, Math.floor((now - started) / 1000))
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = String(seconds % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

/** 本地时间 HH:MM:SS。 */
export function formatClock(iso: string | null): string {
  const time = iso ? Date.parse(iso) : Number.NaN
  if (Number.isNaN(time)) return '—'
  return new Date(time).toLocaleTimeString('zh-CN', { hour12: false })
}

export function shortId(uuid: string): string {
  return uuid.slice(0, 8)
}

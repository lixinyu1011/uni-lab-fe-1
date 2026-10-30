import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  DeviceCatalogItem,
  DeviceStatusProperties,
  SchedulerOccupancy,
  SchedulerSnapshot,
  SchedulerTask,
  Services,
  StationControl
} from '@unilab/services'

import { DeviceStateBadge } from './DeviceStatusMonitor'
import {
  ReleaseOccupancyCard,
  releasePlan,
  type ReleaseState,
  type ReleaseTarget
} from './ReleaseOccupancyCard'
import styles from './SchedulerPanel.module.scss'
import {
  attentionReason,
  canCancelTask,
  currentStep,
  formatClock,
  formatDuration,
  groupSchedulerTasks,
  occupancyStateLabel,
  queueReason,
  schedulerNames,
  shortId,
  taskStatusLabel,
  taskTitle,
  type SchedulerNames,
  type SchedulerTone
} from './schedulerPresentation'
import { StationPausedCard } from './StationDispatchControl'
import { useStationControl, type StationControlState } from './useStationControl'

/** 平时 2 秒刷新；发出取消等命令后 10 秒内每 0.5 秒刷新，尽快看到结果。 */
export const SCHEDULER_POLL_MS = 2000
const FAST_POLL_MS = 500
const FAST_POLL_WINDOW_MS = 10_000
/** 取消按钮点一次进入确认，4 秒内再点一次才发送。 */
const CONFIRM_WINDOW_MS = 4000

/** 某个任务的取消命令进度：确认中、发送中、已发送、失败。 */
export type CommandPhase =
  | { phase: 'confirm' }
  | { phase: 'sending' }
  | { phase: 'sent' }
  | { phase: 'error'; message: string }

/**
 * 调度面板：工站调度闸门、执行中/排队/需处理的任务、设备占用和最近结束的任务。
 *
 * 平时每 2 秒刷新，OS 推送运行事件时立即刷新；取消任务后加快刷新直到看到结果。
 *
 * @param props.services 服务组合。
 * @param props.active 面板可见时为 true；不可见时停止刷新。
 * @safety 取消要连点两次确认；恢复调度要勾选现场核对；所有命令都由 OS 校验后执行。
 */
export function SchedulerPanel({
  services,
  active
}: {
  services: Services
  active: boolean
}): React.JSX.Element {
  const station = useStationControl(services, active)
  const [snapshot, setSnapshot] = useState<SchedulerSnapshot | null>(null)
  const [statuses, setStatuses] = useState<Record<string, DeviceStatusProperties>>({})
  const [catalog, setCatalog] = useState<DeviceCatalogItem[]>([])
  const [readError, setReadError] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  const [commands, setCommands] = useState<Record<string, CommandPhase>>({})
  const [now, setNow] = useState(() => Date.now())
  const fastUntil = useRef(0)
  const refreshNow = useRef<() => void>(() => undefined)

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const [next, nextStatuses] = await Promise.all([
        services.laboratory.getSchedulerSnapshot(signal),
        services.laboratory.getDeviceStatuses(signal).catch(() => null)
      ])
      if (signal?.aborted) return
      setSnapshot(next)
      if (nextStatuses) setStatuses(nextStatuses)
      setReadError(null)
      setUpdatedAt(new Date().toISOString())
    } catch (error) {
      if (signal?.aborted) return
      setReadError(error instanceof Error ? error.message : '读取调度状态失败')
    }
  }, [services.laboratory])

  const loadCatalog = useCallback(() => {
    services.laboratory.getDeviceCatalog().then(setCatalog, () => undefined)  // 读不到时显示设备 id
  }, [services.laboratory])

  // 轮询：可见时 2 秒一次，命令后 10 秒内 0.5 秒一次；页面在后台时不请求。
  useEffect(() => {
    if (!active) return
    loadCatalog()
    const controller = new AbortController()
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined
    let lastPoll = 0
    const schedule = (delay: number) => {
      globalThis.clearTimeout(timer)
      timer = globalThis.setTimeout(() => void poll(), delay)
    }
    const poll = async (): Promise<void> => {
      lastPoll = Date.now()
      if (typeof document === 'undefined' || !document.hidden) await load(controller.signal)
      if (controller.signal.aborted) return
      schedule(Date.now() < fastUntil.current ? FAST_POLL_MS : SCHEDULER_POLL_MS)
    }
    // 事件触发的刷新最多 0.3 秒一次，成串的推送不会刷爆请求。
    refreshNow.current = () => schedule(Math.max(0, lastPoll + 300 - Date.now()))
    void poll()
    return () => {
      controller.abort()
      globalThis.clearTimeout(timer)
      refreshNow.current = () => undefined
    }
  }, [active, load, loadCatalog])

  // OS 推送任务/作业变化时立即刷新。
  useEffect(() => {
    if (!active || !services.capabilities.workflow.subscribeEvents) return
    const subscription = services.workflow.subscribeWorkflowRuntime(() => refreshNow.current())
    return () => subscription.dispose()
  }, [active, services.capabilities.workflow.subscribeEvents, services.workflow])

  // 时长每秒走一次。
  useEffect(() => {
    if (!active) return
    const timer = globalThis.setInterval(() => setNow(Date.now()), 1000)
    return () => globalThis.clearInterval(timer)
  }, [active])

  const setCommand = (taskUuid: string, phase: CommandPhase | null) => {
    setCommands((current) => {
      const next = { ...current }
      if (phase) next[taskUuid] = phase
      else delete next[taskUuid]
      return next
    })
  }

  const cancel = async (task: SchedulerTask): Promise<void> => {
    const phase = commands[task.uuid]?.phase
    if (phase === 'sending') return
    if (phase !== 'confirm') {
      setCommand(task.uuid, { phase: 'confirm' })
      globalThis.setTimeout(() => setCommands((current) =>
        current[task.uuid]?.phase === 'confirm' ? withoutKey(current, task.uuid) : current), CONFIRM_WINDOW_MS)
      return
    }
    setCommand(task.uuid, { phase: 'sending' })
    try {
      // 出错待处置的任务走工站错误处置（取消出错任务），其余走任务取消命令。
      const decision = station.control?.errors.find((error) => error.taskUuid === task.uuid && error.cancelable)
      if (decision && station.control) {
        await services.laboratory.cancelStationErrorTask(station.control, decision)
        void station.reload()
      } else {
        await services.workflow.commandWorkflowTask(task.uuid, {
          type: 'cancel',
          idempotency_key: globalThis.crypto.randomUUID(),
          description: '调度面板取消任务'
        })
      }
      setCommand(task.uuid, { phase: 'sent' })
      // 10 秒后任务还在执行（驱动没响应取消）时，按钮恢复，可以再取消一次。
      globalThis.setTimeout(() => setCommands((current) =>
        current[task.uuid]?.phase === 'sent' ? withoutKey(current, task.uuid) : current), FAST_POLL_WINDOW_MS)
    } catch (error) {
      setCommand(task.uuid, { phase: 'error', message: error instanceof Error ? error.message : String(error) })
    }
    fastUntil.current = Date.now() + FAST_POLL_WINDOW_MS
    refreshNow.current()
  }

  // 核对后解除占用：先读任务的执行锁和 OS 判定的释放资格，再按情况释放或结算。
  const [release, setRelease] = useState<ReleaseState | null>(null)

  const openRelease = (target: ReleaseTarget) => {
    setRelease({ target, plan: null, loadError: null, reason: '', confirmed: false, sending: false, result: null, error: null })
    const sameTarget = (current: ReleaseState | null) => current?.target === target
    services.laboratory.getTaskExecutionLocks(target.taskUuid).then(
      (locks) => setRelease((current) =>
        sameTarget(current) && current ? { ...current, plan: releasePlan(locks, target.jobUuid) } : current),
      (error: unknown) => setRelease((current) =>
        sameTarget(current) && current ? { ...current, loadError: errorMessage(error) } : current)
    )
  }

  const submitRelease = async (): Promise<void> => {
    if (!release?.plan || release.sending || !release.confirmed || !release.reason.trim()) return
    const { plan, target } = release
    const reason = release.reason.trim()
    setRelease({ ...release, sending: true, error: null })
    try {
      let result = ''
      if (plan.kind === 'release') {
        const status = await services.laboratory.releaseExecutionLock(target.taskUuid, plan.lock, reason)
        result = status === 'already_released' ? '占用已经释放过了。' : '已解除占用，排队的任务会继续调度。'
      } else if (plan.kind === 'settle') {
        const settled = await services.laboratory.resolveUncertainJob(plan.jobUuid, reason)
        result = settled.pendingEdgeConfirmation
          ? '已提交按“已取消”结算，等待 Edge 确认后释放占用。'
          : '已按“已取消”结算，占用已释放。'
      }
      setRelease((current) => current && { ...current, sending: false, result })
    } catch (error) {
      setRelease((current) => current && { ...current, sending: false, error: `提交失败：${errorMessage(error)}` })
    }
    fastUntil.current = Date.now() + FAST_POLL_WINDOW_MS
    refreshNow.current()
  }

  return (
    <SchedulerBoard
      station={station}
      snapshot={snapshot}
      catalog={catalog}
      statuses={statuses}
      readError={readError}
      updatedAt={updatedAt}
      commands={commands}
      now={now}
      onRefresh={() => {
        loadCatalog()
        void station.reload()
        refreshNow.current()
      }}
      onCancel={(task) => void cancel(task)}
      release={release}
      onOpenRelease={openRelease}
      onReleaseChange={(change) => setRelease((current) => current && { ...current, ...change })}
      onSubmitRelease={() => void submitRelease()}
      onCloseRelease={() => setRelease(null)}
    />
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 调度面板的展示部分：只依赖传入的数据，便于静态渲染测试。 */
export function SchedulerBoard({
  station,
  snapshot,
  catalog,
  statuses,
  readError,
  updatedAt,
  commands,
  now,
  onRefresh,
  onCancel,
  release = null,
  onOpenRelease = () => undefined,
  onReleaseChange = () => undefined,
  onSubmitRelease = () => undefined,
  onCloseRelease = () => undefined
}: {
  station: Pick<StationControlState,
    'control' | 'readError' | 'confirmed' | 'pending' | 'commandError' | 'setConfirmed' | 'cancelError' | 'resume'>
  snapshot: SchedulerSnapshot | null
  catalog: DeviceCatalogItem[]
  statuses: Record<string, DeviceStatusProperties>
  readError: string | null
  updatedAt: string | null
  commands: Record<string, CommandPhase>
  now: number
  onRefresh: () => void
  onCancel: (task: SchedulerTask) => void
  release?: ReleaseState | null
  onOpenRelease?: (target: ReleaseTarget) => void
  onReleaseChange?: (change: Partial<Pick<ReleaseState, 'reason' | 'confirmed'>>) => void
  onSubmitRelease?: () => void
  onCloseRelease?: () => void
}): React.JSX.Element {
  const names = useMemo(() => schedulerNames(catalog), [catalog])
  const tasks = useMemo(() => snapshot?.tasks ?? [], [snapshot])
  const groups = useMemo(() => groupSchedulerTasks(tasks), [tasks])
  const titles = useMemo(() => new Map(tasks.map((task) => [task.uuid, taskTitle(task, names)])), [tasks, names])
  const titleOf = useCallback((uuid: string) => titles.get(uuid) ?? null, [titles])
  // 正在执行或排队的任务占着设备是正常的，取消即可；只有其他任务的占用才提供“核对后解除”。
  const activeTasks = useMemo(
    () => new Set([...groups.running, ...groups.queued].map((task) => task.uuid)), [groups])
  const cancel = onCancel
  const refresh = onRefresh

  const control = station.control
  return (
    <section className={styles.panel} data-device-management="scheduler" aria-label="调度">
      <header className={styles.head}>
        <div>
          <span className={styles.eyebrow}>SCHEDULER</span>
          <h2>调度</h2>
          <p>OS 调度器正在执行什么、排队的任务在等什么、哪些设备被占用。</p>
        </div>
        <div className={styles.headTools}>
          <small>{updatedAt ? `更新于 ${formatClock(updatedAt)}` : '读取中…'}</small>
          <button type="button" className={styles.button} onClick={refresh}>刷新</button>
        </div>
      </header>

      <StationStrip
        control={control}
        readError={station.readError}
        counts={[groups.running.length, groups.queued.length, groups.attention.length]}
      />
      {control?.mode === 'PAUSED' ? (
        <StationPausedCard
          control={control}
          readError={station.readError}
          confirmed={station.confirmed}
          pending={station.pending}
          commandError={station.commandError}
          onConfirmChange={station.setConfirmed}
          onCancelError={station.cancelError}
          onResume={station.resume}
        />
      ) : null}
      {readError ? <p className={styles.error} role="alert">{readError}</p> : null}
      {release ? (
        <ReleaseOccupancyCard
          state={release}
          onReasonChange={(reason) => onReleaseChange({ reason })}
          onConfirmChange={(confirmed) => onReleaseChange({ confirmed })}
          onSubmit={onSubmitRelease}
          onClose={onCloseRelease}
        />
      ) : null}

      <div className={styles.columns}>
        <div className={styles.column}>
          <TaskSection eyebrow="RUNNING" title="执行中" empty="没有正在执行的任务" count={groups.running.length}>
            {groups.running.map((task) => (
              <TaskRow
                key={task.uuid}
                task={task}
                title={titleOf(task.uuid) ?? ''}
                detail={`已运行 ${formatDuration(currentStep(task)?.startedAt ?? task.startedAt, now)}`}
                command={commands[task.uuid]}
                onCancel={() => void cancel(task)}
              />
            ))}
          </TaskSection>
          <TaskSection eyebrow="QUEUE" title="排队等待" empty="没有排队的任务" count={groups.queued.length}>
            {groups.queued.map((task, index) => (
              <TaskRow
                key={task.uuid}
                task={task}
                order={index + 1}
                title={titleOf(task.uuid) ?? ''}
                detail={`已等待 ${formatDuration(task.waitReason?.since ?? task.createdAt, now)} · ${
                  queueReason(task, control, titleOf)}`}
                command={commands[task.uuid]}
                onCancel={() => void cancel(task)}
              />
            ))}
          </TaskSection>
          <TaskSection eyebrow="ATTENTION" title="需处理" empty="没有需要处理的任务" count={groups.attention.length}>
            {groups.attention.map((task) => (
              <TaskRow
                key={task.uuid}
                task={task}
                title={titleOf(task.uuid) ?? ''}
                detail={attentionReason(task)}
                command={commands[task.uuid]}
                onCancel={control?.errors.some((error) => error.taskUuid === task.uuid && error.cancelable) ||
                  canCancelTask(task) ? () => void cancel(task) : undefined}
                onRelease={() => {
                  const step = task.steps.find((item) => item.uncertaintyReason) ?? currentStep(task)
                  onOpenRelease({
                    taskUuid: task.uuid,
                    jobUuid: step?.jobUuid ?? null,
                    holder: titleOf(task.uuid) ?? '',
                    device: names.device(step?.deviceKey ?? null)
                  })
                }}
              />
            ))}
          </TaskSection>
        </div>

        <div className={styles.column}>
          <DeviceLane
            catalog={catalog}
            statuses={statuses}
            snapshot={snapshot}
            names={names}
            titleOf={titleOf}
            now={now}
            activeTasks={activeTasks}
            onRelease={onOpenRelease}
          />
          <TaskSection eyebrow="RECENT" title="最近结束" empty="还没有结束的任务" count={groups.recent.length}>
            {groups.recent.map((task) => (
              <TaskRow
                key={task.uuid}
                task={task}
                title={titleOf(task.uuid) ?? ''}
                detail={`${formatClock(task.finishedAt)} 结束 · 用时 ${
                  formatDuration(task.startedAt ?? task.createdAt, Date.parse(task.finishedAt ?? '') || now)}`}
              />
            ))}
          </TaskSection>
        </div>
      </div>
    </section>
  )
}

/** 工站调度闸门与任务计数。 */
function StationStrip({
  control,
  readError,
  counts: [running, queued, attention]
}: {
  control: StationControl | null
  readError: string | null
  counts: [number, number, number]
}): React.JSX.Element {
  const [label, tone]: [string, SchedulerTone] = !control
    ? [readError ? '读不到工站状态' : '读取中', 'muted']
    : control.mode === 'PAUSED'
      ? ['工站调度已暂停', 'warning']
      : ['工站调度中', 'success']
  return (
    <section className={styles.station} aria-label="工站调度状态">
      <span className={`${styles.badge} ${styles[tone]}`}>{label}</span>
      <span className={styles.counts}>
        执行中 <strong>{running}</strong> · 排队 <strong>{queued}</strong> · 需处理 <strong>{attention}</strong>
      </span>
    </section>
  )
}

function TaskSection({
  eyebrow,
  title,
  empty,
  count,
  children
}: {
  eyebrow: string
  title: string
  empty: string
  count: number
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className={styles.section} aria-label={title}>
      <div className={styles.sectionHead}>
        <div>
          <span className={styles.eyebrow}>{eyebrow}</span>
          <h3>{title}</h3>
        </div>
        <small>{count}</small>
      </div>
      {count ? <ul className={styles.rows}>{children}</ul> : <p className={styles.empty}>{empty}</p>}
    </section>
  )
}

function TaskRow({
  task,
  title,
  detail,
  order,
  command,
  onCancel,
  onRelease
}: {
  task: SchedulerTask
  title: string
  detail: string
  order?: number
  command?: CommandPhase
  onCancel?: () => void
  onRelease?: () => void
}): React.JSX.Element {
  const status = taskStatusLabel(task)
  const phase = command?.phase
  const cancelable = onCancel && (canCancelTask(task) || task.controlStatus === 'error_waiting')
  return (
    <li className={styles.row} data-task-uuid={task.uuid} data-task-status={task.status}>
      {order ? <span className={styles.order}>{order}</span> : null}
      <div className={styles.rowMain}>
        <div className={styles.rowTitle}>
          <span className={`${styles.badge} ${styles[status.tone]}`}>{status.label}</span>
          <strong title={title}>{title}</strong>
        </div>
        <span className={styles.rowDetail}>{detail}</span>
        <span className={styles.rowMeta}>任务 {shortId(task.uuid)}</span>
        {phase === 'sent' && task.status !== 'canceled' ? (
          <span className={styles.rowNote} role="status">已发送取消，等待设备停下…</span>
        ) : null}
        {command?.phase === 'error' ? (
          <span className={styles.rowError} role="alert">取消失败：{command.message}</span>
        ) : null}
      </div>
      {cancelable && task.status !== 'canceling' ? (
        <button
          type="button"
          className={`${styles.button} ${phase === 'confirm' ? styles.danger : ''}`}
          disabled={phase === 'sending' || phase === 'sent'}
          onClick={onCancel}
        >
          {phase === 'confirm' ? '确认取消' : phase === 'sending' ? '发送中…' : phase === 'sent' ? '已发送' : '取消'}
        </button>
      ) : null}
      {onRelease ? (
        <button type="button" className={styles.button} onClick={onRelease}>核对后解除</button>
      ) : null}
    </li>
  )
}

/** 每台设备的状态和当前占用者。 */
function DeviceLane({
  catalog,
  statuses,
  snapshot,
  names,
  titleOf,
  now,
  activeTasks,
  onRelease
}: {
  catalog: DeviceCatalogItem[]
  statuses: Record<string, DeviceStatusProperties>
  snapshot: SchedulerSnapshot | null
  names: SchedulerNames
  titleOf: (taskUuid: string) => string | null
  now: number
  activeTasks: Set<string>
  onRelease: (target: ReleaseTarget) => void
}): React.JSX.Element {
  const holders = useMemo(() => {
    const byMaterial = new Map<string, {
      title: string
      state: ReturnType<typeof occupancyStateLabel>
      since: string | null
      occupancy: SchedulerOccupancy
    }>()
    for (const occupancy of snapshot?.occupancies ?? []) {
      if (!occupancy.materialUuid) continue
      byMaterial.set(occupancy.materialUuid, {
        title: (occupancy.taskUuid && titleOf(occupancy.taskUuid)) ||
          `作业 ${shortId(occupancy.jobUuid ?? occupancy.taskUuid ?? '')}`,
        state: occupancyStateLabel(occupancy),
        since: occupancy.since,
        occupancy
      })
    }
    return byMaterial
  }, [snapshot, titleOf])
  // 结果不确定、或占用者已不在执行/排队中的占用，才提供“核对后解除”。
  const stuck = (occupancy: SchedulerOccupancy) => Boolean(occupancy.taskUuid) &&
    (occupancy.state === 'uncertain' || !activeTasks.has(occupancy.taskUuid ?? ''))
  const releaseTarget = (occupancy: SchedulerOccupancy, device: string, holder: string): ReleaseTarget => ({
    taskUuid: occupancy.taskUuid ?? '',
    jobUuid: occupancy.jobUuid,
    holder,
    device
  })
  const devices = [...catalog].sort((left, right) =>
    Number(holders.has(right.materialUuid)) - Number(holders.has(left.materialUuid)) ||
    left.label.localeCompare(right.label))
  const others = (snapshot?.occupancies ?? []).filter((occupancy) =>
    !occupancy.materialUuid || !catalog.some((device) => device.materialUuid === occupancy.materialUuid))
  return (
    <section className={styles.section} aria-label="设备占用">
      <div className={styles.sectionHead}>
        <div>
          <span className={styles.eyebrow}>DEVICES</span>
          <h3>设备占用</h3>
        </div>
        <small>{snapshot?.occupancies === null ? '占用接口不可用' : `${holders.size} 台被占用`}</small>
      </div>
      {devices.length ? (
        <ul className={styles.devices}>
          {devices.map((device) => {
            const holder = holders.get(device.materialUuid)
            const state = statuses[device.materialUuid]?.status
            return (
              <li key={device.materialUuid} className={holder ? styles.deviceBusy : styles.device}>
                <div className={styles.deviceHead}>
                  <strong title={device.deviceKey}>{device.label}</strong>
                  {state ? <span className={styles.deviceState}><DeviceStateBadge value={state} /></span> : null}
                </div>
                {holder ? (
                  <div className={styles.holderActions}>
                    <span className={styles.holder}>
                      <span className={`${styles.badge} ${styles[holder.state.tone]}`}>{holder.state.label}</span>
                      {holder.title} · {formatDuration(holder.since, now)}
                    </span>
                    {stuck(holder.occupancy) ? (
                      <button
                        type="button"
                        className={styles.button}
                        onClick={() => onRelease(releaseTarget(holder.occupancy, device.label, holder.title))}
                      >
                        核对后解除
                      </button>
                    ) : null}
                  </div>
                ) : <span className={styles.free}>空闲，未被占用</span>}
              </li>
            )
          })}
        </ul>
      ) : <p className={styles.empty}>正在读取设备目录…</p>}
      {others.length ? (
        <ul className={styles.rows}>
          {others.map((occupancy) => (
            <li key={`${occupancy.kind}:${occupancy.materialUuid}:${occupancy.jobUuid}`} className={styles.row}>
              <div className={styles.rowMain}>
                <div className={styles.rowTitle}>
                  <span className={`${styles.badge} ${styles[occupancyStateLabel(occupancy).tone]}`}>
                    {occupancyStateLabel(occupancy).label}
                  </span>
                  <strong>{names.deviceByMaterial(occupancy.materialUuid)}</strong>
                </div>
                <span className={styles.rowDetail}>
                  {(occupancy.taskUuid && titleOf(occupancy.taskUuid)) || `作业 ${shortId(occupancy.jobUuid ?? '')}`}
                </span>
              </div>
              {stuck(occupancy) ? (
                <button
                  type="button"
                  className={styles.button}
                  onClick={() => onRelease(releaseTarget(
                    occupancy,
                    names.deviceByMaterial(occupancy.materialUuid),
                    (occupancy.taskUuid && titleOf(occupancy.taskUuid)) || `作业 ${shortId(occupancy.jobUuid ?? '')}`
                  ))}
                >
                  核对后解除
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record }
  delete next[key]
  return next
}

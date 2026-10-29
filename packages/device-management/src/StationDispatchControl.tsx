import { useCallback, useEffect, useState } from 'react'
import type { Services, StationControl, StationError } from '@unilab/services'

import styles from './StationDispatchControl.module.scss'

/** 工站闸门轮询周期；暂停只在节点失败时出现，3 秒足够及时。 */
export const STATION_CONTROL_POLL_MS = 3000

/**
 * 判断当前能否恢复工站调度，与 OS 的恢复门禁保持一致。
 *
 * @param control 最近一次读到的工站状态。
 * @returns 是否可恢复与给用户的当前事实说明。
 */
export function stationResumeAvailability(control: StationControl): {
  available: boolean
  reason: string
} {
  if (control.mode !== 'PAUSED') return { available: false, reason: '工站正在调度。' }
  if (control.activeSessionId) {
    return { available: false, reason: '有人工处置会话尚未结束，请先在新前端完成该会话。' }
  }
  if (control.errors.length > 0) {
    return {
      available: false,
      reason: `还有 ${control.errors.length} 个节点错误未处理，先取消出错的任务再恢复调度。`
    }
  }
  if (control.pendingCommands > 0) {
    return { available: false, reason: '还有已受理未应用的控制命令，稍后刷新再试。' }
  }
  return { available: true, reason: '出错任务已处理。核对现场后恢复，OS 才会继续派发排队的任务。' }
}

/** 把 OS 的 409 原因码翻译成可行动的提示。 */
export function stationCommandErrorMessage(error: unknown, verb: string): string {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('station_version_conflict') || message.includes('decision_conflict')) {
    return '工站状态刚刚变化，请重新核对后再操作。'
  }
  if (message.includes('active_session_conflict')) return '有人工处置会话尚未结束，暂不能操作。'
  if (message.includes('operator_confirmation_required')) return '请先勾选现场核对确认。'
  return `${verb}失败：${message}`
}

/**
 * 工站调度暂停时的提示、出错任务取消与恢复入口；工站正常调度时不渲染。
 *
 * 自带轮询状态，避免工站状态变化导致整个设备页重渲染。
 *
 * @param props.services 服务组合。
 * @param props.active 设备页可见且已连接时为 true。
 * @safety 只有勾选现场核对后才发送恢复请求；每个命令都绑定用户看到的版本。
 */
export function StationDispatchControl({
  services,
  active
}: {
  services: Services
  active: boolean
}): React.JSX.Element | null {
  const [control, setControl] = useState<StationControl | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [pending, setPending] = useState(false)
  const [commandError, setCommandError] = useState<string | null>(null)

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await services.laboratory.getStationControl(signal)
      if (signal?.aborted) return
      setControl(next)
      setReadError(null)
    } catch (error) {
      if (signal?.aborted) return
      setReadError(error instanceof Error ? error.message : '读取工站调度状态失败')
    }
  }, [services.laboratory])

  useEffect(() => {
    setControl(null)
    if (!active) return
    const controller = new AbortController()
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined
    const poll = async (): Promise<void> => {
      if (typeof document === 'undefined' || !document.hidden) await load(controller.signal)
      if (!controller.signal.aborted) timer = globalThis.setTimeout(() => void poll(), STATION_CONTROL_POLL_MS)
    }
    void poll()
    return () => {
      controller.abort()
      globalThis.clearTimeout(timer)
    }
  }, [active, load])

  // 快照变化后旧确认作废，必须重新核对。
  const snapshotId = control?.snapshotId
  useEffect(() => {
    setConfirmed(false)
  }, [snapshotId])

  const run = async (verb: string, command: () => Promise<void>): Promise<void> => {
    setPending(true)
    setCommandError(null)
    try {
      await command()
    } catch (error) {
      setCommandError(stationCommandErrorMessage(error, verb))
    } finally {
      setPending(false)
      await load()
    }
  }

  if (!active || !control || control.mode !== 'PAUSED') return null
  return (
    <StationPausedCard
      control={control}
      readError={readError}
      confirmed={confirmed}
      pending={pending}
      commandError={commandError}
      onConfirmChange={setConfirmed}
      onCancelError={(item) => void run('取消任务', () =>
        services.laboratory.cancelStationErrorTask(control, item))}
      onResume={() => void run('恢复', () => services.laboratory.resumeStation(control))}
    />
  )
}

/** 暂停卡片的纯展示部分，便于静态渲染测试。 */
export function StationPausedCard({
  control,
  readError,
  confirmed,
  pending,
  commandError,
  onConfirmChange,
  onCancelError,
  onResume
}: {
  control: StationControl
  readError: string | null
  confirmed: boolean
  pending: boolean
  commandError: string | null
  onConfirmChange: (value: boolean) => void
  onCancelError: (error: StationError) => void
  onResume: () => void
}): React.JSX.Element {
  const state = stationResumeAvailability(control)
  return (
    <section className={styles.card} role="alert" aria-label="工站调度">
      <strong className={styles.title}>工站调度已暂停</strong>
      <p className={styles.detail}>
        有任务执行失败后 OS 会暂停整站调度，新提交的任务会一直等待执行。{state.reason}
      </p>
      {control.errors.length > 0 ? (
        <ul className={styles.errors}>
          {control.errors.map((item) => (
            <li key={item.decisionId}>
              <span>{item.message || '节点执行失败'}</span>
              {item.cancelable ? (
                <button
                  type="button"
                  className={styles.secondary}
                  disabled={pending}
                  onClick={() => onCancelError(item)}
                >
                  取消出错任务
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {readError ? <p className={styles.error}>{readError}</p> : null}
      {state.available ? (
        <>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={confirmed}
              disabled={pending}
              onChange={(event) => onConfirmChange(event.currentTarget.checked)}
            />
            <span>我已核对现场，确认可以恢复工站调度</span>
          </label>
          <button
            type="button"
            className={styles.button}
            disabled={!confirmed || pending}
            onClick={onResume}
          >
            {pending ? '正在恢复…' : '恢复工站调度'}
          </button>
        </>
      ) : null}
      {commandError ? <p className={styles.error} role="status">{commandError}</p> : null}
    </section>
  )
}

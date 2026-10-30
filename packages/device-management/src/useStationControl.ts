import { useCallback, useEffect, useState } from 'react'
import type { Services, StationControl, StationError } from '@unilab/services'

/** 工站闸门轮询周期；暂停只在节点失败时出现，3 秒足够及时。 */
export const STATION_CONTROL_POLL_MS = 3000

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

export interface StationControlState {
  control: StationControl | null
  readError: string | null
  /** 恢复前的现场核对勾选；工站快照变化后自动作废。 */
  confirmed: boolean
  setConfirmed: (value: boolean) => void
  pending: boolean
  commandError: string | null
  reload: () => Promise<void>
  resume: () => void
  cancelError: (error: StationError) => void
}

/**
 * 轮询工站调度闸门，并提供恢复调度、取消出错任务两个命令；设备页与调度面板共用。
 *
 * @param services 服务组合。
 * @param active 面板可见且已连接时为 true；不可见时停止轮询并清空。
 * @returns 最近一次读到的工站状态、命令进度与命令函数。
 * @safety 每个命令都绑定用户看到的工站版本；恢复前须勾选现场核对。
 */
export function useStationControl(services: Services, active: boolean): StationControlState {
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

  const run = useCallback(async (verb: string, command: () => Promise<void>): Promise<void> => {
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
  }, [load])

  return {
    control,
    readError,
    confirmed,
    setConfirmed,
    pending,
    commandError,
    reload: () => load(),
    resume: () => {
      if (control) void run('恢复', () => services.laboratory.resumeStation(control))
    },
    cancelError: (error) => {
      if (control) void run('取消任务', () => services.laboratory.cancelStationErrorTask(control, error))
    }
  }
}

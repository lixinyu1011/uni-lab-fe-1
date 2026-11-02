import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import type { DeviceStatusProperties, Services } from '@unilab/services'

import { keepIfEqual } from './stableState'

/** 状态监控轮询周期，与设备驱动 @topic_config 的默认 2 秒发布周期一致。 */
export const DEVICE_STATUS_POLL_MS = 2000

export interface DeviceStatusSnapshot {
  /** 当前设备最近上报的状态属性；null 表示尚未读到。 */
  properties: DeviceStatusProperties | null
  /** 状态属性最近一次变化的时间；轮询读到同样的值不更新，界面也不重绘。 */
  updatedAt: number | null
  error: string | null
}

const EMPTY_SNAPSHOT: DeviceStatusSnapshot = { properties: null, updatedAt: null, error: null }

/**
 * 轮询选中设备最近一次由 Edge 上报的状态属性。
 *
 * @param props 服务组合、选中设备物料 UUID 与是否允许轮询。
 * @returns 最近一次读到的状态、读取时间与错误；切换设备或停止轮询时清空。
 */
export function useDeviceStatus({
  services,
  deviceId,
  active
}: {
  services: Services
  deviceId: string | null
  active: boolean
}): DeviceStatusSnapshot {
  const [snapshot, setSnapshot] = useState<DeviceStatusSnapshot>(EMPTY_SNAPSHOT)

  useEffect(() => {
    setSnapshot(EMPTY_SNAPSHOT)
    if (!active || !deviceId) return
    return pollDeviceStatus({
      load: (signal) => services.laboratory.getDeviceStatuses(signal),
      deviceId,
      onChange: setSnapshot
    })
  }, [active, deviceId, services.laboratory])

  return snapshot
}

/**
 * 立即读取一次设备状态，之后每次读取结束再等一个周期，避免请求堆积。
 * 读到的属性和上一次相同时保留原快照对象，订阅它的组件不会重新渲染。
 *
 * @param props 读取函数、设备物料 UUID、快照回调和轮询周期。
 * @returns 停止函数：取消进行中的请求并清除下一次定时。
 * @safety 只调用只读的状态读取；读取失败保留上一次的值并给出错误。
 */
export function pollDeviceStatus({
  load,
  deviceId,
  onChange,
  interval = DEVICE_STATUS_POLL_MS
}: {
  load: (signal: AbortSignal) => Promise<Record<string, DeviceStatusProperties>>
  deviceId: string
  onChange: Dispatch<SetStateAction<DeviceStatusSnapshot>>
  interval?: number
}): () => void {
  const controller = new AbortController()
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined
  const poll = async (): Promise<void> => {
    try {
      const statuses = await load(controller.signal)
      if (controller.signal.aborted) return
      const properties = statuses[deviceId] ?? {}
      onChange((previous) =>
        previous.error === null && previous.properties !== null &&
        keepIfEqual(previous.properties, properties) === previous.properties
          ? previous
          : { properties, updatedAt: Date.now(), error: null })
    } catch (err) {
      if (controller.signal.aborted) return
      const error = err instanceof Error ? err.message : '读取设备状态失败'
      onChange((previous) => previous.error === error ? previous : { ...previous, error })
    }
    timer = globalThis.setTimeout(() => void poll(), interval)
  }
  void poll()
  return () => {
    controller.abort()
    globalThis.clearTimeout(timer)
  }
}

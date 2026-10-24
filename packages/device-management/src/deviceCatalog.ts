import type {
  DeviceEdgeStatus,
  DeviceExecutionOccupancy,
  OnlineDevice
} from '@unilab/services'

const deviceNameCollator = new Intl.Collator('zh-CN', {
  numeric: true,
  sensitivity: 'base'
})

export interface ManagedDevice extends OnlineDevice {
  edgeStatus: DeviceEdgeStatus
  dispatchable: boolean
  dispatchBlockReason: string | null
  executionOccupancies: DeviceExecutionOccupancy[] | null
  displayName: string
  displayDetail: string
}

/**
 * 把 Edge 目录转换为仪器设备菜单模型，排除宿主节点并按名称自然排序。
 *
 * @param edgeDevices Edge 实时返回的设备目录。
 * @returns 保留设备身份和在线状态，按中文拼音与数字顺序排列的设备列表。
 * @throws 不抛出异常。
 * @safety 只执行内存映射，不修改设备状态或发送动作。
 */
export function presentEdgeDevices(
  edgeDevices: readonly OnlineDevice[]
): ManagedDevice[] {
  return edgeDevices
    .filter((device) => (
      device.id !== 'host_node' &&
      device.deviceKey !== 'host_node' &&
      !device.deviceKey.endsWith('/host_node')
    ))
    .map((device) => {
      const edgeStatus = device.edgeStatus ?? (
        device.online ? 'online' : 'offline'
      )
      return {
        ...device,
        online: edgeStatus === 'online',
        edgeStatus,
        dispatchable: device.dispatchable ?? device.online,
        dispatchBlockReason: device.dispatchBlockReason ?? null,
        executionOccupancies: device.executionOccupancies ?? null,
        displayName: device.machineName,
        displayDetail: ''
      }
    })
    .sort((left, right) => (
      deviceNameCollator.compare(left.displayName, right.displayName) ||
      left.id.localeCompare(right.id)
    ))
}

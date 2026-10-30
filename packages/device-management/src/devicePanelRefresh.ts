interface VisibleDeviceActionTask {
  taskUuid: string
  actionRef: string
}

interface DevicePanelRefreshOperations {
  refreshDevices: () => Promise<unknown>
  refreshCatalog: () => Promise<unknown>
  /** 当前还在运行的动作任务；多台设备可以同时运行，所以是一组。 */
  activeTasks: readonly VisibleDeviceActionTask[]
  refreshTask: (taskUuid: string, actionRef: string) => Promise<unknown>
}

/**
 * 将设备面板的刷新语义收敛为目录、动作目录与运行中任务的一次权威补读。
 *
 * @param operations 可独立失败的目录与 Task 补读操作。
 * @returns 所有刷新操作结算后返回；单个来源失败不会阻断其他来源。
 */
export async function refreshDevicePanelState(
  operations: DevicePanelRefreshOperations
): Promise<void> {
  const refreshes: Promise<unknown>[] = [
    operations.refreshDevices(),
    operations.refreshCatalog()
  ]
  if (operations.activeTasks) {
    for (const task of operations.activeTasks) {
      refreshes.push(operations.refreshTask(task.taskUuid, task.actionRef))
    }
  }
  await Promise.allSettled(refreshes)
}

import { describe, expect, it, vi } from 'vitest'

import { refreshDevicePanelState } from './devicePanelRefresh'

describe('device panel refresh', () => {
  it('refreshes every running Task together with devices and catalog', async () => {
    const refreshDevices = vi.fn(async () => undefined)
    const refreshCatalog = vi.fn(async () => true)
    const refreshTask = vi.fn(async () => true)

    await refreshDevicePanelState({
      refreshDevices,
      refreshCatalog,
      activeTasks: [
        { taskUuid: 'task-1', actionRef: 'device.action' },
        { taskUuid: 'task-2', actionRef: 'other-device.action' }
      ],
      refreshTask
    })

    expect(refreshDevices).toHaveBeenCalledOnce()
    expect(refreshCatalog).toHaveBeenCalledOnce()
    expect(refreshTask.mock.calls).toEqual([
      ['task-1', 'device.action'],
      ['task-2', 'other-device.action']
    ])
  })

  it('refreshes catalog data without inventing a Task read', async () => {
    const refreshTask = vi.fn(async () => false)

    await refreshDevicePanelState({
      refreshDevices: async () => undefined,
      refreshCatalog: async () => true,
      activeTasks: [],
      refreshTask
    })

    expect(refreshTask).not.toHaveBeenCalled()
  })
})

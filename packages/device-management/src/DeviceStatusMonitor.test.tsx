import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DeviceStatusMonitor } from './DeviceStatusMonitor'
import { pollDeviceStatus, type DeviceStatusSnapshot } from './useDeviceStatus'

const updatedAt = new Date('2026-10-28T14:10:05').getTime()

function render(properties: Record<string, string> | null, error: string | null = null): string {
  return renderToStaticMarkup(
    <DeviceStatusMonitor snapshot={{ properties, updatedAt: properties ? updatedAt : null, error }} />
  )
}

describe('device status monitor', () => {
  it('shows plain values, site lists as tables and barcode grids', () => {
    const markup = render({
      status: 'Idle',
      fault: 'False',
      sites: JSON.stringify([{ site: 1, occupied: true, reserved: false, type: 0, consistent: false }]),
      barcodes: JSON.stringify([['A1', ''], ['B1', 'B2']])
    })

    expect(markup).toContain('状态监控')
    expect(markup).toContain('更新于')
    expect(markup).toContain('<dt>status</dt><dd><code>Idle</code></dd>')
    expect(markup).toContain('<th>site</th><th>occupied</th><th>reserved</th><th>type</th><th>consistent</th>')
    expect(markup).toContain('<td>1</td><td>true</td><td>false</td><td>0</td><td>false</td>')
    expect(markup).toContain('<th>2</th><td>B1</td><td>B2</td>')
    expect(markup).toContain('<td>—</td>')  // 空条码
  })

  it('renders grouped station sites as nested tables', () => {
    const markup = render({ sites: JSON.stringify({ 出入库: [{ site: 1, occupied: false }] }) })
    expect(markup).toContain('<dt>出入库</dt>')
    expect(markup).toContain('<th>site</th><th>occupied</th>')
  })

  it('distinguishes loading, no reported status and read errors', () => {
    expect(render(null)).toContain('读取中')
    expect(render({})).toContain('该设备尚未上报状态属性')
    expect(render({ status: 'Idle' }, '网络错误')).toContain('role="alert">网络错误')
  })
})

describe('device status polling', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('polls the selected device after each read finishes and stops cleanly', async () => {
    vi.useFakeTimers()
    const load = vi.fn(async () => ({ 'pump-1': { status: 'Idle' }, 'pump-2': { status: 'Running' } }))
    const snapshots: DeviceStatusSnapshot[] = []
    let current: DeviceStatusSnapshot = { properties: null, updatedAt: null, error: null }
    const onChange = (next: DeviceStatusSnapshot | ((previous: DeviceStatusSnapshot) => DeviceStatusSnapshot)) => {
      current = typeof next === 'function' ? next(current) : next
      snapshots.push(current)
    }

    const stop = pollDeviceStatus({ load, deviceId: 'pump-1', onChange, interval: 2000 })
    await vi.advanceTimersByTimeAsync(0)
    expect(load).toHaveBeenCalledTimes(1)
    expect(current.properties).toEqual({ status: 'Idle' })
    await vi.advanceTimersByTimeAsync(2000)
    expect(load).toHaveBeenCalledTimes(2)

    stop()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('keeps the last value and reports the error when a read fails', async () => {
    vi.useFakeTimers()
    const load = vi.fn()
      .mockResolvedValueOnce({ 'pump-1': { status: 'Idle' } })
      .mockRejectedValueOnce(new Error('Backend 不可达'))
    let current: DeviceStatusSnapshot = { properties: null, updatedAt: null, error: null }
    const stop = pollDeviceStatus({
      load,
      deviceId: 'pump-1',
      onChange: (next) => {
        current = typeof next === 'function' ? next(current) : next
      },
      interval: 2000
    })
    await vi.advanceTimersByTimeAsync(2000)
    expect(current).toMatchObject({ properties: { status: 'Idle' }, error: 'Backend 不可达' })
    stop()
  })
})

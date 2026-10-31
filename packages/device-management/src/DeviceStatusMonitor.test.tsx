import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DeviceStatusMonitor, orderStatusEntries } from './DeviceStatusMonitor'
import {
  checkSiteDraft,
  reportedSiteDraft,
  siteWriteBusy,
  siteWriteDraft,
  siteWriteStatus,
  type SiteWriter
} from './siteWrite'
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
    expect(markup).toMatch(/<dt>status<\/dt><dd><span[^>]*data-device-state="Idle"[^>]*>空闲 Idle<\/span><\/dd>/)
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

  it('puts status on top, sites right below it, then the rest by name', () => {
    expect(orderStatusEntries({ temperature: '60', sites: '[]', heating: 'True', status: 'Running' })
      .map(([name]) => name)).toEqual(['status', 'sites', 'heating', 'temperature'])
    const markup = render({ barcodes: '[]', sites: '[]', status: 'Running' })
    expect(markup.indexOf('<dt>status</dt>')).toBeLessThan(markup.indexOf('<dt>sites</dt>'))
    expect(markup.indexOf('<dt>sites</dt>')).toBeLessThan(markup.indexOf('<dt>barcodes</dt>'))
  })

  it('labels the four device states and shows any other value as text', () => {
    expect(render({ status: 'Running' })).toContain('运行中 Running')
    expect(render({ status: 'Error' })).toContain('故障 Error')
    expect(render({ status: 'Offline' })).toContain('离线 Offline')
    expect(render({ status: 'Online' })).toContain('<code>Online</code>')
  })

  it('distinguishes loading, no reported status and read errors', () => {
    expect(render(null)).toContain('读取中')
    expect(render({})).toContain('该设备尚未上报状态属性')
    expect(render({ status: 'Idle' }, '网络错误')).toContain('role="alert">网络错误')
  })
})

describe('editable sites table (device with write_site)', () => {
  const sites = JSON.stringify([
    { site: 1, occupied: true, reserved: false, type: 0, consistent: false },
    { site: 2, occupied: false, reserved: false, type: 0, consistent: true }
  ])
  const writer = (overrides: Partial<SiteWriter> = {}): SiteWriter => ({
    write: () => undefined,
    state: null,
    disabledReason: null,
    ...overrides
  })
  const renderWith = (siteWriter?: SiteWriter): string => renderToStaticMarkup(
    <DeviceStatusMonitor snapshot={{ properties: { sites }, updatedAt, error: null }} siteWriter={siteWriter} />
  )

  it('turns reserved and type into inputs with a write button per site', () => {
    const markup = renderWith(writer())
    expect(markup).toContain('data-device-management="site-editor"')
    expect(markup).toContain('<th>reserved</th><th>type</th><th>consistent</th><th>写入</th>')
    expect(markup).toMatch(/<input type="checkbox" aria-label="库位 1 reserved"(?![^>]*checked)[^>]*\/>/)
    expect(markup).toMatch(/<input type="number" aria-label="库位 1 type"[^>]*value="0"[^>]*\/>/)
    // 没改过的行不能写
    expect(markup.match(/<button type="button" disabled=""[^>]*>写入<\/button>/g)).toHaveLength(2)
    expect(markup).toContain('reserved 和 occupied 一致，机器人才会取放这个库位')
  })

  it('stays a read-only table without a write action', () => {
    const markup = renderWith(undefined)
    expect(markup).not.toContain('site-editor')
    expect(markup).toContain('<td>1</td><td>true</td><td>false</td><td>0</td><td>false</td>')
  })

  it('explains why writing is blocked and shows the device reply after writing', () => {
    expect(renderWith(writer({ disabledReason: '设备未连接，不能写入' }))).toContain('设备未连接，不能写入')
    const done = renderWith(writer({
      state: {
        kind: 'succeeded',
        message: '动作执行完成',
        taskUuid: '10000000-0000-4000-8000-000000000001',
        output: { return_value: { success: true, message: '四通道库位1：内部寄存状态=True，类型=51，占位传感器=有料；一致' } }
      }
    }))
    expect(done).toContain('四通道库位1：内部寄存状态=True，类型=51，占位传感器=有料；一致')
  })
})

describe('site write helpers', () => {
  it('builds the write_site draft the action form would send', () => {
    expect(siteWriteDraft(3, true, 51)).toEqual({ site: '3', reserved: true, site_type: '51' })
  })

  it('marks edited rows and validates the type range', () => {
    const reported = reportedSiteDraft({ site: 1, reserved: false, type: 0 })
    expect(reported).toEqual({ reserved: false, type: '0' })
    expect(checkSiteDraft(reported, reported)).toEqual({ changed: false, type: 0 })
    expect(checkSiteDraft({ reserved: true, type: '51' }, reported)).toEqual({ changed: true, type: 51 })
    expect(checkSiteDraft({ reserved: false, type: '40000' }, reported).type).toBeNull()
    expect(checkSiteDraft({ reserved: false, type: '1.5' }, reported).type).toBeNull()
    expect(checkSiteDraft({ reserved: false, type: '' }, reported)).toEqual({ changed: true, type: null })
  })

  it('reports progress, the device reply and the driver error line', () => {
    const taskUuid = '10000000-0000-4000-8000-000000000001'
    expect(siteWriteBusy({ kind: 'running', message: '', taskUuid })).toBe(true)
    expect(siteWriteBusy({ kind: 'succeeded', message: '', taskUuid })).toBe(false)
    expect(siteWriteStatus({ kind: 'running', message: '', taskUuid })).toBe('正在写入 PLC…')
    expect(siteWriteStatus({
      kind: 'failed',
      message: '动作执行失败',
      taskUuid,
      error: [{
        message: 'Traceback (most recent call last):\n  File "x.py", line 1\n' +
          'station_organic.devices.plc_opcua.PlcError: 四通道 写库位寄存与类型：机器人运行中，等它停下再写库位寄存\n'
      }]
    })).toBe('写入失败：四通道 写库位寄存与类型：机器人运行中，等它停下再写库位寄存')
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

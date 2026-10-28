import { deviceClass } from './deviceStyles'
import { formatTime } from './DevicePanelPresentation'
import type { DeviceStatusSnapshot } from './useDeviceStatus'

/**
 * 展示选中设备最近一次由 Edge 上报的状态属性。
 *
 * @param props 状态快照；属性值是发布文本，JSON 数组/对象按表格展示。
 * @returns 带更新时间、错误提示和属性列表的状态监控区域。
 */
export function DeviceStatusMonitor({
  snapshot
}: {
  snapshot: DeviceStatusSnapshot
}): React.JSX.Element {
  const entries = Object.entries(snapshot.properties ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
  return (
    <section
      className={deviceClass('edge-device__status-monitor')}
      aria-label="状态监控"
      data-device-management="status-monitor"
    >
      <div className={deviceClass('edge-device__section-heading')}>
        <div>
          <span>状态监控</span>
          <h3>Edge 上报的设备状态</h3>
        </div>
        <small>
          {snapshot.updatedAt ? `更新于 ${formatTime(snapshot.updatedAt)}` : '读取中…'}
        </small>
      </div>
      {snapshot.error ? (
        <p className={deviceClass('edge-device__status-error')} role="alert">
          {snapshot.error}
        </p>
      ) : null}
      {entries.length ? (
        <dl className={deviceClass('edge-device__status-list')}>
          {entries.map(([name, value]) => (
            <div key={name}>
              <dt>{name}</dt>
              <dd><StatusValue value={parseStatusValue(value)} /></dd>
            </div>
          ))}
        </dl>
      ) : snapshot.properties ? (
        <div className={deviceClass('edge-device__no-actions')}>
          该设备尚未上报状态属性。
        </div>
      ) : null}
    </section>
  )
}

/** 递归展示状态值：对象数组为表格，二维数组为网格，对象为键值列表，其余为文本。 */
function StatusValue({ value }: { value: unknown }): React.JSX.Element {
  if (Array.isArray(value) && value.length && value.every(isPlainObject)) {
    const columns = [...new Set(value.flatMap((row) => Object.keys(row)))]
    return (
      <table className={deviceClass('edge-device__status-table')}>
        <thead>
          <tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr>
        </thead>
        <tbody>
          {value.map((row, index) => (
            <tr key={index}>
              {columns.map((column) => <td key={column}>{formatCell(row[column])}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    )
  }
  if (Array.isArray(value) && value.length && value.every(Array.isArray)) {
    return (
      <table className={deviceClass('edge-device__status-table')}>
        <tbody>
          {value.map((row: unknown[], index) => (
            <tr key={index}>
              <th>{index + 1}</th>
              {row.map((cell, column) => <td key={column}>{formatCell(cell)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    )
  }
  if (isPlainObject(value)) {
    return (
      <dl className={deviceClass('edge-device__status-list')}>
        {Object.entries(value).map(([name, item]) => (
          <div key={name}>
            <dt>{name}</dt>
            <dd><StatusValue value={item} /></dd>
          </div>
        ))}
      </dl>
    )
  }
  return <code>{formatCell(value)}</code>
}

/** 发布值以 `[` 或 `{` 开头时按 JSON 解析，失败或其他文本原样返回。 */
function parseStatusValue(value: string): unknown {
  if (!/^\s*[[{]/.test(value)) return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

function formatCell(value: unknown): string {
  if (value == null || value === '') return '—'
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

import { deviceClass } from './deviceStyles'
import { formatTime } from './DevicePanelPresentation'
import type { DeviceStatusSnapshot } from './useDeviceStatus'

/** 设备 status 只有四种取值：按中文标签和颜色显示，其他取值原样显示。 */
const STATUS_BADGES: Readonly<Record<string, { label: string; tone: string }>> = {
  Idle: { label: '空闲', tone: 'is-online' },
  Running: { label: '运行中', tone: 'is-running' },
  Error: { label: '故障', tone: 'is-blocked' },
  Offline: { label: '离线', tone: 'is-offline' }
}

/** 展示顺序：status 在最上面，sites 紧跟其后，其余属性按名称排序。 */
const PINNED_PROPERTIES = ['status', 'sites']

/**
 * 按展示顺序排列状态属性。
 *
 * @param properties 设备上报的属性名到发布值。
 * @returns status、sites 在前，其余按名称排序的属性列表。
 */
export function orderStatusEntries(properties: Record<string, string>): [string, string][] {
  const rank = (name: string): number => {
    const index = PINNED_PROPERTIES.indexOf(name)
    return index === -1 ? PINNED_PROPERTIES.length : index
  }
  return Object.entries(properties)
    .sort(([left], [right]) => rank(left) - rank(right) || left.localeCompare(right))
}

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
  const entries = orderStatusEntries(snapshot.properties ?? {})
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
              <dd>
                {name === 'status'
                  ? <DeviceStateBadge value={value} />
                  : <StatusValue value={parseStatusValue(value)} />}
              </dd>
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

/** 设备状态标签：空闲、运行中、故障、离线，附原始取值；调度面板的设备列也用它。 */
export function DeviceStateBadge({ value }: { value: string }): React.JSX.Element {
  const badge = STATUS_BADGES[value]
  if (!badge) return <code>{formatCell(value)}</code>
  return (
    <span
      className={deviceClass('edge-device__status-badge', badge.tone)}
      data-device-state={value}
    >
      {badge.label} {value}
    </span>
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

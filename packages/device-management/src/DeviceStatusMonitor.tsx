import { useEffect, useState } from 'react'

import { deviceClass } from './deviceStyles'
import { formatTime } from './DevicePanelPresentation'
import {
  checkSiteDraft,
  reportedSiteDraft,
  siteWriteBusy,
  siteWriteStatus,
  type SiteDraft,
  type SiteWriter
} from './siteWrite'
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
 *   siteWriter 存在时（设备有 write_site 动作），sites 表的 reserved、type 可以改并写入 PLC。
 * @returns 带更新时间、错误提示和属性列表的状态监控区域。
 */
export function DeviceStatusMonitor({
  snapshot,
  siteWriter
}: {
  snapshot: DeviceStatusSnapshot
  siteWriter?: SiteWriter
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
                  : name === 'sites' && siteWriter && isSiteList(parseStatusValue(value))
                    ? <SiteEditor published={value} writer={siteWriter} />
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

/** sites 是带 site 编号的对象数组时才能逐行编辑。 */
function isSiteList(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.length > 0 &&
    value.every((row) => isPlainObject(row) && Number.isInteger(row.site))
}

/**
 * 可编辑的库位表：reserved 用勾选框、type 用数字框，改过的行点“写入”交给设备的 write_site 动作。
 *
 * @param props published 是 sites 的发布文本；writer 提交写入并给出最近一次写入的状态。
 * @returns 库位表和下方的一句写入状态。
 */
function SiteEditor({
  published,
  writer
}: {
  published: string
  writer: SiteWriter
}): React.JSX.Element {
  const rows = parseStatusValue(published) as Record<string, unknown>[]
  // 只保存改过、还没写进 PLC 的行；没改的行跟着上报值走。
  const [drafts, setDrafts] = useState<Readonly<Record<number, SiteDraft>>>({})
  useEffect(() => {
    // 上报值已经等于编辑值（写入成功），就不再保留这一行的编辑值。
    setDrafts((current) => {
      const done = (parseStatusValue(published) as Record<string, unknown>[]).filter((row) => {
        const draft = current[Number(row.site)]
        return draft && !checkSiteDraft(draft, reportedSiteDraft(row)).changed
      })
      if (done.length === 0) return current
      const next = { ...current }
      for (const row of done) delete next[Number(row.site)]
      return next
    })
  }, [published])
  const busy = siteWriteBusy(writer.state)
  const edit = (site: number, reported: SiteDraft, next: SiteDraft): void => {
    setDrafts((current) => {
      const rest = { ...current }
      delete rest[site]
      return checkSiteDraft(next, reported).changed ? { ...rest, [site]: next } : rest
    })
  }
  return (
    <div data-device-management="site-editor">
      <table className={deviceClass('edge-device__status-table', 'edge-device__site-editor')}>
        <thead>
          <tr>
            <th>site</th>
            <th>occupied</th>
            <th>reserved</th>
            <th>type</th>
            <th>consistent</th>
            <th>写入</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const site = Number(row.site)
            const reported = reportedSiteDraft(row)
            const draft = drafts[site] ?? reported
            const { changed, type } = checkSiteDraft(draft, reported)
            const blocked = writer.disabledReason
            return (
              <tr key={site} data-site-edited={changed || undefined}>
                <td>{formatCell(row.site)}</td>
                <td>{formatCell(row.occupied)}</td>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`库位 ${site} reserved`}
                    checked={draft.reserved}
                    disabled={busy}
                    onChange={(event) => edit(site, reported, { ...draft, reserved: event.target.checked })}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    aria-label={`库位 ${site} type`}
                    min={0}
                    max={32767}
                    step={1}
                    value={draft.type}
                    disabled={busy}
                    onChange={(event) => edit(site, reported, { ...draft, type: event.target.value })}
                  />
                </td>
                <td>{formatCell(row.consistent)}</td>
                <td>
                  <button
                    type="button"
                    disabled={!changed || type === null || busy || blocked !== null}
                    title={blocked ?? (changed && type === null ? 'type 须是 0..32767 的整数' : undefined)}
                    onClick={() => {
                      if (type !== null) writer.write(site, draft.reserved, type)
                    }}
                  >
                    写入
                  </button>
                  {changed ? <small>上报 {String(reported.reserved)} / {reported.type}</small> : null}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <p className={deviceClass('edge-device__site-editor-status')} role="status">
        {writer.disabledReason ?? siteWriteStatus(writer.state)}
      </p>
    </div>
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

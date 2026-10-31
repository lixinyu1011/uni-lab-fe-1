import type { DeviceActionRunState } from './DeviceActionAvailability'

/**
 * 设备包约定的动作名：设备有这个动作时，状态监控的 sites 表可以直接改 reserved、type 并写入 PLC。
 * 参数为 site（库位）、reserved（内部寄存状态）、site_type（类型）。
 */
export const SITE_WRITE_ACTION = 'write_site'

/** 状态监控 sites 表的写入入口，由设备页按 write_site 动作提供。 */
export interface SiteWriter {
  /** 提交一次写入：库位、内部寄存状态、类型。 */
  write: (site: number, reserved: boolean, type: number) => void
  /** 最近一次写入的运行状态；还没写过为 null。 */
  state: DeviceActionRunState | null
  /** 现在不能写的原因；能写为 null。 */
  disabledReason: string | null
}

/** 一行库位正在编辑的值；type 保留输入框里的文本，便于提示不合法的输入。 */
export interface SiteDraft {
  reserved: boolean
  type: string
}

/** 上报值对应的编辑初值。 */
export function reportedSiteDraft(row: Record<string, unknown>): SiteDraft {
  return { reserved: row.reserved === true, type: String(row.type ?? 0) }
}

/**
 * 比较编辑值和上报值，并校验类型。
 *
 * @returns changed 表示和上报值不同；type 为 0..32767 的整数，不合法时为 null。
 */
export function checkSiteDraft(
  draft: SiteDraft,
  reported: SiteDraft
): { changed: boolean; type: number | null } {
  const text = draft.type.trim()
  const type = Number(text)
  return {
    changed: draft.reserved !== reported.reserved || text !== reported.type,
    type: text !== '' && Number.isInteger(type) && type >= 0 && type <= 32767 ? type : null
  }
}

/** write_site 的参数草稿：整数用字符串，和动作参数表单的草稿格式一致。 */
export function siteWriteDraft(
  site: number,
  reserved: boolean,
  type: number
): Record<string, string | boolean> {
  return { site: String(site), reserved, site_type: String(type) }
}

/** 写入任务还没结束。 */
export function siteWriteBusy(state: DeviceActionRunState | null): boolean {
  return state !== null &&
    ['submitting', 'accepted', 'running', 'finishing'].includes(state.kind)
}

/** 表格下方的一句话：提示、进行中、设备返回的结果或失败原因。 */
export function siteWriteStatus(state: DeviceActionRunState | null): string {
  if (state === null) {
    return '改 reserved、type 后点“写入”；reserved 和 occupied 一致，机器人才会取放这个库位。'
  }
  switch (state.kind) {
    case 'submitting':
      return '正在提交写入…'
    case 'accepted':
    case 'running':
    case 'finishing':
      return '正在写入 PLC…'
    case 'succeeded': {
      const returned = state.output?.return_value
      const message = returned && typeof returned === 'object'
        ? (returned as Record<string, unknown>).message
        : null
      return typeof message === 'string' && message ? message : '写入完成'
    }
    case 'failed':
      return `写入失败：${lastErrorLine(state.error) ?? state.message}`
    case 'canceled':
      return '写入已取消'
    case 'error':
    case 'unavailable':
      return `写入失败：${state.message}`
    default:
      return state.message
  }
}

/** 取驱动报错的最后一行（Python 异常的那句话），去掉异常类名前缀。 */
function lastErrorLine(errors: unknown[] | undefined): string | null {
  const first = errors?.[0]
  const text = typeof first === 'string'
    ? first
    : first && typeof first === 'object'
      ? (first as Record<string, unknown>).message
      : null
  if (typeof text !== 'string') return null
  const line = text.split('\n').map((item) => item.trim()).filter(Boolean).pop()
  return line ? line.replace(/^[A-Za-z_][\w.]*: /u, '') : null
}

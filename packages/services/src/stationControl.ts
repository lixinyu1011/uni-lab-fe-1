import { ServiceError } from './errors'
import { requestData, type HttpClient } from './http'

/** 工站普通调度闸门：PAUSED 时 OS 不再派发新任务，需人工核对现场后恢复。 */
export interface StationControl {
  stationId: string
  mode: string
  stationVersion: number
  errorEpoch: number
  snapshotId: string
  activeSessionId: string | null
  /** 尚未处理的节点错误（取消或重试对应任务后消失）。 */
  errors: StationError[]
  /** 已受理但尚未应用的控制命令数量。 */
  pendingCommands: number
}

export interface StationError {
  decisionId: string
  decisionVersion: number
  taskUuid: string | null
  message: string
  /** DECISION_REQUIRED 且不在人工处置会话中时，可直接取消出错任务。 */
  cancelable: boolean
}

/** 本地工作区只有一个工站，标识与 OS 默认值一致。 */
export const DEFAULT_STATION_ID = 'local'

function stationPath(stationId: string, suffix: string): string {
  return `/api/v1/stations/${encodeURIComponent(stationId)}/${suffix}`
}

/**
 * 读取工站调度闸门与待处理错误。
 *
 * @param http 已绑定当前 Backend 的 HTTP 客户端。
 * @param stationId 工站标识，本地工作区为 `local`。
 * @param signal 可选取消信号。
 * @returns 恢复调度所需的版本、错误轮次与快照标识。
 */
export async function loadStationControl(
  http: HttpClient,
  stationId = DEFAULT_STATION_ID,
  signal?: AbortSignal
): Promise<StationControl> {
  const raw = await requestData<Record<string, unknown>>(
    http,
    stationPath(stationId, 'error-handling'),
    { signal }
  )
  const stationVersion = raw.station_version
  const errorEpoch = raw.error_epoch
  if (
    typeof raw.mode !== 'string' ||
    typeof raw.snapshot_id !== 'string' ||
    !Number.isInteger(stationVersion) ||
    !Number.isInteger(errorEpoch)
  ) {
    throw new ServiceError({
      code: 'INVALID_STATION_CONTROL_RESPONSE',
      message: '工站调度状态响应无效',
      retryable: false
    })
  }
  return {
    stationId,
    mode: raw.mode,
    stationVersion: stationVersion as number,
    errorEpoch: errorEpoch as number,
    snapshotId: raw.snapshot_id,
    activeSessionId: typeof raw.active_session_id === 'string' && raw.active_session_id
      ? raw.active_session_id
      : null,
    errors: records(raw.errors).map((item) => ({
      decisionId: String(item.decision_id ?? ''),
      decisionVersion: Number.isInteger(item.decision_version) ? item.decision_version as number : 0,
      taskUuid: typeof item.source_task_uuid === 'string' ? item.source_task_uuid : null,
      message: String(asRecord(item.meta_data).message ?? ''),
      cancelable: item.stage === 'DECISION_REQUIRED' && !item.session_id &&
        Number.isInteger(item.decision_version)
    })),
    pendingCommands: records(raw.control_commands)
      .filter((item) => item.needs_apply === true).length
  }
}

/**
 * 按用户确认恢复工站普通调度；版本与快照必须是用户确认时看到的那一份。
 *
 * @param http 已绑定当前 Backend 的 HTTP 客户端。
 * @param control 用户确认时读到的工站状态。
 * @returns OS 受理后完成；版本过期、仍有处置会话等由 OS 以 409 拒绝。
 * @safety 只发送 operator_confirmed=true，调用方必须先让用户勾选现场核对。
 */
export async function resumeStationControl(
  http: HttpClient,
  control: StationControl
): Promise<void> {
  await requestData<unknown>(http, stationPath(control.stationId, 'resume'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': `workbench-resume:${control.snapshotId}:${Date.now()}`
    },
    body: JSON.stringify({
      expected_station_version: control.stationVersion,
      observed_error_epoch: control.errorEpoch,
      operator_confirmed: true,
      confirm_snapshot_id: control.snapshotId
    })
  })
}

/**
 * 对一个节点错误选择“取消任务”；OS 受理后立即停止并终结该任务，不恢复调度。
 *
 * @param http 已绑定当前 Backend 的 HTTP 客户端。
 * @param control 用户操作时读到的工站状态。
 * @param error 要处理的节点错误。
 * @returns OS 受理后完成；版本过期等由 OS 以 409 拒绝。
 */
export async function cancelStationErrorTask(
  http: HttpClient,
  control: StationControl,
  error: StationError
): Promise<void> {
  await requestData<unknown>(
    http,
    stationPath(control.stationId, `errors/${encodeURIComponent(error.decisionId)}/decision`),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': `workbench-cancel:${error.decisionId}:${error.decisionVersion}:${Date.now()}`
      },
      body: JSON.stringify({
        action: 'cancel_task',
        expected_station_version: control.stationVersion,
        expected_decision_version: error.decisionVersion,
        observed_error_epoch: control.errorEpoch,
        resume_requested: false,
        reason: 'workbench 设备页取消出错任务'
      })
    }
  )
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(asRecord) : []
}

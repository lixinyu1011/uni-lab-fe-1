import { ServiceError } from './errors'
import { requestData, type HttpClient } from './http'
import { DEFAULT_STATION_ID } from './stationControl'

/** 调度面板的一次快照：活动与近期任务、当前设备/物料占用。 */
export interface SchedulerSnapshot {
  tasks: SchedulerTask[]
  /** 当前未释放的执行占用；服务未提供该接口时为 null。 */
  occupancies: SchedulerOccupancy[] | null
}

export interface SchedulerTask {
  uuid: string
  /** workflow：工作流任务；ad_hoc_device_action：设备页单动作。 */
  kind: string
  workflowName: string | null
  /** pending / running / canceling / succeeded / failed / canceled / timeout */
  status: string
  /** active / paused / error_waiting / waiting_reconciliation …… */
  controlStatus: string
  /** none / settled / requires_attention …… */
  cleanupStatus: string
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  waitReason: SchedulerWaitReason | null
  steps: SchedulerStep[]
}

/** 执行计划里的一个节点及其当前作业。 */
export interface SchedulerStep {
  nodeUuid: string
  name: string | null
  /** 设备在组态图里的 id，如 organic_right_capper。 */
  deviceKey: string | null
  actionName: string | null
  jobUuid: string | null
  /** pending / dispatched / running / succeeded / failed / canceled …… 尚无作业时为 null。 */
  jobStatus: string | null
  startedAt: string | null
  uncertaintyReason: string | null
}

/** OS 记录的排队原因（执行资源被其他作业占用时）。 */
export interface SchedulerWaitReason {
  message: string
  /** 被占用的设备名称或 id。 */
  resources: string[]
  blockingTaskUuid: string | null
  since: string | null
}

/** 一条未释放的执行占用。 */
export interface SchedulerOccupancy {
  /** execution_lock：作业执行锁；device_tenancy：任务独占设备。 */
  kind: string
  /** reserved / running / uncertain / active */
  state: string
  scope: string
  /** 被占用设备（或物料）的物料 UUID。 */
  materialUuid: string | null
  taskUuid: string | null
  jobUuid: string | null
  since: string | null
}

/** 矩阵视图返回的近期已结束任务数。 */
export const SCHEDULER_RECENT_LIMIT = 10

/**
 * 读取调度快照：任务来自 OS 任务矩阵（活动、需关注与最近结束的任务），占用来自工站资源处置接口。
 *
 * @param http 已绑定当前 Backend 的 HTTP 客户端。
 * @param signal 可选取消信号。
 * @returns 解码后的调度快照；占用接口不可用时 occupancies 为 null，不影响任务。
 */
export async function loadSchedulerSnapshot(
  http: HttpClient,
  signal?: AbortSignal
): Promise<SchedulerSnapshot> {
  const [matrix, occupancies] = await Promise.all([
    requestData<Record<string, unknown>>(
      http,
      `/api/v1/workflow-task-presentations?view=matrix&terminal_limit=${SCHEDULER_RECENT_LIMIT}`,
      { signal }
    ),
    requestData<unknown>(
      http,
      `/api/v1/stations/${DEFAULT_STATION_ID}/resource-dispositions`,
      { signal }
    ).then(
      (raw) => records(raw).map(decodeOccupancy),
      (error: unknown) => {
        if (signal?.aborted) throw error
        return null
      }
    )
  ])
  if (!Array.isArray(matrix.items)) {
    throw new ServiceError({
      code: 'INVALID_SCHEDULER_RESPONSE',
      message: '任务矩阵响应无效',
      retryable: false
    })
  }
  return { tasks: records(matrix.items).map(decodeTask), occupancies }
}

function decodeTask(raw: Record<string, unknown>): SchedulerTask {
  const jobs = records(raw.jobs)
    .filter((job) => job.current_attempt !== false)
  const jobByNode = new Map(jobs.map((job) => [text(job.workflow_node_uuid), job]))
  const nodes = records(asRecord(raw.execution_plan).nodes)
    .filter((node) => node.disabled !== true)
    .sort((left, right) => Number(left.topological_index ?? 0) - Number(right.topological_index ?? 0))
  return {
    uuid: text(raw.uuid),
    kind: text(raw.execution_kind),
    workflowName: optionalText(asRecord(asRecord(raw.workflow_snapshot).workflow).name),
    status: text(raw.status),
    controlStatus: text(raw.control_status),
    cleanupStatus: text(raw.cleanup_status),
    createdAt: text(raw.create_time),
    startedAt: optionalText(raw.started_at),
    finishedAt: optionalText(raw.finished_at),
    waitReason: decodeWaitReason(raw.wait_reason),
    steps: nodes.map((node) => {
      const job = jobByNode.get(text(node.uuid))
      const executor = asRecord(asRecord(job?.control_data).actual_executor)
      return {
        nodeUuid: text(node.uuid),
        name: optionalText(node.name),
        deviceKey: optionalText(node.device_id) ?? optionalText(executor.local_device_id),
        actionName: optionalText(node.action_name),
        jobUuid: job ? optionalText(job.uuid) : null,
        jobStatus: job ? optionalText(job.status) : null,
        startedAt: job ? optionalText(job.started_at) : null,
        uncertaintyReason: job ? optionalText(job.uncertainty_reason) : null
      }
    })
  }
}

function decodeWaitReason(value: unknown): SchedulerWaitReason | null {
  const raw = asRecord(value)
  const message = optionalText(raw.message)
  if (!message) return null
  return {
    message,
    resources: records(raw.resources)
      .map((item) => optionalText(item.device_name) ?? optionalText(item.material_name) ??
        optionalText(item.site_name) ?? optionalText(item.local_device_id))
      .filter((item): item is string => item !== null),
    blockingTaskUuid: optionalText(raw.blocking_task_uuid),
    since: optionalText(raw.waiting_since)
  }
}

function decodeOccupancy(raw: Record<string, unknown>): SchedulerOccupancy {
  const lockKey = text(raw.lock_key)
  return {
    kind: text(raw.occupancy_kind),
    state: text(raw.state),
    scope: text(raw.scope) || (lockKey.startsWith('/devices/') ? 'device' : ''),
    materialUuid: optionalText(raw.material_uuid) ??
      (lockKey.startsWith('/devices/') ? lockKey.slice('/devices/'.length) || null : null),
    taskUuid: optionalText(raw.workflow_task_uuid),
    jobUuid: optionalText(raw.workflow_node_job_uuid) ?? optionalText(raw.acquired_by_job_uuid),
    since: optionalText(raw.acquired_at) ?? optionalText(raw.create_time)
  }
}

/** 任务当前的执行锁，以及 OS 判定的每把锁能否人工释放。 */
export interface TaskExecutionLocks {
  taskUuid: string
  taskStatus: string
  locks: TaskExecutionLock[]
  /** 任务独占设备的数量；有独占时执行锁不能单独释放。 */
  activeDeviceTenancyCount: number
}

export interface TaskExecutionLock {
  uuid: string
  jobUuid: string | null
  /** reserved / running / uncertain */
  state: string
  materialUuid: string | null
  claimUuid: string | null
  fencingToken: number | null
  jobStatus: string | null
  claimState: string | null
  canRelease: boolean
  releaseBlockReason: string | null
}

/**
 * 读取任务当前的执行锁与人工释放资格（GET /workflow-tasks/{task}/execution-locks）。
 *
 * @param http 已绑定当前 Backend 的 HTTP 客户端。
 * @param taskUuid 占用设备的任务。
 * @param signal 可选取消信号。
 */
export async function loadTaskExecutionLocks(
  http: HttpClient,
  taskUuid: string,
  signal?: AbortSignal
): Promise<TaskExecutionLocks> {
  const raw = await requestData<Record<string, unknown>>(
    http,
    `/api/v1/workflow-tasks/${encodeURIComponent(taskUuid)}/execution-locks`,
    { signal }
  )
  return {
    taskUuid,
    taskStatus: text(raw.task_status),
    locks: records(raw.locks).map((lock) => ({
      uuid: text(lock.uuid),
      jobUuid: optionalText(lock.workflow_node_job_uuid),
      state: text(lock.state),
      materialUuid: optionalText(lock.material_uuid),
      claimUuid: optionalText(lock.claim_uuid),
      fencingToken: Number.isInteger(lock.fencing_token) ? lock.fencing_token as number : null,
      jobStatus: optionalText(lock.job_status),
      claimState: optionalText(lock.claim_state),
      canRelease: lock.can_release === true,
      releaseBlockReason: optionalText(lock.release_block_reason)
    })),
    activeDeviceTenancyCount: Number.isInteger(raw.active_device_tenancy_count)
      ? raw.active_device_tenancy_count as number
      : 0
  }
}

/**
 * 人工释放一个已结束作业的全部执行锁（POST …/execution-locks/{lease}/force-release）。
 *
 * @param http 已绑定当前 Backend 的 HTTP 客户端。
 * @param taskUuid 锁所属任务。
 * @param lock 用户确认时看到的锁；Claim/Fence 不一致时 OS 拒绝并要求刷新。
 * @param reason 现场核对说明，写入 OS 审计。
 * @returns OS 结果：released 或 already_released。
 * @safety 只在用户确认“设备已停止、现场安全”后调用；OS 仍会校验任务和作业已结束、结果确定。
 */
export async function forceReleaseExecutionLock(
  http: HttpClient,
  taskUuid: string,
  lock: TaskExecutionLock,
  reason: string
): Promise<string> {
  if (!lock.claimUuid || lock.fencingToken === null) {
    throw new ServiceError({
      code: 'EXECUTION_LOCK_NOT_RELEASABLE',
      message: '执行锁缺少 Claim 或 Fence，不能人工释放',
      retryable: false
    })
  }
  const result = await requestData<Record<string, unknown>>(
    http,
    `/api/v1/workflow-tasks/${encodeURIComponent(taskUuid)}/execution-locks/${encodeURIComponent(lock.uuid)}/force-release`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expected_claim_uuid: lock.claimUuid,
        expected_fencing_token: lock.fencingToken,
        reason,
        physical_settlement_confirmed: true
      })
    }
  )
  return text(asRecord(result).status)
}

/**
 * 把结果不确定的作业按“已取消”结算（POST /workflow-node-jobs/{job}/resolve-uncertain）；
 * Edge 在设备命令账上确认后，作业结束、占用释放。
 *
 * @returns 是否还在等 Edge 确认。
 * @safety 只在用户确认设备已停止、本次动作没有继续执行后调用。
 */
export async function resolveUncertainJob(
  http: HttpClient,
  jobUuid: string,
  reason: string
): Promise<{ pendingEdgeConfirmation: boolean }> {
  const result = await requestData<Record<string, unknown>>(
    http,
    `/api/v1/workflow-node-jobs/${encodeURIComponent(jobUuid)}/resolve-uncertain`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resolution: 'canceled', reason })
    }
  )
  return { pendingEdgeConfirmation: asRecord(result).pending_edge_confirmation === true }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(asRecord) : []
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

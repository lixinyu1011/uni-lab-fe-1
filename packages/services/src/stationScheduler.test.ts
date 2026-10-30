import { describe, expect, it } from 'vitest'

import type { HttpClient } from './http'
import {
  forceReleaseExecutionLock,
  loadSchedulerSnapshot,
  loadTaskExecutionLocks,
  resolveUncertainJob
} from './stationScheduler'

/** 形状取自本地 OS 的 /workflow-task-presentations?view=matrix 实际响应。 */
const RUNNING_TASK = {
  uuid: 't-run',
  execution_kind: 'ad_hoc_device_action',
  status: 'running',
  control_status: 'active',
  cleanup_status: 'none',
  create_time: '2026-10-30T01:21:02Z',
  started_at: '2026-10-30T01:21:02Z',
  finished_at: null,
  wait_reason: {},
  workflow_snapshot: { workflow: { uuid: null, name: null, revision: null } },
  execution_plan: {
    nodes: [{ uuid: 'n-1', name: null, action_name: 'open_caps', device_id: 'organic_right_capper', topological_index: 0 }]
  },
  jobs: [{
    uuid: 'j-run', workflow_node_uuid: 'n-1', status: 'running', current_attempt: true,
    started_at: '2026-10-30T01:21:03Z', uncertainty_reason: null,
    control_data: { actual_executor: { local_device_id: 'organic_right_capper' } }
  }]
}

const QUEUED_TASK = {
  ...RUNNING_TASK,
  uuid: 't-wait',
  status: 'pending',
  started_at: null,
  wait_reason: {
    code: 'operation_lease',
    message: '执行资源正在被其他作业使用',
    resources: [{ local_device_id: 'organic_right_capper', device_name: '右开关盖机构' }],
    blocking_task_uuid: 't-run',
    waiting_since: '2026-10-30T01:22:00Z'
  },
  jobs: []
}

function fakeHttp(responses: Record<string, unknown>, calls: string[] = []): HttpClient {
  return {
    request: async <Value>(path: string) => {
      calls.push(path)
      const key = Object.keys(responses).find((prefix) => path.startsWith(prefix))
      const body = key === undefined ? undefined : responses[key]
      if (body instanceof Error) throw body
      return { code: 0, data: body } as Value
    }
  }
}

describe('station scheduler snapshot', () => {
  it('reads the task matrix and current occupancies in one snapshot', async () => {
    const calls: string[] = []
    const snapshot = await loadSchedulerSnapshot(fakeHttp({
      '/api/v1/workflow-task-presentations': { items: [RUNNING_TASK, QUEUED_TASK], total: 2 },
      '/api/v1/stations/local/resource-dispositions': [{
        occupancy_kind: 'execution_lock', state: 'running', scope: 'device',
        lock_key: '/devices/m-right', material_uuid: 'm-right',
        workflow_task_uuid: 't-run', workflow_node_job_uuid: 'j-run', acquired_at: '2026-10-30T01:21:03Z'
      }]
    }, calls))

    expect(calls).toEqual([
      '/api/v1/workflow-task-presentations?view=matrix&terminal_limit=10',
      '/api/v1/stations/local/resource-dispositions'
    ])
    expect(snapshot.tasks[0]).toEqual({
      uuid: 't-run',
      kind: 'ad_hoc_device_action',
      workflowName: null,
      status: 'running',
      controlStatus: 'active',
      cleanupStatus: 'none',
      createdAt: '2026-10-30T01:21:02Z',
      startedAt: '2026-10-30T01:21:02Z',
      finishedAt: null,
      waitReason: null,
      steps: [{
        nodeUuid: 'n-1', name: null, deviceKey: 'organic_right_capper', actionName: 'open_caps',
        jobUuid: 'j-run', jobStatus: 'running', startedAt: '2026-10-30T01:21:03Z', uncertaintyReason: null
      }]
    })
    expect(snapshot.tasks[1]?.waitReason).toEqual({
      message: '执行资源正在被其他作业使用',
      resources: ['右开关盖机构'],
      blockingTaskUuid: 't-run',
      since: '2026-10-30T01:22:00Z'
    })
    expect(snapshot.tasks[1]?.steps[0]?.jobStatus).toBeNull()  // 还没派发，没有作业
    expect(snapshot.occupancies).toEqual([{
      kind: 'execution_lock', state: 'running', scope: 'device', materialUuid: 'm-right',
      taskUuid: 't-run', jobUuid: 'j-run', since: '2026-10-30T01:21:03Z'
    }])
  })

  it('keeps tasks when the occupancy service is unavailable', async () => {
    const snapshot = await loadSchedulerSnapshot(fakeHttp({
      '/api/v1/workflow-task-presentations': { items: [RUNNING_TASK] },
      '/api/v1/stations/local/resource-dispositions': new Error('503 工站错误处置服务尚未就绪')
    }))
    expect(snapshot.tasks).toHaveLength(1)
    expect(snapshot.occupancies).toBeNull()
  })

  it('only shows the current attempt of a retried node', async () => {
    const retried = {
      ...RUNNING_TASK,
      jobs: [
        { ...RUNNING_TASK.jobs[0], uuid: 'j-old', status: 'failed', current_attempt: false },
        RUNNING_TASK.jobs[0]
      ]
    }
    const snapshot = await loadSchedulerSnapshot(fakeHttp({
      '/api/v1/workflow-task-presentations': { items: [retried] },
      '/api/v1/stations/local/resource-dispositions': []
    }))
    expect(snapshot.tasks[0]?.steps[0]?.jobUuid).toBe('j-run')
  })

  it('reads lock release eligibility and releases with the claim and fence the user saw', async () => {
    const posts: Array<{ path: string; body: unknown }> = []
    const http: HttpClient = {
      request: async <Value>(path: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          posts.push({ path, body: JSON.parse(String(init.body)) })
          return { code: 0, data: path.endsWith('/resolve-uncertain')
            ? { pending_edge_confirmation: true }
            : { status: 'released' } } as Value
        }
        return { code: 0, data: {
          workflow_task_uuid: 't-done', task_status: 'canceled', active_device_tenancy_count: 0,
          locks: [{
            uuid: 'lease-1', workflow_node_job_uuid: 'j-1', state: 'running', material_uuid: 'm-right',
            claim_uuid: 'claim-1', fencing_token: 3, job_status: 'canceled', claim_state: 'running',
            can_release: true, release_block_reason: null
          }]
        } } as Value
      }
    }
    const locks = await loadTaskExecutionLocks(http, 't-done')
    expect(locks.locks[0]).toMatchObject({ uuid: 'lease-1', jobUuid: 'j-1', canRelease: true, fencingToken: 3 })
    expect(await forceReleaseExecutionLock(http, 't-done', locks.locks[0]!, '现场已核对')).toBe('released')
    expect(await resolveUncertainJob(http, 'j-2', '设备已停止')).toEqual({ pendingEdgeConfirmation: true })
    expect(posts).toEqual([
      {
        path: '/api/v1/workflow-tasks/t-done/execution-locks/lease-1/force-release',
        body: { expected_claim_uuid: 'claim-1', expected_fencing_token: 3, reason: '现场已核对', physical_settlement_confirmed: true }
      },
      { path: '/api/v1/workflow-node-jobs/j-2/resolve-uncertain', body: { resolution: 'canceled', reason: '设备已停止' } }
    ])
  })

  it('refuses to release a lock without claim or fence', async () => {
    const http: HttpClient = { request: async <Value>() => ({ code: 0, data: {} }) as Value }
    await expect(forceReleaseExecutionLock(http, 't', {
      uuid: 'l', jobUuid: 'j', state: 'running', materialUuid: null, claimUuid: null, fencingToken: null,
      jobStatus: 'canceled', claimState: null, canRelease: true, releaseBlockReason: null
    }, '原因')).rejects.toThrow('缺少 Claim 或 Fence')
  })

  it('rejects a malformed matrix instead of showing an empty schedule', async () => {
    await expect(loadSchedulerSnapshot(fakeHttp({
      '/api/v1/workflow-task-presentations': { total: 0 },
      '/api/v1/stations/local/resource-dispositions': []
    }))).rejects.toThrow('任务矩阵响应无效')
  })
})

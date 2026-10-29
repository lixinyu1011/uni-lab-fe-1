import { describe, expect, it } from 'vitest'

import type { HttpClient } from './http'
import { cancelStationErrorTask, loadStationControl, resumeStationControl } from './stationControl'

/** OS `GET /api/v1/stations/local/error-handling` 的精简形状。 */
const SNAPSHOT = {
  station_id: 'local',
  mode: 'PAUSED',
  station_version: 6,
  error_epoch: 3,
  snapshot_id: 'local:6:3',
  active_session_id: null,
  errors: [{
    decision_id: 'd-1',
    decision_version: 2,
    stage: 'DECISION_REQUIRED',
    session_id: null,
    source_task_uuid: 't-1',
    meta_data: { message: 'PLC 报告故障：03控制交互.右开关盖.状态.故障' }
  }, {
    decision_id: 'd-2',
    decision_version: 4,
    stage: 'MANUAL_HANDLING',
    session_id: 's-1',
    source_task_uuid: 't-2',
    meta_data: {}
  }],
  control_commands: [
    { command_uuid: 'c-1', needs_apply: false },
    { command_uuid: 'c-2', needs_apply: true }
  ]
}

function fakeHttp(calls: Array<{ path: string; init?: RequestInit }>): HttpClient {
  return {
    request: async <Value>(path: string, init?: RequestInit) => {
      calls.push({ path, init })
      return { code: 0, data: path.endsWith('/resume') ? { resume_requested: true } : SNAPSHOT } as Value
    }
  }
}

describe('station control service', () => {
  it('reads the station gate, open errors and pending commands', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = []
    const control = await loadStationControl(fakeHttp(calls))
    expect(calls[0]?.path).toBe('/api/v1/stations/local/error-handling')
    expect(control).toEqual({
      stationId: 'local',
      mode: 'PAUSED',
      stationVersion: 6,
      errorEpoch: 3,
      snapshotId: 'local:6:3',
      activeSessionId: null,
      errors: [
        { decisionId: 'd-1', decisionVersion: 2, taskUuid: 't-1', message: 'PLC 报告故障：03控制交互.右开关盖.状态.故障', cancelable: true },
        { decisionId: 'd-2', decisionVersion: 4, taskUuid: 't-2', message: '', cancelable: false }
      ],
      pendingCommands: 1
    })
  })

  it('cancels one failed task with the decision and station versions it saw', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = []
    const http = fakeHttp(calls)
    const control = await loadStationControl(http)
    await cancelStationErrorTask(http, control, control.errors[0]!)
    const cancel = calls[1]
    expect(cancel?.path).toBe('/api/v1/stations/local/errors/d-1/decision')
    expect(new Headers(cancel?.init?.headers).get('Idempotency-Key')).toMatch(/^workbench-cancel:d-1:2:/)
    expect(JSON.parse(String(cancel?.init?.body))).toMatchObject({
      action: 'cancel_task',
      expected_station_version: 6,
      expected_decision_version: 2,
      observed_error_epoch: 3,
      resume_requested: false
    })
  })

  it('resumes with the confirmed snapshot, versions and an idempotency key', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = []
    const http = fakeHttp(calls)
    await resumeStationControl(http, await loadStationControl(http))
    const resume = calls[1]
    expect(resume?.path).toBe('/api/v1/stations/local/resume')
    expect(resume?.init?.method).toBe('POST')
    expect(new Headers(resume?.init?.headers).get('Idempotency-Key')).toMatch(/^workbench-resume:local:6:3:/)
    expect(JSON.parse(String(resume?.init?.body))).toEqual({
      expected_station_version: 6,
      observed_error_epoch: 3,
      operator_confirmed: true,
      confirm_snapshot_id: 'local:6:3'
    })
  })

  it('rejects a malformed snapshot instead of guessing versions', async () => {
    const http: HttpClient = { request: async <Value>() => ({ code: 0, data: { mode: 'PAUSED' } }) as Value }
    await expect(loadStationControl(http)).rejects.toThrow('工站调度状态响应无效')
  })
})

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { StationControl, StationError } from '@unilab/services'

import {
  StationPausedCard,
  stationCommandErrorMessage,
  stationResumeAvailability
} from './StationDispatchControl'

const PAUSED: StationControl = {
  stationId: 'local',
  mode: 'PAUSED',
  stationVersion: 6,
  errorEpoch: 3,
  snapshotId: 'local:6:3',
  activeSessionId: null,
  errors: [],
  pendingCommands: 0
}

const ERROR: StationError = {
  decisionId: 'd-1',
  decisionVersion: 2,
  taskUuid: 't-1',
  message: 'PLC 报告故障：右开关盖',
  cancelable: true
}

function render(control: StationControl, confirmed = false): string {
  return renderToStaticMarkup(
    <StationPausedCard
      control={control}
      readError={null}
      confirmed={confirmed}
      pending={false}
      commandError={null}
      onConfirmChange={() => undefined}
      onCancelError={() => undefined}
      onResume={() => undefined}
    />
  )
}

describe('station dispatch control', () => {
  it('allows resume only when paused with no open errors, session or pending commands', () => {
    expect(stationResumeAvailability(PAUSED).available).toBe(true)
    expect(stationResumeAvailability({ ...PAUSED, mode: 'RUNNING' }).available).toBe(false)
    expect(stationResumeAvailability({ ...PAUSED, activeSessionId: 's-1' }).reason).toContain('人工处置会话')
    expect(stationResumeAvailability({ ...PAUSED, errors: [ERROR] }).reason).toContain('1 个节点错误')
    expect(stationResumeAvailability({ ...PAUSED, pendingCommands: 1 }).available).toBe(false)
  })

  it('requires the operator confirmation before the resume button is enabled', () => {
    const unconfirmed = render(PAUSED)
    expect(unconfirmed).toContain('工站调度已暂停')
    expect(unconfirmed).toContain('我已核对现场')
    expect(unconfirmed).toMatch(/<button[^>]*disabled=""[^>]*>恢复工站调度<\/button>/)
    expect(render(PAUSED, true)).not.toMatch(/<button[^>]*disabled=""/)
  })

  it('lists open errors with a cancel button and hides resume until they are handled', () => {
    const markup = render({ ...PAUSED, errors: [ERROR, { ...ERROR, decisionId: 'd-2', cancelable: false }] })
    expect(markup).toContain('PLC 报告故障：右开关盖')
    expect(markup.match(/取消出错任务/g)).toHaveLength(1)  // 人工处置中的错误不在这里取消
    expect(markup).not.toContain('恢复工站调度</button>')
  })

  it('translates OS conflict codes', () => {
    expect(stationCommandErrorMessage(new Error('station_version_conflict'), '恢复')).toContain('重新核对')
    expect(stationCommandErrorMessage(new Error('decision_conflict'), '取消任务')).toContain('重新核对')
    expect(stationCommandErrorMessage(new Error('active_session_conflict'), '恢复')).toContain('人工处置会话')
    expect(stationCommandErrorMessage(new Error('其他'), '恢复')).toBe('恢复失败：其他')
  })
})

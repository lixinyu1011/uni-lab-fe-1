import type { TaskExecutionLock, TaskExecutionLocks } from '@unilab/services'

import styles from './SchedulerPanel.module.scss'

/** 用户点“核对后解除”的那个占用。 */
export interface ReleaseTarget {
  taskUuid: string
  /** 占用所属作业；未知时按任务的全部锁判断。 */
  jobUuid: string | null
  /** 占用者，如“右开关盖机构 · 开盖”。 */
  holder: string
  /** 被占用的设备。 */
  device: string
}

/** 读完任务的执行锁后，这次解除走哪条路。 */
export type ReleasePlan =
  /** 作业已结束、结果确定：释放该作业的全部执行锁。 */
  | { kind: 'release'; lock: TaskExecutionLock }
  /** 作业结果不确定：按“已取消”结算，结算后 OS 释放占用。 */
  | { kind: 'settle'; jobUuid: string }
  /** 现在不能解除，附原因与下一步。 */
  | { kind: 'blocked'; reason: string }
  /** 占用已经释放。 */
  | { kind: 'none' }

const UNCERTAIN = '不确定'

/**
 * 按 OS 返回的释放资格决定解除方式。
 *
 * @param locks 任务当前的执行锁。
 * @param jobUuid 占用所属作业；为空时看任务的全部锁。
 */
export function releasePlan(locks: TaskExecutionLocks, jobUuid: string | null): ReleasePlan {
  const relevant = locks.locks.filter((lock) => !jobUuid || lock.jobUuid === jobUuid)
  if (relevant.length === 0) {
    return locks.activeDeviceTenancyCount > 0
      ? { kind: 'blocked', reason: '任务独占设备（不是单个作业的执行锁），取消任务后才会释放。' }
      : { kind: 'none' }
  }
  const releasable = relevant.find((lock) => lock.canRelease)
  if (releasable) return { kind: 'release', lock: releasable }
  const uncertain = relevant.find((lock) =>
    lock.state === 'uncertain' || lock.claimState === 'uncertain' ||
    (lock.releaseBlockReason ?? '').includes(UNCERTAIN))
  if (uncertain?.jobUuid) return { kind: 'settle', jobUuid: uncertain.jobUuid }
  const reason = relevant.find((lock) => lock.releaseBlockReason)?.releaseBlockReason ?? 'OS 判定当前不能释放。'
  const active = !['failed', 'canceled', 'timeout'].includes(locks.taskStatus)
  return { kind: 'blocked', reason: active ? `${reason}。任务还在执行或排队，请先取消任务，取消后占用会自动释放。` : reason }
}

export interface ReleaseState {
  target: ReleaseTarget
  /** null 表示正在读取执行锁。 */
  plan: ReleasePlan | null
  loadError: string | null
  reason: string
  confirmed: boolean
  sending: boolean
  result: string | null
  error: string | null
}

const CONFIRM_TEXT: Record<'release' | 'settle', string> = {
  release: '我已到现场核对：设备已停止，托盘与物料位置已确认，可以解除占用',
  settle: '我已到现场核对：这次动作已经停止、不会再继续执行，按“已取消”结算'
}

/**
 * 解除占用的核对卡片：说明为什么占着、能不能解除；能解除时要填写核对说明并勾选确认。
 */
export function ReleaseOccupancyCard({
  state,
  onReasonChange,
  onConfirmChange,
  onSubmit,
  onClose
}: {
  state: ReleaseState
  onReasonChange: (value: string) => void
  onConfirmChange: (value: boolean) => void
  onSubmit: () => void
  onClose: () => void
}): React.JSX.Element {
  const { target, plan } = state
  const actionable = plan?.kind === 'release' || plan?.kind === 'settle'
  const finished = state.result !== null
  return (
    <section className={styles.release} aria-label="核对后解除占用" data-release-task={target.taskUuid}>
      <div className={styles.sectionHead}>
        <div>
          <span className={styles.eyebrow}>RELEASE</span>
          <h3>核对后解除占用：{target.device}</h3>
        </div>
        <button type="button" className={styles.button} onClick={onClose}>{finished ? '完成' : '关闭'}</button>
      </div>
      <p className={styles.rowDetail}>占用者：{target.holder}（任务 {target.taskUuid.slice(0, 8)}）</p>
      {state.loadError ? <p className={styles.error} role="alert">读取执行锁失败：{state.loadError}</p> : null}
      {!plan && !state.loadError ? <p className={styles.empty}>正在读取执行锁与释放资格…</p> : null}
      {plan?.kind === 'none' ? <p className={styles.resultOk}>占用已经释放，无需处理。</p> : null}
      {plan?.kind === 'blocked' ? <p className={styles.rowNote} role="status">现在不能解除：{plan.reason}</p> : null}
      {plan?.kind === 'release' ? (
        <p className={styles.rowDetail}>
          任务已结束（{plan.lock.jobStatus ?? '未知'}），但执行占用没有释放，排队的任务会一直等。
          确认设备已停止、现场安全后解除；OS 会记录这次人工释放。
        </p>
      ) : null}
      {plan?.kind === 'settle' ? (
        <p className={styles.rowDetail}>
          OS 不知道这次动作有没有在设备上执行完，所以一直占着设备。到现场确认设备已停止后，
          按“已取消”结算，Edge 确认后占用自动释放。
        </p>
      ) : null}
      {actionable && !finished ? (
        <div className={styles.releaseForm}>
          <textarea
            className={styles.textarea}
            value={state.reason}
            disabled={state.sending}
            placeholder="核对说明（必填），例如：现场确认右开关盖已停止，托盘在库位 2"
            onChange={(event) => onReasonChange(event.currentTarget.value)}
          />
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={state.confirmed}
              disabled={state.sending}
              onChange={(event) => onConfirmChange(event.currentTarget.checked)}
            />
            <span>{CONFIRM_TEXT[plan.kind]}</span>
          </label>
          <button
            type="button"
            className={`${styles.button} ${styles.danger}`}
            disabled={!state.confirmed || !state.reason.trim() || state.sending}
            onClick={onSubmit}
          >
            {state.sending ? '提交中…' : plan.kind === 'release' ? '解除占用' : '按已取消结算'}
          </button>
        </div>
      ) : null}
      {state.result ? <p className={styles.resultOk} role="status">{state.result}</p> : null}
      {state.error ? <p className={styles.error} role="alert">{state.error}</p> : null}
    </section>
  )
}

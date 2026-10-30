import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import {
  ServiceError,
  type DeviceAction,
  type WorkflowActionCatalogSnapshot,
  type WorkflowActionNodeTemplate,
  type WorkflowNodeJobFeedback
} from '@unilab/services'

import type { ManagedDevice } from './deviceCatalog'
import { useDevices } from './useDevices'
import { useDeviceStatus } from './useDeviceStatus'
import { StationDispatchControl } from './StationDispatchControl'
import {
  deviceActionDraftStorageKey,
  projectSelectedDeviceAction,
  serializeDeviceActionInput
} from './deviceActionRun'
import {
  startDeviceActionTaskRecovery
} from './deviceActionTaskRecovery'
import {
  startDeviceActionCatalogRecovery,
  type DeviceActionCatalogRecovery
} from './deviceActionCatalogRecovery'
import { refreshDevicePanelState } from './devicePanelRefresh'
import {
  ConnectionSummary,
  DeviceListItem,
  DeviceWorkspace,
  UnlockConfirmationDialog,
  activeDeviceActionTaskUuid,
  createArgumentDraft,
  isTerminalDeviceActionTask,
  projectDeviceActionTask,
  readArgumentDraft,
  writeArgumentDraft,
  type ArgumentDraft,
  type DeviceActionRunState,
  type UnlockIntent,
  type UnlockOperation
} from './DevicePanelSupport'
import { deviceClass } from './deviceStyles'
import type { DeviceManagementPanelProps } from './types'
export {
  DeviceActionAvailability,
  DeviceLockControl,
  UnlockConfirmationDialog
} from './DevicePanelSupport'

/** 每个动作各自的运行状态，键是 actionRef；多台设备的动作可以同时运行。 */
type DeviceActionRunStates = Readonly<Record<string, DeviceActionRunState>>

/** 一个正在运行、需要补读状态的动作任务。 */
interface ActiveDeviceActionRun {
  taskUuid: string
  actionRef: string
}

interface DeviceActionRunAttempt {
  signature: string
  idempotencyKey: string
}

interface DeviceActionFeedbackState {
  cursor: number
  items: WorkflowNodeJobFeedback[]
}

/**
 * 渲染设备目录、实时状态、动作参数与单动作任务控制面板。
 *
 * @param props 服务组合、当前 Backend、连接状态和总开关。
 * @returns 设备列表、空设备引导和当前设备动作工作区。
 * @throws 服务上下文或数据服务异常由对应 Hook 与 React 错误边界传播。
 * @safety 设备动作与人工解锁仍必须经过既有能力检查和确认流程。
 */
export default function DevicePanel({
  services,
  backend,
  connection,
  backendEnabled = true,
  active = true
}: DeviceManagementPanelProps): React.JSX.Element {
  const {
    devices,
    loading,
    error,
    lastUpdated,
    refresh
  } = useDevices({ services, backendEnabled, connection, active })
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null)
  const [selectedActionRef, setSelectedActionRef] = useState<string | null>(null)
  const [argumentDraft, setArgumentDraft] = useState<ArgumentDraft>({})
  const [unlockIntent, setUnlockIntent] = useState<UnlockIntent | null>(null)
  const [unlockOperation, setUnlockOperation] =
    useState<UnlockOperation | null>(null)
  const [actionCatalog, setActionCatalog] =
    useState<WorkflowActionCatalogSnapshot | null>(null)
  const [actionCatalogLoading, setActionCatalogLoading] = useState(false)
  const [actionCatalogError, setActionCatalogError] = useState<string | null>(null)
  const [runStates, setRunStates] = useState<DeviceActionRunStates>({})
  const runAttemptRef = useRef<Map<string, DeviceActionRunAttempt>>(new Map())
  const feedbackByTaskRef = useRef<Map<string, DeviceActionFeedbackState>>(
    new Map()
  )
  const refreshByTaskRef = useRef<Map<string, Promise<boolean>>>(new Map())
  const actionCatalogRecoveryRef = useRef<DeviceActionCatalogRecovery | null>(
    null
  )
  const canForceUnlock = services.capabilities.devices.forceUnlock
  const canRunActionTask = services.capabilities.devices.runActionTask

  useEffect(() => {
    runAttemptRef.current.clear()
    feedbackByTaskRef.current.clear()
    refreshByTaskRef.current.clear()
    setRunStates({})
  }, [backend.apiUrl, backend.id])

  /** 写入某个动作的运行状态；回调返回 null 表示这次不改（任务身份已经变了）。 */
  const setRunState = useCallback((
    actionRef: string,
    next: DeviceActionRunState |
      ((current: DeviceActionRunState | undefined) => DeviceActionRunState | null)
  ): void => {
    setRunStates((current) => {
      const value = typeof next === 'function' ? next(current[actionRef]) : next
      return value === null ? current : { ...current, [actionRef]: value }
    })
  }, [])

  const selectedDevice = useMemo(
    () =>
      devices.find((device) => device.id === selectedDeviceId)
      ?? devices[0]
      ?? null,
    [devices, selectedDeviceId]
  )
  const selectedDeviceStatus = useDeviceStatus({
    services,
    deviceId: selectedDevice?.id ?? null,
    active: active && backendEnabled && connection === 'connected'
  })
  const selectedCatalogAction = useMemo(
    () =>
      selectedDevice?.actions.find(
        (action) => action.actionRef === selectedActionRef
      )
      ?? selectedDevice?.actions[0]
      ?? null,
    [selectedActionRef, selectedDevice]
  )
  // 投影必须同时绑定资源模板（ResourceTemplate）身份，防止同名动作跨设备误派发。
  const selectedActionProjection = useMemo(
    () => projectSelectedDeviceAction(
      actionCatalog,
      selectedCatalogAction,
      selectedDevice?.resourceTemplateUuid
    ),
    [actionCatalog, selectedCatalogAction, selectedDevice?.resourceTemplateUuid]
  )
  const selectedActionTemplate = selectedActionProjection.template
  const selectedAction = selectedActionProjection.action
  const argumentDraftKey = useMemo(
    () => deviceActionDraftStorageKey(
      backend.id,
      backend.apiUrl,
      selectedDevice,
      selectedAction,
      selectedActionTemplate,
      actionCatalog?.fingerprint
    ),
    [
      backend.apiUrl,
      backend.id,
      actionCatalog?.fingerprint,
      selectedAction,
      selectedActionTemplate?.uuid,
      selectedDevice
    ]
  )
  const loadActionCatalog = useCallback(async (
    signal?: AbortSignal,
    refresh = false
  ): Promise<boolean> => {
    if (!active || !canRunActionTask || connection !== 'connected') return false
    setActionCatalogLoading(true)
    setActionCatalogError(null)
    try {
      const catalog = await services.workflow.getWorkflowActionCatalog(
        signal,
        { refresh }
      )
      if (signal?.aborted) return false
      setActionCatalog(catalog)
      return true
    } catch (error) {
      if (signal?.aborted) return false
      setActionCatalog(null)
      setActionCatalogError(
        error instanceof Error ? error.message : '无法读取设备动作信息'
      )
      return false
    } finally {
      if (!signal?.aborted) setActionCatalogLoading(false)
    }
  }, [active, canRunActionTask, connection, services.workflow])

  useEffect(() => {
    if (!active) return
    if (!canRunActionTask || connection !== 'connected') {
      setActionCatalog(null)
      setActionCatalogError(null)
      setActionCatalogLoading(false)
      return
    }
    const controller = new AbortController()
    const recovery = startDeviceActionCatalogRecovery({
      load: (refresh) => loadActionCatalog(controller.signal, refresh)
    })
    actionCatalogRecoveryRef.current = recovery
    return () => {
      controller.abort()
      recovery.dispose()
      if (actionCatalogRecoveryRef.current === recovery) {
        actionCatalogRecoveryRef.current = null
      }
    }
  }, [
    active,
    backend.apiUrl,
    backend.id,
    canRunActionTask,
    connection,
    loadActionCatalog
  ])

  useEffect(() => {
    if (!devices.length) {
      setSelectedDeviceId(null)
      return
    }
    if (!devices.some((device) => device.id === selectedDeviceId)) {
      setSelectedDeviceId(devices[0]?.id ?? null)
    }
  }, [devices, selectedDeviceId])

  useEffect(() => {
    if (!selectedDevice?.actions.length) {
      setSelectedActionRef(null)
      return
    }
    if (
      !selectedDevice.actions.some(
        (action) => action.actionRef === selectedActionRef
      )
    ) {
      setSelectedActionRef(selectedDevice.actions[0]?.actionRef ?? null)
    }
  }, [selectedActionRef, selectedDevice])

  useEffect(() => {
    const fallback = selectedAction
      ? createArgumentDraft(selectedAction.inputSchema)
      : {}
    setArgumentDraft(readArgumentDraft(argumentDraftKey, fallback))
  }, [argumentDraftKey, selectedAction?.actionRef])

  const handleArgumentChange = useCallback(
    (name: string, value: string | boolean) => {
      setArgumentDraft((current) => {
        const next = { ...current, [name]: value }
        writeArgumentDraft(argumentDraftKey, next)
        return next
      })
    },
    [argumentDraftKey]
  )

  const handleRequestUnlock = useCallback(
    (device: ManagedDevice, action: DeviceAction) => {
      if (!action.currentJobId) return
      setUnlockOperation(null)
      setUnlockIntent({
        deviceId: device.id,
        deviceName: device.displayName,
        actionName: action.actionName,
        actionRef: action.actionRef,
        actionLabel: action.displayName,
        expectedJobId: action.currentJobId
      })
    },
    []
  )

  const handleConfirmUnlock = useCallback(async () => {
    const intent = unlockIntent
    if (!intent) return
    setUnlockOperation({
      actionRef: intent.actionRef,
      state: 'pending',
      message: '正在请求 OS 取消当前动作并释放锁…'
    })
    try {
      const result = await services.laboratory.forceUnlockDeviceAction({
        deviceId: intent.deviceId,
        actionName: intent.actionName,
        expectedJobId: intent.expectedJobId
      })
      setUnlockIntent(null)
      setUnlockOperation({
        actionRef: intent.actionRef,
        state: 'success',
        message: result.status === 'already_unlocked'
          ? '该动作锁已由 OS 释放，正在复核最新目录状态。'
          : `OS 已释放 ${result.releasedJobIds.length} 个关联 Job，正在复核最新目录状态。`
      })
      await refresh()
    } catch (error) {
      setUnlockOperation({
        actionRef: intent.actionRef,
        state: 'error',
        message: error instanceof Error
          ? error.message
          : '设备解锁失败，请刷新状态后重试'
      })
    }
  }, [refresh, services.laboratory, unlockIntent])

  const refreshDeviceActionTask = useCallback(async (
    taskUuid: string,
    actionRef: string
  ): Promise<boolean> => {
    const view = await services.deviceActionTasks.getDeviceActionTask(taskUuid)
    const previous = feedbackByTaskRef.current.get(taskUuid) ?? {
      cursor: 0,
      items: []
    }
    let cursor = previous.cursor
    const feedback = [...previous.items]
    while (cursor < view.feedback_cursor) {
      const page = await services.workflow.listWorkflowNodeJobFeedback(
        view.job_uuid,
        { after_sequence: cursor, limit: 100 }
      )
      feedback.push(...page.items.filter((item) => item.sequence > cursor))
      if (page.next_cursor <= cursor) break
      cursor = page.next_cursor
      if (!page.has_more) break
    }
    feedbackByTaskRef.current.set(taskUuid, { cursor, items: feedback })
    setRunState(actionRef, (current) => (
      current && 'taskUuid' in current && current.taskUuid === taskUuid
        ? projectDeviceActionTask(view, feedback)
        : null
    ))
    const terminal = isTerminalDeviceActionTask(view.status)
    if (terminal) {
      await refresh()
    }
    return terminal
  }, [refresh, services.deviceActionTasks, services.workflow, setRunState])

  const queueDeviceActionTaskRefresh = useCallback((
    taskUuid: string,
    actionRef: string
  ): Promise<boolean> => {
    const previous = refreshByTaskRef.current.get(taskUuid) ?? Promise.resolve()
    const next = previous
      .catch(() => undefined)
      .then(() => refreshDeviceActionTask(taskUuid, actionRef))
    refreshByTaskRef.current.set(taskUuid, next)
    const removeIfCurrent = (): void => {
      if (refreshByTaskRef.current.get(taskUuid) === next) {
        refreshByTaskRef.current.delete(taskUuid)
      }
    }
    void next.then(removeIfCurrent, removeIfCurrent)
    return next
  }, [refreshDeviceActionTask])

  // 所有还在运行的动作任务（可能分属多台设备），都要补读状态，不只看当前选中的那个。
  const activeRuns = useMemo<ActiveDeviceActionRun[]>(
    () => Object.entries(runStates).flatMap(([actionRef, state]) => {
      const taskUuid = activeDeviceActionTaskUuid({ actionRef, state })
      return taskUuid ? [{ taskUuid, actionRef }] : []
    }),
    [runStates]
  )
  const activeRunsKey = activeRuns.map((run) => `${run.actionRef}:${run.taskUuid}`).join('|')
  useEffect(() => {
    if (!active || activeRuns.length === 0) return
    const recovery = startDeviceActionTaskRecovery({
      tasks: activeRuns,
      subscribe: services.capabilities.workflow.subscribeEvents
        ? (listener, options) =>
            services.workflow.subscribeWorkflowRuntime(listener, options)
        : undefined,
      read: (task) => queueDeviceActionTaskRefresh(
        task.taskUuid,
        task.actionRef
      ),
      onError: (task, error) => {
        setRunState(task.actionRef, (current) => (
          current && 'taskUuid' in current && current.taskUuid === task.taskUuid
            ? {
                ...current,
                message: error instanceof Error
                  ? `任务状态补读失败：${error.message}`
                  : '任务状态补读失败'
              }
            : null
        ))
      },
      fallbackDelaysMs: [2_000, 5_000, 10_000, 30_000]
    })
    return () => recovery.dispose()
    // activeRunsKey 覆盖 activeRuns 的内容变化；数组本身每次渲染都是新对象。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    active,
    activeRunsKey,
    queueDeviceActionTaskRefresh,
    services.capabilities.workflow.subscribeEvents,
    services.workflow,
    setRunState
  ])

  const handleRefresh = useCallback(async (): Promise<void> => {
    await refreshDevicePanelState({
      refreshDevices: refresh,
      refreshCatalog: () =>
        actionCatalogRecoveryRef.current?.refresh() ?? loadActionCatalog(),
      activeTasks: activeRuns,
      refreshTask: queueDeviceActionTaskRefresh
    })
  }, [
    activeRuns,
    loadActionCatalog,
    queueDeviceActionTaskRefresh,
    refresh
  ])

  /**
   * 用稳定设备物料身份创建一个设备单动作工作流任务（WorkflowTask）。
   *
   * @param device 当前选择的设备。
   * @param action 当前选择的动作。
   * @param template 动作对应的工作流节点模板（WorkflowNodeTemplate）。
   * @returns 提交及首次补水完成后返回无。
   * @throws 异常在回调内投影为可见错误状态，不向事件循环传播。
   */
  const handleRunAction = useCallback(async (
    device: ManagedDevice,
    action: DeviceAction,
    template: WorkflowActionNodeTemplate
  ) => {
    const running = runStates[action.actionRef]?.kind
    if (
      !actionCatalog ||
      running === 'submitting' ||
      running === 'accepted' ||
      running === 'running' ||
      running === 'finishing'
    ) return
    if (!device.materialUuid) {
      setRunState(action.actionRef, {
        kind: 'error',
        message: '当前设备缺少运行标识，请刷新设备列表后重试',
        retryable: false
      })
      return
    }
    let input: Record<string, unknown>
    try {
      input = serializeDeviceActionInput(action, argumentDraft, template)
    } catch (error) {
      setRunState(action.actionRef, {
        kind: 'error',
        message: error instanceof Error ? error.message : 'Action 参数不合法',
        retryable: false
      })
      return
    }
    const signature = JSON.stringify({
      fingerprint: actionCatalog.fingerprint,
      templateUuid: template.uuid,
      materialUuid: device.materialUuid,
      input
    })
    // 幂等键按动作分别保存：重试同一个动作复用原键，别的动作不受影响。
    const previous = runAttemptRef.current.get(action.actionRef)
    const idempotencyKey = previous?.signature === signature
      ? previous.idempotencyKey
      : globalThis.crypto.randomUUID()
    runAttemptRef.current.set(action.actionRef, { signature, idempotencyKey })
    setRunState(action.actionRef, { kind: 'submitting', message: '正在创建正式任务…' })
    try {
      const view = await services.deviceActionTasks.createDeviceActionTask({
        material_uuid: device.materialUuid,
        workflow_node_template_uuid: template.uuid,
        param: input,
        execution_policy: {},
        idempotency_key: idempotencyKey,
        description: '设备页单动作运行',
        meta_data: {
          source: 'device-panel',
          device_id: device.id,
          action_name: action.actionName
        }
      })
      runAttemptRef.current.delete(action.actionRef)
      feedbackByTaskRef.current.set(view.task_uuid, { cursor: 0, items: [] })
      setRunState(action.actionRef, projectDeviceActionTask(view, []))
      const [, taskRefresh] = await Promise.allSettled([
        refresh(),
        queueDeviceActionTaskRefresh(view.task_uuid, action.actionRef)
      ])
      if (taskRefresh.status === 'rejected') {
        const error = taskRefresh.reason
        setRunState(action.actionRef, (current) => (
          current && 'taskUuid' in current && current.taskUuid === view.task_uuid
            ? {
                ...current,
                message: error instanceof Error
                  ? `任务已接受，状态补读失败：${error.message}`
                  : '任务已接受，状态补读失败'
              }
            : null
        ))
      }
    } catch (error) {
      if (
        error instanceof ServiceError &&
        error.code === 'template_catalog_conflict'
      ) {
        runAttemptRef.current.delete(action.actionRef)
        await Promise.all([loadActionCatalog(), refresh()])
        setRunState(action.actionRef, {
          kind: 'error',
          message: '动作信息已更新，请重新检查参数后运行',
          retryable: false
        })
        return
      }
      setRunState(action.actionRef, {
        kind: 'error',
        message: error instanceof Error ? error.message : '任务创建失败',
        retryable: error instanceof ServiceError && error.retryable
      })
    }
  }, [
    actionCatalog,
    argumentDraft,
    loadActionCatalog,
    refresh,
    queueDeviceActionTaskRefresh,
    runStates,
    services.deviceActionTasks,
    setRunState
  ])

  const handleCancelActionTask = useCallback(async (taskUuid: string) => {
    /** 把取消结果写到持有这个任务的那个动作上。 */
    const noteOnTask = (message: string): void => {
      setRunStates((current) => {
        const entry = Object.entries(current).find(([, state]) =>
          'taskUuid' in state && state.taskUuid === taskUuid)
        if (!entry) return current
        const [actionRef, state] = entry
        return { ...current, [actionRef]: { ...state, message } }
      })
    }
    try {
      await services.workflow.commandWorkflowTask(taskUuid, {
        type: 'cancel',
        idempotency_key: globalThis.crypto.randomUUID(),
        description: '设备页取消单动作任务'
      })
      noteOnTask('取消命令已接受，等待 OS 确认生效')
    } catch (error) {
      noteOnTask(error instanceof Error
        ? `取消任务失败：${error.message}`
        : '取消任务失败，请重试')
    }
  }, [services.workflow])

  return (
    <>
      <section
        className={deviceClass('edge-device', devices.length === 0 && 'is-empty')}
        data-device-management="panel"
      >
      <aside className={deviceClass('section__list')} aria-label="设备实例列表">
        <header className={deviceClass('edge-device__list-head')}>
          <div>
            <h1 className={deviceClass('section__list-title')}>仪器设备</h1>
            <span className={deviceClass('section__list-meta')}>
              {devices.length} 台设备 · Authority 设备目录
            </span>
          </div>
          <button
            type="button"
            className={deviceClass('edge-device__refresh')}
            disabled={loading || connection !== 'connected'}
            onClick={() => void handleRefresh()}
          >
            {loading ? '同步中' : '刷新'}
          </button>
        </header>
        <ConnectionSummary
          connection={connection}
          backendName={backend.name}
          lastUpdated={lastUpdated}
        />
        <StationDispatchControl
          services={services}
          active={active && backendEnabled && connection === 'connected'}
        />
        {loading && devices.length === 0 ? (
          <div className={deviceClass('device-loading')} role="status">
            正在读取设备实例与动作模板目录…
          </div>
        ) : null}
        {error ? (
          <div className={deviceClass('edge-device__load-error')} role="alert">
            <strong>设备目录不可用</strong>
            <span>{error}</span>
            <button type="button" onClick={() => void handleRefresh()}>
              重新读取
            </button>
          </div>
        ) : null}
        {error ? null : devices.length === 0 ? (
          <div className={deviceClass('device-empty device-empty--compact')}>
            <strong>
              {connection === 'connected'
                ? '当前未配置仪器设备'
                : '等待 Authority 提供设备'}
            </strong>
            {connection === 'connected' ? (
              <p>
                Edge 核心服务已连接。安装或配置设备包和设备图后，重新启动 Edge 并刷新设备。
              </p>
            ) : (
              <p>
                连接后会读取设备实例，并关联动作节点模板的参数 Schema。
              </p>
            )}
          </div>
        ) : (
          <ul className={deviceClass('device-list')}>
            {devices.map((device) => (
              <DeviceListItem
                key={device.id}
                device={device}
                selected={device.id === selectedDevice?.id}
                onSelect={setSelectedDeviceId}
              />
            ))}
          </ul>
        )}
        <div className={deviceClass('edge-device__source-note')}>
          <span>数据来源</span>
          设备与在线状态来自 DeviceOverview；动作参数来自 WorkflowNodeTemplate。
        </div>
      </aside>

      <main className={deviceClass('section__detail edge-device__detail')}>
        {error ? (
          <div className={deviceClass('device-empty device-empty--detail')}>
            <strong>设备目录暂未就绪</strong>
            <p>请根据左侧诊断检查 OS 设备启动日志，然后重新读取。</p>
          </div>
        ) : selectedDevice ? (
          <DeviceWorkspace
            device={selectedDevice}
            selectedAction={selectedAction}
            selectedActionRef={selectedActionRef}
            argumentDraft={argumentDraft}
            onSelectAction={setSelectedActionRef}
            onArgumentChange={handleArgumentChange}
            actionTemplate={selectedActionTemplate}
            actionCatalogLoading={actionCatalogLoading}
            actionCatalogError={actionCatalogError}
            canRunActionTask={canRunActionTask}
            connection={connection}
            runState={selectedAction ? runStates[selectedAction.actionRef] ?? null : null}
            runningActionRefs={activeRuns.map((run) => run.actionRef)}
            onRunAction={(action, template) => {
              void handleRunAction(selectedDevice, action, template)
            }}
            onCancelActionTask={(taskUuid) => {
              void handleCancelActionTask(taskUuid)
            }}
            canForceUnlock={canForceUnlock}
            unlockOperation={unlockOperation}
            onRequestUnlock={handleRequestUnlock}
            status={selectedDeviceStatus}
          />
        ) : (
          <div className={deviceClass('device-empty device-empty--detail')}>
            <strong>暂无可调试设备</strong>
            <p>
              {connection === 'connected'
                ? '当前可继续使用 Edge 核心服务；配置仪器设备后请重新启动并刷新。'
                : '请确认 Edge 已启动并连接到本地桥。'}
            </p>
          </div>
        )}
        </main>
      </section>
      {unlockIntent ? (
        <UnlockConfirmationDialog
          intent={unlockIntent}
          operation={unlockOperation}
          onCancel={() => {
            if (unlockOperation?.state !== 'pending') setUnlockIntent(null)
          }}
          onConfirm={() => void handleConfirmUnlock()}
        />
      ) : null}
    </>
  )
}

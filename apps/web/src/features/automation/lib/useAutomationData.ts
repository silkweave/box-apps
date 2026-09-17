import { useEffect } from 'react'
import { registerStoreReloads } from '../../../lib/changeFeed.ts'
import { createDataStore } from '../../../lib/dataStore.ts'
import { trpc } from '../../../lib/trpc.ts'

// Automation data layer - schedules (config/schedules.json via the server) and the scheduler
// status (the TopBar's restart-required poll target). The action registry, the run history and
// Run Now are core's (lib/useRuns.ts) and re-exported here for this feature's views.

export {
  fetchRun,
  reloadRuns,
  runNow,
  useActions as useAutomationActions,
  useRuns as useAutomationRuns,
  type Action as AutomationAction,
  type ProgressChunk,
  type Run as AutomationRun,
  type RunLogLine,
  type RunStatus,
  type RunWithLog as AutomationRunWithLog,
} from '../../../lib/useRuns.ts'
import { useFresh } from '../../../lib/useRuns.ts'

export interface AutomationSchedule {
  id: string
  action_id: string
  cron: string
  /** Server-humanized cron ("At 07:00 AM"). */
  human: string
  enabled: boolean
  description?: string
  valid: boolean
  problem: string | null
  /** Next fire per the RUNNING scheduler (ISO), null when not armed. */
  nextFire: string | null
}

export interface SchedulesData {
  schedules: AutomationSchedule[]
  restartRequired: boolean
  loadedAt: string
  disabled: boolean
}

export interface AutomationStatus {
  restartRequired: boolean
  loadedAt: string
  disabled: boolean
  scheduleCount: number
  running: { runId: string; actionId: string; state: 'queued' | 'running' }[]
}

const schedulesStore = createDataStore<SchedulesData>(() =>
  trpc.automationSchedules.query({}).then((d) => d as unknown as SchedulesData),
)

const statusStore = createDataStore<AutomationStatus>(() =>
  trpc.automationStatus.query({}).then((d) => d as unknown as AutomationStatus),
)
registerStoreReloads(['config:schedules.json'], schedulesStore)

export const useAutomationSchedules = (): { data: SchedulesData | null; error: string | null } =>
  useFresh(schedulesStore)
export const reloadSchedules = schedulesStore.reload
export const useAutomationStatusData = (): { data: AutomationStatus | null; error: string | null } =>
  useFresh(statusStore)
export const reloadStatus = statusStore.reload

/**
 * Scheduler status with a slow background poll (60s + window focus) - shared by the TopBar's
 * RestartRequiredButton and the Automation view, so both agree on `restartRequired`.
 */
export function useAutomationStatus(): { data: AutomationStatus | null; error: string | null } {
  const state = useAutomationStatusData()
  useEffect(() => {
    const tick = (): void => void statusStore.reload().catch(() => undefined)
    const timer = setInterval(tick, 60_000)
    window.addEventListener('focus', tick)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', tick)
    }
  }, [])
  return state
}

/** Create/update a schedule (partial merge into config/schedules.json), then refresh. */
export async function upsertSchedule(input: {
  id: string
  action_id?: string
  cron?: string
  enabled?: boolean
  description?: string
}): Promise<void> {
  await trpc.automationScheduleUpsert.mutate(input)
  await Promise.all([schedulesStore.reload(), statusStore.reload()])
}

/** Delete a schedule from the config file, then refresh. */
export async function deleteSchedule(id: string): Promise<void> {
  await trpc.automationScheduleDelete.mutate({ id })
  await Promise.all([schedulesStore.reload(), statusStore.reload()])
}

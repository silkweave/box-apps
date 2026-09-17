import { RefreshCw } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@silkweave/box-ui'
import { RestartServerButton } from './RestartServerButton.tsx'
import { useAutomationStatus } from '../lib/useAutomationData.ts'

/**
 * Shown in the TopBar only while config/schedules.json differs from what the running scheduler
 * loaded at boot (schedule CRUD never hot-reloads timers). Restarting applies the config: the
 * server exits non-zero and launchd respawns it - see RestartServerButton.
 */
export function RestartRequiredButton() {
  const { data } = useAutomationStatus()
  if (!data?.restartRequired) return null

  return (
    <Popover>
      <PopoverTrigger
        className='inline-flex h-8 items-center gap-1.5 rounded-md border border-warning/30 bg-warning-bg px-2.5 text-body-sm text-warning transition-colors outline-none hover:border-warning/60 focus-visible:border-warning'
        title='Schedule config changed - restart the server to apply'>
        <RefreshCw className='size-3.5' />
        <span className='hidden sm:inline'>Restart required</span>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-72 gap-2 p-3 text-body-sm'>
        <p className='font-medium text-text'>Schedule config changed</p>
        <p className='text-muted-foreground'>
          <code>config/schedules.json</code> was edited after the server started. The scheduler keeps its
          boot-time snapshot; restart to apply (back in a few seconds).
        </p>
        <RestartServerButton />
      </PopoverContent>
    </Popover>
  )
}

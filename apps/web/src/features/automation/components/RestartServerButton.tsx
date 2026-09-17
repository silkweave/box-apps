import { useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Button, confirm } from '@silkweave/box-ui'
import { trpc } from '../../../lib/trpc.ts'

/**
 * Admin-only control (the server rejects non-admins) that triggers `automationRestart`: the
 * service exits non-zero and launchd respawns it (~2-5s). After triggering, polls until the
 * server answers again, then reloads the page so every store refetches against the new process.
 *
 * The server REFUSES (`ok: false`) while an agent session is mid-turn - workerdeck runs in the Box
 * server process now, so a restart ends every sidebar and @nova session. That refusal has to be surfaced
 * rather than polled through: the poll would find the un-restarted server answering immediately and
 * reload the page as if it had worked.
 */
export function RestartServerButton({ label = 'Restart server' }: { label?: string }) {
  const [state, setState] = useState<'idle' | 'waiting' | 'failed'>('idle')

  const restart = async () => {
    if (!(await confirm({ title: 'Restart the server?', message: 'In-flight requests drop; the service is back in a few seconds.' }))) return
    setState('waiting')
    try {
      const res = await trpc.automationRestart.mutate({})
      if (!res.ok) {
        setState('idle')
        if (!(await confirm({ title: 'Agent sessions are mid-turn', message: `${res.message} Restart anyway?` }))) return
        setState('waiting')
        await trpc.automationRestart.mutate({ force: true })
      }
    } catch {
      /* the connection can die as the process exits - the poll below decides the outcome */
    }
    await new Promise((r) => setTimeout(r, 1_500)) // grace: don't poll the OLD process
    const deadline = Date.now() + 40_000
    while (Date.now() < deadline) {
      try {
        await trpc.automationStatus.query({})
        window.location.reload()
        return
      } catch {
        await new Promise((r) => setTimeout(r, 1_000))
      }
    }
    setState('failed')
  }

  if (state === 'failed')
    return <p className='text-label text-danger'>Server did not come back within 40s - check the server log where its supervisor writes it.</p>
  return (
    <Button variant='outline' size='sm' disabled={state === 'waiting'} onClick={() => void restart()}>
      <RefreshCw className={state === 'waiting' ? 'animate-spin' : ''} />
      {state === 'waiting' ? 'Restarting…' : label}
    </Button>
  )
}

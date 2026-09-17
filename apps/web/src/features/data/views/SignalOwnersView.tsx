import { useEffect, useState } from 'react'
import { trpc } from '../../../lib/trpc.ts'
import { reloadSignals, useSignalsData } from '../lib/useSignalsData.ts'
import { signalLabel, signalMap } from '../lib/signalLabel.ts'
import { UserPicker, PageContainer, PageHeader } from '@silkweave/box-ui'

interface OwnersFile {
  channels: Record<string, string>
  signals: Record<string, string | null>
}

/**
 * Settings → Signal owners: the channel-level defaults from config/signal-owners.json (a channel
 * default covers every signal in it, e.g. github → every github.* signal). Per-signal overrides are
 * edited on each signal's detail page; the ones on file are listed read-only here for transparency.
 */
export function SignalOwnersView() {
  const { data: signals } = useSignalsData()
  const [owners, setOwners] = useState<OwnersFile | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    trpc.signalsOwners
      .query({})
      .then((d) => setOwners(d as unknown as OwnersFile))
      .catch((e) => setError(String(e)))
  }, [])

  const save = async (channel: string, owner: string | null) => {
    const next = await trpc.signalsOwnersSave.mutate(
      owner === null ? { scope: 'channel', key: channel } : { scope: 'channel', key: channel, owner },
    )
    setOwners(next as unknown as OwnersFile)
    void reloadSignals()
  }

  if (error) return <p className='px-8 py-8 text-body-sm text-danger'>{error}</p>
  if (!owners) return <p className='px-8 py-8 text-body-sm text-muted-foreground'>Loading…</p>

  // Every channel that has signal in the warehouse, plus any channel already mapped in the file.
  const channels = [...new Set([...(signals?.channels ?? []), ...Object.keys(owners.channels)])].sort()
  const overrides = Object.entries(owners.signals)
  const byId = signalMap(signals)

  return (
    <PageContainer width='wide'>
      <PageHeader
        title='Signal owners'
        description={
          <>
            Who each signal belongs to (<code>config/signal-owners.json</code>). A channel default covers
            all of its signal; clearing it leaves the channel unowned. Per-signal overrides are set on the
            signal's detail page.
          </>
        }
      />

      <div className='overflow-hidden rounded-lg border border-border bg-surface shadow-(--shadow-sm)'>
        {channels.map((c) => (
          <div key={c} className='flex items-center gap-3 border-b border-border px-4 py-2.5 last:border-0'>
            <code className='w-36 shrink-0 text-body-sm text-text'>{c}</code>
            <span className='flex-1 text-label text-muted-foreground'>
              {(signals?.signals ?? []).filter((s) => s.channel === c).length} signal
            </span>
            <UserPicker value={owners.channels[c] ?? null} onChange={(id) => void save(c, id)} />
          </div>
        ))}
      </div>

      {overrides.length > 0 && (
        <section className='mt-8'>
          <h2 className='mb-3 text-label uppercase tracking-[0.07em] text-muted-foreground'>
            Per-signal overrides
          </h2>
          <div className='overflow-hidden rounded-lg border border-border bg-surface shadow-(--shadow-sm)'>
            {overrides.map(([signalId, owner]) => (
              <div key={signalId} className='flex items-center gap-3 border-b border-border px-4 py-2 text-body-sm last:border-0'>
                {/* Friendly name first, id underneath - an override on a signal that no longer
                    exists still shows (as its bare id), because that is exactly the row to clean up. */}
                <span className='flex min-w-0 flex-1 flex-col'>
                  <span className='truncate text-text'>{signalLabel(byId, signalId, { withChannel: true })}</span>
                  <code className='truncate text-label text-muted-foreground'>{signalId}</code>
                </span>
                <span className='text-muted-foreground'>{owner ?? 'unowned (brand)'}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </PageContainer>
  )
}

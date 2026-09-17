import * as React from 'react'
import { RotateCcw, Save } from 'lucide-react'
import { trpc } from '../../../lib/trpc.ts'
import { PageContainer, PageHeader, Badge, Button, confirm, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@silkweave/box-ui'
import { ChannelGlyph } from '@/lib/channelIcons.tsx'
import { cn } from '@/lib/utils'

// Settings → Channels: the two things that decide what a piece is allowed to look like, side by side
// per channel - the PROFILE (the mechanical constraints verify checks) and the VOICE files (the style
// rules it checks against). They were split across a TypeScript constant and a folder of markdown you
// needed a checkout to edit, which meant the enforceable half of house style was the half nobody on
// the team could change.
//
// The screen is deliberately one channel at a time. A table of six channels x eight fields is a
// spreadsheet, and the question people actually arrive with is "what are the rules for LinkedIn".

/** The closed channel vocabulary, as the generated tRPC input already narrows it. Declared here (the
 *  one cast at the boundary) because the payload's `channels` reflects as `unknown[]`. */
type ProfileChannel = 'blog' | 'hackernews' | 'linkedin' | 'linkedin-article' | 'reddit' | 'x'

interface ChannelProfile {
  channel: ProfileChannel
  label: string
  bodyKind: string
  limits: { perUnitChars?: number; titleChars?: number; units?: [number, number]; unitKind?: string }
  voiceNotes: string
  requires: string[]
  recommends?: string[]
  publish: { mode: string; tool?: string; costNote?: string; gated: boolean; auto: boolean }
}

interface ChannelConfig {
  profile: ChannelProfile
  defaults: ChannelProfile
  overridden: string[]
}

interface VoiceLayer {
  channel: string | null
  author: string | null
  path: string
  bytes: number
}

interface ChannelsConfig {
  generatedAt: string
  channels: ChannelConfig[]
  voiceLayers: VoiceLayer[]
  authors: string[]
}

const inputCls =
  'w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-body-sm text-text transition-colors hover:border-accent/40 focus:border-accent focus:outline-none'

const BODY_KINDS = ['longform', 'medium', 'thread', 'short'] as const
const UNIT_KINDS = ['words', 'posts', 'chars'] as const

export function ChannelsView() {
  const [config, setConfig] = React.useState<ChannelsConfig | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [active, setActive] = React.useState<string | null>(null)

  const load = React.useCallback(() => {
    trpc.channelsConfig
      .query({})
      .then((d) => setConfig(d as unknown as ChannelsConfig))
      .catch((e: unknown) => setError(String(e)))
  }, [])
  React.useEffect(load, [load])

  if (error) return <p className='px-8 py-8 text-body-sm text-danger'>{error}</p>
  if (!config) return <p className='px-8 py-8 text-body-sm text-muted-foreground'>Loading…</p>

  const current = config.channels.find((c) => c.profile.channel === active) ?? config.channels[0]

  return (
    <PageContainer width='wide'>
      <PageHeader
        title='Channels'
        description={
          <>
            What a piece on each channel has to be. The <strong>profile</strong> is the mechanical
            constraint <code>/verify-content</code> checks (<code>config/channel-profiles.json</code>,
            overlaid on what the release ships); the <strong>voice</strong> files are the style rules it
            checks against (<code>docs/identity/voice/</code>, edited in place - the content skills read
            the same files).
          </>
        }
      />

      <div className='flex flex-wrap gap-1.5'>
        {config.channels.map(({ profile, overridden }) => (
          <button
            key={profile.channel}
            type='button'
            onClick={() => setActive(profile.channel)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-body-sm transition-colors',
              profile.channel === current.profile.channel
                ? 'border-accent bg-surface text-text'
                : 'border-border text-muted-foreground hover:border-accent/40 hover:text-text',
            )}>
            <ChannelGlyph channel={profile.channel} className='size-3.5' />
            {profile.label}
            {overridden.length > 0 && <span className='size-1.5 rounded-full bg-accent' title='Edited by the team' />}
          </button>
        ))}
      </div>

      <ProfileForm key={`${current.profile.channel}:${config.generatedAt}`} config={current} onSaved={setConfig} />
      <VoiceSection config={config} channel={current.profile.channel} onSaved={load} />
    </PageContainer>
  )
}

/** The editable half of a profile. Buffered with an explicit Save (the parent re-keys on
 *  `generatedAt`, so a save reseeds the form from what the server actually stored). */
function ProfileForm({ config, onSaved }: { config: ChannelConfig; onSaved: (c: ChannelsConfig) => void }) {
  const { profile, defaults, overridden } = config
  const [label, setLabel] = React.useState(profile.label)
  const [bodyKind, setBodyKind] = React.useState(profile.bodyKind)
  const [voiceNotes, setVoiceNotes] = React.useState(profile.voiceNotes)
  const [requires, setRequires] = React.useState(profile.requires.join(', '))
  const [recommends, setRecommends] = React.useState((profile.recommends ?? []).join(', '))
  const [perUnitChars, setPerUnitChars] = React.useState(String(profile.limits.perUnitChars ?? ''))
  const [titleChars, setTitleChars] = React.useState(String(profile.limits.titleChars ?? ''))
  const [unitMin, setUnitMin] = React.useState(String(profile.limits.units?.[0] ?? ''))
  const [unitMax, setUnitMax] = React.useState(String(profile.limits.units?.[1] ?? ''))
  const [unitKind, setUnitKind] = React.useState(profile.limits.unitKind ?? '')
  const [busy, setBusy] = React.useState(false)
  const [err, setErr] = React.useState<string | null>(null)

  const num = (v: string): number | undefined => (v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined)

  const save = (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setErr(null)
    const min = num(unitMin)
    const max = num(unitMax)
    const limits = {
      ...(num(perUnitChars) !== undefined ? { perUnitChars: num(perUnitChars) } : {}),
      ...(num(titleChars) !== undefined ? { titleChars: num(titleChars) } : {}),
      ...(min !== undefined && max !== undefined ? { units: [min, max] } : {}),
      ...(unitKind ? { unitKind } : {}),
    }
    void trpc.channelsProfileSet
      .mutate({
        channel: profile.channel,
        label,
        bodyKind,
        voiceNotes,
        requires,
        recommends,
        // '' is the "back to the shipped default" signal, which is exactly what an emptied form means.
        limits: Object.keys(limits).length ? JSON.stringify(limits) : '',
      })
      .then((d) => onSaved(d as unknown as ChannelsConfig))
      .catch((e2: unknown) => setErr(String(e2)))
      .finally(() => setBusy(false))
  }

  const reset = async () => {
    if (
      !(await confirm({
        title: `Reset ${profile.label} to defaults?`,
        message: `Drops every change the team has made to this channel's profile (${overridden.join(', ')}) and puts back what the release ships. The voice files are not touched.`,
        confirmLabel: 'Reset',
        danger: true,
      }))
    )
      return
    setBusy(true)
    void trpc.channelsProfileReset
      .mutate({ channel: profile.channel })
      .then((d) => onSaved(d as unknown as ChannelsConfig))
      .catch((e2: unknown) => setErr(String(e2)))
      .finally(() => setBusy(false))
  }

  /** A field the team has changed, with what it used to be - so "is this ours or theirs?" is
   *  answerable without a git checkout. */
  const Overlaid = ({ field, was }: { field: string; was: React.ReactNode }) =>
    overridden.includes(field) ? (
      <span className='text-fg-4'>
        edited · default: <span className='text-muted-foreground'>{was}</span>
      </span>
    ) : null

  return (
    <form onSubmit={save} className='mt-6 flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 shadow-(--shadow-sm)'>
      <div className='flex items-center justify-between gap-3'>
        <h2 className='text-label uppercase tracking-[0.07em] text-muted-foreground'>Profile</h2>
        {overridden.length > 0 && (
          <Button type='button' variant='ghost' size='sm' disabled={busy} onClick={() => void reset()}>
            <RotateCcw /> Reset to defaults
          </Button>
        )}
      </div>

      <div className='grid grid-cols-2 gap-3'>
        <label className='flex flex-col gap-1 text-label text-muted-foreground'>
          Label <Overlaid field='label' was={defaults.label} />
          <input value={label} onChange={(e) => setLabel(e.target.value)} className={inputCls} />
        </label>
        <label className='flex flex-col gap-1 text-label text-muted-foreground'>
          Body shape <Overlaid field='bodyKind' was={defaults.bodyKind} />
          <Select
            value={bodyKind}
            onValueChange={(v) => setBodyKind(v ?? "")}
            items={BODY_KINDS.map((k) => ({ value: k, label: k }))}>
            <SelectTrigger aria-label='Body shape' className='w-full'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {BODY_KINDS.map((k) => (
                <SelectItem key={k} value={k}>
                  {k}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      </div>

      <div className='flex flex-col gap-1 text-label text-muted-foreground'>
        Limits <Overlaid field='limits' was={JSON.stringify(defaults.limits)} />
        <span className='text-fg-4'>
          Blank means "no limit of this kind". A range needs both ends; the counter in the editor and the
          verify gate both read these.
        </span>
        <div className='grid grid-cols-5 gap-2'>
          <input value={perUnitChars} onChange={(e) => setPerUnitChars(e.target.value)} placeholder='per unit chars' className={inputCls} aria-label='Max characters per unit' />
          <input value={titleChars} onChange={(e) => setTitleChars(e.target.value)} placeholder='title chars' className={inputCls} aria-label='Max title characters' />
          <input value={unitMin} onChange={(e) => setUnitMin(e.target.value)} placeholder='units min' className={inputCls} aria-label='Minimum units' />
          <input value={unitMax} onChange={(e) => setUnitMax(e.target.value)} placeholder='units max' className={inputCls} aria-label='Maximum units' />
          <Select
            value={unitKind}
            onValueChange={(v) => setUnitKind(v ?? "")}
            items={[{ value: '', label: '(none)' }, ...UNIT_KINDS.map((k) => ({ value: k, label: k }))]}>
            <SelectTrigger aria-label='What units counts' className='w-full'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value=''>(none)</SelectItem>
              {UNIT_KINDS.map((k) => (
                <SelectItem key={k} value={k}>
                  {k}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <label className='flex flex-col gap-1 text-label text-muted-foreground'>
        Style note <Overlaid field='voiceNotes' was={defaults.voiceNotes} />
        <span className='text-fg-4'>One line. The iterable rules live in the voice files below.</span>
        <textarea value={voiceNotes} onChange={(e) => setVoiceNotes(e.target.value)} rows={2} className={cn(inputCls, 'resize-y')} />
      </label>

      <div className='grid grid-cols-2 gap-3'>
        <label className='flex flex-col gap-1 text-label text-muted-foreground'>
          Requires <Overlaid field='requires' was={defaults.requires.join(', ') || '(none)'} />
          <span className='text-fg-4'>Comma-separated. Missing one FAILS verify.</span>
          <input value={requires} onChange={(e) => setRequires(e.target.value)} placeholder='e.g. subreddit' className={inputCls} />
        </label>
        <label className='flex flex-col gap-1 text-label text-muted-foreground'>
          Recommends <Overlaid field='recommends' was={(defaults.recommends ?? []).join(', ') || '(none)'} />
          <span className='text-fg-4'>Comma-separated. Missing one WARNS.</span>
          <input value={recommends} onChange={(e) => setRecommends(e.target.value)} placeholder='e.g. flair' className={inputCls} />
        </label>
      </div>

      <div className='flex flex-col gap-1 rounded-lg border border-border bg-bg px-3 py-2 text-label text-muted-foreground'>
        <span className='flex items-center gap-2'>
          Publish
          <Badge variant={profile.publish.auto ? 'accent' : 'neutral'}>
            {profile.publish.auto ? 'sends for you' : 'you post it'}
          </Badge>
          <span className='text-fg-4'>mode: {profile.publish.mode}</span>
        </span>
        <span className='text-fg-4'>
          {profile.publish.tool ?? 'no tool'}
          {profile.publish.costNote ? ` · ${profile.publish.costNote}` : ''}
        </span>
        <span className='text-fg-4'>
          Not editable: this describes what CODE exists. Turning "sends for you" on for a channel with no
          runner would make every confirm dialog here promise a send nothing performs.
        </span>
      </div>

      {err && <p className='text-label text-danger'>{err}</p>}

      <div className='flex items-center justify-end'>
        <Button type='submit' size='sm' disabled={busy}>
          <Save /> {busy ? 'Saving…' : 'Save profile'}
        </Button>
      </div>
    </form>
  )
}

/** The channel's voice file plus its per-author overlays. One editor at a time - the layers are read
 *  in order by the skills, and showing four textareas at once invites editing the wrong one. */
function VoiceSection({ config, channel, onSaved }: { config: ChannelsConfig; channel: string; onSaved: () => void }) {
  const overlays = config.voiceLayers.filter((l) => l.channel === channel && l.author)
  const [author, setAuthor] = React.useState<string | null>(null)
  // Reset the selected overlay when the channel changes - an overlay for the previous channel's
  // author would silently open a different file.
  React.useEffect(() => setAuthor(null), [channel])

  const missing = config.authors.filter((a) => !overlays.some((o) => o.author === a))

  return (
    <section className='mt-6 flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 shadow-(--shadow-sm)'>
      <div className='flex flex-wrap items-center gap-2'>
        <h2 className='text-label uppercase tracking-[0.07em] text-muted-foreground'>Voice</h2>
        <span className='text-label text-fg-4'>
          read after <code>global.md</code> and <code>@author.md</code>, both edited in the repo
        </span>
      </div>

      <div className='flex flex-wrap gap-1.5'>
        <LayerChip active={author === null} onClick={() => setAuthor(null)} label={`${channel}.md`} />
        {overlays.map((o) => (
          <LayerChip key={o.author} active={author === o.author} onClick={() => setAuthor(o.author)} label={`@${o.author}`} />
        ))}
        {missing.length > 0 && (
          <Select
            value=''
            onValueChange={(v) => v && setAuthor(v)}
            items={[{ value: '', label: 'Add overlay…' }, ...missing.map((a) => ({ value: a, label: a }))]}>
            <SelectTrigger aria-label='Add an author overlay' className='h-[34px]'>
              <span className='text-muted-foreground'>Add overlay…</span>
            </SelectTrigger>
            <SelectContent>
              {missing.map((a) => (
                <SelectItem key={a} value={a}>
                  {a}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      <VoiceEditor key={`${channel}@${author ?? ''}`} channel={channel} author={author} onSaved={onSaved} />
    </section>
  )
}

function LayerChip({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type='button'
      onClick={onClick}
      className={cn(
        'rounded-md border px-2.5 py-1.5 font-mono text-label transition-colors',
        active ? 'border-accent bg-bg text-text' : 'border-border text-muted-foreground hover:border-accent/40 hover:text-text',
      )}>
      {label}
    </button>
  )
}

/** One layer's markdown, loaded on select and saved whole. Plain textarea on purpose: these are
 *  rules an agent parses, so what you type is what it reads - a WYSIWYG would put its own markup
 *  between the two. */
function VoiceEditor({ channel, author, onSaved }: { channel: string; author: string | null; onSaved: () => void }) {
  const [content, setContent] = React.useState<string | null>(null)
  const [saved, setSaved] = React.useState('')
  const [path, setPath] = React.useState('')
  const [exists, setExists] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [err, setErr] = React.useState<string | null>(null)

  React.useEffect(() => {
    let live = true
    void trpc.channelsVoiceRead
      .mutate({ channel, ...(author ? { author } : {}) })
      .then((f) => {
        if (!live) return
        const file = f as unknown as { path: string; exists: boolean; content: string }
        setContent(file.content)
        setSaved(file.content)
        setPath(file.path)
        setExists(file.exists)
      })
      .catch((e: unknown) => live && setErr(String(e)))
    return () => {
      live = false
    }
  }, [channel, author])

  const save = () => {
    setBusy(true)
    setErr(null)
    void trpc.channelsVoiceSave
      .mutate({ channel, ...(author ? { author } : {}), content: content ?? '' })
      .then((f) => {
        const file = f as unknown as { content: string; exists: boolean }
        setSaved(file.content)
        setExists(file.exists)
        onSaved()
      })
      .catch((e: unknown) => setErr(String(e)))
      .finally(() => setBusy(false))
  }

  if (content === null) return <p className='text-body-sm text-muted-foreground'>Loading…</p>

  return (
    <>
      <div className='flex items-center gap-2 text-label text-fg-4'>
        <code>{path}</code>
        {!exists && <Badge variant='neutral'>new file</Badge>}
      </div>
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={18}
        spellCheck={false}
        aria-label={`Voice rules for ${channel}${author ? ` as ${author}` : ''}`}
        className={cn(inputCls, 'resize-y font-mono text-label leading-relaxed')}
      />
      {err && <p className='text-label text-danger'>{err}</p>}
      <div className='flex items-center justify-end gap-2'>
        {content !== saved && <span className='text-label text-fg-4'>unsaved changes</span>}
        <Button type='button' size='sm' disabled={busy || content === saved} onClick={save}>
          <Save /> {busy ? 'Saving…' : 'Save voice file'}
        </Button>
      </div>
    </>
  )
}

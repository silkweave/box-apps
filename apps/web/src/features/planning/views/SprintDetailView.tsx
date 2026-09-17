import { useState } from 'react'
import { useNavigate, useParams } from '@tanstack/react-router'
import { CalendarRange, LayoutGrid, Rocket, SlidersHorizontal } from 'lucide-react'
import { cn } from '@/lib/utils'
import { PageContainer, TopBarActions, TopBarCenter, Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@silkweave/box-ui'
import { SprintBoard } from '../components/sprint/SprintBoard.tsx'
import { SprintDesign } from '../components/sprint/SprintDesign.tsx'
import { SprintPlanning } from '../components/sprint/SprintPlanning.tsx'
import { SprintStatusButton } from '../components/sprint/SprintStatusButton.tsx'
import { TaskDialog } from '../components/TaskDialog.tsx'
import { upsertSprint, useSprintDetail } from '../lib/useSprintsData.ts'
import { useUsersData } from '../../../lib/useUsersData.ts'
import { SPRINT_STATUSES, SPRINT_STATUS_META, type SprintDetail, type SprintStatus } from '../sprint-types.ts'

// One sprint, one surface, three tabs - Design, Planning, Board. The tabs are always reachable and
// the one that OPENS is chosen from the status (see `defaultTab`): a sprint's availability is a
// thing you fix mid-flight, and making that mean "move the sprint backwards" would be a state
// machine punishing an honest edit.
//
// **The view draws no header of its own** (2026-09-07). It used to: a serif title, a meta line and a
// tab strip, ~140px of chrome above three surfaces whose entire value is how much calendar fits. All
// three pieces already had a home in the top bar - the breadcrumb names the sprint, so repeating it
// as a title said the same thing twice - so the tabs portal into the bar's CENTRE and the status
// control into its right, and what is left below the bar is the surface. The window, the counts and
// the title now live where they are EDITED, in Design, rather than being restated on every tab.
//
// The status control is the only place a refusal can surface, and it must: the server refuses
// `scheduled` without dates and `planned` while any day is provably over capacity, naming the worst
// three. That message is the thing the operator has to act on, so it is rendered verbatim rather
// than flattened into "could not save" - now in a banner at the top of the surface, since there is
// no header left to hold it.

const TABS = [
  { id: 'design', label: 'Design', icon: SlidersHorizontal, hint: 'Dates, and who is available for how long' },
  { id: 'planning', label: 'Planning', icon: LayoutGrid, hint: 'Pull tasks in, then put them on days' },
  { id: 'board', label: 'Board', icon: CalendarRange, hint: 'The running sprint: standup plus the week' },
] as const

type TabId = (typeof TABS)[number]['id']

/**
 * Which tab a sprint OPENS on: the STATUS decides, because the status says which step the sprint is
 * waiting on. Pending still needs its window and roster (Design); scheduled has them and needs tasks
 * (Planning); planned has passed the capacity check, so what is left is to run it (Board), and so
 * are active and done.
 *
 * This reverses the 2026-09-07 rule that let the WINDOW win ("today falls inside it, so open the
 * Board"). That rule existed because every sprint then sat in `scheduled` and nobody drove the
 * lifecycle, but it opened a sprint created on its own first morning - pending, no roster, nothing
 * slotted - on a Board with nothing to show, one click away from the step it actually needed.
 */
const TAB_FOR_STATUS: Record<SprintStatus, TabId> = {
  pending: 'design',
  scheduled: 'planning',
  planned: 'board',
  active: 'board',
  done: 'board',
}

function defaultTab(sprint: SprintDetail): TabId {
  // The server refuses anything past pending without both dates; a row that slipped through still
  // has nothing to plan or run until its window exists.
  if (!sprint.start_date || !sprint.end_date) return 'design'
  return TAB_FOR_STATUS[sprint.status] ?? 'design'
}

export function SprintDetailView() {
  const { id, tab } = useParams({ strict: false }) as { id?: string; tab?: string }
  const navigate = useNavigate()
  const { detail, error } = useSprintDetail(id)
  const { data: users } = useUsersData()
  const [failure, setFailure] = useState<string | null>(null)
  // A card click opens the task HERE rather than routing away: planning is a comparing activity, and
  // leaving the grid to change one size loses the column you were reading.
  const [openTaskId, setOpenTaskId] = useState<string | null>(null)

  if (error) return <PageContainer><p className='text-body-sm text-danger'>{error}</p></PageContainer>
  if (!detail || !id) return <PageContainer><p className='text-body-sm text-muted-foreground'>Loading…</p></PageContainer>

  const active: TabId = TABS.some((t) => t.id === tab) ? (tab as TabId) : defaultTab(detail)

  const save = (patch: Parameters<typeof upsertSprint>[0]): void => {
    setFailure(null)
    void upsertSprint(patch).catch((e: unknown) => setFailure(e instanceof Error ? e.message : String(e)))
  }

  return (
    <PageContainer width='flush' className='flex h-full min-h-0 flex-col'>
      <TopBarCenter>
        <nav
          className='inline-flex h-8 items-center rounded-md border border-border bg-bg p-0.5'
          aria-label='Sprint views'>
          {TABS.map(({ id: tid, label, icon: Icon, hint }) => (
            <button
              key={tid}
              type='button'
              title={hint}
              aria-current={active === tid ? 'page' : undefined}
              onClick={() => void navigate({ to: '/sprints/$id/$tab', params: { id, tab: tid } })}
              className={cn(
                'inline-flex h-full items-center gap-1.5 rounded-sm px-2.5 text-body-sm transition-colors',
                active === tid
                  ? 'bg-accent-tint font-medium text-text'
                  : 'text-muted-foreground hover:text-text',
              )}>
              <Icon className='size-3.5' />
              {label}
            </button>
          ))}
        </nav>
      </TopBarCenter>

      <TopBarActions>
        <SprintStatusButton sprint={detail} users={users ?? []} />
        {/* The badge that used to sit beside this is gone: the select already SHOWS the status, and
            a badge repeating it in colour beside it was two controls' worth of width for one fact. */}
        <Select
          value={detail.status}
          onValueChange={(next) => save({ id: detail.id, status: next as SprintStatus })}
          items={SPRINT_STATUSES.map((s) => ({ value: s, label: SPRINT_STATUS_META[s].label }))}>
          <SelectTrigger aria-label='Sprint status' className='h-8 w-36'>
            <SelectValue>{(v) => SPRINT_STATUS_META[v as SprintStatus].label}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {SPRINT_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                <span className='flex flex-col'>
                  <span className='font-medium'>{SPRINT_STATUS_META[s].label}</span>
                  <span className='text-label text-muted-foreground'>{SPRINT_STATUS_META[s].hint}</span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {detail.status === 'planned' && (
          <Button size='sm' onClick={() => save({ id: detail.id, status: 'active' })}>
            <Rocket /> Kick off
          </Button>
        )}
      </TopBarActions>

      {failure && (
        <p className='shrink-0 border-b border-danger/40 bg-danger-bg px-3 py-2 text-body-sm text-danger'>
          {failure}
        </p>
      )}

      {/* The tab body OWNS the remaining height rather than growing the page: the frame already
          scrolls the sidebar and the calendar inside their own boxes, and a second scrollbar on the
          page is the dead white space under a grid that had already capped itself. */}
      <div className='flex min-h-0 flex-1 flex-col'>
        {active === 'design' && <SprintDesign sprint={detail} users={users ?? []} onError={setFailure} />}
        {/* No padding here: the planning sidebar is flush to the frame and owns the padding on its
            own side, so a gutter around the whole thing would float it off the edge again. */}
        {active === 'planning' && (
          <SprintPlanning sprint={detail} users={users ?? []} onError={setFailure} onOpenTask={setOpenTaskId} />
        )}
        {active === 'board' && (
          <div className='flex min-h-0 flex-1 flex-col p-3'>
            <SprintBoard sprint={detail} users={users ?? []} onError={setFailure} onOpenTask={setOpenTaskId} />
          </div>
        )}
      </div>

      {/* The sprint's own tasks ride along because a SPRINT task has no initiative, so the board
          store the dialog normally reads never sees it. */}
      <TaskDialog taskId={openTaskId} onClose={() => setOpenTaskId(null)} sprintTasks={detail.tasks} />
    </PageContainer>
  )
}

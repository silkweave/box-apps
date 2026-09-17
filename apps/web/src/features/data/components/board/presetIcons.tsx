// The icons a preset may wear, and the picker for choosing one.
//
// A CLOSED set, deliberately. Lucide ships well over a thousand icons and resolving one by name at
// runtime would mean either bundling all of them or a dynamic import per icon - for a decoration.
// Thirty-odd covers "what is this preset about" (a stage, a number, a person, a risk, a deadline)
// without turning the picker into a search problem.
//
// The stored value is just a string. An icon key we do not recognise falls back to the default
// rather than erroring, which is what lets the set be trimmed or renamed in a later release without
// stranding anyone's preset - the same repair-not-reset posture the view state itself has.

import {
  Activity,
  AlertTriangle,
  BarChart3,
  Bookmark,
  Briefcase,
  Bug,
  Building2,
  CalendarDays,
  CheckCircle2,
  Clock,
  Compass,
  DollarSign,
  Eye,
  Flag,
  Flame,
  GitBranch,
  Handshake,
  Heart,
  Inbox,
  KanbanSquare,
  LayoutGrid,
  Lightbulb,
  List,
  Package,
  Rocket,
  Sparkles,
  Star,
  Target,
  TrendingUp,
  Users,
  Wrench,
  Zap,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { NavIcon } from '@silkweave/box-ui'

/** key → component. The key is what gets stored; the order here is the order in the picker grid. */
export const PRESET_ICONS: Record<string, NavIcon> = {
  bookmark: Bookmark,
  star: Star,
  flag: Flag,
  target: Target,
  compass: Compass,
  eye: Eye,
  'layout-grid': LayoutGrid,
  list: List,
  kanban: KanbanSquare,
  inbox: Inbox,
  calendar: CalendarDays,
  clock: Clock,
  'trending-up': TrendingUp,
  'bar-chart': BarChart3,
  activity: Activity,
  'dollar-sign': DollarSign,
  briefcase: Briefcase,
  building: Building2,
  users: Users,
  handshake: Handshake,
  heart: Heart,
  rocket: Rocket,
  sparkles: Sparkles,
  zap: Zap,
  flame: Flame,
  'alert-triangle': AlertTriangle,
  bug: Bug,
  wrench: Wrench,
  package: Package,
  'git-branch': GitBranch,
  lightbulb: Lightbulb,
  'check-circle': CheckCircle2,
}

export type PresetIconKey = keyof typeof PRESET_ICONS

/** What a view with no icon of its own wears. */
export const DEFAULT_PRESET_ICON: PresetIconKey = 'bookmark'

/** What an initiative KIND with no icon of its own wears (this set is shared with Settings →
 *  Initiative kinds - one icon vocabulary for everything the team names on a board). A different
 *  default from a preset's on purpose: a kind is a lane, not a saved lens. */
export const DEFAULT_KIND_ICON: PresetIconKey = 'layout-grid'

/** The component for a stored key - unknown or absent falls back, never throws. */
export const presetIcon = (key: string | null | undefined): NavIcon =>
  (key && PRESET_ICONS[key]) || PRESET_ICONS[DEFAULT_PRESET_ICON]

/** The picker grid. Small enough to sit inside the save popover, which is the point: choosing an
 *  icon is part of naming a view, not a second trip to a settings screen. */
export function PresetIconPicker({
  value,
  onChange,
}: {
  value: string
  onChange: (key: string) => void
}) {
  return (
    <div className='grid grid-cols-8 gap-0.5' role='radiogroup' aria-label='View icon'>
      {Object.entries(PRESET_ICONS).map(([key, Icon]) => {
        const on = key === value
        return (
          <button
            key={key}
            type='button'
            role='radio'
            aria-checked={on}
            aria-label={key}
            title={key}
            onClick={() => onChange(key)}
            className={cn(
              'inline-flex size-7 items-center justify-center rounded transition-colors',
              on ? 'bg-accent-tint text-accent' : 'text-muted-foreground hover:bg-accent-tint hover:text-text',
            )}>
            <Icon className='size-4' />
          </button>
        )
      })}
    </div>
  )
}

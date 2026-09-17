// The vocabulary-FREE half of a module's board machinery: persistence, the repair-not-reset read,
// preset resolution, and the structural equality that tells "you are on a preset" from "you edited
// it". Three modules use it (Content, the CRM, Initiatives) and they share none of their axes - so
// what is lifted here is deliberately only the part that has no opinion about what a filter IS.
//
// The split, stated once so the next module does not have to rediscover it:
//
//   • HERE: how a view is stored, repaired, named, saved, selected and compared. Subtle, easy to get
//     wrong, and identical for every module - a second hand-rolled copy would drift.
//   • IN EACH MODULE's own `*View.ts`: what the columns/filters/sorts/groupings mean, what the
//     default presets are, and how rows are filtered/sorted/grouped. Forcing those into one union
//     type is how you end up with a `Filters` carrying `value_customer` for accounts and `channel`
//     for content.
//
// A module supplies its own `normalize` (which decides how a stored view of ITS shape is repaired),
// its own `same`, and its default presets; everything below is mechanical.
//
// TWO STORAGE TIERS, and the line between them is the load-bearing idea:
//
//   • PRESETS ARE GLOBAL - one shared list per module in tenant config, over `presets.ts`. A named
//     lens is a team artifact ("the Friday view"), so everyone sees the same names and any internal
//     user may edit any of them. There is no personal tier and no unchangeable tier: the built-ins
//     are a seed, not a floor (2026-08-12).
//   • THE LIVE VIEW stays per-browser localStorage. What you have filtered right now is a cursor, not
//     an artifact; syncing it would mean one person's filter click moving everybody else's screen.
//
// WHICH PRESET YOU ARE ON LIVES IN THE URL (`?preset=Critical%20path`, 2026-08-12). It is the one
// piece of view state that is worth sharing in a link and worth having a back button, and putting it
// in the query string makes both free. localStorage still remembers which preset the live state was
// derived from - that is what tells a fresh navigation ("apply this preset") from a reload of your own
// half-edited session ("leave my filters alone"), and the two would be indistinguishable from the URL
// alone.
//
// The live view is a MODULE-level store rather than per-component state, because two components read
// it at once (the sidebar's preset list and the board itself) and two `useState`s would drift apart
// the moment either one wrote.

import { useCallback, useEffect, useState } from 'react'
import type { BoardLayout, SortDir } from '@silkweave/box-ui/board'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { readStored, writeStored } from '../../../lib/usePersistedState.ts'
import { isStringArray } from '../../../lib/guards.ts'
import {
  deletePreset,
  reorderPresets,
  savePreset,
  seedPresets,
  updatePreset,
  usePresets,
  type PresetModule,
  type PresetRecord,
  type PresetSeed,
} from './presets.ts'

/**
 * The two axes the library's board bar also reads, re-exported so a module names them once. They are
 * ITS types on purpose: a stored view and the control that edits it have to agree about what "board"
 * and "desc" are, and one vocabulary across the three modules is what keeps a shared `normalize`
 * from needing a per-module table. (The CRM calls its board a "Pipeline" - that is a LABEL.)
 */
export type { BoardLayout, SortDir }

/** The axes every module's view state carries. Each narrows them to its own enums; this is the
 *  shape the shared bar and store are allowed to assume. */
export interface BaseViewState {
  search: string
  layout: BoardLayout
  groupBy: string
  /** OPTIONAL, because a module may have no sort axis at all - Initiatives has none (2026-08-13):
   *  its rows sit in the order they were created and only its tasks are arranged by hand. A module
   *  without one hands the bar an empty `sort` list and the control never renders. */
  sort?: string
  sortDir?: SortDir
  /** Axis key → selected values. Narrowed per module (`CrmFilters`), read loosely here. */
  filters: object
  /** Optional column keys, IN RENDER ORDER, in the module's own vocabulary. */
  columns: readonly string[]
}

/** One preset as the UI sees it - the server record with its state already repaired to `S`. */
export interface Preset<S> {
  name: string
  description: string | null
  state: S
  /** Icon key (`components/board/presetIcons`), or null for the default. */
  icon: string | null
  updated_at: string
  updated_by: string | null
}

/** What a module's view hook hands its components. */
export interface ViewStore<S> {
  view: S
  setView: (next: S | ((prev: S) => S)) => void
  /** Update one field of the live view. */
  patch: <K extends keyof S>(key: K, value: S[K]) => void
  /** The team's presets for this module, in their order (empty until the first fetch lands). */
  presets: Preset<S>[]
  /**
   * The preset the URL points at, or null. It does NOT go away when you edit a filter - the picker
   * keeps showing the lens you came from and marks it changed instead, because "Custom view" threw
   * away the one fact you need to decide between saving over it and saving a new one.
   */
  selected: string | null
  /** The live state differs from what `selected` shows - or, with nothing selected, from the module
   *  default. This is what puts Save New / Save Existing / Reset on screen. */
  dirty: boolean
  select: (name: string) => void
  /** Create or overwrite a preset with what is on screen. */
  save: (name: string, icon?: string | null, description?: string | null) => Promise<void>
  /**
   * Edit one existing preset's TITLE, one-liner or icon in place; omitted fields are left alone.
   * Deliberately cannot rewrite what a preset SHOWS - that is `save`, from the bar, where you are
   * looking at exactly what you would be storing. The manage dialog used to offer it too and had to
   * ask "are you sure" precisely because from there it could be aimed at a preset you were not
   * looking through.
   */
  update: (
    name: string,
    patch: { name?: string; description?: string | null; icon?: string | null },
  ) => Promise<void>
  /** Set the team's order for this module (names in their new order). */
  reorder: (names: string[]) => Promise<void>
  /** Delete a preset - for everyone. */
  remove: (name: string) => Promise<void>
  /** Re-add any built-in the team has deleted. Never touches a preset that is still there. */
  restoreDefaults: () => Promise<void>
  /** True when at least one built-in is missing, i.e. "Restore default presets" has work to do. */
  missingDefaults: number
  /** Throw away the edits: back to what `selected` shows, or to the module default when nothing is
   *  selected (which also clears the URL). */
  reset: () => void
  /** The shared list has not arrived yet. */
  loading: boolean
  /** The last read or write failure, for the bar to show verbatim. */
  error: string | null
}

export interface ViewStoreSpec<S extends BaseViewState> {
  /** Module id as the server knows it - which shared list this store reads. */
  module: PresetModule
  /** localStorage prefix, e.g. `appKey('crm')` - the LIVE view hangs off it. */
  storageKey: string
  defaultView: S
  /** The module's built-in presets. A SEED: written to the team's list the first time anybody opens
   *  the module, and ordinary editable records from that moment on. */
  defaultPresets: { name: string; description: string; icon: string; state: S }[]
  /**
   * Read one stored view, REPAIRING what can be repaired and returning null only when the value is
   * not a view at all. A stored preset is the team's own work, so a release that renames a column
   * migrates it rather than silently dropping the preset.
   */
  normalize: (raw: unknown) => S | null
  /** Structural equality - compared field by field, never by JSON string (key order does not
   *  survive a normalize round trip, and a reloaded preset must not read as "Custom view"). */
  same: (a: S, b: S) => boolean
}

/**
 * Build a module's view hook: a shared live-view store plus the team's presets off the server.
 */
export function createViewStore<S extends BaseViewState>(spec: ViewStoreSpec<S>): () => ViewStore<S> {
  const liveKey = `${spec.storageKey}.view`
  const basedOnKey = `${spec.storageKey}.basedOn`
  const seed: PresetSeed[] = spec.defaultPresets.map((p) => ({
    name: p.name,
    description: p.description,
    icon: p.icon,
    state: p.state,
  }))

  // --- the live view: one module-level value, localStorage-backed, subscribed by every consumer ---
  let live: S | null = null
  const listeners = new Set<() => void>()
  const emit = (): void => listeners.forEach((l) => l())
  const readLive = (): S => (live ??= readStored(liveKey, spec.defaultView, undefined, spec.normalize))
  const writeLive = (next: S): void => {
    live = next
    writeStored(liveKey, next)
    emit()
  }

  // Which preset this edit session started from. Kept beside the view rather than inside it: it is
  // bookkeeping about where you came from, not part of what the board shows, so it must not reach
  // the module's `normalize`, its `same` (a view would stop matching itself), or the state that gets
  // written to the shared list. `undefined` = not read from storage yet, `null` = came from nowhere.
  let basedOn: string | null | undefined
  const readBasedOn = (): string | null =>
    (basedOn ??= readStored<string | null>(basedOnKey, null, (v) => v === null || typeof v === 'string'))
  const writeBasedOn = (next: string | null): void => {
    basedOn = next
    writeStored(basedOnKey, next)
    emit()
  }

  // --- the one-time install of this module's built-ins ---------------------------------------------
  // Fired at most once per page load per module, and a no-op on the server once the module is in
  // `seeded` - so the guard against re-adding a deleted preset lives server-side, where two tabs
  // opening the board at the same moment cannot race it.
  let seeding: Promise<void> | null = null

  return function useViewStore(): ViewStore<S> {
    const [local, setLocal] = useState<{ view: S; basedOn: string | null }>(() => ({
      view: readLive(),
      basedOn: readBasedOn(),
    }))
    const [writeError, setWriteError] = useState<string | null>(null)
    const { data, error: readError } = usePresets()
    const view = local.view
    // `strict: false` because one store serves several routes (a board index and its detail children),
    // and none of them declares this param - it is view state that happens to live in the URL, not
    // part of any route's contract.
    const search = useSearch({ strict: false }) as { preset?: unknown }
    const navigate = useNavigate()
    const urlName = typeof search.preset === 'string' && search.preset.trim() ? search.preset.trim() : null
    /** Write (or clear) `?preset=` without adding a history entry - selecting a lens is not a page. */
    const setUrl = useCallback(
      (name: string | null) =>
        void navigate({
          // No route here declares `preset`, so the reducer is typed against an empty search shape -
          // the cast is the price of keeping this out of every route's contract (see `strict: false`).
          search: ((prev: Record<string, unknown>) => ({ ...prev, preset: name ?? undefined })) as never,
          replace: true,
        }),
      [navigate],
    )

    useEffect(() => {
      const sync = (): void => setLocal({ view: readLive(), basedOn: readBasedOn() })
      listeners.add(sync)
      sync()
      return () => {
        listeners.delete(sync)
      }
    }, [])

    useEffect(() => {
      if (!data || data.seeded.includes(spec.module) || seeding) return
      seeding = seedPresets(spec.module, seed, 'initial').catch(() => {
        // Leave it unset so the next load retries; an unseeded module renders its (empty) list
        // rather than blocking the board.
        seeding = null
      })
    }, [data])

    // Repair each preset through THIS module's normalize; one the client cannot parse at all is
    // hidden rather than shown broken (it stays on disk, so a fix is a release away, not a re-entry).
    const presets: Preset<S>[] = (data?.modules[spec.module] ?? []).flatMap((r: PresetRecord) => {
      const state = spec.normalize(r.state)
      return state
        ? [{ name: r.name, description: r.description, state, icon: r.icon, updated_at: r.updated_at, updated_by: r.updated_by }]
        : []
    })

    const setView = useCallback((next: S | ((prev: S) => S)) => {
      writeLive(typeof next === 'function' ? (next as (prev: S) => S)(readLive()) : next)
    }, [])

    // The URL names the selection; `presets` decides whether that name still resolves. A link to a
    // preset that has since been renamed or deleted selects nothing rather than showing a title the
    // list does not contain.
    const selectedPreset = urlName ? (presets.find((v) => v.name === urlName) ?? null) : null
    const selected = selectedPreset?.name ?? null
    // Nothing selected is not "nothing to save": you can arrive on a bare board, set it up, and want
    // that as a preset. So the comparison falls back to the module default, and the bar offers Save
    // New and Reset (but not Save Existing - there is nothing to overwrite).
    const dirty = !spec.same(selectedPreset ? selectedPreset.state : spec.defaultView, view)

    // Keep the URL and the live view in step, in both directions:
    //  • a name in the URL that the live view was NOT derived from is a navigation (a link, the back
    //    button, a sidebar click) - apply it;
    //  • the same name it WAS derived from is a reload of your own session - leave your edits alone,
    //    which is the whole reason `basedOn` still exists;
    //  • a selection remembered from last time with no name in the URL puts itself back in the URL, so
    //    the address bar always says what the picker says;
    //  • a name that no longer resolves clears itself out.
    useEffect(() => {
      if (!data) return
      if (urlName) {
        const found = presets.find((v) => v.name === urlName)
        if (!found) return setUrl(null)
        if (readBasedOn() !== urlName) {
          writeBasedOn(urlName)
          setView(found.state)
        }
        return
      }
      const remembered = readBasedOn()
      if (remembered && presets.some((v) => v.name === remembered)) setUrl(remembered)
    }, [data, urlName, presets, setUrl, setView])

    const patch = useCallback(
      <K extends keyof S>(key: K, value: S[K]) => setView((prev) => ({ ...prev, [key]: value })),
      [setView],
    )

    const select = useCallback(
      (name: string) => {
        const found = presets.find((v) => v.name === name)
        if (!found) return
        // Applied here rather than left to the effect so the board does not repaint twice, and so
        // re-picking the preset you are already on (after editing it) resets you onto it.
        writeBasedOn(name)
        setView(found.state)
        setUrl(name)
      },
      [presets, setView, setUrl],
    )

    const run = useCallback(async (op: Promise<void>): Promise<void> => {
      setWriteError(null)
      try {
        await op
      } catch (e) {
        setWriteError(e instanceof Error ? e.message : String(e))
      }
    }, [])

    const save = useCallback(
      async (name: string, icon?: string | null, description?: string | null): Promise<void> => {
        const trimmed = name.trim()
        if (!trimmed) return
        await run(savePreset(spec.module, trimmed, view, icon, description))
        // You are now ON that preset - the URL says so, and a further edit offers to save back to it.
        writeBasedOn(trimmed)
        setUrl(trimmed)
      },
      [run, view, setUrl],
    )

    const update = useCallback(
      async (
        name: string,
        patch: { name?: string; description?: string | null; icon?: string | null },
      ): Promise<void> => {
        const next = patch.name?.trim()
        await run(
          updatePreset(spec.module, name, { name: next, description: patch.description, icon: patch.icon }),
        )
        // A rename carries the selection with it, in the URL and in storage - otherwise Save Existing
        // would point at a name that no longer exists and quietly re-create the preset under its old
        // title, and the address bar would still be advertising the dead one.
        if (next && next !== name && readBasedOn() === name) {
          writeBasedOn(next)
          setUrl(next)
        }
      },
      [run, setUrl],
    )

    const reorder = useCallback(async (names: string[]): Promise<void> => run(reorderPresets(spec.module, names)), [run])

    const remove = useCallback(
      async (name: string): Promise<void> => {
        await run(deletePreset(spec.module, name))
        if (readBasedOn() === name) {
          writeBasedOn(null)
          setUrl(null)
        }
      },
      [run, setUrl],
    )

    const restoreDefaults = useCallback(async (): Promise<void> => run(seedPresets(spec.module, seed, 'restore')), [run])

    // "Reset" means "put back what I was looking at", which is the selected preset when there is one.
    // Only a board with nothing selected resets to the module default, and that also drops the URL -
    // there is no lens to point at any more.
    const reset = useCallback(() => {
      if (selectedPreset) return setView(selectedPreset.state)
      writeBasedOn(null)
      setUrl(null)
      setView(spec.defaultView)
    }, [selectedPreset, setView, setUrl])

    const have = new Set(presets.map((p) => p.name))
    return {
      view,
      setView,
      patch,
      presets,
      selected,
      dirty,
      select,
      save,
      update,
      reorder,
      remove,
      restoreDefaults,
      missingDefaults: data ? spec.defaultPresets.filter((p) => !have.has(p.name)).length : 0,
      reset,
      loading: !data,
      error: writeError ?? readError,
    }
  }
}

// --- the small repair primitives every module's `normalize` needs ---------------------------------

export { isStringArray } from '../../../lib/guards.ts'

/** One value from a closed vocabulary, or the fallback. The guard behind every enum-shaped field. */
export function pickEnum<T extends string>(raw: unknown, allowed: readonly T[], fallback: T): T {
  return typeof raw === 'string' && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback
}

/**
 * Rebuild a filters record from a stored one: every key of `empty` is present, and a key whose
 * stored value is not a string array degrades to empty rather than poisoning the whole board.
 * Values are NOT checked against their vocabulary here - a retired enum value simply matches
 * nothing, which is self-healing, whereas dropping it would silently widen the user's filter.
 */
export function normalizeFilters<F extends object>(raw: unknown, empty: F): F {
  const stored = (raw ?? {}) as Record<string, unknown>
  return Object.fromEntries(
    Object.keys(empty).map((k) => [k, isStringArray(stored[k]) ? stored[k] : []]),
  ) as F
}

/** Order-insensitive list equality - the right comparison for a filter axis, where the order you
 *  happened to click the chips in means nothing. */
export const sameList = (x: readonly string[], y: readonly string[]): boolean =>
  x.length === y.length && [...x].sort().join() === [...y].sort().join()

/** Order-SENSITIVE list equality - the right comparison for columns, whose order is now something a
 *  person arranges deliberately and a preset therefore has to store. */
export const sameOrder = (x: readonly string[], y: readonly string[]): boolean =>
  x.length === y.length && x.every((v, i) => v === y[i])

/** What one row ranks as on the current sort axis. `null` means "this row has no value here". */
export type SortKey = string | number | null

/**
 * Compare two rows' sort keys.
 *
 * BLANKS ALWAYS SINK, in both directions. A row with no due date is not "the earliest" when you flip
 * the arrow - it is a row with no due date, and burying it is what every one of these boards wanted
 * back when each sort baked its own direction in. Only rows that HAVE a value get reversed.
 */
export function compareKeys(a: SortKey, b: SortKey, dir: SortDir): number {
  if (a == null || b == null) return a == null ? (b == null ? 0 : 1) : -1
  return (a < b ? -1 : a > b ? 1 : 0) * (dir === 'desc' ? -1 : 1)
}

/** Read a stored direction, falling back to whatever the chosen sort field reads naturally. */
export const pickSortDir = (raw: unknown, fallback: SortDir): SortDir =>
  raw === 'asc' || raw === 'desc' ? raw : fallback

/**
 * Every filter axis equal, key by key. Typed over `object` rather than `Record<string, string[]>`
 * because a module's own Filters narrows each axis to its enum (`CrmAccountStatus[]`), and a narrowed
 * array is not assignable to `string[]` through an index signature. The caller guarantees the shape;
 * this layer only ever reads string arrays out of it.
 */
export function sameFilters<F extends object>(a: F, b: F, empty: F): boolean {
  const [x, y] = [a as Record<string, string[]>, b as Record<string, string[]>]
  return Object.keys(empty).every((k) => sameList(x[k], y[k]))
}

/** How many dimensions are narrowing the board right now (drives the "Filter · n" badge). */
export function activeFilterCountOf(filters: object, search: string): number {
  return (
    Object.values(filters as Record<string, string[]>).reduce((n, list) => n + (list.length > 0 ? 1 : 0), 0) +
    (search.trim() ? 1 : 0)
  )
}

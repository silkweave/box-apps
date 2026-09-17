// config/pods.json - which channels expect an engagement, the recency window, and the flat karma
// rates. Committed and read at query time (like config/engagement.json), so edits apply without a
// restart. See features/engagement/SPEC.md.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { configPath } from '../../../io.js'
import type { EngagementAction, PodsConfigFile } from './types.js'

const DEFAULT_KARMA: Record<EngagementAction, number> = {
  like: 1,
  react: 1,
  repost: 2,
  comment: 5,
  crosspost: 2,
}

export function podsConfigPath(): string {
  return configPath('pods.json')
}

/** Parse config/pods.json; a missing file means "no channels expect engagement" + default karma. */
export function readPodsConfig(): PodsConfigFile {
  const file = podsConfigPath()
  if (!existsSync(file)) {
    return { windowDays: 14, channels: {}, karma: { ...DEFAULT_KARMA }, autoContent: null }
  }
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<PodsConfigFile>
  return {
    windowDays: raw.windowDays ?? 14,
    channels: raw.channels ?? {},
    karma: { ...DEFAULT_KARMA, ...raw.karma },
    autoContent: raw.autoContent?.pod ? raw.autoContent : null,
  }
}

/**
 * Flip `autoContent.enabled` in config/pods.json, preserving the rest of the file verbatim.
 * Requires an autoContent block with a pod - the toggle pauses/resumes, it never configures.
 */
export function setPodsAutoContentEnabled(enabled: boolean): PodsConfigFile {
  const file = podsConfigPath()
  if (!existsSync(file)) throw new Error('config/pods.json does not exist - nothing to toggle')
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<PodsConfigFile>
  if (!raw.autoContent?.pod) {
    throw new Error('pods.json has no autoContent config - set { pod, channels } there first')
  }
  raw.autoContent = { ...raw.autoContent, enabled }
  writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, 'utf8')
  return readPodsConfig()
}

/** Karma points for an action, from config (0 if unmapped). */
export function karmaFor(action: EngagementAction): number {
  return readPodsConfig().karma[action] ?? 0
}

/**
 * ALL actions a piece expects: the channel base from config UNIONED with the piece's advice
 * (actions list, or legacy single action). The base is "always" (e.g. linkedin → react), advice
 * ADDS the sometimes-extras (comment, repost) - it never suppresses the base. Deduped, base first.
 */
export function expectedActions(
  cfg: PodsConfigFile,
  channel: string,
  advice: { action?: EngagementAction; actions?: EngagementAction[] } | null,
): EngagementAction[] {
  const ch = cfg.channels[channel]
  const base = ch?.actions ?? (ch?.action ? [ch.action] : [])
  const extra = advice?.actions ?? (advice?.action ? [advice.action] : [])
  return [...new Set([...base, ...extra])]
}

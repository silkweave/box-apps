// Signal ownership - most signals belong to a person (github.* is one account holder's). The mapping
// lives in config/signal-owners.json (checked in, dashboard-editable) rather than in the signals
// rows, because live rows are wholesale-replaced on every re-derive. Resolution happens at READ
// time (signalsData), so edits take effect instantly - no re-derive, no restart.
//
// Resolution order for a signal:
//   1. signal override (an explicit key, which may be null = deliberately unowned/brand-level)
//   2. the channel default
//   3. the channel's account binding (account-scoped channels: 'github@bob' → accounts.json → 'bob')
//   4. null (unowned)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { channelAccountUser } from '../../../accounts.js'
import { configPath } from '../../../io.js'

export interface SignalOwnersFile {
  /** Channel → users.id default (e.g. github → alice covers every github.* signal). */
  channels: Record<string, string>
  /** signal_id → users.id override; an explicit null marks a signal deliberately unowned. */
  signals: Record<string, string | null>
}

export function signalOwnersPath(): string {
  return configPath('signal-owners.json')
}

/** Parse the config file; a missing file means "nothing is owned". Malformed JSON throws. */
export function readSignalOwnersFile(): SignalOwnersFile {
  const file = signalOwnersPath()
  if (!existsSync(file)) return { channels: {}, signals: {} }
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<SignalOwnersFile>
  return { channels: raw.channels ?? {}, signals: raw.signals ?? {} }
}

/** Pretty-print the config back to disk (2-space, sorted keys, trailing newline - diff-friendly). */
export function writeSignalOwnersFile(file: SignalOwnersFile): void {
  const path = signalOwnersPath()
  mkdirSync(dirname(path), { recursive: true })
  const sort = <V>(o: Record<string, V>): Record<string, V> =>
    Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)))
  const out: SignalOwnersFile = { channels: sort(file.channels), signals: sort(file.signals) }
  writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`, 'utf8')
}

/** The owning users.id for one signal, or null (see resolution order above). */
export function resolveSignalOwner(file: SignalOwnersFile, channel: string, signalId: string): string | null {
  if (signalId in file.signals) return file.signals[signalId]
  // Account-scoped channels resolve through the account binding - ownership falls out of the
  // account (config/accounts.json), no per-channel default needed.
  return file.channels[channel] ?? channelAccountUser(channel)
}

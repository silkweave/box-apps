// Where chat's own store lives. It was `chatPath()` in core's `io.ts` until 2026-09-13, which was
// core naming a feature's file - harmless at runtime, wrong at the seam. It resolves under the
// instance dir like every other tenant path, through core's `dataPath()`.

import { dataPath } from '../../io.js'

/** The chat SQLite file (`<instance>/chat.db`) - beside the warehouse, never inside it. Chat is
 *  many tiny interactive writes, which the warehouse's single-writer ephemeral-connection design
 *  is wrong for; see docs/SERVER.md for the rationale and the future read-only ATTACH. */
export function chatPath(): string {
  return dataPath('chat.db')
}

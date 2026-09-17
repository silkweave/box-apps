import { createContext, useContext } from 'react'

/**
 * Is the surface being rendered a DIRECT MESSAGE?
 *
 * A context rather than a prop, for one reason: the only consumer is the @-mention menu, and the
 * menu is mounted by EVERY composer - the room's, and the one an edit swaps in three components
 * deep inside MessageList. Threading a boolean through MessageList -> MessageRow -> Thread to
 * reach it would add the prop to three signatures that have no other use for it, and the edit
 * composer is exactly the one that got forgotten when this was tried as a prop.
 *
 * Default false: a surface that has not said otherwise is a named room, which is the permissive
 * case (everyone is mentionable there).
 */
const DirectRoomContext = createContext(false)

export const DirectRoomProvider = DirectRoomContext.Provider

/** True when the composer being rendered belongs to a DM. See MentionSuggest's `direct`. */
export function useDirectRoom(): boolean {
  return useContext(DirectRoomContext)
}

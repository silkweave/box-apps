import {
  Activity, Anchor, Banknote, Beaker, Bell, Book, Bookmark, Bot, Brain, Briefcase, Bug, Building, Calendar,
  Camera, CircleHelp, ClipboardList, Cloud, Code, Coffee, Compass, Cpu, CreditCard, Database, Flag, Flame,
  Gauge, Globe, Handshake, Hash, Heart, Image, Inbox, Key, Leaf, Lightbulb, Link, Lock, Mail, Map,
  Megaphone, Moon, Music, Newspaper, Package, Palette, PartyPopper, Phone, Pizza, Plane, Presentation,
  Rocket, Scissors, Server, Shield, Siren, Sparkles, Star, Sun, Target, Telescope, Terminal, Ticket, Trophy,
  Truck, Users, Wallet, Waves, Wrench, Zap
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

/**
 * The room-icon vocabulary, as components.
 *
 * A MIRROR of `CHAT_ROOM_ICONS` in `@silkweave/box-core` (`packages/core/src/chat/types.ts`), which is the
 * authority - the server validates against it and refuses anything else. It is mirrored rather
 * than imported for the same reason `chatTypes.ts` mirrors the wire DTOs: the SPA does not depend
 * on `@silkweave/box-core`. Keep the two in step; a name here that the server does not know is simply
 * unpickable (its patch 400s), and a name the server knows that is missing here renders as the
 * default rather than breaking a row.
 *
 * Static imports, not `lucide-react/dynamic`: 69 named icons tree-shake into the chunk that uses
 * them, while the dynamic map pulls the whole set and makes every row an async boundary.
 */
const ROOM_ICONS = {
  'hash': Hash, 'megaphone': Megaphone, 'rocket': Rocket, 'bug': Bug, 'code': Code, 'wrench': Wrench,
  'lightbulb': Lightbulb, 'flame': Flame, 'sparkles': Sparkles, 'star': Star, 'heart': Heart,
  'coffee': Coffee, 'music': Music, 'camera': Camera, 'image': Image, 'palette': Palette, 'book': Book,
  'bookmark': Bookmark, 'briefcase': Briefcase, 'building': Building, 'calendar': Calendar,
  'target': Target, 'trophy': Trophy, 'zap': Zap, 'shield': Shield, 'lock': Lock, 'globe': Globe,
  'compass': Compass, 'map': Map, 'users': Users, 'bot': Bot, 'brain': Brain, 'beaker': Beaker,
  'gauge': Gauge, 'cpu': Cpu, 'database': Database, 'server': Server, 'terminal': Terminal,
  'package': Package, 'truck': Truck, 'banknote': Banknote, 'credit-card': CreditCard, 'activity': Activity,
  'bell': Bell, 'inbox': Inbox, 'mail': Mail, 'phone': Phone, 'pizza': Pizza, 'plane': Plane,
  'party-popper': PartyPopper, 'leaf': Leaf, 'sun': Sun, 'moon': Moon, 'cloud': Cloud, 'anchor': Anchor,
  'key': Key, 'link': Link, 'scissors': Scissors, 'siren': Siren, 'telescope': Telescope, 'ticket': Ticket,
  'wallet': Wallet, 'waves': Waves, 'newspaper': Newspaper, 'presentation': Presentation,
  'clipboard-list': ClipboardList, 'circle-help': CircleHelp, 'flag': Flag, 'handshake': Handshake,
} satisfies Record<string, LucideIcon>

/**
 * The pickable names as a UNION, which is what makes the mirror self-checking: these are the values
 * the generated tRPC input accepts, so a name added here and not in `@silkweave/box-core` (or the other way
 * round) fails to compile at the wire boundary rather than 400ing at runtime.
 */
export type RoomIconName = keyof typeof ROOM_ICONS

/** Every pickable icon, in the order the picker lays them out (the core list's order). */
export const ROOM_ICON_NAMES = Object.keys(ROOM_ICONS) as RoomIconName[]

/**
 * The component for a room's stored icon name, with the default for null and for anything this
 * build does not know. `Hash` is that default everywhere - web sidebar, web header, and the phone -
 * so a room nobody has styled looks the way every room looked before this existed.
 */
export function roomIcon(name: string | null | undefined): LucideIcon {
  if (name === null || name === undefined) return Hash
  return (ROOM_ICONS as Record<string, LucideIcon>)[name] ?? Hash
}

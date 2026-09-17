import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'

/**
 * The chat.db migration chain: ordered, append-only, keyed by name in `schema_migrations`.
 * Two rules, and breaking either one loses data:
 *
 * 1. NEVER edit, rename or reorder a migration that has shipped. The name is the ledger key, so a
 *    rename silently re-runs the migration on every deployed database.
 * 2. Every migration that rebuilds a table asserts its row count INSIDE its own transaction, so a
 *    backfill whose join drops rows rolls back instead of committing quiet data loss.
 *
 * There is deliberately no separate baseline: `001` creates the whole schema, so a fresh database
 * runs the entire chain and the migration path is exercised on every dev boot and every test run
 * rather than once, in anger, on production data.
 */
export interface ChatMigration {
  /** Stable ledger key. The `NNN-` prefix is a reading aid; array order is authoritative. */
  name: string
  up: (db: Database.Database) => void
}

const schema: ChatMigration = {
  name: '001-chat-schema',
  up: (db) => {
    // User ids (`created_by`, `user_id`, `sender_id`, `actor_id`) are the Box's `users.id` values,
    // which
    // live in the DuckDB warehouse - a different engine - so no REFERENCES clause can hold them.
    // Integrity is the server's job: senders are always the authenticated request principal.
    db.exec(`
      CREATE TABLE rooms (
        id         TEXT PRIMARY KEY,
        slug       TEXT NOT NULL,
        topic      TEXT,
        visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'private')),
        -- The per-room seq allocator. Bumped only by ChatStore.post via
        -- UPDATE ... RETURNING, inside the posting transaction, which is what makes seq gapless.
        -- NEVER derive the next seq from MAX(seq): correct today, fatally wrong once the outbox
        -- is pruned - a quiet room's counter would restart at 1 and every reader would silently
        -- re-read history as new.
        next_seq   INTEGER NOT NULL DEFAULT 1,
        created_by TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX rooms_slug ON rooms (slug);

      -- Membership doubles as subscription (drives the sidebar) and, for private rooms, as the
      -- ACL - one table, two readings. last_read_seq makes unread a subtraction against the
      -- room's latest seq rather than a query over messages.
      CREATE TABLE room_members (
        room_id       TEXT    NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        user_id       TEXT    NOT NULL,
        joined_at     INTEGER NOT NULL,
        last_read_seq INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (room_id, user_id)
      ) WITHOUT ROWID;
      CREATE INDEX room_members_user ON room_members (user_id);

      -- The queryable entity store. The events table is the log; they stay separate so history
      -- stays a simple indexed read while replay stays exactly correct. sender_name is a
      -- WRITE-TIME snapshot of the principal's display name: users live in the warehouse, so a
      -- read-time join would cross engines on every history page, and a snapshot also keeps the
      -- audit trail honest across renames and outlives a deleted user row.
      CREATE TABLE messages (
        id          TEXT    PRIMARY KEY,
        room_id     TEXT    NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        seq         INTEGER NOT NULL,
        sender_id   TEXT    NOT NULL,
        sender_name TEXT    NOT NULL,
        body        TEXT    NOT NULL,
        created_at  INTEGER NOT NULL,
        edited_at   INTEGER,
        deleted_at  INTEGER,
        -- Doubles as the history index: (room_id, seq) serves the backwards page scan (SQLite
        -- walks an index in either direction), so no extra DESC index is needed.
        UNIQUE (room_id, seq)
      );

      -- The outbox. Two ordering keys, both load-bearing:
      --   id  - GLOBAL, strictly increasing: the live feed's resume cursor. One multiplexed feed
      --         per user spans every room they are in, so it cannot resume from a per-room
      --         counter. AUTOINCREMENT rather than a bare rowid is deliberate: a bare rowid is
      --         max(rowid) + 1, so pruning the newest row would hand the same id out twice and a
      --         resuming client would silently skip real events.
      --   seq - PER ROOM, gapless (allocated from rooms.next_seq): the history cursor and the
      --         unread arithmetic. A global counter here would make unread a query, not a
      --         subtraction.
      -- Timestamps are display data. They are never an ordering key.
      CREATE TABLE events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id    TEXT    NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        seq        INTEGER NOT NULL,
        type       TEXT    NOT NULL,
        payload    TEXT    NOT NULL,
        actor_id   TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE (room_id, seq)
      );
    `)

    // Seed the default room so a fresh install has somewhere to talk. An ordinary row, not special:
    // open-join like any other public room.
    const now = Date.now()
    db.prepare(
      `INSERT INTO rooms (id, slug, topic, created_by, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)`
    ).run(randomUUID(), 'general', 'Team-wide chat', now, now)
  }
}

const mentions: ChatMigration = {
  name: '002-mentions',
  up: (db) => {
    db.exec(`
      -- One row per (message, mentioned user): the durable record behind the notification bell.
      -- The live path is the seq-less mention.created ephemeral (see ChatEphemeralEvent); the ROW
      -- is what a reconnecting client converges on. Deliberately NOT an events outbox row: an
      -- outbox row allocates a room seq, and unread is the subtraction
      -- next_seq - 1 - last_read_seq, so a persisted mention event would fabricate phantom unread
      -- in every member's sidebar - the same trap Track 2 closed for edits and deletes. Only
      -- message.created may ever move a room's allocator.
      --
      -- user_id carries no REFERENCES clause for the same reason room_members.user_id carries
      -- none: users live in the DuckDB warehouse, another engine. room_id and seq are write-time
      -- copies from the mentioning message (same transaction, so they cannot drift): they let the
      -- bell deep-link into a room's history without touching messages. The BODY is deliberately
      -- not copied - it joins at read time, so a soft delete hides the mention with no second
      -- bookkeeping write and no stale text surviving in a second table.
      CREATE TABLE mentions (
        message_id TEXT    NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        user_id    TEXT    NOT NULL,
        room_id    TEXT    NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        seq        INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        -- NULL = unseen. Stamped once by markMentionsSeen (guarded by seen_at IS NULL, never
        -- restamped): it records when the bell first showed the mention, and rewriting it would
        -- rewrite history.
        seen_at    INTEGER,
        PRIMARY KEY (message_id, user_id)
      ) WITHOUT ROWID;
      -- The bell's read path: one user's mentions, newest first.
      CREATE INDEX mentions_user ON mentions (user_id, created_at DESC);

      -- Per-user watermark for notification sources whose rows live in ANOTHER engine (the DuckDB
      -- warehouse alerts table) and therefore cannot carry a seen_at column here. A watermark,
      -- not per-row read receipts: the bell marks everything seen on open, and one row per
      -- (user, source) beats one row per alert per user. Monotonic by construction in
      -- setNotificationWatermark (MAX in the upsert), the same rule markRead enforces for the
      -- room pointer: a stale tab must never resurrect a badge.
      CREATE TABLE notification_reads (
        user_id      TEXT    NOT NULL,
        source       TEXT    NOT NULL,
        seen_through INTEGER NOT NULL,
        PRIMARY KEY (user_id, source)
      ) WITHOUT ROWID;
    `)
  }
}

const dismissals: ChatMigration = {
  name: '003-notification-dismissals',
  up: (db) => {
    db.exec(`
      -- Per-user, per-item dismissal for the notification bell.
      --
      -- SEEN and DISMISSED are different states and both are needed. "Seen" is passive - the bell
      -- was opened, the badge stops nagging, the row stays readable. "Dismissed" is a decision:
      -- the row goes away. Folding them together would mean opening the bell silently threw its
      -- contents away, which is the behaviour that teaches people not to open it.
      --
      -- item_id is the BELL's id, not a chat id: mention:<messageId> / message:<messageId> /
      -- alert:<alertId>. That is deliberate - it is the only key that can name a row from the
      -- DuckDB warehouse and a row from this file in one table, which is what lets one dismiss
      -- button work on every stratum without a second mechanism per source.
      CREATE TABLE notification_dismissals (
        user_id      TEXT    NOT NULL,
        item_id      TEXT    NOT NULL,
        dismissed_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, item_id)
      ) WITHOUT ROWID;
    `)
  }
}

const pushSubscriptions: ChatMigration = {
  name: '004-push-subscriptions',
  up: (db) => {
    db.exec(`
      -- One row per Web Push subscription (chat Track 9). The endpoint IS the identity: the
      -- browser mints one per (browser profile, origin, service-worker registration), so it is
      -- the natural primary key and an upsert on it makes re-subscribing idempotent. This table
      -- is deliberately the Web Push endpoint/p256dh/auth triple and NOTHING more general - a
      -- native app brings its own table (device_tokens) and its own transport; a column set
      -- built for two protocols before the second one exists gets both wrong.
      --
      -- A subscription is a CAPABILITY: the push payload carries a real message preview off the
      -- tailnet, encrypted to p256dh/auth so the push services cannot read it, but any device
      -- holding the subscription renders it on a lock screen. Hence the prune rules: a 404/410
      -- from the endpoint deletes the row immediately, and last_seen_at (stamped on every
      -- successful send) makes a stale subscription identifiable.
      --
      -- user_id carries no REFERENCES clause for the same reason room_members.user_id carries
      -- none: users live in the DuckDB warehouse, another engine. It belongs here beside the
      -- other small hot per-user state: subscribing is an interactive write on a user gesture.
      CREATE TABLE push_subscriptions (
        user_id      TEXT NOT NULL,
        endpoint     TEXT PRIMARY KEY,
        p256dh       TEXT NOT NULL,
        auth         TEXT NOT NULL,
        user_agent   TEXT,
        created_at   INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      ) WITHOUT ROWID;
      -- The send path: every subscription for one user.
      CREATE INDEX push_subscriptions_user ON push_subscriptions (user_id);
    `)
  }
}

const deviceTokens: ChatMigration = {
  name: '005-device-tokens',
  up: (db) => {
    db.exec(`
      -- One row per native-app push token (the mobile POC's FCM transport). The token IS the
      -- identity - FCM mints one per (app install, Firebase project) - so it is the natural
      -- primary key and an upsert on it makes re-registering idempotent, exactly like
      -- push_subscriptions.endpoint. Kept as its own table rather than widening
      -- push_subscriptions: the protocols share nothing but "a string that reaches a device"
      -- (see 004's comment - a column set built for two protocols gets both wrong).
      --
      -- Same capability rules as a Web Push subscription: the FCM payload carries the mention
      -- preview off the tailnet, so rows are prunable, an UNREGISTERED answer deletes the row
      -- immediately, and last_seen_at is stamped on every successful send.
      CREATE TABLE device_tokens (
        token        TEXT PRIMARY KEY,
        user_id      TEXT NOT NULL,
        platform     TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      ) WITHOUT ROWID;
      -- The send path: every device for one user.
      CREATE INDEX device_tokens_user ON device_tokens (user_id);
    `)
  }
}

const attachments: ChatMigration = {
  name: '006-attachments',
  up: (db) => {
    db.exec(`
      -- One row per upload (chat Track 11). The BYTES do not live here: a SQLite file holding
      -- screenshots is a backup problem (every VACUUM INTO snapshot carries them) and a WAL
      -- problem (a 20MB paste is a 20MB write transaction), so the content lives on disk beside
      -- this database under chat-uploads/, addressed by sha256. The row is the metadata, the
      -- authorization anchor, and the reference that keeps the blob alive.
      --
      -- message_id is NULLABLE by design: an attachment is created BEFORE its message (the upload
      -- completes, then the post claims it), so every row starts as an ORPHAN. While orphaned it
      -- is readable only by its uploader - there is no message, hence no room, hence nothing for
      -- canReadRoom to answer. ChatStore.sweepOrphanAttachments reaps rows that never got posted.
      --
      -- The REFERENCES clause deliberately carries NO ON DELETE action (= NO ACTION, enforced on
      -- this connection): blob garbage collection is refcounted over these rows by sha256, so a
      -- cascade that silently dropped rows would strand blobs on disk forever with nothing left
      -- to count them. Messages are only ever SOFT-deleted today (deleteMessage stamps deleted_at
      -- and hard-deletes the attachment rows itself, GC'ing blobs); if a future path ever tries
      -- to hard-delete a message that still owns attachments, this constraint makes it fail
      -- loudly instead of leaking quietly.
      --
      -- uploader_id carries no REFERENCES clause for the same reason room_members.user_id carries
      -- none: users live in the DuckDB warehouse, another engine.
      --
      -- Dedup happens at the BLOB level, never the row level: two uploads of the same screenshot
      -- are two rows (their own filename, uploader, message) sharing one sha256 - one file on
      -- disk. A blob may be deleted exactly when its row refcount reaches zero.
      CREATE TABLE attachments (
        id          TEXT    PRIMARY KEY,
        message_id  TEXT    REFERENCES messages(id),
        uploader_id TEXT    NOT NULL,
        filename    TEXT    NOT NULL,
        mime        TEXT    NOT NULL,
        bytes       INTEGER NOT NULL,
        sha256      TEXT    NOT NULL,
        created_at  INTEGER NOT NULL
      );
      -- The render path: every attachment for one message (history pages, feed payloads).
      CREATE INDEX attachments_message ON attachments (message_id);
      -- The refcount path: how many rows still reference a blob (GC's only question).
      CREATE INDEX attachments_sha256 ON attachments (sha256);
      -- The sweeper's path: expired orphans only, so the sweep never scans posted rows.
      CREATE INDEX attachments_orphans ON attachments (created_at) WHERE message_id IS NULL;
    `)
  }
}

const agentSessions: ChatMigration = {
  name: '007-agent-sessions',
  up: (db) => {
    db.exec(`
      -- The chat agent's durable state, one row per room (chat Track 15). @abi in a channel runs a
      -- workerdeck session on the sibling worker, and this row is the ONLY thing that survives a
      -- server restart to say which one - the handle itself is a socket, and a socket is not state.
      --
      -- Why chat.db and not the warehouse: this is small hot per-room state written on the chat
      -- write path, and a cross-engine write there is exactly what the chat/warehouse split exists
      -- to avoid. It also inherits chat.db's backup (Track 12) for free.
      --
      -- Why durable at all rather than a Map in the module: a restart mid-turn would otherwise
      -- strand a half-streamed placeholder message forever, with nothing left that knows which
      -- worker session was filling it or how far it got. The three recovery columns answer exactly
      -- that - which session to re-attach, from which seq, and which message was being written.
      --
      -- room_id is the PRIMARY KEY because the scope decision is one session per ROOM, not per
      -- user: two people talking to @abi in one channel are one conversation, which is what a
      -- channel IS. The uniqueness is therefore the feature, not an implementation detail.
      CREATE TABLE agent_sessions (
        room_id              TEXT    PRIMARY KEY REFERENCES rooms(id),
        -- The workerdeck session this room converses with. Not a foreign key to anything here:
        -- it names a row in ANOTHER process's registry, which may vanish under us (a worker
        -- restart). Code treats a stale id as "recreate", never as an invariant violation.
        worker_session_id    TEXT    NOT NULL,
        -- Non-NULL exactly while a turn is mid-flight: the messages(id) whose body the turn is
        -- filling in. No REFERENCES clause on purpose - the message is soft-deletable and this
        -- is a transient pointer, so a constraint here would turn "someone deleted the agent's
        -- placeholder mid-turn" into a write failure on an unrelated path.
        streaming_message_id TEXT,
        -- Resume point for attach({ afterSeq }) after a server restart. The worker keeps running
        -- while the server is down, so the replay from here is what makes a mid-turn deploy cost
        -- a few seconds of stale bubble instead of the whole turn.
        last_worker_seq      INTEGER NOT NULL DEFAULT 0,
        turn_started_at      INTEGER,
        -- The per-room turn budget: the backstop BEHIND the loop guard, not the primary defense.
        -- A rolling window kept as a counter plus its start, rather than counting rows in some
        -- log, so the check is one point read on the trigger path.
        turns_this_hour      INTEGER NOT NULL DEFAULT 0,
        window_started_at    INTEGER NOT NULL,
        updated_at           INTEGER NOT NULL
      );
      -- Restart recovery's only question: which rooms were mid-turn when the process died.
      -- Partial, so the sweep never scans idle rooms.
      CREATE INDEX agent_sessions_streaming ON agent_sessions (room_id) WHERE streaming_message_id IS NOT NULL;
    `)
  }
}

const messageMeta: ChatMigration = {
  name: '008-message-meta',
  up: (db) => {
    db.exec(`
      -- Structure a message carries beyond its prose (chat Track 19): today exactly one shape,
      -- the agent's approval card. NULLABLE and unindexed on purpose.
      --
      -- Why a column on messages rather than a table of its own: the card IS a message. It has a
      -- seq, it badges the room, it groups under abi's avatar, it is deleted when the message is
      -- deleted, and it rides the outbox payload that the live feed already delivers. A side
      -- table would need every one of those joined back on, and would let the two disagree.
      --
      -- Why JSON text rather than typed columns: the only consumer is a renderer that already
      -- switches on "kind", and a second kind must not cost a migration on the chat hot path.
      -- Nothing here is ever queried BY its contents - the lookup is always "this message id" -
      -- so there is nothing an index or a column split would buy.
      --
      -- Existing rows get NULL, which is the same absence a pre-008 outbox payload has and the
      -- same absence a client that never learned the field sees. That is the whole backward
      -- compatibility story, and it is why the card's BODY is written to stand on its own.
      ALTER TABLE messages ADD COLUMN meta TEXT;
    `)
  }
}

const threads: ChatMigration = {
  name: '009-threads',
  up: (db) => {
    db.exec(`
      -- Threads (Slack-shaped): a reply hangs off the message it answers. NULL on every ordinary
      -- message, which is the whole compatibility story again - a pre-009 row, a stored pre-009
      -- outbox payload and a client that never learned the field all agree that a message with no
      -- parent is a root.
      --
      -- Why a self-reference on messages rather than a threads table: a reply IS a message. It
      -- allocates a room seq like any other (so unread stays the subtraction next_seq - 1 -
      -- last_read_seq and a reply badges the room exactly like a top-level message), it rides the
      -- outbox payload the live feed already delivers, it is edited, deleted, attached-to and
      -- backed up by the paths that already exist. A separate table would need every one of those
      -- re-implemented, and would let the two orderings disagree.
      --
      -- The hierarchy is exactly ONE level deep, enforced in ChatStore.post rather than by a
      -- constraint SQLite cannot express: replying to a reply re-parents onto that reply's root.
      -- Slack's rule, and it keeps "a room is a list of roots" true for the timeline query.
      --
      -- No ON DELETE CASCADE: deletion here is a SOFT delete (deleted_at), so the row a reply
      -- points at never goes away except with its whole room, which cascades through room_id.
      ALTER TABLE messages ADD COLUMN parent_id TEXT REFERENCES messages(id);

      -- Serves both thread reads: the reply list for one root (parent_id = ? ORDER BY seq) and the
      -- per-root summary counts. Partial, because the overwhelming majority of rows are roots and
      -- have nothing to say here.
      CREATE INDEX messages_thread ON messages (parent_id, seq) WHERE parent_id IS NOT NULL;
    `)
  }
}

/**
 * Retire the per-room `seq` for a time-shaped order key, and retire soft delete for hard delete.
 *
 * The decision (2026-09-02): one order concept, not two. `messages.created_at` becomes THE key -
 * unique per room, strictly increasing in posting order, issued by a per-room monotonic guard
 * (`rooms.head_at`, bumped as `MAX(head_at + 1, now)` inside the posting transaction) rather than
 * read off the wall clock. The cost, chosen with eyes open: under a backwards clock step the key
 * runs ahead of real time until the clock catches up. The mechanism and its rationale live on
 * `ChatStore.issueKeyStmt`; this migration only has to carry the existing rows across.
 *
 * ## Deriving the key for existing rows
 *
 * Walk each room's messages in `seq` order and assign `key = MAX(created_at, previous key + 1)`.
 * That keeps every `created_at` that was already increasing exactly where it was, breaks a same-
 * millisecond tie by nudging the later row forward, and - the case nobody remembers - repairs a
 * history where a past clock step left `created_at` out of `seq` order, since the ORDER readers
 * saw was seq's and must survive. Every derived key is unique per room by construction, which is
 * what lets `UNIQUE (room_id, created_at)` replace `UNIQUE (room_id, seq)` on messages and events.
 *
 * ## Translating the pointers
 *
 * `room_members.last_read_seq` meant "everything at or below this seq is read", so its translation
 * is the key of the newest message at or below it (0 when there is none), computed over ALL rows
 * before any are purged: a pointer that sat on a since-deleted message must land on that message's
 * key, or the member owes messages they read. `rooms.head_at` is the largest key ever derived for
 * the room, again over all rows, so it can never be below a pointer or a cursor somebody holds.
 *
 * ## Purging the soft deletes
 *
 * A tombstone row (`deleted_at` set) becomes a hard delete here, and its outbox row goes with it -
 * that outbox row still carried the ORIGINAL body in `events.payload` (the bug that forced this
 * change), so this is also the moment that text finally leaves the file. The new deletion rule is
 * applied retroactively as well: a tombstoned ROOT takes its surviving replies with it, because
 * without a tombstone there is nothing left to hang them under, and re-rooting them into the
 * timeline would change what they meant. Attachment rows of those replies go too; their blobs are
 * garbage the next `sweepOrphanAttachments` reconciles (a migration has no upload directory).
 *
 * ## Why `events` is rebuilt with its AUTOINCREMENT high-water mark restored by hand
 *
 * `events.id` is every client's resume cursor, and the counter can be far past the rows that
 * survive (rooms have been purged before). Dropping the table drops its `sqlite_sequence` entry,
 * and the rebuilt table would restart at MAX(id) + 1 of what was copied - handing out ids a client
 * already holds as its cursor, which silently skips real events on the next reconnect. The old
 * counter is read first and written back after the rename.
 *
 * `rooms`, `room_members` and `mentions` take ADD/UPDATE/DROP COLUMN in place - none of the
 * retired columns is part of a key or an index there. `messages` and `events` carry `seq` inside a
 * UNIQUE constraint, which DROP COLUMN refuses, so both follow SQLite's rebuild-and-rename
 * procedure (foreign keys are OFF for the whole chain - see `openChatDatabase`).
 */
const timeOrderKey: ChatMigration = {
  name: '010-time-order-key',
  up: (db) => {
    interface OldMessage {
      id: string
      room_id: string
      seq: number
      created_at: number
      deleted_at: number | null
      parent_id: string | null
    }
    const rows = db
      .prepare('SELECT id, room_id, seq, created_at, deleted_at, parent_id FROM messages ORDER BY room_id, seq')
      .all() as OldMessage[]

    db.exec(`
      CREATE TEMP TABLE message_keys (
        id      TEXT    PRIMARY KEY,
        room_id TEXT    NOT NULL,
        seq     INTEGER NOT NULL,
        key     INTEGER NOT NULL
      );
      CREATE INDEX temp.message_keys_room_seq ON message_keys (room_id, seq);
      CREATE TEMP TABLE doomed (id TEXT PRIMARY KEY);
    `)
    const insertKey = db.prepare('INSERT INTO message_keys (id, room_id, seq, key) VALUES (?, ?, ?, ?)')
    const doom = db.prepare('INSERT OR IGNORE INTO doomed (id) VALUES (?)')
    let room: string | null = null
    let previous = 0
    for (const row of rows) {
      if (row.room_id !== room) {
        room = row.room_id
        previous = 0
      }
      const key = Math.max(row.created_at, previous + 1)
      insertKey.run(row.id, row.room_id, row.seq, key)
      previous = key
      if (row.deleted_at !== null) doom.run(row.id)
    }
    // The retroactive cascade: a tombstoned root takes its replies. One level deep, so one pass.
    db.exec(`
      INSERT OR IGNORE INTO doomed (id)
        SELECT m.id FROM messages m JOIN messages r ON r.id = m.parent_id WHERE r.deleted_at IS NOT NULL
    `)
    const doomedCount = (db.prepare('SELECT COUNT(*) AS n FROM doomed').get() as { n: number }).n

    // --- rooms: the guard, seeded from every key ever derived (purged rows included). ---
    db.exec(`
      ALTER TABLE rooms ADD COLUMN head_at INTEGER NOT NULL DEFAULT 0;
      UPDATE rooms SET head_at = COALESCE((SELECT MAX(key) FROM message_keys WHERE room_id = rooms.id), 0);
      ALTER TABLE rooms DROP COLUMN next_seq;
    `)

    // --- room_members: the pointer, translated before the purge for the reason in the header. ---
    db.exec(`
      ALTER TABLE room_members ADD COLUMN last_read_at INTEGER NOT NULL DEFAULT 0;
      UPDATE room_members
         SET last_read_at = COALESCE(
           (SELECT MAX(k.key) FROM message_keys k
             WHERE k.room_id = room_members.room_id AND k.seq <= room_members.last_read_seq),
           0);
      ALTER TABLE room_members DROP COLUMN last_read_seq;
    `)

    // --- messages: rebuilt without seq and deleted_at, keyed by the derived created_at. ---
    db.exec(`
      CREATE TABLE messages_new (
        id          TEXT    PRIMARY KEY,
        room_id     TEXT    NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        sender_id   TEXT    NOT NULL,
        sender_name TEXT    NOT NULL,
        body        TEXT    NOT NULL,
        -- The order key. Issued, not observed - see ChatStore.issueKeyStmt.
        created_at  INTEGER NOT NULL,
        edited_at   INTEGER,
        meta        TEXT,
        -- Still no ON DELETE action, and now that is load-bearing the other way round: deletion
        -- is a hard delete that cascades through the store EXPLICITLY (replies first, each with
        -- its outbox row, attachments and dismissals), and a database-level cascade here would
        -- let a root's deletion silently skip that bookkeeping. See ChatStore.deleteMessage.
        parent_id   TEXT    REFERENCES messages(id)
      );
      INSERT INTO messages_new (id, room_id, sender_id, sender_name, body, created_at, edited_at, meta, parent_id)
        SELECT m.id, m.room_id, m.sender_id, m.sender_name, m.body, k.key, m.edited_at, m.meta, m.parent_id
          FROM messages m JOIN message_keys k ON k.id = m.id
         WHERE m.id NOT IN (SELECT id FROM doomed);
    `)
    const survivors = (db.prepare('SELECT COUNT(*) AS n FROM messages_new').get() as { n: number }).n
    if (survivors !== rows.length - doomedCount) {
      throw new Error(`010: expected ${rows.length - doomedCount} messages after the rebuild, got ${survivors}`)
    }
    db.exec(`
      DROP TABLE messages;
      ALTER TABLE messages_new RENAME TO messages;
      -- Doubles as the history index, exactly as (room_id, seq) did: the backwards page scan and
      -- the unread COUNT (room_id = ? AND created_at > ?) both walk it, and COUNT(*) over it is a
      -- covering read. Named, so a query plan can be asserted against it.
      CREATE UNIQUE INDEX messages_room_created ON messages (room_id, created_at);
      CREATE INDEX messages_thread ON messages (parent_id, created_at) WHERE parent_id IS NOT NULL;
    `)

    // --- events: rebuilt under the message's key, minus the rows whose message is gone. ---
    const orphans = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM events e
            WHERE NOT EXISTS (SELECT 1 FROM message_keys k WHERE k.room_id = e.room_id AND k.seq = e.seq)`
        )
        .get() as { n: number }
    ).n
    // An outbox row with no message behind it is a contradiction of the one invariant post()
    // keeps (row and event commit together). Refuse rather than drop: silently losing a row
    // here would be exactly the quiet data loss rule 2 of this file exists to prevent.
    if (orphans !== 0) throw new Error(`010: ${orphans} outbox row(s) have no message - refusing to guess`)
    const eventsBefore = (db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n
    const counter = db.prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'events'`).get() as
      | { seq: number }
      | undefined
    db.exec(`
      CREATE TABLE events_new (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id    TEXT    NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        type       TEXT    NOT NULL,
        payload    TEXT    NOT NULL,
        actor_id   TEXT,
        -- The message's own order key, so a message's outbox row is the point read
        -- (room_id, created_at) - which is how deleteMessage finds and removes it.
        created_at INTEGER NOT NULL
      );
      -- The stored payload is rewritten to agree with the row it announces: the retired fields
      -- go, and createdAt takes the derived key where a tie-break moved it. A replayed event
      -- must describe the message exactly as history now does.
      INSERT INTO events_new (id, room_id, type, payload, actor_id, created_at)
        SELECT e.id, e.room_id, e.type,
               json_set(json_remove(e.payload, '$.seq', '$.deletedAt'), '$.createdAt', k.key),
               e.actor_id, k.key
          FROM events e JOIN message_keys k ON k.room_id = e.room_id AND k.seq = e.seq
         WHERE k.id NOT IN (SELECT id FROM doomed);
    `)
    const doomedEvents = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM events e JOIN message_keys k ON k.room_id = e.room_id AND k.seq = e.seq
            WHERE k.id IN (SELECT id FROM doomed)`
        )
        .get() as { n: number }
    ).n
    const eventsAfter = (db.prepare('SELECT COUNT(*) AS n FROM events_new').get() as { n: number }).n
    if (eventsAfter !== eventsBefore - doomedEvents) {
      throw new Error(`010: expected ${eventsBefore - doomedEvents} outbox rows after the rebuild, got ${eventsAfter}`)
    }
    db.exec(`
      DROP TABLE events;
      ALTER TABLE events_new RENAME TO events;
      CREATE UNIQUE INDEX events_room_created ON events (room_id, created_at);
    `)
    if (counter !== undefined) {
      // The rename carried the rebuilt table's counter across under the new name (SQLite does
      // that for AUTOINCREMENT tables), holding MAX(id) of what was copied - or no row at all when
      // nothing was. Lift it to the old counter, never lower: the resume-cursor argument in the
      // header. Two statements because sqlite_sequence has no unique constraint for an UPSERT.
      const lifted = db
        .prepare(`UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = 'events'`)
        .run(counter.seq)
      if (lifted.changes === 0) {
        db.prepare(`INSERT INTO sqlite_sequence (name, seq) VALUES ('events', ?)`).run(counter.seq)
      }
    }

    // --- mentions: the copied key follows the message; a doomed message's mentions go. ---
    db.exec(`
      DELETE FROM mentions WHERE message_id IN (SELECT id FROM doomed);
      UPDATE mentions SET created_at = (SELECT key FROM message_keys WHERE id = mentions.message_id);
      ALTER TABLE mentions DROP COLUMN seq;
    `)

    // --- the rest of the purge: what a live deleteMessage would have removed alongside. ---
    db.exec(`
      DELETE FROM attachments WHERE message_id IN (SELECT id FROM doomed);
      DELETE FROM notification_dismissals
       WHERE item_id IN (SELECT 'mention:' || id FROM doomed)
          OR item_id IN (SELECT 'message:' || id FROM doomed);
      DROP TABLE doomed;
      DROP TABLE message_keys;
    `)
  }
}

const reactions: ChatMigration = {
  name: '011-reactions',
  up: (db) => {
    db.exec(`
      -- Reactions (chat Track 10): an ack that does not cost a message.
      --
      -- A TABLE rather than a column, which is the opposite call from meta/parent_id and for the
      -- opposite reason: a reaction is not a property of the message, it is a row per (message,
      -- person, emoji), and the question asked of it is always "everything for this message".
      --
      -- The primary key is all three columns, and it carries the whole concurrency story: a
      -- double-tap is an INSERT OR IGNORE that changes nothing, un-reacting is a DELETE, and two
      -- clients racing the same reaction converge instead of counting it twice. No surrogate id,
      -- because there is nothing else to address a reaction BY.
      --
      -- ON DELETE CASCADE, like mentions: a hard-deleted message (migration 010) must not leave
      -- reactions pointing at a row that no longer exists. That is the only cleanup a delete
      -- needs, which is why deleteMessage does not mention reactions at all.
      --
      -- What this table deliberately does NOT have: a room_id (the message has one, and copying it
      -- would let the two disagree), a seq or order key (a reaction allocates nothing - the
      -- invariant is that only message.created may ever move a room's allocator), and any index
      -- beyond the PK, whose leading column IS message_id and so already serves the one read
      -- anybody makes.
      CREATE TABLE message_reactions (
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        user_id    TEXT NOT NULL,
        emoji      TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (message_id, user_id, emoji)
      );
    `)
  }
}

const directMessages: ChatMigration = {
  name: '012-direct-messages',
  up: (db) => {
    db.exec(`
      -- Direct messages (chat Track 14): a DM is a PRIVATE room with exactly two members, and this
      -- column is what tells it apart from a named channel. Every existing row is a named room, so
      -- the DEFAULT is the backfill.
      --
      -- What is deliberately NOT here: a second table, a pair column, or a second unique index.
      -- A DM's address is its slug, derived from the sorted pair of member ids ('dm:<a>:<b>'), and
      -- rooms_slug is ALREADY unique - so "open a DM with Dan" cannot create a duplicate no matter
      -- how many callers race it, without a new constraint to keep in step with the old one. The
      -- 'dm:' prefix cannot collide with a named room because the named-room slug grammar
      -- ([a-z0-9-]) has no ':' in it, and ChatStore refuses the prefix on createRoom/updateRoom
      -- for callers that bypass the controller's regex.
      --
      -- The CHECK ties kind to visibility: a DM is private BY SCHEMA, not by the code path that
      -- happens to create it. updateRoom refuses a DM outright, but that is a TS rule; this is the
      -- one that holds when someone reaches for the SQL - flipping a 1:1 history public under a
      -- typeable address is exactly the mistake a private conversation cannot survive.
      ALTER TABLE rooms ADD COLUMN kind TEXT NOT NULL DEFAULT 'room'
        CHECK (kind IN ('room', 'dm') AND (kind = 'room' OR visibility = 'private'));
    `)
  }
}

const roomIcon: ChatMigration = {
  name: '013-room-icon',
  up: (db) => {
    db.exec(`
      -- Room appearance: which lucide icon a room wears in a sidebar or a list row.
      --
      -- ONE nullable TEXT column, holding a kebab-case lucide name from the closed CHAT_ROOM_ICONS
      -- list in chat/types.ts. Not an enum CHECK, because the list is a client-rendering concern
      -- that will grow, and a CHECK would need a table rewrite every time it did - ChatStore
      -- validates against the list with isChatRoomIcon, which is where an unknown name is refused.
      --
      -- NULL means "never picked", not "hash": both clients draw the default themselves, so
      -- changing that default later is a client change rather than an UPDATE over every row.
      ALTER TABLE rooms ADD COLUMN icon TEXT;
    `)
  }
}

const roomName: ChatMigration = {
  name: '014-room-name',
  up: (db) => {
    db.exec(`
      -- The room's DISPLAY name, free-form: capitals, spaces, punctuation - everything the slug
      -- grammar ([a-z0-9-]) refuses.
      --
      -- A second column rather than a relaxed slug, because the slug is an ADDRESS: it is in every
      -- saved link, every MCP room: argument and every push payload, and rooms_slug is a
      -- case-SENSITIVE unique index, so widening the grammar would let #Dev and #dev both exist and
      -- make a wrong-case lookup a 404. Splitting them keeps the address machine-clean and lets the
      -- label be whatever a human wants.
      --
      -- Deliberately NOT unique and NOT indexed: nothing resolves a room by name, so uniqueness
      -- would only make a cosmetic edit fail for a reason nobody can see. NULL means "never set" -
      -- the slug is the name, which is every room that existed before this migration.
      ALTER TABLE rooms ADD COLUMN name TEXT;
    `)
  }
}

/**
 * Every channel is open (2026-09-07): `rooms.visibility` goes, and the private channel with it.
 *
 * The decision: a small team keeps its rooms relevant, so every named room is readable by every
 * principal, and the only room with an audience of its own is a direct message - which is already
 * told apart by `kind`, not by `visibility`. Two columns encoding one fact ("is this room closed to
 * outsiders") is the drift that bites later: one gets read and the other written, and a room ends
 * up private by one column and open by the other. So the column is dropped and readability is
 * keyed on `kind` alone (`READABLE_PREDICATE` in store.ts).
 *
 * ## What happens to a channel that WAS private
 *
 * The one question this migration must not get wrong, and it is decided by whether anybody is
 * still in the room - never by guessing:
 *
 * - **No member rows: PURGED.** Under the rules being retired that is the archived terminal state
 *   (the last member left, and a private channel refused every non-member - no read, no join, no
 *   invite, and a mention needs somebody who can post), so the words are unreachable through every
 *   surface. Dropping the column would publish them to the whole team with nothing left to say they
 *   were ever private, which is the one irreversible outcome; deleting them is reversible from the
 *   snapshot `openChatDatabase` takes before the chain runs. NAME THAT SNAPSHOT CAREFULLY: it is
 *   `chat.db.pre-<FIRST PENDING migration>.bak`, not this one - `snapshotBeforeMigration` derives it
 *   from `pending[0]`, so a checkout several migrations behind writes one file covering the whole
 *   chain. Production ran 013, 014 and 015 together on 2026-09-07, so its undo is
 *   `chat.db.pre-013-room-icon.bak` and NOT `pre-015-open-channels.bak`, which does not exist. A
 *   recovery that guesses this migration's own name looks for the wrong file and concludes the
 *   backup was never taken. So the
 *   room goes exactly the way `deleteRoom` takes one - messages (replies included), outbox rows,
 *   mentions, reactions, attachment rows, dismissal tombstones, the agent-session row, the room row
 *   - by EXPLICIT deletes per table, because foreign keys are OFF for the chain and ON DELETE
 *   CASCADE does not fire here; the constructor's `foreign_key_check` is the proof nothing was left
 *   dangling. The one thing a migration cannot do is unlink attachment BLOBS (it has no upload
 *   directory); those are garbage the next `sweepOrphanAttachments` reconciles - 010's rule.
 *   Production's `founders` (private, nobody left in it, five messages) is why this branch exists,
 *   and the user chose deletion over disclosure for it (2026-09-07).
 * - **Member rows: REFUSED.** Rolled back whole, naming the slug(s), rerunnable - rule 2 of this
 *   file. People are in it, and neither purging their room nor publishing it is a decision a
 *   migration may take on its own; a loud log line under a deploy nobody is watching would not make
 *   publishing any less irreversible. The operator decides per room with one statement against the
 *   still-intact old schema and reruns: `UPDATE rooms SET visibility = 'public'` to publish it
 *   (history included, exactly as `updateRoom`'s private -> public did on demand), or `DELETE FROM
 *   room_members WHERE room_id = ...` to route it to the purge branch. No deployment holds such a
 *   room today, so the refusal costs nothing and removes the footgun.
 *
 * A DM's privacy is untouched, because `kind = 'dm'` is what its two member rows are the ACL for:
 * a DM is neither purged nor refused, only its `visibility` cell goes. Every surviving room is
 * copied into the rebuilt table value for value.
 *
 * `room_members` stays, with a narrower job: the per-user read pointer (`last_read_at`) and a
 * DM's pair of participants. It is no longer an ACL or a subscription for a channel; every writer
 * that used to gate on "is a member" gates on readability instead, and a row for a channel is
 * written lazily by the first post, mention or markRead.
 *
 * Why a rebuild rather than DROP COLUMN: migration 012's CHECK on `kind` names `visibility`
 * (`kind = 'room' OR visibility = 'private'`), and SQLite refuses to drop a column that another
 * column's CHECK refers to. So `rooms` follows the rebuild-and-rename procedure 010 used for
 * `messages` - foreign keys are OFF for the chain (see `openChatDatabase`), the child tables'
 * REFERENCES clauses name `rooms` by text and land on the renamed table, the constructor's
 * `foreign_key_check` proves it afterwards - with the row count asserted inside the transaction
 * and the unique slug index recreated on the new table.
 *
 * The CHECK that replaces 012's pins `kind` to the ADDRESS instead of to the retired column: a
 * room is a DM exactly when its slug is in the `dm:` namespace (`directSlug`). That keeps the
 * protection 012 was there for - a raw `UPDATE rooms SET kind = 'room'` on a DM would publish a
 * 1:1 history under a typeable address, and it now fails the way flipping `visibility` did. A row
 * that already disagrees with that rule (impossible by construction: `openDirect` is the only
 * writer of a DM and refuses a slug without the prefix; `createRoom` refuses one with it) is a
 * refusal, never a guess - rule 2 of this file.
 */
const openChannels: ChatMigration = {
  name: '015-open-channels',
  up: (db) => {
    const mislabeled = (
      db
        .prepare(`SELECT COUNT(*) AS n FROM rooms WHERE (kind = 'dm') <> (substr(slug, 1, 3) = 'dm:')`)
        .get() as { n: number }
    ).n
    if (mislabeled !== 0) {
      throw new Error(`015: ${mislabeled} room(s) have a kind that disagrees with their slug namespace - refusing to guess`)
    }

    // The refusal comes BEFORE the purge. The whole migration is one transaction, so a database
    // holding both kinds of private channel rolls back with nothing deleted either way - but the
    // error must name the rooms the operator has to decide about, not a purge that undid itself.
    const occupied = (
      db
        .prepare(
          `SELECT r.slug FROM rooms r
            WHERE r.kind = 'room' AND r.visibility = 'private'
              AND EXISTS (SELECT 1 FROM room_members m WHERE m.room_id = r.id)
            ORDER BY r.slug`
        )
        .all() as { slug: string }[]
    ).map((row) => row.slug)
    if (occupied.length > 0) {
      throw new Error(
        `015: private channel(s) still have members - ${occupied.join(', ')} - refusing to decide for them: ` +
          `for each, either UPDATE rooms SET visibility = 'public' to publish it, or delete its room_members ` +
          `rows to have it purged, then rerun`
      )
    }

    const before = (db.prepare('SELECT COUNT(*) AS n FROM rooms').get() as { n: number }).n

    // The purge: every private channel nobody is left in, with everything that hangs off it.
    // Children first, one explicit statement per table (no cascade fires with foreign keys OFF),
    // in the order deleteRoom and deleteMessage take them. room_members is empty for these rooms
    // by definition; it is deleted anyway so the purge reads as deleteRoom's cascade, table for
    // table, and stays correct if the definition above ever widens.
    db.exec(`
      CREATE TEMP TABLE doomed_rooms AS
        SELECT r.id FROM rooms r
         WHERE r.kind = 'room' AND r.visibility = 'private'
           AND NOT EXISTS (SELECT 1 FROM room_members m WHERE m.room_id = r.id);
      CREATE TEMP TABLE doomed_messages AS
        SELECT id FROM messages WHERE room_id IN (SELECT id FROM doomed_rooms);
      DELETE FROM message_reactions WHERE message_id IN (SELECT id FROM doomed_messages);
      DELETE FROM mentions
       WHERE message_id IN (SELECT id FROM doomed_messages) OR room_id IN (SELECT id FROM doomed_rooms);
      DELETE FROM attachments WHERE message_id IN (SELECT id FROM doomed_messages);
      DELETE FROM notification_dismissals
       WHERE item_id IN (SELECT 'mention:' || id FROM doomed_messages)
          OR item_id IN (SELECT 'message:' || id FROM doomed_messages);
      DELETE FROM events WHERE room_id IN (SELECT id FROM doomed_rooms);
      DELETE FROM messages WHERE id IN (SELECT id FROM doomed_messages);
      DELETE FROM room_members WHERE room_id IN (SELECT id FROM doomed_rooms);
      DELETE FROM agent_sessions WHERE room_id IN (SELECT id FROM doomed_rooms);
      DELETE FROM rooms WHERE id IN (SELECT id FROM doomed_rooms);
    `)
    const purged = (db.prepare('SELECT COUNT(*) AS n FROM doomed_rooms').get() as { n: number }).n
    db.exec('DROP TABLE doomed_messages; DROP TABLE doomed_rooms;')

    db.exec(`
      CREATE TABLE rooms_new (
        id         TEXT    PRIMARY KEY,
        slug       TEXT    NOT NULL,
        -- The display name (014). NULL means the slug IS the name.
        name       TEXT,
        topic      TEXT,
        -- What the room IS (012): a named channel, open to everyone, or a direct message whose
        -- two room_members rows are its whole audience. The CHECK ties the kind to the slug
        -- namespace ('dm:<a>:<b>', see directSlug in store.ts) so neither can be flipped without
        -- the other - the schema-level pin 012 hung on visibility, rehung on the address.
        kind       TEXT    NOT NULL DEFAULT 'room'
                   CHECK (kind IN ('room', 'dm') AND ((kind = 'dm') = (substr(slug, 1, 3) = 'dm:'))),
        -- The lucide icon name (013), or NULL for the client-drawn default.
        icon       TEXT,
        -- The order-key guard (010): the newest key this room has issued. See ChatStore.issueKeyStmt.
        head_at    INTEGER NOT NULL DEFAULT 0,
        created_by TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO rooms_new (id, slug, name, topic, kind, icon, head_at, created_by, created_at, updated_at)
        SELECT id, slug, name, topic, kind, icon, head_at, created_by, created_at, updated_at FROM rooms;
    `)
    const after = (db.prepare('SELECT COUNT(*) AS n FROM rooms_new').get() as { n: number }).n
    if (after !== before - purged) {
      throw new Error(`015: expected ${before - purged} rooms after the rebuild, got ${after}`)
    }
    db.exec(`
      DROP TABLE rooms;
      ALTER TABLE rooms_new RENAME TO rooms;
      CREATE UNIQUE INDEX rooms_slug ON rooms (slug);
    `)
  }
}

export const CHAT_MIGRATIONS: readonly ChatMigration[] = [
  schema,
  mentions,
  dismissals,
  pushSubscriptions,
  deviceTokens,
  attachments,
  agentSessions,
  messageMeta,
  threads,
  timeOrderKey,
  reactions,
  directMessages,
  roomIcon,
  roomName,
  openChannels
]

/**
 * Apply every unapplied migration, each atomically with its own ledger row. Returns the names
 * actually applied (the caller logs them at boot). `migrations` is a parameter so a test can drive
 * a failing chain and assert the rollback.
 */
export function migrateChat(db: Database.Database, migrations: readonly ChatMigration[] = CHAT_MIGRATIONS): string[] {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)')

  const applied = new Set(
    (db.prepare('SELECT name FROM schema_migrations').all() as { name: string }[]).map((row) => row.name)
  )
  const record = db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)')
  const done: string[] = []

  for (const migration of migrations) {
    if (applied.has(migration.name)) continue
    // The DDL, the data movement and the ledger row commit together: a crash mid-chain leaves a
    // migration unapplied, never HALF-applied. IMMEDIATE takes the write lock at BEGIN rather
    // than on first write.
    db.transaction(() => {
      migration.up(db)
      record.run(migration.name, Date.now())
    }).immediate()
    done.push(migration.name)
  }

  return done
}

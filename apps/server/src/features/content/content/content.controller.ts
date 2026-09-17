import { createReadStream } from 'node:fs'
import { BadRequestException, Body, Controller, Get, Header, NotFoundException, Param, Post, Req, StreamableFile, UseGuards } from '@nestjs/common'
import { AuthGuard } from '../../../auth/auth.guard.js'
import { type PrincipalRequest } from '../../../auth/auth.decorators.js'
import { ApiOkResponse, ApiProperty } from '@nestjs/swagger'
import { IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator'
import { Mcp, Trpc } from '@silkweave/nestjs'
import { CONTENT_CHANNELS, CONTENT_KINDS, VERIFY_SEVERITIES, TOPIC_STATUSES, CONTENT_STATUSES, CONTENT_TRANSITIONS, channelProfiles, applyContentTransition, availableTransitions, contentAssetFile, deleteContent, listContentAssets, readContentDoc, readContentPiece, readContentPieces, deleteContentTopic, pendingTopicChannels, readContentTopics, transitionNeedsDialog, upsertContentTopic, readVoiceStyles, recordContentPublish, recordContentVerify, setFindingsApproved, upsertContent, writeContentDoc, type ChannelContentProfile, type ContentChannel, type ContentInput, type ContentKind, type ContentPiece, type ContentTopic, type TopicStatus, type ContentStatus, type ContentTransitionId, type VerifyFinding } from '@silkweave/box-core'

// DTOs document the REST/Swagger surface and drive the generated tRPC input/output types. As with the
// inbox/planning controllers, the dashboard keeps its own content-types and structurally casts nested
// arrays (tRPC reflects nested DTO arrays as `unknown[]`).
class VerifyFindingDto {
  @ApiProperty() lens!: string
  @ApiProperty({ enum: VERIFY_SEVERITIES }) severity!: string
  @ApiProperty() message!: string
  @ApiProperty({ required: false, description: 'ticked off by a human; a `pass` arrives already ticked' })
  approved?: boolean
}
class VerifyDto {
  @ApiProperty() passed!: boolean
  @ApiProperty({ type: [VerifyFindingDto] }) findings!: VerifyFindingDto[]
  @ApiProperty() checkedAt!: string
}
class ReviewDto {
  @ApiProperty({ description: "'approved' - the only member since 2026-08-13" }) decision!: string
  @ApiProperty() note!: string
  @ApiProperty({ description: 'users.id of the reviewer' }) by!: string
  @ApiProperty() at!: string
}
class ContentPieceDto {
  @ApiProperty() id!: string
  @ApiProperty() topic_id!: string
  @ApiProperty() channel!: string
  @ApiProperty() kind!: string
  @ApiProperty({ required: false, nullable: true }) source_id!: string | null
  @ApiProperty() status!: string
  @ApiProperty() title!: string
  @ApiProperty({ required: false, nullable: true }) body_path!: string | null
  @ApiProperty({ type: VerifyDto, required: false, nullable: true }) verify!: VerifyDto | null
  @ApiProperty({ type: ReviewDto, required: false, nullable: true, description: 'Last human review decision' })
  review!: ReviewDto | null
  @ApiProperty({
    type: [String],
    description:
      'Transitions available from this state, most-likely-next first (content-transition ids). Server-computed so clients render actions instead of re-deriving the machine.',
  })
  transitions!: string[]
  @ApiProperty({ type: Object }) metadata!: Record<string, unknown>
  @ApiProperty({ required: false, nullable: true, description: 'When a scheduled piece should go out (ISO)' })
  scheduled_at!: string | null
  @ApiProperty({ required: false, nullable: true }) published_at!: string | null
  @ApiProperty({ required: false, nullable: true }) published_url!: string | null
  @ApiProperty({ required: false, nullable: true }) published_by!: string | null
  @ApiProperty() created_at!: string
  @ApiProperty() updated_at!: string
  @ApiProperty({ required: false, nullable: true }) created_by!: string | null
  @ApiProperty({ required: false, nullable: true }) updated_by!: string | null
}
class ProfileDto {
  @ApiProperty() channel!: string
  @ApiProperty() label!: string
  @ApiProperty() bodyKind!: string
  @ApiProperty({ type: Object }) limits!: Record<string, unknown>
  @ApiProperty() voiceNotes!: string
  @ApiProperty({ type: [String] }) requires!: string[]
  @ApiProperty({ type: [String], required: false }) recommends?: string[]
  @ApiProperty({ type: Object }) publish!: Record<string, unknown>
}
class TransitionSpecDto {
  @ApiProperty() id!: string
  @ApiProperty({ description: 'Button text - the verb the operator performs' }) label!: string
  @ApiProperty({ description: 'What actually happens, for the confirm dialog' }) intent!: string
  @ApiProperty({ required: false, nullable: true, description: 'Status the piece lands in' })
  target!: string | null
  @ApiProperty({ description: "Extra input required: none | note | note? | time | url" }) input!: string
  @ApiProperty({ description: "'human' (applied here) | 'agent' (runs in a Claude Code session)" })
  runner!: string
  @ApiProperty({ description: 'Touches or records the outside world - confirm harder' }) outward!: boolean
  @ApiProperty({
    description:
      'Whether the dashboard stops and asks before running this. True only for required input or an outward consequence - everything else is a direct click.',
  })
  needsDialog!: boolean
}
class ContentPiecesDto {
  @ApiProperty() generatedAt!: string
  @ApiProperty({ type: [ContentPieceDto] }) pieces!: ContentPieceDto[]
  @ApiProperty({ type: [ProfileDto], description: 'Per-channel content profiles (constraints/voice)' })
  profiles!: ProfileDto[]
  @ApiProperty({ type: [TransitionSpecDto], description: 'The lifecycle transition catalogue (labels + copy)' })
  transitionSpecs!: TransitionSpecDto[]
}

// NOTE: @Mcp() input fields must have a concrete scalar/array JSON-schema `type` so the cli proxy can
// build an option for each. No objects / nullable unions - pass JSON-bag fields as a string (parsed
// server-side) and omit a field to leave it unchanged. See [[mcp-tool-input-scalar-constraint]].
class UpsertContentDto {
  @ApiProperty({ description: 'Piece id - slug path <topic>/<channel>' }) @IsString() id!: string
  @ApiProperty({ required: false }) @IsOptional() @IsString() topic_id?: string
  @ApiProperty({ required: false, enum: CONTENT_CHANNELS }) @IsOptional() @IsIn(CONTENT_CHANNELS) channel?: ContentChannel
  @ApiProperty({ required: false, enum: CONTENT_KINDS }) @IsOptional() @IsIn(CONTENT_KINDS) kind?: ContentKind
  @ApiProperty({ required: false, description: 'The canonical piece a derived one adapts from' })
  @IsOptional() @IsString() source_id?: string
  @ApiProperty({ required: false, enum: CONTENT_STATUSES }) @IsOptional() @IsIn(CONTENT_STATUSES) status?: ContentStatus
  @ApiProperty({ required: false }) @IsOptional() @IsString() title?: string
  @ApiProperty({ required: false, description: 'Repo-relative markdown path (defaults from the id)' })
  @IsOptional() @IsString() body_path?: string
  @ApiProperty({
    required: false,
    description:
      'JSON object string of per-channel fields (subreddit, flair, assets…). DEEP-MERGED into the stored metadata: keys you pass overwrite (scalars/arrays wholesale, nested objects merge), keys you omit are preserved, and a key set to null is deleted. So you can change one field without resending the rest.',
  })
  @IsOptional() @IsString() metadata?: string
  @ApiProperty({
    required: false,
    description:
      'ISO timestamp gating a `scheduled` piece - publishers hold it until this time has passed. Pass an empty string to clear. Required (here or already stored) when status is `scheduled`.',
  })
  @IsOptional() @IsString() scheduled_at?: string
  @ApiProperty({ required: false, description: 'users.id performing this mutation (audit stamp; defaults to the authenticated principal)' })
  @IsOptional() @IsString() actor?: string
}
class SetStatusDto {
  @ApiProperty() @IsString() id!: string
  @ApiProperty({ enum: CONTENT_STATUSES }) @IsIn(CONTENT_STATUSES) status!: ContentStatus
  @ApiProperty({ required: false, description: 'users.id performing this mutation (audit stamp; defaults to the authenticated principal)' })
  @IsOptional() @IsString() actor?: string
}
class FindingsApproveDto {
  @ApiProperty({ description: 'Piece id - slug path <topic>/<channel>' }) @IsString() id!: string
  @ApiProperty({ description: 'true ticks the finding off, false unticks it' }) @IsBoolean() approved!: boolean
  @ApiProperty({
    required: false,
    type: [Number],
    description:
      'Which findings, by position in the stored verdict. Omit to set every finding at once (the panel header checkbox).',
  })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @Min(0, { each: true })
  indices?: number[]
  @ApiProperty({ required: false, description: 'users.id performing this mutation (audit stamp; defaults to the authenticated principal)' })
  @IsOptional() @IsString() actor?: string
}
const TRANSITION_IDS = Object.keys(CONTENT_TRANSITIONS)
class TransitionDto {
  @ApiProperty({ description: 'Piece id - slug path <topic>/<channel>' }) @IsString() id!: string
  @ApiProperty({
    enum: TRANSITION_IDS,
    description:
      'The transition to apply. Availability depends on the piece\'s current state + channel (see `transitions` on the piece).',
  })
  @IsIn(TRANSITION_IDS)
  transition!: ContentTransitionId
  @ApiProperty({ required: false, description: 'Optional note on approve; required by any transition whose spec says so' })
  @IsOptional() @IsString() note?: string
  @ApiProperty({ required: false, description: 'Required by schedule - ISO timestamp the piece goes out' })
  @IsOptional() @IsString() scheduled_at?: string
  @ApiProperty({ required: false, description: 'Required by record-published - the live URL of the post you made' })
  @IsOptional() @IsString() published_url?: string
  @ApiProperty({ required: false, description: 'users.id performing the transition (defaults to the authenticated principal)' })
  @IsOptional() @IsString() actor?: string
}
class VerifyInputDto {
  @ApiProperty() @IsString() id!: string
  @ApiProperty({ description: 'The verdict. It does NOT move the piece - a draft stays a draft either way' }) @IsBoolean() passed!: boolean
  @ApiProperty({ required: false, description: 'JSON array string of {lens,severity,message} findings' })
  @IsOptional() @IsString() findings?: string
}
class IdDto {
  @ApiProperty() @IsString() id!: string
}
class TopicIdDto {
  @ApiProperty({ description: 'Topic slug (docs/content/<topic>/)' }) @IsString() topic_id!: string
}
class AssetListDto {
  @ApiProperty({ type: [String], description: 'Servable media filenames in the topic folder' })
  files!: string[]
}
class DocDto {
  @ApiProperty() path!: string
  @ApiProperty() content!: string
  @ApiProperty() exists!: boolean
  @ApiProperty({ description: 'vscode://file/<abs> deep link' }) editorUri!: string
}
class DocSaveDto {
  @ApiProperty() @IsString() id!: string
  @ApiProperty({ description: 'Full markdown body to write to disk' }) @IsString() content!: string
}
// A servable asset in a topic folder + the REST path that streams its bytes. A remote MCP
// client on another machine prepends the server's base URL to `path` and GETs the bytes - MCP tool
// results are text, so the file itself never rides the MCP channel.
class AssetRefDto {
  @ApiProperty({ description: 'Flat media filename in docs/content/<topic>/' }) file!: string
  @ApiProperty({ description: 'REST path that streams the bytes: /api/content/asset/<topic>/<file>' })
  path!: string
}
// Everything a remote session needs to reproduce a piece: the row, its markdown body, and the assets.
class ContentGetDto {
  @ApiProperty({ type: ContentPieceDto, required: false, nullable: true }) piece!: ContentPieceDto | null
  @ApiProperty({ type: DocDto, description: 'The markdown body on disk (exists:false when none yet)' })
  doc!: DocDto
  @ApiProperty({ type: [AssetRefDto], description: 'Servable media in the topic folder + their fetch paths' })
  assets!: AssetRefDto[]
}
class ListContentDto {
  @ApiProperty({ required: false, description: 'Filter to one topic slug; omit for every piece' })
  @IsOptional() @IsString() topic_id?: string
}
class PublishDto {
  @ApiProperty({ description: 'Piece id (must be approved or scheduled)' }) @IsString() id!: string
  @ApiProperty({ description: 'The live URL of what was posted (record-only - you post manually)' })
  @IsString() published_url!: string
  @ApiProperty({ description: 'Hard gate - must be true to record a publish' }) @IsBoolean() confirm!: boolean
  @ApiProperty({ required: false, description: 'users.id that published - stamps published_by (drives the engagement matrix; defaults to the authenticated principal)' })
  @IsOptional() @IsString() actor?: string
}

/** Row → wire, with the transitions this piece can make next computed from its state + channel. */
const toDto = (p: ContentPiece): ContentPieceDto =>
  ({ ...p, transitions: availableTransitions(p) }) as unknown as ContentPieceDto
class VoiceFileDto {
  @ApiProperty({ description: 'Instance-relative path (docs/identity/voice/...)' }) path!: string
  @ApiProperty() exists!: boolean
  @ApiProperty({ description: 'File body; empty when the file does not exist' }) content!: string
}
class VoiceStylesDto {
  @ApiProperty({ type: [VoiceFileDto] }) files!: VoiceFileDto[]
}
class VoiceReadDto {
  @ApiProperty({ required: false, description: 'Channel layer to include (e.g. linkedin, reddit)' })
  @IsOptional()
  @IsString()
  channel?: string
  @ApiProperty({ required: false, description: "Author overlay to include (a users.id or 'company'; needs channel)" })
  @IsOptional()
  @IsString()
  author?: string
}

const profilesDto = (): ProfileDto[] =>
  Object.values(channelProfiles()).map((p: ChannelContentProfile) => p as unknown as ProfileDto)

// `needsDialog` is derived, never stored: core owns the rule (see transitionNeedsDialog) and the
// dashboard reads the answer off the spec rather than re-deriving it from `input`/`outward`.
const transitionSpecsDto = (): TransitionSpecDto[] =>
  Object.values(CONTENT_TRANSITIONS).map(
    (t) => ({ ...t, needsDialog: transitionNeedsDialog(t) }) as unknown as TransitionSpecDto,
  )

class ContentTopicDto {
  @ApiProperty() id!: string
  @ApiProperty() title!: string
  @ApiProperty() brief!: string
  @ApiProperty({ enum: TOPIC_STATUSES }) status!: string
  @ApiProperty({ required: false, nullable: true }) owner!: string | null
  @ApiProperty({ type: [String], description: 'Channels this topic should become' })
  target_channels!: string[]
  @ApiProperty({ required: false, nullable: true }) doc_path!: string | null
  @ApiProperty({ type: [String] }) signal_ids!: string[]
  @ApiProperty({ type: [String] }) tags!: string[]
  @ApiProperty({ required: false, nullable: true }) due_date!: string | null
  @ApiProperty() sort!: number
  @ApiProperty() created_at!: string
  @ApiProperty() updated_at!: string
  @ApiProperty({ required: false, nullable: true }) created_by!: string | null
  @ApiProperty({ required: false, nullable: true }) updated_by!: string | null
}
class ContentTopicsDto {
  @ApiProperty() generatedAt!: string
  @ApiProperty({ type: [ContentTopicDto] }) topics!: ContentTopicDto[]
}
// The @Mcp() scalar-inputs constraint again: the two list fields travel comma-separated.
class UpsertTopicDto {
  @ApiProperty({ description: 'Topic slug (a-z, 0-9, -) - the namespace its pieces are filed under' })
  @IsString() id!: string
  @ApiProperty({ required: false }) @IsOptional() @IsString() title?: string
  @ApiProperty({ required: false, description: 'One or two sentences: what this is and why it is worth posting' })
  @IsOptional() @IsString() brief?: string
  @ApiProperty({
    required: false,
    enum: TOPIC_STATUSES,
    description: 'The review gate: planned = an idea nobody has ruled on, active = approved, dropped = killed',
  })
  @IsOptional() @IsIn(TOPIC_STATUSES) status?: string
  @ApiProperty({ required: false, description: "users.id whose voice the pieces speak in ('' clears it)" })
  @IsOptional() @IsString() owner?: string
  @ApiProperty({ required: false, description: "Comma-separated channels this topic should become, e.g. 'blog,linkedin'" })
  @IsOptional() @IsString() target_channels?: string
  @ApiProperty({ required: false, description: 'Comma-separated signals.id values this topic is meant to move' })
  @IsOptional() @IsString() signal_ids?: string
  @ApiProperty({ required: false, description: 'Comma-separated free-form labels' })
  @IsOptional() @IsString() tags?: string
  @ApiProperty({ required: false, description: "Target publish date YYYY-MM-DD ('' clears it)" })
  @IsOptional() @IsString() due_date?: string
  @ApiProperty({ required: false }) @IsOptional() @IsString() actor?: string
}
class TopicDeleteReportDto {
  @ApiProperty() id!: string
  @ApiProperty({ type: [String], description: 'Piece ids removed with it' }) pieces!: string[]
  @ApiProperty({ type: [String], description: 'Of those, the ones already PUBLISHED - they still exist in public' })
  published!: string[]
}
class TopicPendingDto {
  @ApiProperty() id!: string
  @ApiProperty({ type: [String], description: 'Target channels with no piece yet (empty unless the topic is approved)' })
  channels!: string[]
}

/** Comma-separated list → array; '' means "empty it", omitted means "leave it alone". */
const listParam = (v: string | undefined): string[] | undefined =>
  v === undefined ? undefined : v.split(',').map((s) => s.trim()).filter(Boolean)

/**
 * Content surface - a TOPIC (the idea, its brief, the channels it should reach) and its PIECES (that
 * topic on one channel, run through draft→review→verified→approved→published). Two objects since
 * 2026-08-12; neither is an initiative, and the planning layer no longer knows about content at all.
 *
 * The topic's status is the REVIEW GATE the draft pipeline needs: it writes ideas as `planned`, a
 * human moves each to `active` (approved) or `dropped` (killed), and only an approved topic reports
 * channels to generate. Generating is a separate act - `topic-pending-channels` says what is
 * outstanding and something else does the drafting, so a review click never silently spends model
 * time.
 *
 * The agent never advances a piece past `verified`; `approved`/`published` are explicit human actions
 * (rule #5). Publishing is **record-only** for every channel without a wired sender.
 */
@Controller('content')
@UseGuards(AuthGuard)
export class ContentController {
  /** tRPC query `contentTopics` / MCP `topic-list` - every topic, in the team's order. */
  @Get('topics')
  @ApiOkResponse({ type: ContentTopicsDto })
  @Trpc()
  @Mcp({ name: 'topic-list' })
  async topics(): Promise<ContentTopicsDto> {
    const topics = (await readContentTopics()) as ContentTopic[] as ContentTopicDto[]
    return { generatedAt: new Date().toISOString(), topics }
  }

  /**
   * tRPC mutation `contentTopicUpsert` / MCP `topic-upsert` - create or partially update a topic.
   * This is what the weekly draft pipeline writes: ten ideas per person, each `planned` with a brief
   * and the channels it is meant for, waiting for a human to approve or kill it.
   */
  @Post('topic')
  @ApiOkResponse({ type: ContentTopicDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'topic-upsert' })
  async topicUpsert(@Body() body: UpsertTopicDto, @Req() req: PrincipalRequest): Promise<ContentTopicDto> {
    try {
      return (await upsertContentTopic({
        id: body.id,
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.brief !== undefined ? { brief: body.brief } : {}),
        ...(body.status !== undefined ? { status: body.status as TopicStatus } : {}),
        ...(body.owner !== undefined ? { owner: body.owner.trim() || null } : {}),
        ...(listParam(body.target_channels) ? { target_channels: listParam(body.target_channels) as ContentChannel[] } : {}),
        ...(listParam(body.signal_ids) ? { signal_ids: listParam(body.signal_ids)! } : {}),
        ...(listParam(body.tags) ? { tags: listParam(body.tags)! } : {}),
        ...(body.due_date !== undefined ? { due_date: body.due_date.trim() || null } : {}),
        actor: body.actor ?? req.principal?.id,
      })) as ContentTopic as ContentTopicDto
    } catch (e) {
      // The domain refuses unknown channels, unknown owners and bad slugs with a message that says
      // which - a 500 would strip exactly the part the caller needs to act on.
      throw new BadRequestException(e instanceof Error ? e.message : String(e))
    }
  }

  /**
   * tRPC mutation `contentTopicDelete` / MCP `topic-delete` - remove a topic AND cascade to its
   * pieces, then report what that means: how many pieces went, and which of them were already
   * published (those posts still exist in public; the warehouse is simply forgetting them).
   */
  @Post('topic/delete')
  @ApiOkResponse({ type: TopicDeleteReportDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'topic-delete' })
  async topicDelete(@Body() body: IdDto): Promise<TopicDeleteReportDto> {
    try {
      return await deleteContentTopic(body.id)
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : String(e))
    }
  }

  /**
   * tRPC mutation `contentTopicPending` / MCP `topic-pending-channels` - the target channels an
   * APPROVED topic still has no piece for. Empty for anything not approved, which is the gate doing
   * its job. The drafting itself is a separate act (`/draft-content`); this only says what is owed.
   */
  @Post('topic/pending')
  @ApiOkResponse({ type: TopicPendingDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'topic-pending-channels' })
  async topicPending(@Body() body: IdDto): Promise<TopicPendingDto> {
    return { id: body.id, channels: await pendingTopicChannels(body.id) }
  }

  /** tRPC query `contentPieces` - every piece + the per-channel profiles (constraints/voice). */
  @Get('pieces')
  @ApiOkResponse({ type: ContentPiecesDto })
  @Trpc()
  async pieces(): Promise<ContentPiecesDto> {
    const pieces = (await readContentPieces()).map(toDto)
    return { generatedAt: new Date().toISOString(), pieces, profiles: profilesDto(), transitionSpecs: transitionSpecsDto() }
  }

  /**
   * tRPC mutation `contentList` / MCP `content-list` - the piece ledger (id, channel, status, title,
   * published fields, metadata), optionally filtered to one topic. The read entry point for a
   * remote session (e.g. a MacBook driving a publish): find the piece, then `content-get` it.
   */
  @Post('pieces/list')
  @ApiOkResponse({ type: ContentPiecesDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'content-list' })
  async list(@Body() body: ListContentDto): Promise<ContentPiecesDto> {
    const pieces = (await readContentPieces(body.topic_id)).map(toDto)
    return { generatedAt: new Date().toISOString(), pieces, profiles: profilesDto(), transitionSpecs: transitionSpecsDto() }
  }

  /**
   * tRPC mutation `contentGet` / MCP `content-get` - one piece with everything a remote machine needs
   * to publish it: the row, its markdown body from disk, and the topic's assets with the REST
   * paths that stream their bytes (prepend the server base URL to fetch each file over HTTP).
   */
  @Post('piece/get')
  @ApiOkResponse({ type: ContentGetDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'content-get' })
  async get(@Body() body: IdDto): Promise<ContentGetDto> {
    const piece = await readContentPiece(body.id)
    const doc = readContentDoc(body.id)
    const topic = piece?.topic_id ?? body.id.split('/')[0]
    const assets: AssetRefDto[] = listContentAssets(topic).map((file) => ({
      file,
      path: `/api/content/asset/${topic}/${file}`,
    }))
    return { piece: piece ? toDto(piece) : null, doc, assets }
  }

  /** tRPC mutation `contentUpsert` / MCP `content-upsert` - create or partially update a piece. */
  @Post('piece')
  @ApiOkResponse({ type: ContentPieceDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'content-upsert' })
  async upsert(@Body() body: UpsertContentDto, @Req() req: PrincipalRequest): Promise<ContentPieceDto> {
    body.actor ??= req.principal?.id
    const { metadata, scheduled_at, ...rest } = body
    const parsed = metadata !== undefined ? (JSON.parse(metadata) as Record<string, unknown>) : undefined
    const input: ContentInput = {
      ...rest,
      ...(parsed ? { metadata: parsed } : {}),
      // MCP inputs are scalar strings: '' clears the schedule, omitted leaves it unchanged.
      ...(scheduled_at !== undefined ? { scheduled_at: scheduled_at || null } : {}),
    }
    return toDto(await upsertContent(input))
  }

  /**
   * tRPC mutation `contentTransition` / MCP `content-transition` - move a piece through the lifecycle
   * by NAMING what you are doing (approve, schedule, publish-now, reopen…) rather than by
   * setting a status. Each transition carries its own preconditions, required input and consequence;
   * the server refuses one that isn't available from the piece's current state, so a stale client
   * can't fire a move that no longer applies. This is the path the dashboard uses - `content-upsert`
   * / `content-set-status` remain for authoring and for agents doing bookkeeping.
   */
  @Post('piece/transition')
  @ApiOkResponse({ type: ContentPieceDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'content-transition' })
  async transition(@Body() body: TransitionDto, @Req() req: PrincipalRequest): Promise<ContentPieceDto> {
    return toDto(await applyContentTransition({ ...body, actor: body.actor ?? req.principal?.id }))
  }

  /** tRPC mutation `contentSetStatus` / MCP `content-set-status` - the common quick action. */
  @Post('piece/status')
  @ApiOkResponse({ type: ContentPieceDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'content-set-status' })
  async setStatus(@Body() body: SetStatusDto, @Req() req: PrincipalRequest): Promise<ContentPieceDto> {
    return toDto(await upsertContent({ id: body.id, status: body.status, actor: body.actor ?? req.principal?.id }))
  }

  /**
   * tRPC mutation `contentVerify` / MCP `content-verify` - record an agent-verify verdict (produced by
   * the /verify-content skill; the controller does NOT run a model). pass → verified, fail →
   * changes_requested.
   *
   * Severity is validated here rather than trusted. It was typed as a bare string until 2026-08-13,
   * and production had been carrying 8 findings at `severity: 'info'` - a value no skill documents,
   * which rendered green for months by falling through a ternary. A finding whose severity the app
   * does not know cannot be coloured, counted or ticked off, so the write is refused at the door.
   */
  @Post('piece/verify')
  @ApiOkResponse({ type: ContentPieceDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'content-verify' })
  async verify(@Body() body: VerifyInputDto): Promise<ContentPieceDto> {
    const findings = body.findings ? (JSON.parse(body.findings) as VerifyFinding[]) : []
    const bad = findings.filter((f) => !(VERIFY_SEVERITIES as readonly string[]).includes(f.severity))
    if (bad.length > 0) {
      throw new BadRequestException(
        `content-verify refused: ${bad.length} finding(s) carry an unknown severity ` +
          `(${[...new Set(bad.map((f) => String(f.severity)))].join(', ')}) - use one of ${VERIFY_SEVERITIES.join(' | ')}`,
      )
    }
    return toDto(await recordContentVerify(body.id, { passed: body.passed, findings, checkedAt: new Date().toISOString() }))
  }

  /**
   * tRPC mutation `contentFindingsApprove` / MCP `content-findings-approve` - tick verify findings
   * off, or every finding at once (omit `indices`). A piece cannot be approved until all of them are
   * ticked, which is what makes the gate something a human read rather than dismissed.
   *
   * It moves nothing: the status machine is untouched, and approving findings only decides whether the
   * `approve` transition is offered as enabled.
   */
  @Post('piece/findings/approve')
  @ApiOkResponse({ type: ContentPieceDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'content-findings-approve' })
  async findingsApprove(@Body() body: FindingsApproveDto, @Req() req: PrincipalRequest): Promise<ContentPieceDto> {
    try {
      return toDto(
        await setFindingsApproved({
          id: body.id,
          approved: body.approved,
          ...(body.indices === undefined ? {} : { indices: body.indices }),
          actor: body.actor ?? req.principal?.id,
        }),
      )
    } catch (err) {
      throw new BadRequestException(err instanceof Error ? err.message : String(err))
    }
  }

  /**
   * tRPC mutation `contentVoiceRead` / MCP `voice-read` - the layered voice-style markdown
   * (voice-guide + global + optional channel + optional author overlay). Makes remote draft/verify
   * sessions self-sufficient: plugin-installed skills have no repo on disk, and the voice files are
   * the enforceable style contract they check drafts against (added 2026-07-20 for remote operation).
   * Missing layers return `exists: false` rather than erroring - a missing overlay is legal.
   */
  @Post('voice/read')
  @ApiOkResponse({ type: VoiceStylesDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'voice-read' })
  async voiceRead(@Body() body: VoiceReadDto): Promise<VoiceStylesDto> {
    return { files: readVoiceStyles(body.channel, body.author) }
  }

  /** tRPC mutation `contentDelete` / MCP `content-delete` - remove a piece (body left on disk). */
  @Post('piece/delete')
  @ApiOkResponse({ type: ContentPiecesDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'content-delete' })
  async remove(@Body() body: IdDto): Promise<ContentPiecesDto> {
    await deleteContent(body.id)
    return this.pieces()
  }

  /**
   * Plain REST (no tRPC/MCP): stream a media file from a topic's docs/content folder - the
   * `<img src>` behind `metadata.assets` in the dashboard. Path pieces are validated like piece
   * bodies (slug + flat filename, media extensions only).
   */
  @Get('asset/:topic/:file')
  @Header('Cache-Control', 'private, max-age=60')
  asset(@Param('topic') topic: string, @Param('file') file: string): StreamableFile {
    try {
      const { abs, mime } = contentAssetFile(topic, file)
      return new StreamableFile(createReadStream(abs), { type: mime, disposition: 'inline' })
    } catch (err) {
      throw new NotFoundException(String(err instanceof Error ? err.message : err))
    }
  }

  /** tRPC mutation `contentAssets` - list a topic folder's media files (the asset picker). */
  @Post('assets')
  @ApiOkResponse({ type: AssetListDto })
  @Trpc({ kind: 'mutation' })
  assets(@Body() body: TopicIdDto): AssetListDto {
    return { files: listContentAssets(body.topic_id) }
  }

  /** tRPC mutation `contentDoc` - read a piece's markdown body from disk (empty if none yet). */
  @Post('doc/read')
  @ApiOkResponse({ type: DocDto })
  @Trpc({ kind: 'mutation' })
  async doc(@Body() body: IdDto): Promise<DocDto> {
    return readContentDoc(body.id)
  }

  /** tRPC mutation `contentDocSave` / MCP `content-doc-save` - write a body to disk (autosave). */
  @Post('doc')
  @ApiOkResponse({ type: DocDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'content-doc-save' })
  async docSave(@Body() body: DocSaveDto): Promise<DocDto> {
    return writeContentDoc(body.id, body.content)
  }

  /**
   * tRPC mutation `contentPublish` / MCP `content-publish` - the **gated, record-only** publish.
   * Refuses unless the piece cleared the gate (`verified`/`approved`/`scheduled`) and `confirm` is
   * true; refuses `linkedin` outright (that channel has a real sender). Does NOT auto-send: you post
   * manually on the channel, then this records `published_url` + `published_at` and flips the piece to
   * `published`, feeding the `content.published.*` signal. (Auto-dispatch stays deferred until an
   * explicit go-ahead to wire real sends - operating rule #5 / "checkpoint before any real send".)
   */
  @Post('piece/publish')
  @ApiOkResponse({ type: ContentPieceDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'content-publish' })
  async publish(@Body() body: PublishDto, @Req() req: PrincipalRequest): Promise<ContentPieceDto> {
    body.actor ??= req.principal?.id
    if (!body.confirm) throw new Error('content-publish refused: confirm must be true')
    // The gate itself lives in core (recordContentPublish) so this tool and the dashboard's
    // `record-published` transition can never drift apart.
    return toDto(
      await recordContentPublish({ id: body.id, published_url: body.published_url, actor: body.actor }),
    )
  }
}

import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common'
import { AuthGuard } from '../../../auth/auth.guard.js'
import { type PrincipalRequest } from '../../../auth/auth.decorators.js'
import { ApiOkResponse, ApiProperty } from '@nestjs/swagger'
import { IsIn, IsOptional, IsString } from 'class-validator'
import { Mcp, Trpc } from '@silkweave/nestjs'
import { buildInbox, listInboxDrafts, readInboxDraft, readInboxState, saveInboxDraft, setInboxState, type InboxData, type InboxState } from '@silkweave/box-core'

// DTOs document the REST/Swagger surface and drive the generated tRPC output types. The dashboard
// keeps its own inbox-types and structurally casts the result (mirrors SignalsController).
class InboxItemDto {
  @ApiProperty() id!: string
  @ApiProperty() channel!: string
  @ApiProperty() kind!: string
  @ApiProperty() author!: string
  @ApiProperty() title!: string
  @ApiProperty() snippet!: string
  @ApiProperty() url!: string
  @ApiProperty() created_at!: string
  @ApiProperty() target!: string
  @ApiProperty({ required: false, description: 'Full untruncated text (detail page)' }) body?: string
}
class InboxDataDto {
  @ApiProperty() generatedAt!: string
  @ApiProperty({ type: [String] }) channels!: string[]
  @ApiProperty({ type: [InboxItemDto] }) items!: InboxItemDto[]
}

class InboxStateEntryDto {
  @ApiProperty() id!: string
  @ApiProperty({ enum: ['done', 'snoozed'] }) status!: string
  @ApiProperty() done_at!: string
  @ApiProperty({ required: false }) note?: string
}
class InboxStateDto {
  @ApiProperty({ type: [InboxStateEntryDto] }) items!: InboxStateEntryDto[]
}

/** Input for `inboxSetDone` - reflected into the tRPC/MCP input schema via class-validator. */
class SetInboxStateDto {
  @ApiProperty({ description: 'InboxItem.id to update' })
  @IsString()
  id!: string

  @ApiProperty({ enum: ['done', 'snoozed', 'open'], description: '"open" clears the row' })
  @IsIn(['done', 'snoozed', 'open'])
  status!: 'done' | 'snoozed' | 'open'

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  note?: string
}

class InboxDraftDto {
  @ApiProperty() item_id!: string
  @ApiProperty() channel!: string
  @ApiProperty() body!: string
  @ApiProperty({ required: false, nullable: true, description: "users.id whose voice the draft speaks in" }) author!: string | null
  @ApiProperty({ required: false, nullable: true }) created_by!: string | null
  @ApiProperty({ required: false, nullable: true }) updated_by!: string | null
  @ApiProperty() created_at!: string
  @ApiProperty() updated_at!: string
}
class InboxDraftsDto {
  @ApiProperty({ type: [InboxDraftDto] }) drafts!: InboxDraftDto[]
}
class InboxDraftGetDto {
  @ApiProperty({ description: 'InboxItem.id the draft is attached to' }) @IsString() item_id!: string
}
class InboxDraftMaybeDto {
  @ApiProperty({ type: InboxDraftDto, required: false, nullable: true }) draft!: InboxDraftDto | null
}
class InboxDraftSaveDto {
  @ApiProperty({ description: 'InboxItem.id the draft is attached to' }) @IsString() item_id!: string
  @ApiProperty({ description: "The item's inbox channel (reddit/x/linkedin/…)" }) @IsString() channel!: string
  @ApiProperty({ description: 'Draft reply text; empty string CLEARS the draft' }) @IsString() body!: string
  @ApiProperty({ required: false, description: "users.id whose voice the draft speaks in" })
  @IsOptional() @IsString() author?: string
  @ApiProperty({ required: false, description: 'users.id performing the save (audit stamp; defaults to the authenticated principal)' })
  @IsOptional() @IsString() actor?: string
}

/**
 * Tactical engagement inbox - served live from the warehouse (no inbox.json prebuild). `inboxData`
 * flattens the latest engagement snapshots; `inboxState`/`inboxSetDone` read/write done-state in the
 * `inbox_state` table (no more dev-only Vite endpoint). Draft replies (P3b) are state in
 * `inbox_drafts` - written by the /draft-reply skill or the detail page, copied out by the human,
 * never auto-sent.
 */
@Controller('inbox')
@UseGuards(AuthGuard)
export class InboxController {
  /** tRPC query `inboxData` - the actionable engagement list, newest-first. */
  @Get()
  @ApiOkResponse({ type: InboxDataDto })
  @Trpc()
  async data(): Promise<InboxDataDto> {
    return (await buildInbox()) as InboxData as InboxDataDto
  }

  /** tRPC query `inboxState` - every done/snoozed entry. */
  @Get('state')
  @ApiOkResponse({ type: InboxStateDto })
  @Trpc()
  async state(): Promise<InboxStateDto> {
    return (await readInboxState()) as InboxState as InboxStateDto
  }

  /** tRPC mutation `inboxSetDone` / MCP tool `InboxSetDone` - record/clear an item's state. */
  @Post('state')
  @ApiOkResponse({ type: InboxStateDto })
  @Trpc({ kind: 'mutation' })
  @Mcp()
  async setDone(@Body() body: SetInboxStateDto): Promise<InboxStateDto> {
    return (await setInboxState(body.id, body.status, body.note)) as InboxState as InboxStateDto
  }

  /** tRPC query `inboxDrafts` - every stored draft reply (the dashboard filters per item/channel). */
  @Get('drafts')
  @ApiOkResponse({ type: InboxDraftsDto })
  @Trpc()
  async drafts(): Promise<InboxDraftsDto> {
    return { drafts: (await listInboxDrafts()) as InboxDraftDto[] }
  }

  /** tRPC mutation `inboxDraftGet` / MCP `inbox-draft-get` - one item's draft (null when none). */
  @Post('draft/get')
  @ApiOkResponse({ type: InboxDraftMaybeDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'inbox-draft-get' })
  async draftGet(@Body() body: InboxDraftGetDto): Promise<InboxDraftMaybeDto> {
    return { draft: (await readInboxDraft(body.item_id)) as InboxDraftDto | null }
  }

  /** tRPC mutation `inboxDraftSave` / MCP `inbox-draft-save` - upsert (empty body clears). */
  @Post('draft')
  @ApiOkResponse({ type: InboxDraftMaybeDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'inbox-draft-save' })
  async draftSave(@Body() body: InboxDraftSaveDto, @Req() req: PrincipalRequest): Promise<InboxDraftMaybeDto> {
    body.actor ??= req.principal?.id
    return { draft: (await saveInboxDraft(body)) as InboxDraftDto | null }
  }
}

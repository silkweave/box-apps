import { BadRequestException, Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common'
import { ApiOkResponse, ApiProperty } from '@nestjs/swagger'
import { IsBoolean, IsOptional, IsString } from 'class-validator'
import { Mcp, Trpc } from '@silkweave/nestjs'
import { AuthGuard } from '../../../auth/auth.guard.js'
import { type PrincipalRequest } from '../../../auth/auth.decorators.js'
import { deleteReminder, listReminders, setReminderDone, upsertReminder, type Reminder } from '@silkweave/box-core'

// The @Mcp() adapter has no way to express `| null`, so `description: ''` is how an agent clears the
// description (the convention crm and planning already use). Omitting a field leaves it alone.

class ReminderDto {
  @ApiProperty() id!: string
  @ApiProperty() title!: string
  @ApiProperty({ description: 'ISO-8601 with Z - when it should fire' }) due_at!: string
  @ApiProperty({ required: false, nullable: true }) description!: string | null
  @ApiProperty({ required: false, nullable: true, description: 'NULL while open; the completion stamp once done' })
  done_at!: string | null
  @ApiProperty() created_at!: string
  @ApiProperty() updated_at!: string
  @ApiProperty({ required: false, nullable: true }) created_by!: string | null
  @ApiProperty({ required: false, nullable: true }) updated_by!: string | null
}

class RemindersDto {
  @ApiProperty() generatedAt!: string
  @ApiProperty({ type: [ReminderDto] }) reminders!: ReminderDto[]
}

class UpsertReminderDto {
  @ApiProperty({ required: false, description: 'Omit to create a new reminder' })
  @IsOptional() @IsString() id?: string
  @ApiProperty({ required: false, description: 'Required on create' })
  @IsOptional() @IsString() title?: string
  @ApiProperty({ required: false, description: 'Required on create. Any ISO-8601 date/time; stored as UTC' })
  @IsOptional() @IsString() due_at?: string
  @ApiProperty({ required: false, description: "Optional note. '' clears it" })
  @IsOptional() @IsString() description?: string
  @ApiProperty({ required: false, description: 'Who did this; defaults to the caller' })
  @IsOptional() @IsString() actor?: string
}

class ReminderDoneDto {
  @ApiProperty() @IsString() id!: string
  @ApiProperty({ description: 'true completes it, false reopens it' }) @IsBoolean() done!: boolean
  @ApiProperty({ required: false }) @IsOptional() @IsString() actor?: string
}

class ReminderIdDto {
  @ApiProperty() @IsString() id!: string
}

/**
 * Reminders - a moment in time, a name, an optional description. The whole surface is one query and
 * three mutations, each of which is also an MCP tool, so the dashboard, an agent and `pnpm cli` all
 * reach the same code. Class-level `@UseGuards(AuthGuard)` is deny-by-default: nothing here is
 * publicly reachable on REST, tRPC or MCP.
 *
 * Validation lives one layer down, in core's reminders/state.ts, so a tool call and a click are
 * refused for the same reasons with the same sentence; this controller only turns that sentence
 * into a 400 instead of a 500.
 */
@Controller('reminders')
@UseGuards(AuthGuard)
export class RemindersController {
  /** tRPC query `remindersList` / MCP `reminders-list` - every reminder, open ones first, soonest first. */
  @Get()
  @ApiOkResponse({ type: RemindersDto })
  @Trpc()
  @Mcp({ name: 'reminders-list' })
  async list(): Promise<RemindersDto> {
    return { generatedAt: new Date().toISOString(), reminders: (await listReminders()) as Reminder[] as ReminderDto[] }
  }

  /**
   * tRPC mutation `remindersUpsert` / MCP `reminder-upsert` - create one (no `id`, needs `title` and
   * `due_at`) or partially update one.
   */
  @Post()
  @ApiOkResponse({ type: ReminderDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'reminder-upsert' })
  async upsert(@Body() body: UpsertReminderDto, @Req() req: PrincipalRequest): Promise<ReminderDto> {
    body.actor ??= req.principal?.id
    try {
      return (await upsertReminder(body)) as Reminder as ReminderDto
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : String(e))
    }
  }

  /** tRPC mutation `remindersDone` / MCP `reminder-done` - complete or reopen one. */
  @Post('done')
  @ApiOkResponse({ type: ReminderDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'reminder-done' })
  async done(@Body() body: ReminderDoneDto, @Req() req: PrincipalRequest): Promise<ReminderDto> {
    try {
      return (await setReminderDone(body.id, body.done, body.actor ?? req.principal?.id)) as Reminder as ReminderDto
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : String(e))
    }
  }

  /** tRPC mutation `remindersDelete` / MCP `reminder-delete` - remove one, returning the fresh list. */
  @Post('delete')
  @ApiOkResponse({ type: RemindersDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'reminder-delete' })
  async delete(@Body() body: ReminderIdDto): Promise<RemindersDto> {
    await deleteReminder(body.id)
    return { generatedAt: new Date().toISOString(), reminders: (await listReminders()) as Reminder[] as ReminderDto[] }
  }
}

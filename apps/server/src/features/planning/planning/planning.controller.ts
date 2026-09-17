import { BadRequestException, Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common'
import { AuthGuard } from '../../../auth/auth.guard.js'
import { type PrincipalRequest, Admin } from '../../../auth/auth.decorators.js'
import { ApiOkResponse, ApiProperty } from '@nestjs/swagger'
import { IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString } from 'class-validator'
import { Mcp, Trpc } from '@silkweave/nestjs'
import { CHECKIN_BUCKETS, completeCheckin, createSprintTask, deleteInitiative, deleteInitiativeKind, deleteSprint, deleteTask, moveTask, readInitiative, readInitiativeKindUsage, readInitiatives, readPlanningDoc, readSprint, readSprints, saveInitiativeKind, tickCheckin, renameInitiative, renameTask, reorderInitiatives, reorderTasks, PLANNING_STATUSES, SPRINT_STATUSES, upsertInitiative, upsertSprint, upsertTask, VALUE_LEVELS, savePlanningDoc, type CheckinBucket, type DocKind, type InitiativeKind, type InitiativeWithTasks, type PlanningStatus, type Sprint, type SprintDetail, type SprintStatus, type Task, type ValueLevel } from '@silkweave/box-core'

const DOC_KINDS: DocKind[] = ['initiative', 'task']

// The @Mcp() adapter has no way to express `| null`, so the optional enum dimensions accept '' as
// "clear it" - the same convention `target_signal_id` already uses. Omitting the field leaves the
// stored value alone.
const CLEARABLE = <T extends string>(values: readonly T[]): string[] => [...values, '']
const clearable = <T extends string>(v: string | undefined): T | null | undefined =>
  v === undefined ? undefined : v === '' ? null : (v as T)

// DTOs document the REST/Swagger surface and drive the generated tRPC input/output types. As with
// the inbox/signals controllers, the dashboard keeps its own planning-types and structurally casts
// nested arrays (tRPC reflects nested DTO arrays as `unknown[]`).
class TargetDto {
  @ApiProperty() signal_id!: string
  @ApiProperty() value!: number
  @ApiProperty({ required: false }) by_date?: string
  @ApiProperty({ required: false }) baseline?: number
}
class TaskDto {
  @ApiProperty() id!: string
  @ApiProperty({ required: false, nullable: true, description: 'null = a sprint task (belongs to its sprint, no initiative)' })
  initiative_id!: string | null
  @ApiProperty() title!: string
  @ApiProperty() summary!: string
  @ApiProperty() status!: string
  @ApiProperty() rank!: number
  @ApiProperty({ required: false, nullable: true }) score!: number | null
  @ApiProperty({ required: false, nullable: true, description: '1-3 stars; null = unrated' }) priority!: number | null
  @ApiProperty({ required: false, nullable: true, description: 'Estimate in whole hours 1-8; null = not estimated' })
  estimate_hours!: number | null
  @ApiProperty({ type: [String] }) tags!: string[]
  @ApiProperty({ required: false, nullable: true }) url!: string | null
  @ApiProperty({ required: false, nullable: true }) assignee!: string | null
  @ApiProperty({ type: Object }) metadata!: Record<string, unknown>
  @ApiProperty({ required: false, nullable: true }) due_date!: string | null
  @ApiProperty({ required: false, nullable: true, description: 'Sprint this task is scoped into' }) sprint_id!: string | null
  @ApiProperty({ required: false, nullable: true, description: 'Day inside that sprint the plan puts it on' }) slot_date!: string | null
  @ApiProperty() created_at!: string
  @ApiProperty() updated_at!: string
  @ApiProperty({ required: false, nullable: true }) done_at!: string | null
  @ApiProperty({ required: false, nullable: true }) created_by!: string | null
  @ApiProperty({ required: false, nullable: true }) updated_by!: string | null
}
class InitiativeDto {
  @ApiProperty() id!: string
  @ApiProperty() title!: string
  @ApiProperty() summary!: string
  @ApiProperty() status!: string
  @ApiProperty() kind!: string
  @ApiProperty({ required: false, nullable: true }) owner!: string | null
  @ApiProperty({ type: [String] }) signal_ids!: string[]
  @ApiProperty({ type: TargetDto, required: false, nullable: true }) target!: TargetDto | null
  @ApiProperty({ required: false, nullable: true, enum: VALUE_LEVELS }) value_customer!: string | null
  @ApiProperty({ required: false, nullable: true, enum: VALUE_LEVELS }) value_company!: string | null
  @ApiProperty({ required: false, nullable: true, description: '1-3 stars; null = unrated' }) priority!: number | null
  @ApiProperty({ type: [String] }) blocked_by!: string[]
  @ApiProperty({ type: [String] }) tags!: string[]
  @ApiProperty({ required: false, nullable: true }) doc_path!: string | null
  @ApiProperty({ required: false, nullable: true }) due_date!: string | null
  @ApiProperty() sort!: number
  @ApiProperty() created_at!: string
  @ApiProperty() updated_at!: string
  @ApiProperty({ required: false, nullable: true }) created_by!: string | null
  @ApiProperty({ required: false, nullable: true }) updated_by!: string | null
  @ApiProperty({ type: [TaskDto] }) tasks!: TaskDto[]
}
class InitiativesDto {
  @ApiProperty() generatedAt!: string
  @ApiProperty({ type: [InitiativeDto] }) initiatives!: InitiativeDto[]
}

// NOTE: @Mcp() input fields must have a concrete scalar/array JSON-schema `type` so the cli proxy
// can build an option for each. This adapter does NOT emit a `type` for @IsObject() fields, so the
// `target` is flattened into scalars and `metadata` is passed as a JSON string (parsed server-side).
// No `nullable` / `| null` unions either - omit a field to leave it unchanged.
class UpsertInitiativeDto {
  @ApiProperty({ description: 'Initiative slug (stable id)' }) @IsString() id!: string
  @ApiProperty({ required: false }) @IsOptional() @IsString() title?: string
  @ApiProperty({ required: false, enum: PLANNING_STATUSES, description: 'Lifecycle: planned active blocked done dropped' })
  @IsOptional() @IsIn(PLANNING_STATUSES) status?: PlanningStatus
  // No `enum:` and no @IsIn: the kind list is tenant configuration (config/initiative-kinds.json),
  // and a decorator is evaluated once at class-definition time, so baking the list in here would
  // freeze whatever it was at boot and refuse a lane the team added an hour ago. `upsertInitiative`
  // validates against the live list and the catch below turns that into a 400 naming the allowed
  // values - the same message the MCP caller needs.
  @ApiProperty({ required: false, description: 'What shape of work this is - the board grouping axis. One of the tenant kind ids (planning-kinds lists them; edit in Settings)' })
  @IsOptional() @IsString() kind?: InitiativeKind
  @ApiProperty({ required: false }) @IsOptional() @IsString() owner?: string
  @ApiProperty({ required: false, type: [String], description: 'signals.signal_id values this drives' })
  @IsOptional() @IsArray() @IsString({ each: true }) signal_ids?: string[]
  @ApiProperty({ required: false, enum: CLEARABLE(VALUE_LEVELS), description: "Worth to customers ('' clears)" })
  @IsOptional() @IsIn(CLEARABLE(VALUE_LEVELS)) value_customer?: string
  @ApiProperty({ required: false, enum: CLEARABLE(VALUE_LEVELS), description: "Worth to us ('' clears)" })
  @IsOptional() @IsIn(CLEARABLE(VALUE_LEVELS)) value_company?: string
  @ApiProperty({ required: false, description: 'How much it matters: 1-3 stars (0 clears)' })
  @IsOptional() @IsInt() priority?: number
  @ApiProperty({ required: false, type: [String], description: 'initiatives.id values this waits on (must exist, no cycles)' })
  @IsOptional() @IsArray() @IsString({ each: true }) blocked_by?: string[]
  @ApiProperty({ required: false, type: [String], description: 'Free-form labels (lowercased + de-duplicated)' })
  @IsOptional() @IsArray() @IsString({ each: true }) tags?: string[]
  @ApiProperty({ required: false, description: "Target signal_id ('' clears the whole target)" }) @IsOptional() @IsString() target_signal_id?: string
  @ApiProperty({ required: false, description: 'Target value to reach' }) @IsOptional() @IsNumber() target_value?: number
  @ApiProperty({ required: false, description: 'Target date YYYY-MM-DD' }) @IsOptional() @IsString() target_by_date?: string
  @ApiProperty({ required: false, description: 'Signal value at start' }) @IsOptional() @IsNumber() target_baseline?: number
  @ApiProperty({ required: false }) @IsOptional() @IsString() doc_path?: string
  @ApiProperty({ required: false, description: "Deadline YYYY-MM-DD ('' clears it)" })
  @IsOptional() @IsString() due_date?: string
  @ApiProperty({ required: false }) @IsOptional() @IsInt() sort?: number
  @ApiProperty({ required: false, description: 'users.id performing this mutation (audit stamp; defaults to the authenticated principal)' })
  @IsOptional() @IsString() actor?: string
}

class UpsertTaskDto {
  @ApiProperty({ description: 'Task id (stable)' }) @IsString() id!: string
  @ApiProperty({ required: false }) @IsOptional() @IsString() initiative_id?: string
  @ApiProperty({ required: false }) @IsOptional() @IsString() title?: string
  @ApiProperty({ required: false, enum: PLANNING_STATUSES, description: 'Lifecycle: planned active blocked done dropped' })
  @IsOptional() @IsIn(PLANNING_STATUSES) status?: PlanningStatus
  @ApiProperty({ required: false }) @IsOptional() @IsInt() rank?: number
  @ApiProperty({ required: false }) @IsOptional() @IsNumber() score?: number
  @ApiProperty({ required: false, description: 'How much it matters: 1-3 stars (0 clears)' })
  @IsOptional() @IsInt() priority?: number
  @ApiProperty({ required: false, description: 'Estimate in whole hours 1-8, rounded + clamped (0 clears it)' })
  @IsOptional() @IsInt() estimate_hours?: number
  @ApiProperty({ required: false, type: [String], description: 'Free-form labels (lowercased + de-duplicated)' })
  @IsOptional() @IsArray() @IsString({ each: true }) tags?: string[]
  @ApiProperty({ required: false }) @IsOptional() @IsString() url?: string
  @ApiProperty({ required: false, description: 'users.id this task is assigned to' })
  @IsOptional() @IsString() assignee?: string
  @ApiProperty({ required: false, description: 'JSON object string of kind-specific fields' })
  @IsOptional() @IsString() metadata?: string
  @ApiProperty({ required: false, description: "Deadline YYYY-MM-DD ('' clears it)" })
  @IsOptional() @IsString() due_date?: string
  @ApiProperty({ required: false, description: "Sprint to scope this task into ('' takes it out, which also unslots it)" })
  @IsOptional() @IsString() sprint_id?: string
  @ApiProperty({ required: false, description: "Day inside the sprint, YYYY-MM-DD ('' unslots while keeping it in scope). Must be within the sprint's range" })
  @IsOptional() @IsString() slot_date?: string
  @ApiProperty({ required: false, description: 'Explicit done/merge timestamp' })
  @IsOptional() @IsString() done_at?: string
  @ApiProperty({ required: false, description: 'users.id performing this mutation (audit stamp; defaults to the authenticated principal)' })
  @IsOptional() @IsString() actor?: string
}

class SetTaskStatusDto {
  @ApiProperty() @IsString() id!: string
  @ApiProperty({ enum: PLANNING_STATUSES }) @IsIn(PLANNING_STATUSES) status!: PlanningStatus
  @ApiProperty({ required: false, description: 'users.id performing this mutation (audit stamp; defaults to the authenticated principal)' })
  @IsOptional() @IsString() actor?: string
}

class IdDto {
  @ApiProperty() @IsString() id!: string
}

class GetInitiativesDto {
  @ApiProperty({ required: false, description: 'One initiative slug; omit for every initiative' })
  @IsOptional() @IsString() id?: string
}

class MoveTaskDto {
  @ApiProperty({ description: 'Task id to move (slug-path <initiative>/<task>)' }) @IsString() id!: string
  @ApiProperty({ description: 'Destination initiative id' }) @IsString() to_initiative_id!: string
  @ApiProperty({ required: false, description: 'New rank within the destination' }) @IsOptional() @IsInt() rank?: number
}

class ReorderDto {
  @ApiProperty({ type: [String], description: 'Ids in their new order (sequential sort/rank assigned)' })
  @IsArray() @IsString({ each: true }) ids!: string[]
}

class RenameInitiativeDto {
  @ApiProperty({ description: 'Current initiative id (slug)' }) @IsString() id!: string
  @ApiProperty({ description: 'New initiative slug' }) @IsString() new_id!: string
}

class RenameTaskDto {
  @ApiProperty({ description: 'Current task id (slug-path <initiative>/<task>)' }) @IsString() id!: string
  @ApiProperty({ description: 'New task-part slug (stays in the same initiative)' }) @IsString() new_slug!: string
}

class DocDto {
  @ApiProperty() path!: string
  @ApiProperty() content!: string
  @ApiProperty() exists!: boolean
  @ApiProperty({ description: 'vscode://file/<abs> deep link' }) editorUri!: string
}
class DocRefDto {
  @ApiProperty({ enum: DOC_KINDS, description: 'initiative or task' }) @IsIn(DOC_KINDS) kind!: DocKind
  @ApiProperty({ description: 'slug id - e.g. silkweave-pr-targets or silkweave-pr-targets/invoicerr' })
  @IsString() id!: string
}
class DocSaveDto {
  @ApiProperty({ enum: DOC_KINDS }) @IsIn(DOC_KINDS) kind!: DocKind
  @ApiProperty() @IsString() id!: string
  @ApiProperty({ description: 'Full markdown body to write to disk' }) @IsString() content!: string
  @ApiProperty({ required: false, description: 'users.id making the edit (defaults to the principal)' })
  @IsOptional() @IsString() actor?: string
}

// --- sprints ---------------------------------------------------------------------------------------
// A sprint is a window of days with capacity (features/planning/SPEC.md). The capacity numbers are
// computed, never stored: `SprintDetail` carries the per-person-per-day grid and the check derived
// from the sprint's tasks, so no caller has to re-implement the capacity arithmetic.

class DayLoadDto {
  @ApiProperty() date!: string
  @ApiProperty({ description: 'users.id' }) user!: string
  @ApiProperty({ description: 'Capacity in hours; 0 on a weekend or a day off' }) hours!: number
  @ApiProperty({ description: "Estimated hours slotted onto the day - the sum of its tasks' estimate_hours" })
  planned!: number
  @ApiProperty() taskCount!: number
  @ApiProperty({ description: 'Slotted tasks with no estimate - excluded from `planned`' }) unsized!: number
  @ApiProperty({ description: "empty | under | ok | over. Only 'over' blocks reaching 'planned'" }) verdict!: string
}
class SprintCheckDto {
  @ApiProperty({ description: 'False when any day is provably over capacity' }) ok!: boolean
  @ApiProperty({ type: [DayLoadDto] }) over!: DayLoadDto[]
  @ApiProperty({ type: [DayLoadDto] }) under!: DayLoadDto[]
  @ApiProperty({ type: [DayLoadDto] }) unsized!: DayLoadDto[]
}
class SprintDto {
  @ApiProperty() id!: string
  @ApiProperty() title!: string
  @ApiProperty() goal!: string
  @ApiProperty({ enum: SPRINT_STATUSES }) status!: string
  @ApiProperty({ required: false, nullable: true }) start_date!: string | null
  @ApiProperty({ required: false, nullable: true }) end_date!: string | null
  @ApiProperty({ type: Object, description: 'users.id -> { hours?, hours_by_date? } for THIS sprint' })
  availability!: Record<string, unknown>
  @ApiProperty({ required: false, nullable: true }) started_at!: string | null
  @ApiProperty({ required: false, nullable: true }) done_at!: string | null
  @ApiProperty() created_at!: string
  @ApiProperty() updated_at!: string
  @ApiProperty({ required: false, nullable: true }) created_by!: string | null
  @ApiProperty({ required: false, nullable: true }) updated_by!: string | null
}
class BurndownPointDto {
  @ApiProperty() date!: string
  @ApiProperty({ description: 'Hours the plan says should remain at the end of this day' }) ideal!: number
  @ApiProperty({ required: false, nullable: true, description: 'Actual hours left; null for a future day' })
  remaining!: number | null
}
class SprintCheckinDto {
  @ApiProperty() sprint_id!: string
  @ApiProperty() date!: string
  @ApiProperty({ type: [String], description: '`<users.id>:<bucket>` - buckets walked in the stand-up' })
  ticks!: string[]
  @ApiProperty({ required: false, nullable: true }) completed_at!: string | null
  @ApiProperty({ required: false, nullable: true }) completed_by!: string | null
}
class SprintDetailDto extends SprintDto {
  @ApiProperty({ type: [TaskDto] }) tasks!: TaskDto[]
  @ApiProperty({ type: [String], description: 'INFERRED from the tasks - never assigned' })
  initiative_ids!: string[]
  @ApiProperty({ type: [DayLoadDto], description: 'One entry per person per day; empty until the sprint has dates' })
  loads!: DayLoadDto[]
  @ApiProperty({ type: SprintCheckDto }) check!: SprintCheckDto
  @ApiProperty({ type: [BurndownPointDto], description: 'Hours remaining per day against the plan' })
  burndown!: BurndownPointDto[]
  @ApiProperty({ required: false, nullable: true, type: SprintCheckinDto, description: "TODAY's stand-up" })
  checkin!: SprintCheckinDto | null
}
class CheckinTickDto {
  @ApiProperty({ description: 'Sprint id (slug)' }) @IsString() id!: string
  @ApiProperty({ description: 'The sprint-day, YYYY-MM-DD' }) @IsString() date!: string
  @ApiProperty({ description: 'users.id whose lane is being ticked' }) @IsString() user!: string
  @ApiProperty({ enum: CHECKIN_BUCKETS, description: 'done | today | slipping' })
  @IsIn(CHECKIN_BUCKETS as unknown as string[]) bucket!: CheckinBucket
  @ApiProperty({ description: 'true ticks it off, false un-ticks and reopens a completed day' })
  @IsBoolean() done!: boolean
  @ApiProperty({ required: false, description: 'users.id doing it (defaults to the principal)' })
  @IsOptional() @IsString() actor?: string
}
class CheckinCompleteDto {
  @ApiProperty({ description: 'Sprint id (slug)' }) @IsString() id!: string
  @ApiProperty({ description: 'The sprint-day, YYYY-MM-DD' }) @IsString() date!: string
  @ApiProperty({ required: false, description: 'users.id doing it (defaults to the principal)' })
  @IsOptional() @IsString() actor?: string
}
class SprintsDto {
  @ApiProperty() generatedAt!: string
  @ApiProperty({ type: [SprintDto] }) sprints!: SprintDto[]
}
class GetSprintDto {
  @ApiProperty({ description: 'Sprint id (slug)' }) @IsString() id!: string
}
class UpsertSprintDto {
  @ApiProperty({ description: 'Sprint id (slug, stable)' }) @IsString() id!: string
  @ApiProperty({ required: false }) @IsOptional() @IsString() title?: string
  @ApiProperty({ required: false, description: 'One line on what this sprint is for' })
  @IsOptional() @IsString() goal?: string
  @ApiProperty({ required: false, enum: SPRINT_STATUSES, description: 'pending scheduled planned active done. Anything past pending needs both dates; planned is refused while a day is over capacity' })
  @IsOptional() @IsIn(SPRINT_STATUSES) status?: SprintStatus
  @ApiProperty({ required: false, description: "First day, YYYY-MM-DD ('' clears it)" })
  @IsOptional() @IsString() start_date?: string
  @ApiProperty({ required: false, description: "Last day inclusive, YYYY-MM-DD ('' clears it)" })
  @IsOptional() @IsString() end_date?: string
  @ApiProperty({ required: false, description: 'JSON object string: {"alice":{"hours":5,"hours_by_date":{"2026-09-09":0,"2026-09-10":3}}}. Replaces the whole map. `hours` is the per-working-day default (5 when omitted); `hours_by_date` overrides it for named days, and 0 IS a day off' })
  @IsOptional() @IsString() availability?: string
  @ApiProperty({ required: false, description: 'users.id performing this mutation (audit stamp; defaults to the authenticated principal)' })
  @IsOptional() @IsString() actor?: string
}
class CreateSprintTaskDto {
  @ApiProperty({ description: 'Sprint id (slug) the task belongs to' }) @IsString() sprint_id!: string
  @ApiProperty({ description: 'Task title (the id is derived from it: <sprint>/<slug>)' }) @IsString() title!: string
  @ApiProperty({ description: 'users.id whose column the task lands in' }) @IsString() assignee!: string
  @ApiProperty({ description: "The person-day, YYYY-MM-DD, inside the sprint's window (also becomes the due date)" })
  @IsString() slot_date!: string
  @ApiProperty({ required: false, description: 'Estimate in whole hours 1-8 (0 or omitted = not estimated)' })
  @IsOptional() @IsInt() estimate_hours?: number
  @ApiProperty({ required: false, description: 'users.id performing this mutation (audit stamp; defaults to the authenticated principal)' })
  @IsOptional() @IsString() actor?: string
}

// --- the kind list ---------------------------------------------------------------------------------
// The board's lanes are tenant configuration (config/initiative-kinds.json) rather than a code enum
// since 2026-08-28, so they need a surface. Reading is open to any internal principal - the whole
// dashboard renders labels off this list - while every WRITE is admin, like the other configuration
// routes (signal owners, schedules, rules).

class InitiativeKindDto {
  @ApiProperty({ description: 'The value stored on initiatives.kind - immutable once created' }) id!: string
  @ApiProperty() label!: string
  @ApiProperty({ required: false, nullable: true, description: 'Icon key from the SPA vocabulary, or null for its default' }) icon!: string | null
  @ApiProperty({ description: 'Initiatives currently in this lane' }) count!: number
  @ApiProperty() updated_at!: string
  @ApiProperty({ required: false, nullable: true }) updated_by!: string | null
}
class InitiativeKindsDto {
  @ApiProperty() generatedAt!: string
  @ApiProperty({ type: [InitiativeKindDto] }) kinds!: InitiativeKindDto[]
}
class SaveInitiativeKindDto {
  @ApiProperty({ description: 'Kind id (slug). Unknown = create, known = edit. Never rewritten - a rename would be a silent data migration' })
  @IsString() id!: string
  @ApiProperty({ required: false, description: 'How it renders on the board (required when creating)' })
  @IsOptional() @IsString() label?: string
  @ApiProperty({ required: false, description: "Icon key (see the dashboard's picker); '' clears it back to the default" })
  @IsOptional() @IsString() icon?: string
  @ApiProperty({ required: false, description: 'users.id performing this mutation (audit stamp; defaults to the authenticated principal)' })
  @IsOptional() @IsString() actor?: string
}

/**
 * Planning surface - initiatives (signals-bound bodies of work) and their tasks. Mirrors the
 * inbox controller: a `initiatives` tRPC query plus mutations that are also MCP tools, so the same
 * actions are callable from the dashboard, from agents, and from the `cli` proxy. Task mutations
 * re-derive the `github.silkweave_prs_merged` outcome signal (handled in @silkweave/box-core).
 */
@Controller('planning')
@UseGuards(AuthGuard)
export class PlanningController {
  /** tRPC query `initiatives` - every initiative with its tasks nested. */
  @Get('initiatives')
  @ApiOkResponse({ type: InitiativesDto })
  @Trpc()
  async initiatives(): Promise<InitiativesDto> {
    const initiatives = (await readInitiatives()) as InitiativeWithTasks[] as InitiativeDto[]
    return { generatedAt: new Date().toISOString(), initiatives }
  }

  /**
   * tRPC mutation `initiativesGet` / MCP `initiatives-get` - initiatives + their nested tasks, all of
   * them or one by `id`. The read entry point for a remote session (e.g. a MacBook running the
   * post-publish sync): find the initiative + the task to close before writing status back.
   */
  @Post('initiatives/get')
  @ApiOkResponse({ type: InitiativesDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'initiatives-get' })
  async initiativesGet(@Body() body: GetInitiativesDto): Promise<InitiativesDto> {
    const initiatives = body.id
      ? ([await readInitiative(body.id)].filter(Boolean) as InitiativeWithTasks[])
      : await readInitiatives()
    return { generatedAt: new Date().toISOString(), initiatives: initiatives as InitiativeDto[] }
  }

  /** tRPC mutation `initiativeUpsert` / MCP `initiative-upsert` - create or partially update one. */
  @Post('initiative')
  @ApiOkResponse({ type: InitiativeDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'initiative-upsert' })
  async initiativeUpsert(@Body() body: UpsertInitiativeDto, @Req() req: PrincipalRequest): Promise<InitiativeDto> {
    body.actor ??= req.principal?.id
    const { target_signal_id, target_value, target_by_date, target_baseline, value_customer, value_company, ...rest } = body
    // '' explicitly CLEARS the target (the flattened scalar DTO has no other way to say null).
    const target =
      target_signal_id !== undefined
        ? target_signal_id === ''
          ? null
          : { signal_id: target_signal_id, value: target_value ?? 0, by_date: target_by_date, baseline: target_baseline }
        : undefined
    const dims = {
      ...(value_customer !== undefined ? { value_customer: clearable<ValueLevel>(value_customer) } : {}),
      ...(value_company !== undefined ? { value_company: clearable<ValueLevel>(value_company) } : {}),
    }
    try {
      return (await upsertInitiative({
        ...rest,
        ...dims,
        ...(target !== undefined ? { target } : {}),
      })) as InitiativeWithTasks as InitiativeDto
    } catch (e) {
      // The domain refuses dependency cycles, unknown blocked_by ids and out-of-enum values with a
      // message that says which - a 500 would strip exactly the part the caller needs to act on.
      throw new BadRequestException(e instanceof Error ? e.message : String(e))
    }
  }

  /** tRPC mutation `initiativeDelete` / MCP `initiative-delete` - remove an initiative + its tasks. */
  @Post('initiative/delete')
  @ApiOkResponse({ type: InitiativesDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'initiative-delete' })
  async initiativeDelete(@Body() body: IdDto): Promise<InitiativesDto> {
    await deleteInitiative(body.id)
    return this.initiatives()
  }

  /** tRPC mutation `taskUpsert` / MCP `task-upsert` - create or partially update a task. */
  @Post('task')
  @ApiOkResponse({ type: TaskDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'task-upsert' })
  async taskUpsert(@Body() body: UpsertTaskDto, @Req() req: PrincipalRequest): Promise<TaskDto> {
    body.actor ??= req.principal?.id
    const { metadata, priority, estimate_hours, ...rest } = body
    const parsed = metadata !== undefined ? (JSON.parse(metadata) as Record<string, unknown>) : undefined
    try {
      return (await upsertTask({
        ...rest,
        // 0 clears - the numeric twin of the '' convention the enums use (normalizePriority in core
        // maps anything outside 1-3 to null, so this needs no separate guard).
        ...(priority !== undefined ? { priority } : {}),
        // 0 clears here too (normalizeEstimateHours maps anything <= 0 to null).
        ...(estimate_hours !== undefined ? { estimate_hours } : {}),
        ...(parsed ? { metadata: parsed } : {}),
      })) as Task as TaskDto
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : String(e))
    }
  }

  /** tRPC mutation `taskSetStatus` / MCP `task-set-status` - the common quick action. */
  @Post('task/status')
  @ApiOkResponse({ type: TaskDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'task-set-status' })
  async taskSetStatus(@Body() body: SetTaskStatusDto, @Req() req: PrincipalRequest): Promise<TaskDto> {
    return (await upsertTask({ id: body.id, status: body.status, actor: body.actor ?? req.principal?.id })) as Task as TaskDto
  }

  /** tRPC mutation `taskDelete` / MCP `task-delete` - remove a task. */
  @Post('task/delete')
  @ApiOkResponse({ type: InitiativesDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'task-delete' })
  async taskDelete(@Body() body: IdDto): Promise<InitiativesDto> {
    await deleteTask(body.id)
    return this.initiatives()
  }

  /**
   * tRPC mutation `taskMove` / MCP `task-move` - move a task to another initiative, re-keying its id
   * (and renaming its doc) to the slug-path convention. Returns the full refreshed list (the id changed).
   */
  @Post('task/move')
  @ApiOkResponse({ type: InitiativesDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'task-move' })
  async taskMove(@Body() body: MoveTaskDto): Promise<InitiativesDto> {
    await moveTask(body.id, body.to_initiative_id, body.rank)
    return this.initiatives()
  }

  /** tRPC mutation `tasksReorder` / MCP `tasks-reorder` - set sequential rank for one initiative's tasks. */
  @Post('tasks/reorder')
  @ApiOkResponse({ type: InitiativesDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'tasks-reorder' })
  async tasksReorder(@Body() body: ReorderDto): Promise<InitiativesDto> {
    await reorderTasks(body.ids)
    return this.initiatives()
  }

  /** tRPC mutation `initiativesReorder` / MCP `initiatives-reorder` - set sequential sort for initiatives. */
  @Post('initiatives/reorder')
  @ApiOkResponse({ type: InitiativesDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'initiatives-reorder' })
  async initiativesReorder(@Body() body: ReorderDto): Promise<InitiativesDto> {
    await reorderInitiatives(body.ids)
    return this.initiatives()
  }

  /**
   * tRPC mutation `initiativeRename` / MCP `initiative-rename` - rename an initiative's slug; cascades to
   * its tasks (re-keyed) + moves all docs. Returns the full refreshed list (ids changed).
   */
  @Post('initiative/rename')
  @ApiOkResponse({ type: InitiativesDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'initiative-rename' })
  async initiativeRename(@Body() body: RenameInitiativeDto): Promise<InitiativesDto> {
    await renameInitiative(body.id, body.new_id)
    return this.initiatives()
  }

  /** tRPC mutation `taskRename` / MCP `task-rename` - rename a task's slug within its initiative. */
  @Post('task/rename')
  @ApiOkResponse({ type: InitiativesDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'task-rename' })
  async taskRename(@Body() body: RenameTaskDto): Promise<InitiativesDto> {
    await renameTask(body.id, body.new_slug)
    return this.initiatives()
  }

  // --- the kind list ------------------------------------------------------------------------------

  /**
   * tRPC query `planningKinds` / MCP `initiative-kinds` - the team's kind list, by label, each with
   * how many initiatives sit in it. Any internal principal may read it: it is the vocabulary
   * every board label is rendered from, not a secret.
   */
  @Get('kinds')
  @ApiOkResponse({ type: InitiativeKindsDto })
  @Trpc()
  @Mcp({ name: 'initiative-kinds' })
  async kinds(): Promise<InitiativeKindsDto> {
    return { generatedAt: new Date().toISOString(), kinds: (await readInitiativeKindUsage()) as InitiativeKindDto[] }
  }

  /**
   * tRPC mutation `planningKindSave` / MCP `initiative-kind-save` - create a lane or edit an existing
   * one's label/area. The id is the key and is never rewritten (see planning/kinds.ts).
   */
  @Post('kind')
  @ApiOkResponse({ type: InitiativeKindsDto })
  @Trpc({ kind: 'mutation' })
  @Admin()
  @Mcp({ name: 'initiative-kind-save' })
  async kindSave(@Body() body: SaveInitiativeKindDto, @Req() req: PrincipalRequest): Promise<InitiativeKindsDto> {
    try {
      saveInitiativeKind({
        id: body.id,
        label: body.label,
        icon: body.icon,
        actor: body.actor ?? req.principal?.id,
      })
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : String(e))
    }
    return this.kinds()
  }

  /**
   * tRPC mutation `planningKindDelete` / MCP `initiative-kind-delete` - remove a lane. Refused while
   * any initiative is in it: moving those rows is a decision, and a settings screen must not make it
   * silently.
   */
  @Post('kind/delete')
  @ApiOkResponse({ type: InitiativeKindsDto })
  @Trpc({ kind: 'mutation' })
  @Admin()
  @Mcp({ name: 'initiative-kind-delete' })
  async kindDelete(@Body() body: IdDto): Promise<InitiativeKindsDto> {
    try {
      await deleteInitiativeKind(body.id)
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : String(e))
    }
    return this.kinds()
  }

  /**
   * tRPC mutation `planningDoc` / MCP `doc-read` - read an initiative/task markdown doc from disk
   * (empty if none yet). Modeled as a mutation so its input body reflects the same way the other
   * mutations do (the queries here are all input-less); an input-carrying read is fine as an RPC
   * call. The MCP read pairs with `doc-save` so a remote session can patch a doc (e.g. keep the
   * `**Status:**` line in parity) without the repo on disk.
   */
  @Post('doc/read')
  @ApiOkResponse({ type: DocDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'doc-read' })
  async doc(@Body() body: DocRefDto): Promise<DocDto> {
    return readPlanningDoc(body.kind, body.id)
  }

  /**
   * tRPC mutation `planningDocSave` / MCP `doc-save` - write a doc to disk (autosave target).
   *
   * It also refreshes the row's `summary`, which since 2026-08-24 is a derived one-line preview of
   * this doc rather than a field of its own (see `savePlanningDoc`). That is why the write goes
   * through core rather than straight to the filesystem.
   */
  @Post('doc')
  @ApiOkResponse({ type: DocDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'doc-save' })
  async docSave(@Body() body: DocSaveDto, @Req() req: PrincipalRequest): Promise<DocDto> {
    return savePlanningDoc(body.kind, body.id, body.content, body.actor ?? req.principal?.id)
  }

  // --- sprints ---------------------------------------------------------------------------------

  /** tRPC query `sprints` - every sprint, newest window first. No tasks, no capacity grid: use `sprintGet`. */
  @Get('sprints')
  @ApiOkResponse({ type: SprintsDto })
  @Trpc()
  async sprints(): Promise<SprintsDto> {
    return { generatedAt: new Date().toISOString(), sprints: (await readSprints()) as Sprint[] as SprintDto[] }
  }

  /**
   * tRPC mutation `sprintGet` / MCP `sprint-get` - one sprint with its tasks, the initiatives
   * INFERRED from them, and the computed capacity grid. A mutation for the same reason
   * `initiatives-get` is one: it carries an input body.
   */
  @Post('sprint/get')
  @ApiOkResponse({ type: SprintDetailDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'sprint-get' })
  async sprintGet(@Body() body: GetSprintDto): Promise<SprintDetailDto> {
    const sprint = await readSprint(body.id)
    if (!sprint) throw new BadRequestException(`sprint ${body.id} not found`)
    return sprint as SprintDetail as SprintDetailDto
  }

  /**
   * tRPC mutation `sprintUpsert` / MCP `sprint-upsert` - create or partially update a sprint.
   *
   * The refusals are the interesting part and they come from core: a status past `pending` needs
   * both dates, and `planned` is refused while any day is provably over capacity (naming the worst
   * three). Both are surfaced as 400s rather than 500s - the message IS the thing the caller has to
   * act on.
   */
  @Post('sprint')
  @ApiOkResponse({ type: SprintDetailDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'sprint-upsert' })
  async sprintUpsert(@Body() body: UpsertSprintDto, @Req() req: PrincipalRequest): Promise<SprintDetailDto> {
    const { availability, ...rest } = body
    let parsed: Record<string, { hours?: number; hours_by_date?: Record<string, number> }> | undefined
    if (availability !== undefined) {
      try {
        parsed = JSON.parse(availability) as Record<string, { hours?: number; hours_by_date?: Record<string, number> }>
      } catch {
        throw new BadRequestException(`availability is not valid JSON: ${availability}`)
      }
    }
    try {
      return (await upsertSprint({
        ...rest,
        actor: body.actor ?? req.principal?.id,
        ...(parsed ? { availability: parsed } : {}),
      })) as SprintDetail as SprintDetailDto
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : String(e))
    }
  }

  /**
   * tRPC mutation `sprintCheckinTick` - tick one person's bucket on or off in today's stand-up.
   *
   * The KEY travels, not the array: two people ticking different buckets in the same second would
   * otherwise each write their own read of the set and one tick would vanish. Un-ticking anything on
   * a completed day REOPENS it - a check-in closed early is a mistake to correct.
   */
  @Post('sprint/checkin/tick')
  @ApiOkResponse({ type: SprintCheckinDto })
  @Trpc({ kind: 'mutation' })
  async sprintCheckinTick(@Body() body: CheckinTickDto, @Req() req: PrincipalRequest): Promise<SprintCheckinDto> {
    try {
      return (await tickCheckin({
        sprintId: body.id,
        date: body.date,
        user: body.user,
        bucket: body.bucket,
        done: body.done,
        actor: body.actor ?? req.principal?.id,
      })) as SprintCheckinDto
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : String(e))
    }
  }

  /** tRPC mutation `sprintCheckinComplete` - close the day's stand-up out. Idempotent. */
  @Post('sprint/checkin/complete')
  @ApiOkResponse({ type: SprintCheckinDto })
  @Trpc({ kind: 'mutation' })
  async sprintCheckinComplete(
    @Body() body: CheckinCompleteDto,
    @Req() req: PrincipalRequest,
  ): Promise<SprintCheckinDto> {
    return (await completeCheckin({
      sprintId: body.id,
      date: body.date,
      actor: body.actor ?? req.principal?.id,
    })) as SprintCheckinDto
  }

  /**
   * tRPC mutation `sprintTaskCreate` / MCP `sprint-task-create` - make a task straight onto one
   * person-day of a sprint, under NO initiative. It belongs to the sprint: it can be edited, re-dated
   * inside the window and deleted, but never taken out of the sprint (core refuses it, naming the
   * way out). To make it ordinary work, `task-move` it into an initiative.
   */
  @Post('sprint/task')
  @ApiOkResponse({ type: TaskDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'sprint-task-create' })
  async sprintTaskCreate(@Body() body: CreateSprintTaskDto, @Req() req: PrincipalRequest): Promise<TaskDto> {
    try {
      return (await createSprintTask({ ...body, actor: body.actor ?? req.principal?.id })) as Task as TaskDto
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : String(e))
    }
  }

  /**
   * tRPC mutation `sprintDelete` / MCP `sprint-delete` - remove a sprint. Its tasks are RELEASED,
   * never deleted: a sprint is a window over work, not the work itself. Its SPRINT tasks (made on
   * the grid, under no initiative) ARE deleted - there is no board to release them to.
   */
  @Post('sprint/delete')
  @ApiOkResponse({ type: SprintsDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'sprint-delete' })
  async sprintDelete(@Body() body: IdDto): Promise<SprintsDto> {
    await deleteSprint(body.id)
    return this.sprints()
  }
}

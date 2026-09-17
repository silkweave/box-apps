import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common'
import { AuthGuard } from '../../../auth/auth.guard.js'
import { Admin } from '../../../auth/auth.decorators.js'
import { ApiOkResponse, ApiProperty } from '@nestjs/swagger'
import { IsBoolean, IsOptional, IsString } from 'class-validator'
import { Mcp, Trpc } from '@silkweave/nestjs'
import { humanizeCron, readSchedulesFile, scheduleProblem, validateSchedule, writeSchedulesFile, type Schedule } from '@silkweave/box-core'
import { SchedulerService } from './scheduler.service.js'
import { agentSessionsWorking, shutdownWorkerdeck } from '../../../agent/workerdeck.host.js'

// DTOs document the REST/Swagger surface and drive the generated tRPC input/output types. As with
// the planning/content controllers, @Mcp() inputs stay scalar-only (see the note there).
class ScheduleDto {
  @ApiProperty() id!: string
  @ApiProperty() action_id!: string
  @ApiProperty({ description: 'Full 5-field cron expression (server-local timezone)' }) cron!: string
  @ApiProperty({ description: 'Human-friendly rendering of the cron expression' }) human!: string
  @ApiProperty() enabled!: boolean
  @ApiProperty({ required: false }) description?: string
  @ApiProperty({ description: 'False when the entry cannot be armed (bad cron / unknown action)' }) valid!: boolean
  @ApiProperty({ required: false, nullable: true, description: 'Why the entry is invalid' }) problem!: string | null
  @ApiProperty({ required: false, nullable: true, description: 'Next fire (ISO) per the RUNNING scheduler; null when not armed' })
  nextFire!: string | null
}
class SchedulesDto {
  @ApiProperty({ type: [ScheduleDto] }) schedules!: ScheduleDto[]
  @ApiProperty({ description: 'True when config/schedules.json changed after the scheduler loaded it' })
  restartRequired!: boolean
  @ApiProperty({ description: 'When the running scheduler loaded the config (ISO)' }) loadedAt!: string
  @ApiProperty({ description: 'True when AUTOMATION_ENABLED is not set - timers unarmed (the dev-safe default)' }) disabled!: boolean
}

class UpsertScheduleDto {
  @ApiProperty({ description: 'Schedule slug (stable id)' }) @IsString() id!: string
  @ApiProperty({ required: false, description: 'Automation action id (see automationActions)' })
  @IsOptional() @IsString() action_id?: string
  @ApiProperty({ required: false, description: 'Full 5-field cron expression, e.g. "0 7 * * *"' })
  @IsOptional() @IsString() cron?: string
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() enabled?: boolean
  @ApiProperty({ required: false }) @IsOptional() @IsString() description?: string
}
class IdDto {
  @ApiProperty() @IsString() id!: string
}

class ActiveRunDto {
  @ApiProperty() runId!: string
  @ApiProperty() actionId!: string
  @ApiProperty({ enum: ['queued', 'running'] }) state!: string
}
class StatusDto {
  @ApiProperty() restartRequired!: boolean
  @ApiProperty() loadedAt!: string
  @ApiProperty() disabled!: boolean
  @ApiProperty() scheduleCount!: number
  @ApiProperty({ type: [ActiveRunDto] }) running!: ActiveRunDto[]
}

class RestartDto {
  @ApiProperty({
    required: false,
    description: 'Restart even while agent sessions are mid-turn. Those turns are lost - a codex session cannot be rebuilt from a park.',
  })
  @IsOptional() @IsBoolean() force?: boolean
}

class RestartResultDto {
  @ApiProperty({ description: 'False = refused, nothing was restarted (see message).' }) ok!: boolean
  @ApiProperty() message!: string
  @ApiProperty({ type: [String], required: false, description: 'Agent session ids mid-turn, when the restart was refused.' })
  working?: string[]
}

/**
 * Automation surface - cron schedules over core's action registry, the scheduler status and the
 * self-restart. The registry, the run history and Run Now are core's (ops/ops.controller.ts).
 * Schedule CRUD edits config/schedules.json; the RUNNING scheduler keeps its boot-time snapshot,
 * so edits flip `restartRequired` until the server restarts (the TopBar surfaces this).
 */
@Controller('automation')
@UseGuards(AuthGuard)
export class AutomationController {
  constructor(private readonly scheduler: SchedulerService) {}

  /**
   * tRPC query `automationSchedules` / MCP `schedules-list` - the schedules as configured ON DISK,
   * each humanized + validated, with the running scheduler's nextFire joined in where ids match.
   */
  @Get('schedules')
  @ApiOkResponse({ type: SchedulesDto })
  @Trpc()
  @Mcp({ name: 'schedules-list' })
  schedules(): SchedulesDto {
    const status = this.scheduler.status()
    const armed = new Map(status.schedules.map((s) => [s.id, s]))
    const schedules = readSchedulesFile().schedules.map((s) => {
      const problem = scheduleProblem(s)
      return {
        ...s,
        human: humanizeCron(s.cron),
        valid: problem === null,
        problem,
        nextFire: armed.get(s.id)?.nextFire ?? null,
      }
    })
    return { schedules, restartRequired: status.restartRequired, loadedAt: status.loadedAt, disabled: status.disabled }
  }

  /** tRPC mutation `automationScheduleUpsert` / MCP `schedule-upsert` - partial merge into the JSON
   *  file. Configuration, so admin-only. */
  @Post('schedule')
  @ApiOkResponse({ type: SchedulesDto })
  @Trpc({ kind: 'mutation' })
  @Admin()
  @Mcp({ name: 'schedule-upsert' })
  scheduleUpsert(@Body() body: UpsertScheduleDto): SchedulesDto {
    const file = readSchedulesFile()
    const prev = file.schedules.find((s) => s.id === body.id)
    const merged: Schedule = {
      id: body.id,
      action_id: body.action_id ?? prev?.action_id ?? '',
      cron: body.cron ?? prev?.cron ?? '',
      enabled: body.enabled ?? prev?.enabled ?? true,
      ...((body.description ?? prev?.description) !== undefined
        ? { description: body.description ?? prev?.description }
        : {}),
    }
    validateSchedule(merged) // throws with a human-readable reason (bad cron, unknown action, bad id)
    const schedules = prev
      ? file.schedules.map((s) => (s.id === body.id ? merged : s))
      : [...file.schedules, merged]
    writeSchedulesFile({ schedules })
    return this.schedules()
  }

  /** tRPC mutation `automationScheduleDelete` / MCP `schedule-delete` - remove an entry from the
   *  file. Configuration, so admin-only. */
  @Post('schedule/delete')
  @ApiOkResponse({ type: SchedulesDto })
  @Trpc({ kind: 'mutation' })
  @Admin()
  @Mcp({ name: 'schedule-delete' })
  scheduleDelete(@Body() body: IdDto): SchedulesDto {
    const file = readSchedulesFile()
    if (!file.schedules.some((s) => s.id === body.id)) throw new Error(`no schedule "${body.id}"`)
    writeSchedulesFile({ schedules: file.schedules.filter((s) => s.id !== body.id) })
    return this.schedules()
  }

  /** tRPC query `automationStatus` - the cheap poll target for the TopBar restart indicator. */
  @Get('status')
  @ApiOkResponse({ type: StatusDto })
  @Trpc()
  status(): StatusDto {
    const s = this.scheduler.status()
    return {
      restartRequired: s.restartRequired,
      loadedAt: s.loadedAt,
      disabled: s.disabled,
      scheduleCount: s.schedules.length,
      running: s.running.map((r) => ({ runId: r.runId, actionId: r.actionId, state: r.state })),
    }
  }

  /**
   * tRPC mutation `automationRestart` / MCP `service-restart` - restart the running service.
   * Admin-only. The configured agent can reach this when its host-owned role is admin.
   *
   * The implementation is: flush this response, then exit non-zero. **It restarts nothing by
   * itself** - it relies on the Box being run under a supervisor that respawns on a non-clean exit
   * (a launchd KeepAlive agent, a systemd unit with `Restart=on-failure`, a container policy).
   * THIS TEMPLATE SHIPS NO SUPERVISOR, so on a `pnpm dev` Box this tool stops the server and
   * nothing brings it back. Run `pnpm build` before restarting a production Box, or it comes back
   * on the old dist. In-flight requests on other connections are dropped - the DuckDB WAL makes
   * that safe - and stateless MCP/tRPC clients reconnect on their next call.
   */
  @Post('restart')
  @ApiOkResponse({ type: RestartResultDto })
  @Trpc({ kind: 'mutation' })
  @Admin()
  @Mcp({ name: 'service-restart' })
  restart(@Body() body: RestartDto): RestartResultDto {
    const RESTART_EXIT_CODE = 86
    const FLUSH_DELAY_MS = 750
    // Since workerdeck moved into this process (2026-09-02) a restart is no longer free: it ends
    // every sidebar session and every @nova turn. Refuse while one is actually mid-turn unless the
    // caller says otherwise - a deploy can nearly always wait thirty seconds, and the alternative
    // is a lost codex session, which cannot be rebuilt from a park.
    const working = agentSessionsWorking()
    if (working.length > 0 && body.force !== true) {
      return {
        ok: false,
        working,
        message: `Refused: ${working.length} agent session(s) are mid-turn. Wait for them, or pass force:true to restart anyway (those turns are lost).`,
      }
    }
    setTimeout(() => {
      // Drain first for the same reason main.ts does on SIGTERM: let turns that are still finishing
      // land before the process goes. `drain` refuses new sessions while it runs and gives up on
      // its own deadline, so this cannot hang the restart indefinitely.
      void shutdownWorkerdeck()
        .catch((err: unknown) => console.error('  agent: drain failed -', err))
        .finally(() => process.exit(RESTART_EXIT_CODE))
    }, FLUSH_DELAY_MS).unref()
    return {
      ok: true,
      message: `Restarting: agent sessions drain, then the service exits and launchd respawns it (typically back in ~2-5s, longer if a turn is finishing). Run \`pnpm build\` beforehand if code changed.`,
    }
  }
}

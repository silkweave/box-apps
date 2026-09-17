import { BadRequestException, Body, Controller, Get, Post, UseGuards } from '@nestjs/common'
import { AuthGuard } from '../../../auth/auth.guard.js'
import { ApiOkResponse, ApiProperty } from '@nestjs/swagger'
import { Mcp, Trpc } from '@silkweave/nestjs'
import { IsArray, IsBoolean, IsIn, IsNumber, IsOptional, IsString } from 'class-validator'
import { deleteAlertRule, listAlerts, loadAlertRules, upsertAlertRule, type AlertRecord, type AlertRule } from '@silkweave/box-core'

// DTOs document the REST/Swagger surface and drive the generated tRPC output types. The feed is
// read-only (mirroring Automation → Runs); rules live in config/alerts.json and the save/delete
// mutations below edit THAT file in place - the JSON stays the source of truth, no rules table.

class AlertDto {
  @ApiProperty() id!: string
  @ApiProperty() rule_id!: string
  @ApiProperty() event_kind!: string
  @ApiProperty() dedup_key!: string
  @ApiProperty() route!: string
  @ApiProperty({ required: false, nullable: true, description: 'Resolved Lark target once delivered' })
  target!: string | null
  @ApiProperty({ required: false, nullable: true }) title!: string | null
  @ApiProperty({ description: 'Rendered message (rule template filled from the event fields)' }) message!: string
  @ApiProperty({ enum: ['pending', 'delivered', 'suppressed', 'error'] }) status!: string
  @ApiProperty({ required: false, nullable: true, description: 'When the event actually happened (ISO)' })
  event_at!: string | null
  @ApiProperty() created_at!: string
  @ApiProperty({ required: false, nullable: true }) delivered_at!: string | null
  @ApiProperty({ required: false, nullable: true, description: 'Delivery failure detail when status=error' })
  error!: string | null
  @ApiProperty({ required: false, nullable: true, description: 'Shared across rows sent as one batched Lark card' })
  batch_id!: string | null
}
class AlertsDto {
  @ApiProperty() generatedAt!: string
  @ApiProperty({ type: [AlertDto] }) alerts!: AlertDto[]
}

class AlertRuleDto {
  @ApiProperty() id!: string
  @ApiProperty({ description: 'The AlertEvent.kind this rule listens for' }) event!: string
  @ApiProperty({ description: 'Delivery route - owner | user:<id> | channel' }) route!: string
  @ApiProperty({ description: 'Message template; {field} tokens fill from the event fields' }) message!: string
  @ApiProperty({ required: false, description: 'Per-rule suppression window (minutes); 0/absent = none' })
  cooldown_min?: number
  @ApiProperty() enabled!: boolean
  @ApiProperty({ required: false, description: 'signal.* rules: the warehouse signal watched' })
  signal_id?: string
  @ApiProperty({ required: false, description: 'signal.threshold rules: the value to reach/cross' })
  threshold?: number
  @ApiProperty({ required: false, enum: ['realtime', 'digest'], description: 'realtime = batched DM; digest = events-only, daily recap' })
  notify?: string
  @ApiProperty({ required: false, description: 'Delivery debounce (seconds) before the batched flush; default 300' })
  debounce_sec?: number
  @ApiProperty({ required: false, type: [Number], description: 'traction.spike rules: the engagement tier ladder' })
  tiers?: number[]
}
class AlertRulesDto {
  @ApiProperty({ type: [AlertRuleDto] }) rules!: AlertRuleDto[]
}

/** Input for the rule upsert - the full rule, matched by id (create when the id is new). */
class SaveAlertRuleDto {
  @ApiProperty() @IsString() id!: string
  @ApiProperty() @IsString() event!: string
  @ApiProperty() @IsString() route!: string
  @ApiProperty() @IsString() message!: string
  @ApiProperty() @IsBoolean() enabled!: boolean
  @ApiProperty({ required: false }) @IsOptional() @IsNumber() cooldown_min?: number
  @ApiProperty({ required: false }) @IsOptional() @IsString() signal_id?: string
  @ApiProperty({ required: false }) @IsOptional() @IsNumber() threshold?: number
  @ApiProperty({ required: false, enum: ['realtime', 'digest'] })
  @IsOptional()
  @IsIn(['realtime', 'digest'])
  notify?: 'realtime' | 'digest'
  @ApiProperty({ required: false }) @IsOptional() @IsNumber() debounce_sec?: number
  @ApiProperty({ required: false, type: [Number] }) @IsOptional() @IsArray() tiers?: number[]
}

class DeleteAlertRuleDto {
  @ApiProperty() @IsString() id!: string
}

/**
 * Alerts surface (see features/alerts/SPEC.md). `alertsList` is the recorded feed - read-only,
 * every candidate an evaluator matched, deduped, with its delivery outcome; feed writes happen inside
 * the `alerts-*` funnel actions (evaluate → record → deliver), never through this controller.
 * `alertsRules` + the save/delete mutations surface AND edit the config/alerts.json rule set - the
 * file stays the single source of truth (the Schedules philosophy), read fresh per evaluation, so
 * edits apply on the next event without a restart.
 */
@Controller('alerts')
@UseGuards(AuthGuard)
export class AlertsController {
  /** tRPC query `alertsList` / MCP `alerts-list` - recent alerts, newest first (the Alerts feed). */
  @Get()
  @ApiOkResponse({ type: AlertsDto })
  @Trpc({ kind: 'query' })
  @Mcp({ name: 'alerts-list' })
  async list(): Promise<AlertsDto> {
    const alerts = (await listAlerts(200)) as AlertRecord[] as unknown as AlertDto[]
    return { generatedAt: new Date().toISOString(), alerts }
  }

  /** tRPC query `alertsRules` / MCP `alerts-rules` - the configured rule set (config/alerts.json). */
  @Get('rules')
  @ApiOkResponse({ type: AlertRulesDto })
  @Trpc({ kind: 'query' })
  @Mcp({ name: 'alerts-rules' })
  async rules(): Promise<AlertRulesDto> {
    return { rules: loadAlertRules() as AlertRuleDto[] }
  }

  /**
   * tRPC mutation `alertsRulesSave` / MCP `alert-rule-save` - create or replace one rule in
   * config/alerts.json (matched by id). The file stays the source of truth and is read fresh per
   * evaluation, so the edit applies on the next event - no restart.
   */
  @Post('rules')
  @ApiOkResponse({ type: AlertRulesDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'alert-rule-save' })
  rulesSave(@Body() body: SaveAlertRuleDto): AlertRulesDto {
    // Drop absent optionals so the checked-in JSON stays minimal (JSON.stringify skips undefined,
    // but an explicit prune keeps the AlertRule we validate identical to what lands on disk).
    const rule = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)) as AlertRule
    try {
      return { rules: upsertAlertRule(rule) as AlertRuleDto[] }
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : String(e))
    }
  }

  /** tRPC mutation `alertsRulesDelete` / MCP `alert-rule-delete` - remove one rule by id. */
  @Post('rules/delete')
  @ApiOkResponse({ type: AlertRulesDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'alert-rule-delete' })
  rulesDelete(@Body() body: DeleteAlertRuleDto): AlertRulesDto {
    try {
      return { rules: deleteAlertRule(body.id) as AlertRuleDto[] }
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : String(e))
    }
  }
}

import { BadRequestException, Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common'
import { ApiOkResponse, ApiProperty } from '@nestjs/swagger'
import { IsIn, IsOptional, IsString } from 'class-validator'
import { Mcp, Trpc } from '@silkweave/nestjs'
import { DATA_SOURCE_STATUSES, deleteDataSource, listProviders, readDataSourceViews, upsertDataSource, type DataSourceStatus, type DataSourceView } from '@silkweave/box-core'
import { AuthGuard } from '../../../auth/auth.guard.js'
import { type PrincipalRequest, Admin } from '../../../auth/auth.decorators.js'

// Data sources - the user-named instances of a provider that feed connected signals. Reading is
// open to any authenticated internal user (understanding where a number comes from is not
// privileged); WRITING is admin-only, because a source is configuration wired to credentials, the
// same posture as signal-upsert and signal-owner-set.
//
// No endpoint here reads, writes or reports a secret. Credentials live only in the gitignored
// config/credentials.json under `provider → source id → KEY`, hand-edited per docs/SETUP.md; the
// list surface reports per-key PRESENCE booleans and nothing more.

class ProviderMeasureDto {
  @ApiProperty({ description: "The provider's native token, verbatim ('FIRST_MESSAGE')" }) key!: string
  @ApiProperty() label!: string
  @ApiProperty({ required: false, nullable: true }) unit!: string | null
  @ApiProperty({ description: 'Default bucket width for a signal bound to this measure' }) interval!: string
  @ApiProperty({ description: "Default 'snapshot' | 'increment'" }) accumulation!: string
  @ApiProperty() direction!: string
  @ApiProperty({ description: 'Default signal_group' }) group!: string
  @ApiProperty() description!: string
}
class ProviderConfigFieldDto {
  @ApiProperty() key!: string
  @ApiProperty() label!: string
  @ApiProperty() required!: boolean
  @ApiProperty({ required: false }) help?: string
}
class ProviderDto {
  @ApiProperty() id!: string
  @ApiProperty() label!: string
  @ApiProperty() description!: string
  @ApiProperty({ type: [ProviderConfigFieldDto] }) config!: ProviderConfigFieldDto[]
  @ApiProperty({ type: [String], description: 'Credential key NAMES this provider needs (never values)' })
  credentials!: string[]
  @ApiProperty({ type: [ProviderMeasureDto] }) measures!: ProviderMeasureDto[]
}
class ProvidersDto {
  @ApiProperty() generatedAt!: string
  @ApiProperty({ type: [ProviderDto] }) providers!: ProviderDto[]
}

class DeadMeasureDto {
  @ApiProperty() signal_id!: string
  @ApiProperty() measure_key!: string
}
class DataSourceDto {
  @ApiProperty() id!: string
  @ApiProperty() provider!: string
  @ApiProperty({ required: false, nullable: true, description: "The provider's label; null = provider not registered in this build" })
  provider_label!: string | null
  @ApiProperty() label!: string
  @ApiProperty({ type: Object, description: 'Provider-declared non-secret settings' }) config!: Record<string, string>
  @ApiProperty({ enum: DATA_SOURCE_STATUSES, description: 'Only enabled sources ride the sources-sync cron' })
  status!: string
  @ApiProperty() notes!: string
  @ApiProperty({ type: Object, description: 'Credential key → configured? (presence only, never values)' })
  credentials!: Record<string, boolean>
  @ApiProperty({ type: [String], description: 'Signal ids bound to this source - its subscription set' })
  bound_signals!: string[]
  @ApiProperty({ type: [DeadMeasureDto], description: 'Bindings naming a measure this provider no longer offers' })
  dead_measures!: DeadMeasureDto[]
  @ApiProperty({ required: false, nullable: true }) last_sync_at!: string | null
  @ApiProperty({ required: false, nullable: true }) last_sync_status!: string | null
  @ApiProperty({ required: false, nullable: true }) last_sync_error!: string | null
  @ApiProperty({ required: false, nullable: true }) last_sync_points!: number | null
  @ApiProperty() created_at!: string
  @ApiProperty() updated_at!: string
  @ApiProperty({ required: false, nullable: true }) created_by!: string | null
  @ApiProperty({ required: false, nullable: true }) updated_by!: string | null
}
class DataSourcesDto {
  @ApiProperty() generatedAt!: string
  @ApiProperty({ type: [DataSourceDto] }) sources!: DataSourceDto[]
}

// Same @Mcp() scalar-inputs constraint as every other controller: `config` travels as a JSON
// object STRING (the task-upsert `metadata` precedent), and '' clears it.
class UpsertDataSourceDto {
  @ApiProperty({ description: 'Slug id (lowercase a-z 0-9 dashes). Also the credentials account key and the audit-snapshot channel - pick it once' })
  @IsString() id!: string
  @ApiProperty({ required: false, description: 'Provider id (providers-list). Required on create; cannot be changed afterwards' })
  @IsOptional() @IsString() provider?: string
  @ApiProperty({ required: false, description: 'Human name, e.g. "Acme Team"' })
  @IsOptional() @IsString() label?: string
  @ApiProperty({ required: false, description: `JSON object string of the provider's declared config fields, e.g. {"space":"yoexoexl"} ('' clears). Undeclared keys are refused` })
  @IsOptional() @IsString() config?: string
  @ApiProperty({ required: false, enum: DATA_SOURCE_STATUSES, description: 'New sources are born disabled - run source-sync supervised, then enable' })
  @IsOptional() @IsIn(DATA_SOURCE_STATUSES) status?: DataSourceStatus
  @ApiProperty({ required: false }) @IsOptional() @IsString() notes?: string
  @ApiProperty({ required: false, description: 'users.id performing this mutation (audit stamp; defaults to the authenticated principal)' })
  @IsOptional() @IsString() actor?: string
}

class DeleteDataSourceDto {
  @ApiProperty({ description: 'Data source id to delete (bindings are reported, never cleared)' })
  @IsString() id!: string
  @ApiProperty({ required: false, description: 'users.id performing this mutation (audit stamp; defaults to the authenticated principal)' })
  @IsOptional() @IsString() actor?: string
}

class DataSourceDeleteReportDto {
  @ApiProperty() id!: string
  @ApiProperty({ type: [String], description: 'Signals still bound to the deleted source (left in place, dangling but visible)' })
  bound_signals!: string[]
  @ApiProperty({ type: [String] }) warnings!: string[]
}

@Controller('sources')
@UseGuards(AuthGuard)
export class SourcesController {
  /**
   * tRPC query `providersList` / MCP `providers-list` - every registered provider with its config
   * fields, credential key names and full measure catalogue. Static data (providers ship as code),
   * so it is cheap and cacheable; the signal dialog reads it to offer "data source, then measure".
   */
  @Get('providers')
  @ApiOkResponse({ type: ProvidersDto })
  @Trpc()
  @Mcp({ name: 'providers-list' })
  providers(): ProvidersDto {
    return { generatedAt: new Date().toISOString(), providers: listProviders() as ProviderDto[] }
  }

  /**
   * tRPC query `dataSourcesList` / MCP `data-sources` - every source with its health stamps,
   * credential PRESENCE booleans and bound signals. Any authenticated user: knowing where a
   * number comes from is not privileged, and there is no secret in this payload to leak.
   */
  @Get()
  @ApiOkResponse({ type: DataSourcesDto })
  @Trpc()
  @Mcp({ name: 'data-sources' })
  async list(): Promise<DataSourcesDto> {
    const sources = (await readDataSourceViews()) as DataSourceView[] as DataSourceDto[]
    return { generatedAt: new Date().toISOString(), sources }
  }

  /**
   * tRPC mutation `dataSourcesUpsert` / MCP `data-source-upsert` - create or partially update a
   * source. Admin-only (configuration wired to credentials). A new source is born `disabled`: add
   * its credential to config/credentials.json, run `source-sync` supervised, then enable it.
   */
  @Post()
  @ApiOkResponse({ type: DataSourcesDto })
  @Trpc({ kind: 'mutation' })
  @Admin()
  @Mcp({ name: 'data-source-upsert' })
  async upsert(@Body() body: UpsertDataSourceDto, @Req() req: PrincipalRequest): Promise<DataSourcesDto> {
    const { config, ...rest } = body
    let parsedConfig: Record<string, string> | undefined
    if (config !== undefined) {
      if (config === '') parsedConfig = {}
      else {
        let raw: unknown
        try {
          raw = JSON.parse(config)
        } catch {
          throw new BadRequestException(`config must be a JSON object string, e.g. {"space":"yoexoexl"}`)
        }
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
          throw new BadRequestException('config must be a JSON OBJECT string of field → value')
        }
        parsedConfig = raw as Record<string, string>
      }
    }
    try {
      await upsertDataSource({
        ...rest,
        actor: body.actor ?? req.principal?.id,
        ...(parsedConfig !== undefined ? { config: parsedConfig } : {}),
      })
    } catch (e) {
      // The domain refuses unknown providers, undeclared/missing config fields and colliding ids
      // with a message that says which - a 500 would strip the part the caller needs to act on.
      throw new BadRequestException(e instanceof Error ? e.message : String(e))
    }
    return this.list()
  }

  /**
   * tRPC mutation `dataSourcesDelete` / MCP `data-source-delete` - remove a source. Bound signals
   * are REPORTED, never unbound: they keep their points, stop refreshing, and render as a dangling
   * binding, which is exactly the row a human should re-point. Credentials are hand-managed and
   * are not touched.
   */
  @Post('delete')
  @ApiOkResponse({ type: DataSourceDeleteReportDto })
  @Trpc({ kind: 'mutation' })
  @Admin()
  @Mcp({ name: 'data-source-delete' })
  async delete(@Body() body: DeleteDataSourceDto): Promise<DataSourceDeleteReportDto> {
    try {
      return await deleteDataSource(body.id)
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : String(e))
    }
  }
}

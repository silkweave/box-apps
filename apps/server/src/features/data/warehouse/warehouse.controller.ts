import { Controller, UseGuards } from '@nestjs/common'
import { AuthGuard } from '../../../auth/auth.guard.js'
import { ApiOkResponse, ApiOperation, ApiProperty } from '@nestjs/swagger'
import { Mcp, Trpc } from '@silkweave/nestjs'
import { drain, executeRecorded } from '@silkweave/box-core'

class OpResultDto {
  @ApiProperty({ description: 'One-line outcome of the maintenance op' }) summary!: string
}

/**
 * This feature's warehouse maintenance action. It is defined in the unified automation-action
 * registry (also schedulable there) and runs through the execute+record funnel, so every
 * invocation lands in the automation_runs history.
 *
 * `warehouse-backup` used to live here too. It moved to core (core ops/warehouse.controller.ts)
 * on 2026-09-17: a Box with zero features installed still has a warehouse to protect, so its safety
 * net cannot be something you get only by installing `data`.
 */
@Controller('warehouse')
@UseGuards(AuthGuard)
export class WarehouseController {
  /** tRPC mutation `warehouseDerive` / MCP tool `WarehouseDerive` - re-derive all signals. */
  @ApiOperation({ summary: 'Re-derive every channel’s signals from the raw snapshots' })
  @ApiOkResponse({ type: OpResultDto })
  @Trpc({ kind: 'mutation' })
  @Mcp()
  async derive(): Promise<OpResultDto> {
    const result = await drain(executeRecorded('warehouse-derive', { trigger: 'manual' }))
    return { summary: result.summary }
  }
}

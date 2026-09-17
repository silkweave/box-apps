import { BadRequestException, Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common'
import { ApiOkResponse, ApiProperty } from '@nestjs/swagger'
import { IsInt, IsOptional, IsString } from 'class-validator'
import { Mcp, Trpc } from '@silkweave/nestjs'
import { deleteSignalBoard, readSignalBoards, setSignalBoardNodes, upsertSignalBoard, type SignalBoard } from '@silkweave/box-core'
import { AuthGuard } from '../../../auth/auth.guard.js'
import type { PrincipalRequest } from '../../../auth/auth.decorators.js'

// Circuit boards - the user-created composites of signals (which signals are on a board, and where
// each one sits). Edges are NOT here: they live on `signals.depends_on`, and a board renders an edge
// exactly when both endpoints are members.
//
// GUARD LEVEL: any authenticated internal user, deliberately NOT admin (bare AuthGuard, the
// planning-mutation precedent). The repo's admin line is "configuration wired to credentials or
// data ownership" - a board composes ALREADY-curated claims, and the dangerous mutation (creating
// or editing an edge) stays admin-gated on signal-upsert. Admin-gating board writes would also kill
// the primary interaction: a non-admin's drag could never persist, which is exactly the "positions
// are not saved" complaint this surface exists to close. Collaborators see none of it - a bare
// controller is internal-only.
//
// Concurrency is last-write-wins per board: `nodes` is written WHOLE, no version precondition, no
// 409. Two people dragging one board lose one arrangement, attributed by `updated_by` (the repo's
// standing posture, matching DocSave).

class BoardNodeDto {
  @ApiProperty({ description: 'A signals registry id - unknown ids are refused' }) signal_id!: string
  @ApiProperty({ description: 'Flow units, stored verbatim; snapping is the client\'s job' }) x!: number
  @ApiProperty() y!: number
}
class BoardDto {
  @ApiProperty() id!: string
  @ApiProperty() label!: string
  @ApiProperty() description!: string
  @ApiProperty({ type: [BoardNodeDto], description: 'Membership + positions; one entry per signal' })
  nodes!: BoardNodeDto[]
  @ApiProperty() sort!: number
  @ApiProperty() created_at!: string
  @ApiProperty() updated_at!: string
  @ApiProperty({ required: false, nullable: true }) created_by!: string | null
  @ApiProperty({ required: false, nullable: true }) updated_by!: string | null
}
class BoardsDto {
  @ApiProperty() generatedAt!: string
  @ApiProperty({ type: [BoardDto] }) boards!: BoardDto[]
}

class UpsertBoardDto {
  @ApiProperty({ description: 'Slug id (lowercase a-z 0-9 dashes)' }) @IsString() id!: string
  @ApiProperty({ required: false, description: 'Human name, e.g. "Outreach funnel"' })
  @IsOptional() @IsString() label?: string
  @ApiProperty({ required: false, description: "What this board is for ('' clears it)" })
  @IsOptional() @IsString() description?: string
  @ApiProperty({ required: false, description: 'Sidebar ordering' }) @IsOptional() @IsInt() sort?: number
  @ApiProperty({ required: false, description: 'users.id performing this mutation (audit stamp; defaults to the authenticated principal)' })
  @IsOptional() @IsString() actor?: string
}

class DeleteBoardDto {
  @ApiProperty({ description: 'Board id to delete (there is no undo - the arrangement is gone)' })
  @IsString() id!: string
  @ApiProperty({ required: false, description: 'users.id performing this mutation (audit stamp; defaults to the authenticated principal)' })
  @IsOptional() @IsString() actor?: string
}

// The @Mcp() scalar-inputs constraint again: `nodes` travels as a JSON array STRING, the
// signal-points-set precedent.
class SetBoardNodesDto {
  @ApiProperty({ description: 'Board id' }) @IsString() id!: string
  @ApiProperty({
    description: 'JSON array string of {signal_id, x, y}, e.g. [{"signal_id":"mrr","x":0,"y":96}]. Replaces the WHOLE list',
  })
  @IsString() nodes!: string
  @ApiProperty({ required: false, description: 'users.id performing this mutation (audit stamp; defaults to the authenticated principal)' })
  @IsOptional() @IsString() actor?: string
}

class BoardDeleteReportDto {
  @ApiProperty() id!: string
  @ApiProperty({ description: 'How many placements the deleted board held (signals themselves are untouched)' })
  nodes!: number
}

@Controller('boards')
@UseGuards(AuthGuard)
export class BoardsController {
  /**
   * tRPC query `boardsList` / MCP `boards-list` - every board with its full node list. Boards are
   * few and small, so there is no per-board read: the SPA caches this in its own store (separate
   * from the heavy `signalsData` payload) and a drag-save echo costs a few hundred bytes.
   */
  @Get()
  @ApiOkResponse({ type: BoardsDto })
  @Trpc()
  @Mcp({ name: 'boards-list' })
  async list(): Promise<BoardsDto> {
    const boards = (await readSignalBoards()) as SignalBoard[] as BoardDto[]
    return { generatedAt: new Date().toISOString(), boards }
  }

  /**
   * tRPC mutation `boardsUpsert` / MCP `board-upsert` - create or partially update a board's
   * METADATA. It deliberately does not accept `nodes`: a label edit can then never race the
   * position autosave onto the same column.
   */
  @Post()
  @ApiOkResponse({ type: BoardsDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'board-upsert' })
  async upsert(@Body() body: UpsertBoardDto, @Req() req: PrincipalRequest): Promise<BoardsDto> {
    try {
      await upsertSignalBoard({ ...body, actor: body.actor ?? req.principal?.id })
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : String(e))
    }
    return this.list()
  }

  /**
   * tRPC mutation `boardsDelete` / MCP `board-delete` - remove a board. Nothing cascades: a board
   * owns placements, never signals, edges or points. There is no soft delete and no undo.
   */
  @Post('delete')
  @ApiOkResponse({ type: BoardDeleteReportDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'board-delete' })
  async delete(@Body() body: DeleteBoardDto): Promise<BoardDeleteReportDto> {
    try {
      return await deleteSignalBoard(body.id)
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : String(e))
    }
  }

  /**
   * tRPC mutation `boardsNodesSet` / MCP `board-nodes-set` - replace a board's whole membership +
   * position list. The SPA's ~2s debounced autosave calls this; it is idempotent, and the domain
   * refuses a bad shape, a non-finite coordinate, an unknown signal id or a duplicated signal with
   * the reason.
   */
  @Post('nodes')
  @ApiOkResponse({ type: BoardsDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'board-nodes-set' })
  async nodesSet(@Body() body: SetBoardNodesDto, @Req() req: PrincipalRequest): Promise<BoardsDto> {
    let parsed: unknown
    try {
      parsed = JSON.parse(body.nodes)
    } catch {
      throw new BadRequestException(`nodes must be a JSON array string, e.g. [{"signal_id":"mrr","x":0,"y":96}]`)
    }
    try {
      await setSignalBoardNodes(body.id, parsed, body.actor ?? req.principal?.id)
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : String(e))
    }
    return this.list()
  }
}

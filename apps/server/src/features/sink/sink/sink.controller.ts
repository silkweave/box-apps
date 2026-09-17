import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common'
import { AuthGuard } from '../../../auth/auth.guard.js'
import { ApiOkResponse, ApiProperty } from '@nestjs/swagger'
import { IsOptional, IsString } from 'class-validator'
import { Mcp, Trpc } from '@silkweave/nestjs'
import { createSinkDoc, deleteSinkDoc, listSinkDocs, readSinkDoc, writeSinkDoc } from '@silkweave/box-core'

// DTOs document the REST/Swagger surface and drive the generated tRPC input/output types, exactly
// like the inbox/planning controllers.
class SinkDocMetaDto {
  @ApiProperty() name!: string
  @ApiProperty() path!: string
  @ApiProperty() bytes!: number
  @ApiProperty() modified!: string
  @ApiProperty({ description: 'Short flattened body preview for the card grid' }) excerpt!: string
}
class SinkDocsDto {
  @ApiProperty() generatedAt!: string
  @ApiProperty({ type: [SinkDocMetaDto] }) docs!: SinkDocMetaDto[]
}
class SinkDocDto {
  @ApiProperty() name!: string
  @ApiProperty() path!: string
  @ApiProperty() content!: string
  @ApiProperty() exists!: boolean
  @ApiProperty({ description: 'vscode://file/<abs> deep link' }) editorUri!: string
}
class NameDto {
  @ApiProperty({ description: 'Sink filename, e.g. post-idea-claude-max-plan.md' }) @IsString() name!: string
}
class SinkSaveDto {
  @ApiProperty() @IsString() name!: string
  @ApiProperty({ description: 'Full markdown body to write to disk' }) @IsString() content!: string
}
class SinkCreateDto {
  @ApiProperty({ description: 'New sink filename, e.g. my-idea.md' }) @IsString() name!: string
  @ApiProperty({ required: false, description: 'Initial markdown body (defaults to empty)' })
  @IsOptional() @IsString() content?: string
}

/**
 * Sink surface - the docs/sink/ inbox of raw docs awaiting processing. Mirrors the inbox/planning
 * controllers: a `sinkDocs` tRPC query plus mutations that are also MCP tools, so the same actions
 * run from the dashboard, from agents, and from the `cli` proxy. The dashboard lists the queue,
 * edits a file inline (autosave), and copies a `/ingest-sink <name>` command to process it.
 */
@Controller('sink')
@UseGuards(AuthGuard)
export class SinkController {
  /** tRPC query `sinkDocs` - the processable queue (top-level *.md, newest first). */
  @Get('docs')
  @ApiOkResponse({ type: SinkDocsDto })
  @Trpc()
  async docs(): Promise<SinkDocsDto> {
    return { generatedAt: new Date().toISOString(), docs: listSinkDocs() }
  }

  /**
   * tRPC mutation `sinkDoc` / MCP `sink-read` - read one sink doc (empty if none yet). A mutation
   * (not a query) so its input body reflects like the planning doc read - the queries here are
   * input-less.
   */
  @Post('doc/read')
  @ApiOkResponse({ type: SinkDocDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'sink-read' })
  async doc(@Body() body: NameDto): Promise<SinkDocDto> {
    return readSinkDoc(body.name)
  }

  /** tRPC mutation `sinkDocSave` / MCP `sink-save` - write a sink doc to disk (autosave target). */
  @Post('doc')
  @ApiOkResponse({ type: SinkDocDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'sink-save' })
  async docSave(@Body() body: SinkSaveDto): Promise<SinkDocDto> {
    return writeSinkDoc(body.name, body.content)
  }

  /**
   * tRPC mutation `sinkDocCreate` / MCP `sink-create` - add a new sink doc to the queue. Refuses to
   * clobber an existing filename (use `sink-save` to overwrite).
   */
  @Post('doc/create')
  @ApiOkResponse({ type: SinkDocDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'sink-create' })
  async docCreate(@Body() body: SinkCreateDto): Promise<SinkDocDto> {
    return createSinkDoc(body.name, body.content ?? '')
  }

  /** tRPC mutation `sinkDocDelete` / MCP `sink-delete` - remove a sink doc, returning the fresh queue. */
  @Post('doc/delete')
  @ApiOkResponse({ type: SinkDocsDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'sink-delete' })
  async docDelete(@Body() body: NameDto): Promise<SinkDocsDto> {
    deleteSinkDoc(body.name)
    return { generatedAt: new Date().toISOString(), docs: listSinkDocs() }
  }
}

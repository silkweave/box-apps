import { Controller, Get, UseGuards } from '@nestjs/common'
import { AuthGuard } from '../../../auth/auth.guard.js'
import { ApiOkResponse, ApiProperty } from '@nestjs/swagger'
import { Mcp, Trpc } from '@silkweave/nestjs'
import { listAutomationActions, startDetachedRun, type IngestProgress } from '@silkweave/box-core'

class PullResultDto {
  @ApiProperty() channel!: string
  @ApiProperty() date!: string
  @ApiProperty({ description: 'One-line outcome (counts persisted to the warehouse)' }) summary!: string
}

/** One streamed progress chunk. The final (`done`) chunk carries `result`. */
class IngestProgressDto {
  @ApiProperty() channel!: string
  @ApiProperty({ enum: ['start', 'fetch', 'persist', 'done'] }) phase!: IngestProgress['phase']
  @ApiProperty() message!: string
  @ApiProperty({ required: false, type: PullResultDto, nullable: true }) result?: PullResultDto
}

/** A runnable ingest action - drives the dashboard's button grid (id maps to the subscription). */
class IngestActionDto {
  @ApiProperty() id!: string
  @ApiProperty() label!: string
  @ApiProperty() group!: string
  @ApiProperty() description!: string
}
class IngestCatalogDto {
  @ApiProperty({ type: [IngestActionDto] }) actions!: IngestActionDto[]
}

// The pull catalog is core's action registry filtered to the pull groups - one definition shared
// with the scheduler and the Automation dashboard, read at request time (the registry is built
// from the feature manifests after every module has loaded).
const INGEST_GROUPS = new Set(['Pulls', 'Backfills'])
const catalog = (): IngestActionDto[] =>
  listAutomationActions()
    .filter((a) => INGEST_GROUPS.has(a.group) && !a.parameterized)
    .map(({ id, label, group, description }) => ({ id, label, group, description }))

/**
 * Ingest actions - each pull/backfill defined once in @silkweave/box-core, surfaced here three ways: a tRPC
 * subscription (dashboard live progress), an MCP tool with progress notifications (agents + the CLI
 * proxy), and - via the CLI proxy - the terminal. They run **in-process** and UPSERT straight into
 * the DuckDB warehouse (the ground truth); there are no JSON files and no rebuild step. Every run
 * goes through the execute+record funnel, so it lands in the automation_runs history (unattributed
 * - the dashboard's Run Now carries the active user via `automationRunNow` instead).
 */
@Controller('ingest')
@UseGuards(AuthGuard)
export class IngestController {
  /** tRPC query `ingestCatalog` - the runnable in-process actions (grouped for the dashboard). */
  @Get()
  @ApiOkResponse({ type: IngestCatalogDto })
  @Trpc()
  catalog(): IngestCatalogDto {
    return { actions: catalog() }
  }

  @Trpc({ kind: 'subscription', chunk: IngestProgressDto })
  @Mcp()
  async *github(): AsyncGenerator<IngestProgress> {
    yield* startDetachedRun('github', { trigger: 'manual' }).tail()
  }

  @Trpc({ kind: 'subscription', chunk: IngestProgressDto })
  @Mcp()
  async *githubEngagement(): AsyncGenerator<IngestProgress> {
    yield* startDetachedRun('github-engagement', { trigger: 'manual' }).tail()
  }

  @Trpc({ kind: 'subscription', chunk: IngestProgressDto })
  @Mcp()
  async *x(): AsyncGenerator<IngestProgress> {
    yield* startDetachedRun('x', { trigger: 'manual' }).tail()
  }

  @Trpc({ kind: 'subscription', chunk: IngestProgressDto })
  @Mcp()
  async *reddit(): AsyncGenerator<IngestProgress> {
    yield* startDetachedRun('reddit', { trigger: 'manual' }).tail()
  }

  @Trpc({ kind: 'subscription', chunk: IngestProgressDto })
  @Mcp()
  async *redditEngagement(): AsyncGenerator<IngestProgress> {
    yield* startDetachedRun('reddit-engagement', { trigger: 'manual' }).tail()
  }

  @Trpc({ kind: 'subscription', chunk: IngestProgressDto })
  @Mcp()
  async *redditRadar(): AsyncGenerator<IngestProgress> {
    yield* startDetachedRun('reddit-radar', { trigger: 'manual' }).tail()
  }

  @Trpc({ kind: 'subscription', chunk: IngestProgressDto })
  @Mcp()
  async *backfillPrs(): AsyncGenerator<IngestProgress> {
    yield* startDetachedRun('backfill-prs', { trigger: 'manual' }).tail()
  }

  @Trpc({ kind: 'subscription', chunk: IngestProgressDto })
  @Mcp()
  async *backfillStars(): AsyncGenerator<IngestProgress> {
    yield* startDetachedRun('backfill-stars', { trigger: 'manual' }).tail()
  }

  @Trpc({ kind: 'subscription', chunk: IngestProgressDto })
  @Mcp()
  async *backfillX(): AsyncGenerator<IngestProgress> {
    yield* startDetachedRun('backfill-x', { trigger: 'manual' }).tail()
  }

  @Trpc({ kind: 'subscription', chunk: IngestProgressDto })
  @Mcp()
  async *npmPull(): AsyncGenerator<IngestProgress> {
    yield* startDetachedRun('npm-pull', { trigger: 'manual' }).tail()
  }

  @Trpc({ kind: 'subscription', chunk: IngestProgressDto })
  @Mcp()
  async *blogPull(): AsyncGenerator<IngestProgress> {
    yield* startDetachedRun('blog-pull', { trigger: 'manual' }).tail()
  }

  @Trpc({ kind: 'subscription', chunk: IngestProgressDto })
  @Mcp()
  async *hackernewsPull(): AsyncGenerator<IngestProgress> {
    yield* startDetachedRun('hackernews-pull', { trigger: 'manual' }).tail()
  }

  @Trpc({ kind: 'subscription', chunk: IngestProgressDto })
  @Mcp()
  async *npmBackfill(): AsyncGenerator<IngestProgress> {
    yield* startDetachedRun('npm-backfill', { trigger: 'manual' }).tail()
  }
}

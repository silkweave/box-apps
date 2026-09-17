import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common'
import { AuthGuard } from '../../../auth/auth.guard.js'
import { ApiOperation } from '@nestjs/swagger'
import { IsString } from 'class-validator'
import { Mcp } from '@silkweave/nestjs'
import { cdpCheck, redditProbe, redditLogin, redditThread, redditExplore, type CdpCheckResult, type RedditProbeResult, type RedditLoginResult, type RedditThreadResult, type RedditExploreResult } from '@silkweave/box-core'

class RedditThreadDto {
  @IsString()
  path!: string
}

/**
 * Maintenance / Exploration-Mode diagnostics against the remote stealth browser (CDP) and the
 * Reddit session - the old `scripts/` CLIs, now in-process `@Mcp()` actions so they're reachable
 * from the `cli` proxy (`pnpm cli reddit-probe`), agents, and (later) the dashboard. Read-only
 * except RedditLogin, which only navigates the browser (a human still types the credentials on
 * the machine the browser runs on).
 */
@Controller('maintenance')
@UseGuards(AuthGuard)
export class MaintenanceController {
  @Get('cdp-check')
  @ApiOperation({ summary: 'Confirm the remote stealth browser is reachable over CDP' })
  @Mcp({ name: 'CdpCheck' })
  cdpCheck(): Promise<CdpCheckResult> {
    return cdpCheck()
  }

  @Get('reddit-probe')
  @ApiOperation({ summary: "Check the CDP Reddit session is attached + logged in as the configured reddit account" })
  @Mcp({ name: 'RedditProbe' })
  redditProbe(): Promise<RedditProbeResult> {
    return redditProbe()
  }

  @Post('reddit-login')
  @ApiOperation({ summary: 'Navigate the stealth browser to Reddit login (a human types the credentials there)' })
  @Mcp({ name: 'RedditLogin' })
  redditLogin(): Promise<RedditLoginResult> {
    return redditLogin()
  }

  @Post('reddit-thread')
  @ApiOperation({ summary: 'Fetch a full Reddit thread (post + comment tree) for drafting context' })
  @Mcp({ name: 'RedditThread' })
  redditThread(@Body() body: RedditThreadDto): Promise<RedditThreadResult> {
    return redditThread(body.path)
  }

  @Get('reddit-explore')
  @ApiOperation({ summary: 'Exploration-Mode: probe a battery of Reddit JSON endpoints' })
  @Mcp({ name: 'RedditExplore' })
  redditExplore(): Promise<RedditExploreResult> {
    return redditExplore()
  }
}

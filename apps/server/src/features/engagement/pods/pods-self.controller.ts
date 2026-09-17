import { Body, Controller, ForbiddenException, Get, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common'
import { ApiOkResponse, ApiProperty } from '@nestjs/swagger'
import { IsIn, IsOptional, IsString } from 'class-validator'
import { Trpc } from '@silkweave/nestjs'
import { AuthGuard } from '../../../auth/auth.guard.js'
import { ENGAGEMENT_ACTIONS, computeKarma, derivePodCards, readPodMembers, readPods, recordPodEngagement, upsertPodContent, type EngagementAction, type ParticipantKind, type Principal } from '@silkweave/box-core'
import { KarmaDto, PodCardDto } from './pods.controller.js'

// =================================================================================================
// The SELF-scoped pods surface - what the signed-in participant (collaborator or internal user) can
// do about THEIR OWN pod membership: see their cards, log/dismiss an engagement, submit their own
// content, read their karma. This replaces the retired pods micro-app + its internal RPC: the
// identity comes from the request principal (AuthGuard), never from a client-supplied id, so a
// caller can only ever act as themselves. Collaborators reach ONLY this controller (deny-by-default
// everywhere else); the admin surface stays user-only in pods.controller.ts. See docs/AUTH.md.
// =================================================================================================

/** The authenticated caller as a pod participant. */
interface Self {
  id: string
  kind: ParticipantKind
  display: string
}

interface PrincipalRequest {
  principal?: Principal | null
}

/** Resolve the caller. These routes are self-scoped: the identity comes from the request principal
 *  and never from a client-supplied id, so a caller can only ever act as themselves. */
function self(req: PrincipalRequest): Self {
  const p = req.principal
  if (!p) throw new UnauthorizedException('sign in required')
  return { id: p.id, kind: 'user', display: p.display }
}

// ---- DTOs ---------------------------------------------------------------------------------------

class MyPodDto {
  @ApiProperty() id!: string
  @ApiProperty() title!: string
  @ApiProperty() description!: string
}
class MyProfileDto {
  @ApiProperty() id!: string
  @ApiProperty({ enum: ['user'] }) kind!: ParticipantKind
  @ApiProperty() display!: string
}
class MyPodsOverviewDto {
  @ApiProperty() generatedAt!: string
  @ApiProperty({ type: MyProfileDto }) me!: MyProfileDto
  @ApiProperty({ type: [MyPodDto] }) pods!: MyPodDto[]
  @ApiProperty({ type: [PodCardDto] }) cards!: PodCardDto[]
  @ApiProperty({ type: [KarmaDto], description: 'The caller\'s own karma rows (per-pod + global)' })
  karma!: KarmaDto[]
  @ApiProperty({ type: Object, description: 'Per-pod leaderboards for the caller\'s pods, karma-desc' })
  leaderboards!: Record<string, KarmaDto[]>
}
class MyKarmaDto {
  @ApiProperty({ description: 'The caller\'s global karma GIVEN - engaging others (all pods combined)' }) given!: number
  @ApiProperty({ description: 'The caller\'s global karma RECEIVED - their own content (all pods combined)' }) received!: number
}
class MyEngageDto {
  @ApiProperty() @IsString() pod_content_id!: string
  @ApiProperty({ enum: ENGAGEMENT_ACTIONS }) @IsIn(ENGAGEMENT_ACTIONS) action!: EngagementAction
  @ApiProperty({ required: false }) @IsOptional() @IsString() note?: string
}
class MySubmitDto {
  @ApiProperty() @IsString() pod_id!: string
  @ApiProperty() @IsString() channel!: string
  @ApiProperty() @IsString() url!: string
  @ApiProperty({ required: false }) @IsOptional() @IsString() title?: string
}

@Controller('pods')
@UseGuards(AuthGuard)
export class PodsSelfController {
  /** tRPC query `podsSelfOverview` - everything the caller's pod surface needs in one shot. */
  @Get('self/overview')
  @ApiOkResponse({ type: MyPodsOverviewDto })
  @Trpc()
  async overview(@Req() req: PrincipalRequest): Promise<MyPodsOverviewDto> {
    return this.buildOverview(self(req))
  }

  /** tRPC query `podsSelfKarma` - just the caller's global given/received numbers, cheap enough
   *  for the topbar badge (skips derivePodCards + leaderboards, which podsSelfOverview pays for). */
  @Get('self/karma')
  @ApiOkResponse({ type: MyKarmaDto })
  @Trpc()
  async karma(@Req() req: PrincipalRequest): Promise<MyKarmaDto> {
    const me = self(req)
    const rows = await computeKarma()
    const mine = rows.find(
      (k) => k.pod_id === null && k.participant_kind === me.kind && k.participant_id === me.id,
    )
    return { given: mine?.given ?? 0, received: mine?.received ?? 0 }
  }

  /** tRPC mutation `podsSelfEngage` - self-attest an engagement on one of the caller's cards.
   *  recordPodEngagement guards in depth (piece exists, caller is a member, not their own piece). */
  @Post('self/engage')
  @ApiOkResponse({ type: MyPodsOverviewDto })
  @Trpc({ kind: 'mutation' })
  async engage(@Body() body: MyEngageDto, @Req() req: PrincipalRequest): Promise<MyPodsOverviewDto> {
    const me = self(req)
    await recordPodEngagement({
      pod_content_id: body.pod_content_id,
      participant_kind: me.kind,
      participant_id: me.id,
      action: body.action,
      status: 'verified',
      evidence: { method: 'manual', detail: 'self-attested in the dashboard pods view' },
      note: body.note ?? null,
      actor: me.id,
    })
    return this.buildOverview(me)
  }

  /** tRPC mutation `podsSelfDismiss` - opt out of a card without recording a fake engagement. */
  @Post('self/dismiss')
  @ApiOkResponse({ type: MyPodsOverviewDto })
  @Trpc({ kind: 'mutation' })
  async dismiss(@Body() body: MyEngageDto, @Req() req: PrincipalRequest): Promise<MyPodsOverviewDto> {
    const me = self(req)
    await recordPodEngagement({
      pod_content_id: body.pod_content_id,
      participant_kind: me.kind,
      participant_id: me.id,
      action: body.action,
      status: 'dismissed',
      evidence: null,
      note: body.note ?? null,
      actor: me.id,
    })
    return this.buildOverview(me)
  }

  /** tRPC mutation `podsSelfSubmit` - submit the caller's own content into a pod they belong to. */
  @Post('self/submit')
  @ApiOkResponse({ type: MyPodsOverviewDto })
  @Trpc({ kind: 'mutation' })
  async submit(@Body() body: MySubmitDto, @Req() req: PrincipalRequest): Promise<MyPodsOverviewDto> {
    const me = self(req)
    if (!body.url?.trim()) throw new ForbiddenException('a post url is required')
    const members = await readPodMembers(body.pod_id)
    if (!members.some((m) => m.participant_kind === me.kind && m.participant_id === me.id)) {
      throw new ForbiddenException(`not a member of pod "${body.pod_id}"`)
    }
    await upsertPodContent({
      pod_id: body.pod_id,
      source: 'team',
      submitter_kind: me.kind,
      submitter_id: me.id,
      channel: body.channel || 'x',
      url: body.url.trim(),
      title: body.title ?? '',
      actor: me.id,
    })
    return this.buildOverview(me)
  }

  private async buildOverview(me: Self): Promise<MyPodsOverviewDto> {
    const [pods, members, cards, karma] = await Promise.all([
      readPods(),
      readPodMembers(),
      derivePodCards(),
      computeKarma(),
    ])
    const memberOf = new Set(
      members.filter((m) => m.participant_kind === me.kind && m.participant_id === me.id).map((m) => m.pod_id),
    )
    const myPods = pods
      .filter((p) => memberOf.has(p.id) && p.status === 'active')
      .map((p) => ({ id: p.id, title: p.title, description: p.description }))
    const active = new Set(myPods.map((p) => p.id))
    // computeKarma returns given-desc already; leaderboards keep that order.
    const leaderboards: Record<string, KarmaDto[]> = {}
    for (const podId of active) leaderboards[podId] = karma.filter((k) => k.pod_id === podId) as KarmaDto[]
    return {
      generatedAt: new Date().toISOString(),
      me,
      pods: myPods,
      cards: cards.filter(
        (c) => c.participant_kind === me.kind && c.participant_id === me.id && active.has(c.pod_id),
      ) as PodCardDto[],
      karma: karma.filter((k) => k.participant_kind === me.kind && k.participant_id === me.id) as KarmaDto[],
      leaderboards,
    }
  }
}

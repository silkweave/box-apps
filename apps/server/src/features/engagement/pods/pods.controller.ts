import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common'
import { AuthGuard } from '../../../auth/auth.guard.js'
import { Admin } from '../../../auth/auth.decorators.js'
import { ApiOkResponse, ApiProperty } from '@nestjs/swagger'
import { IsBoolean, IsIn, IsInt, IsOptional, IsString } from 'class-validator'
import { Mcp, Trpc } from '@silkweave/nestjs'
import { ENGAGEMENT_ACTIONS, PARTICIPANT_KINDS, POD_CONTENT_SOURCES, addPodMember, computeKarma, deletePod, deletePodContent, deletePodEngagement, derivePodCards, readPodContent, readPodEngagements, readPodMembers, readPods, readPodsConfig, setPodsAutoContentEnabled, recordPodEngagement, removePodMember, startDetachedRun, upsertPod, upsertPodContent, type IngestProgress, type EngagementAction, type EngagementAdvice, type EngagementEvidence, type ParticipantKind, type Pod, type PodContentSource, type PodMember } from '@silkweave/box-core'

// ---- output DTOs --------------------------------------------------------------------------------
// The dashboard keeps its own mirror types and casts; these document the tRPC/Swagger surface.

class PodDto {
  @ApiProperty() id!: string
  @ApiProperty() title!: string
  @ApiProperty() description!: string
  @ApiProperty() status!: string
  @ApiProperty({ required: false, nullable: true }) owner!: string | null
  @ApiProperty() sort!: number
  @ApiProperty() created_at!: string
  @ApiProperty() updated_at!: string
  @ApiProperty({ required: false, nullable: true }) created_by!: string | null
  @ApiProperty({ required: false, nullable: true }) updated_by!: string | null
}
class PodMemberDto {
  @ApiProperty() pod_id!: string
  @ApiProperty({ enum: PARTICIPANT_KINDS }) participant_kind!: string
  @ApiProperty() participant_id!: string
  @ApiProperty() role!: string
  @ApiProperty() joined_at!: string
  @ApiProperty({ required: false, nullable: true }) created_by!: string | null
}
class PodContentDto {
  @ApiProperty() id!: string
  @ApiProperty() pod_id!: string
  @ApiProperty({ enum: POD_CONTENT_SOURCES }) source!: string
  @ApiProperty({ required: false, nullable: true }) content_id!: string | null
  @ApiProperty({ required: false, nullable: true, description: 'initiative.id of the team piece (post-grouping key)' })
  initiative_id!: string | null
  @ApiProperty({ required: false, nullable: true }) submitter_kind!: string | null
  @ApiProperty({ required: false, nullable: true }) submitter_id!: string | null
  @ApiProperty() channel!: string
  @ApiProperty() url!: string
  @ApiProperty() title!: string
  @ApiProperty({ type: Object, required: false, nullable: true }) advice!: EngagementAdvice | null
  @ApiProperty({ required: false, nullable: true }) published_at!: string | null
  @ApiProperty() created_at!: string
  @ApiProperty() updated_at!: string
  @ApiProperty({ required: false, nullable: true }) created_by!: string | null
  @ApiProperty({ required: false, nullable: true }) updated_by!: string | null
}
export class PodCardDto {
  @ApiProperty() pod_id!: string
  @ApiProperty() pod_content_id!: string
  @ApiProperty({ enum: PARTICIPANT_KINDS }) participant_kind!: string
  @ApiProperty() participant_id!: string
  @ApiProperty() channel!: string
  @ApiProperty() title!: string
  @ApiProperty() url!: string
  @ApiProperty({ required: false, nullable: true }) published_at!: string | null
  @ApiProperty({ required: false, nullable: true }) author_kind!: string | null
  @ApiProperty({ required: false, nullable: true }) author_id!: string | null
  @ApiProperty({ type: [String], description: 'ALL expected actions (e.g. react + comment)' }) actions!: string[]
  @ApiProperty({ type: [String], description: 'The subset already completed (verified/dismissed)' })
  done_actions!: string[]
  @ApiProperty({ type: Object, required: false, nullable: true }) advice!: EngagementAdvice | null
  @ApiProperty({ required: false, nullable: true, description: "The participant's own saved comment draft" })
  draft_comment!: string | null
  @ApiProperty() days_left!: number
}
class PodEngagementDto {
  @ApiProperty() pod_content_id!: string
  @ApiProperty() participant_kind!: string
  @ApiProperty() participant_id!: string
  @ApiProperty() action!: string
  @ApiProperty() status!: string
  @ApiProperty({ required: false, nullable: true }) verified_at!: string | null
  @ApiProperty({ type: Object, required: false, nullable: true }) evidence!: EngagementEvidence | null
  @ApiProperty() karma_awarded!: number
  @ApiProperty({ required: false, nullable: true }) note!: string | null
  @ApiProperty() created_at!: string
  @ApiProperty() updated_at!: string
  @ApiProperty({ required: false, nullable: true }) created_by!: string | null
  @ApiProperty({ required: false, nullable: true }) updated_by!: string | null
}
export class KarmaDto {
  @ApiProperty() participant_kind!: string
  @ApiProperty() participant_id!: string
  @ApiProperty() label!: string
  @ApiProperty({ required: false, nullable: true }) pod_id!: string | null
  @ApiProperty({ description: "GIVEN - contributed by engaging others' content" }) given!: number
  @ApiProperty({ description: "RECEIVED - what their own content earned from others" }) received!: number
}
class AutoContentDto {
  @ApiProperty({ description: 'Pod that auto-receives published team content' }) pod!: string
  @ApiProperty({ type: [String] }) channels!: string[]
  @ApiProperty({ description: 'false pauses the hook without losing the config' }) enabled!: boolean
}
class PodsOverviewDto {
  @ApiProperty() generatedAt!: string
  @ApiProperty({ type: AutoContentDto, required: false, nullable: true, description: 'config/pods.json autoContent (null = not configured)' })
  autoContent!: AutoContentDto | null
  @ApiProperty({ type: [PodDto] }) pods!: PodDto[]
  @ApiProperty({ type: [PodMemberDto] }) members!: PodMemberDto[]
  @ApiProperty({ type: [PodContentDto] }) content!: PodContentDto[]
  @ApiProperty({ type: [PodEngagementDto] }) engagements!: PodEngagementDto[]
  @ApiProperty({ type: [PodCardDto] }) cards!: PodCardDto[]
  @ApiProperty({ type: [KarmaDto] }) karma!: KarmaDto[]
}

// ---- input DTOs (MCP scalar-only: objects travel as JSON strings, parsed server-side) -----------

class UpsertPodDto {
  @ApiProperty() @IsString() id!: string
  @ApiProperty({ required: false }) @IsOptional() @IsString() title?: string
  @ApiProperty({ required: false }) @IsOptional() @IsString() description?: string
  @ApiProperty({ required: false, enum: ['active', 'paused', 'archived'] }) @IsOptional() @IsString() status?: string
  @ApiProperty({ required: false, description: 'owning users.id ("" clears)' }) @IsOptional() @IsString() owner?: string
  @ApiProperty({ required: false }) @IsOptional() @IsInt() sort?: number
  @ApiProperty({ required: false }) @IsOptional() @IsString() actor?: string
}
class IdDto {
  @ApiProperty() @IsString() id!: string
  @ApiProperty({ required: false }) @IsOptional() @IsString() actor?: string
}
class MemberDto {
  @ApiProperty() @IsString() pod_id!: string
  @ApiProperty({ enum: PARTICIPANT_KINDS }) @IsIn(PARTICIPANT_KINDS) participant_kind!: ParticipantKind
  @ApiProperty() @IsString() participant_id!: string
  @ApiProperty({ required: false, enum: ['admin', 'member'] }) @IsOptional() @IsString() role?: string
  @ApiProperty({ required: false }) @IsOptional() @IsString() actor?: string
}
class UpsertPodContentDto {
  @ApiProperty({ required: false, description: 'omit to mint a new id' }) @IsOptional() @IsString() id?: string
  @ApiProperty() @IsString() pod_id!: string
  @ApiProperty({ required: false, enum: POD_CONTENT_SOURCES }) @IsOptional() @IsString() source?: string
  @ApiProperty({ required: false, description: 'content.id when source=team' }) @IsOptional() @IsString() content_id?: string
  @ApiProperty({ required: false, enum: PARTICIPANT_KINDS }) @IsOptional() @IsString() submitter_kind?: string
  @ApiProperty({ required: false }) @IsOptional() @IsString() submitter_id?: string
  @ApiProperty() @IsString() channel!: string
  @ApiProperty() @IsString() url!: string
  @ApiProperty({ required: false }) @IsOptional() @IsString() title?: string
  @ApiProperty({ required: false, description: 'JSON {action, hint?, draft_comment?}' }) @IsOptional() @IsString() advice?: string
  @ApiProperty({ required: false, description: 'ISO timestamp' }) @IsOptional() @IsString() published_at?: string
  @ApiProperty({ required: false }) @IsOptional() @IsString() actor?: string
}
class RecordPodEngagementDto {
  @ApiProperty() @IsString() pod_content_id!: string
  @ApiProperty({ enum: PARTICIPANT_KINDS }) @IsIn(PARTICIPANT_KINDS) participant_kind!: ParticipantKind
  @ApiProperty() @IsString() participant_id!: string
  @ApiProperty({ enum: ENGAGEMENT_ACTIONS }) @IsIn(ENGAGEMENT_ACTIONS) action!: EngagementAction
  @ApiProperty({ required: false, description: 'JSON {method, detail?, comment_text?}; defaults {"method":"manual"}' })
  @IsOptional() @IsString() evidence?: string
  @ApiProperty({ required: false }) @IsOptional() @IsString() note?: string
  @ApiProperty({ required: false }) @IsOptional() @IsString() actor?: string
}
class DraftPodEngagementDto {
  @ApiProperty() @IsString() pod_content_id!: string
  @ApiProperty({ enum: PARTICIPANT_KINDS }) @IsIn(PARTICIPANT_KINDS) participant_kind!: ParticipantKind
  @ApiProperty() @IsString() participant_id!: string
  @ApiProperty({ enum: ENGAGEMENT_ACTIONS }) @IsIn(ENGAGEMENT_ACTIONS) action!: EngagementAction
  @ApiProperty({ description: 'The full pre-written comment text (stored as evidence.comment_text)' })
  @IsString() draft!: string
  @ApiProperty({ required: false }) @IsOptional() @IsString() note?: string
  @ApiProperty({ required: false }) @IsOptional() @IsString() actor?: string
}
class VerifyPodEngagementDto {
  @ApiProperty() @IsString() pod_content_id!: string
  @ApiProperty({ enum: PARTICIPANT_KINDS }) @IsIn(PARTICIPANT_KINDS) participant_kind!: ParticipantKind
  @ApiProperty() @IsString() participant_id!: string
  @ApiProperty({ required: false }) @IsOptional() @IsString() actor?: string
}
class PodPullResultDto {
  @ApiProperty() channel!: string
  @ApiProperty() date!: string
  @ApiProperty() summary!: string
}
class PodIngestProgressDto {
  @ApiProperty() channel!: string
  @ApiProperty({ enum: ['start', 'fetch', 'persist', 'done'] }) phase!: IngestProgress['phase']
  @ApiProperty() message!: string
  @ApiProperty({ required: false, type: PodPullResultDto, nullable: true }) result?: PodPullResultDto
}
class SetAutoContentEnabledDto {
  @ApiProperty({ description: 'true resumes the auto-content hook, false pauses it' })
  @IsBoolean() enabled!: boolean
  @ApiProperty({ required: false }) @IsOptional() @IsString() actor?: string
}
class DismissPodEngagementDto {
  @ApiProperty() @IsString() pod_content_id!: string
  @ApiProperty({ enum: PARTICIPANT_KINDS }) @IsIn(PARTICIPANT_KINDS) participant_kind!: ParticipantKind
  @ApiProperty() @IsString() participant_id!: string
  @ApiProperty({ enum: ENGAGEMENT_ACTIONS }) @IsIn(ENGAGEMENT_ACTIONS) action!: EngagementAction
  @ApiProperty({ required: false }) @IsOptional() @IsString() note?: string
  @ApiProperty({ required: false }) @IsOptional() @IsString() actor?: string
}

const cast = <T>(v: unknown): T => v as T

/**
 * Engagement Pods - the admin surface. Pods + membership CRUD, team-content curation with per-piece
 * advice, the derived engagement cards + persisted engagements + karma. The SELF-scoped mirror in
 * pods-self.controller.ts is the same data narrowed to the caller. The controller only RECORDS
 * engagements - it never engages on anyone's behalf. See features/engagement/SPEC.md.
 *
 * The collaborator lifecycle (upsert/delete/invite/reveal/revoke) lived here until 2026-09-10 and is
 * gone with the tier itself; the people directory is `users.controller.ts`.
 */
@Controller('pods')
@UseGuards(AuthGuard)
export class PodsController {
  /** tRPC query `podsOverview` / MCP `pods-overview` - the whole picture (pods, members, content,
   *  engagements, derived cards, karma). The dashboard filters client-side; the /engage skill reads
   *  cards + drafts through the MCP name. */
  @Get('overview')
  @ApiOkResponse({ type: PodsOverviewDto })
  @Trpc()
  @Mcp({ name: 'pods-overview' })
  async overview(): Promise<PodsOverviewDto> {
    const [pods, members, content, engagements, cards, karma] = await Promise.all([
      readPods(),
      readPodMembers(),
      readPodContent(),
      readPodEngagements(),
      derivePodCards(),
      computeKarma(),
    ])
    const auto = readPodsConfig().autoContent
    return {
      generatedAt: new Date().toISOString(),
      autoContent: auto ? { pod: auto.pod, channels: auto.channels, enabled: auto.enabled !== false } : null,
      pods: cast<PodDto[]>(pods),
      members: cast<PodMemberDto[]>(members),
      content: cast<PodContentDto[]>(content),
      engagements: cast<PodEngagementDto[]>(engagements),
      cards: cast<PodCardDto[]>(cards),
      karma: cast<KarmaDto[]>(karma),
    }
  }

  // --- pods (configuration) ---
  @Post('upsert')
  @ApiOkResponse({ type: PodDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'pod-upsert' })
  async upsert(@Body() body: UpsertPodDto): Promise<PodDto> {
    return cast<PodDto>(
      await upsertPod({
        id: body.id,
        title: body.title,
        description: body.description,
        status: body.status as Pod['status'] | undefined,
        owner: body.owner === '' ? null : body.owner,
        sort: body.sort,
        actor: body.actor,
      }),
    )
  }

  @Post('delete')
  @ApiOkResponse({ type: PodsOverviewDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'pod-delete' })
  async delete(@Body() body: IdDto): Promise<PodsOverviewDto> {
    await deletePod(body.id)
    return this.overview()
  }

  /** tRPC mutation `podsAutoContentSet` - pause/resume the publish→pod auto-content hook. The
   *  pod/channel config itself stays in config/pods.json; this only flips `enabled`. */
  @Post('auto-content-set')
  @ApiOkResponse({ type: PodsOverviewDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'pod-auto-content-set' })
  async autoContentSet(@Body() body: SetAutoContentEnabledDto): Promise<PodsOverviewDto> {
    setPodsAutoContentEnabled(body.enabled)
    return this.overview()
  }


  // --- membership (configuration - admin-only) ---
  @Post('member-add')
  @ApiOkResponse({ type: PodMemberDto })
  @Trpc({ kind: 'mutation' })
  @Admin()
  @Mcp({ name: 'pod-member-add' })
  async memberAdd(@Body() body: MemberDto): Promise<PodMemberDto> {
    return cast<PodMemberDto>(
      await addPodMember({
        pod_id: body.pod_id,
        participant_kind: body.participant_kind,
        participant_id: body.participant_id,
        role: body.role as PodMember['role'] | undefined,
        actor: body.actor,
      }),
    )
  }

  @Post('member-remove')
  @ApiOkResponse({ type: PodsOverviewDto })
  @Trpc({ kind: 'mutation' })
  @Admin()
  @Mcp({ name: 'pod-member-remove' })
  async memberRemove(@Body() body: MemberDto): Promise<PodsOverviewDto> {
    await removePodMember(body.pod_id, body.participant_kind, body.participant_id)
    return this.overview()
  }

  // --- content curation ---
  @Post('content-upsert')
  @ApiOkResponse({ type: PodContentDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'pod-content-add' })
  async contentUpsert(@Body() body: UpsertPodContentDto): Promise<PodContentDto> {
    return cast<PodContentDto>(
      await upsertPodContent({
        id: body.id,
        pod_id: body.pod_id,
        source: body.source as PodContentSource | undefined,
        content_id: body.content_id,
        submitter_kind: body.submitter_kind as ParticipantKind | undefined,
        submitter_id: body.submitter_id,
        channel: body.channel,
        url: body.url,
        title: body.title,
        advice: body.advice ? (JSON.parse(body.advice) as EngagementAdvice) : undefined,
        published_at: body.published_at,
        actor: body.actor,
      }),
    )
  }

  @Post('content-delete')
  @ApiOkResponse({ type: PodsOverviewDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'pod-content-delete' })
  async contentDelete(@Body() body: IdDto): Promise<PodsOverviewDto> {
    await deletePodContent(body.id)
    return this.overview()
  }

  // --- engagements ---
  @Post('engagement-record')
  @ApiOkResponse({ type: PodEngagementDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'pod-engagement-record' })
  async engagementRecord(@Body() body: RecordPodEngagementDto): Promise<PodEngagementDto> {
    const evidence = body.evidence
      ? (JSON.parse(body.evidence) as EngagementEvidence)
      : ({ method: 'manual' } satisfies EngagementEvidence)
    return cast<PodEngagementDto>(
      await recordPodEngagement({
        pod_content_id: body.pod_content_id,
        participant_kind: body.participant_kind,
        participant_id: body.participant_id,
        action: body.action,
        status: 'verified',
        evidence,
        note: body.note ?? null,
        actor: body.actor,
      }),
    )
  }

  @Post('engagement-dismiss')
  @ApiOkResponse({ type: PodEngagementDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'pod-engagement-dismiss' })
  async engagementDismiss(@Body() body: DismissPodEngagementDto): Promise<PodEngagementDto> {
    return cast<PodEngagementDto>(
      await recordPodEngagement({
        pod_content_id: body.pod_content_id,
        participant_kind: body.participant_kind,
        participant_id: body.participant_id,
        action: body.action,
        status: 'dismissed',
        evidence: null,
        note: body.note ?? null,
        actor: body.actor,
      }),
    )
  }

  /**
   * tRPC mutation `podsEngagementDraft` / MCP `pod-engagement-draft` - save a participant's own
   * comment DRAFT for one card (written by the /engage skill, rendered in the card dialog). A
   * `draft` row never clears the card and awards no karma; it upserts to `verified` when the
   * participant later records/verifies the real engagement.
   */
  @Post('engagement-draft')
  @ApiOkResponse({ type: PodEngagementDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'pod-engagement-draft' })
  async engagementDraft(@Body() body: DraftPodEngagementDto): Promise<PodEngagementDto> {
    // Guard: the upsert would happily overwrite a VERIFIED row (dropping its karma + evidence) -
    // a draft must never downgrade a completed engagement.
    const existing = (await readPodEngagements()).find(
      (e) =>
        e.pod_content_id === body.pod_content_id &&
        e.participant_kind === body.participant_kind &&
        e.participant_id === body.participant_id &&
        e.action === body.action,
    )
    if (existing?.status === 'verified') {
      throw new Error(`draft refused: "${body.participant_id}" already has a verified ${body.action} on "${body.pod_content_id}"`)
    }
    // An empty draft CLEARS: drop the draft row so the card goes back to "no draft yet" (and the
    // /engage snippet). Only ever deletes a `draft` row - a dismissal must stay a dismissal.
    if (!body.draft.trim()) {
      if (existing?.status === 'draft') {
        await deletePodEngagement(body.pod_content_id, body.participant_kind, body.participant_id, body.action)
      }
      return cast<PodEngagementDto>({
        ...(existing ?? {
          pod_content_id: body.pod_content_id,
          participant_kind: body.participant_kind,
          participant_id: body.participant_id,
          action: body.action,
          status: 'draft',
          verified_at: null,
          karma_awarded: 0,
          note: null,
          created_at: '',
          updated_at: '',
          created_by: null,
          updated_by: null,
        }),
        evidence: null,
      })
    }
    return cast<PodEngagementDto>(
      await recordPodEngagement({
        pod_content_id: body.pod_content_id,
        participant_kind: body.participant_kind,
        participant_id: body.participant_id,
        action: body.action,
        status: 'draft',
        evidence: { method: 'manual', comment_text: body.draft },
        note: body.note ?? null,
        actor: body.actor,
      }),
    )
  }

  /**
   * tRPC subscription `podsEngagementVerify` / MCP `pod-engagement-verify` - kick the deterministic
   * `pod-engagement-verify` automation op for one card and stream its progress. The op checks from
   * the ENGAGER's side (reddit: public thread JSON; x/linkedin: their own logged-in Chrome per
   * config/browsers.json) and records the engagement itself (karma included) on a `confirmed`
   * verdict. Runs detached - dropping the stream never kills the check - and lands in
   * `automation_runs` like any op. The terminal chunk's result.summary is `<verdict>: <detail>`.
   */
  @Trpc({ kind: 'subscription', chunk: PodIngestProgressDto })
  @Mcp({ name: 'pod-engagement-verify' })
  async *engagementVerify(@Body() body: VerifyPodEngagementDto): AsyncGenerator<IngestProgress> {
    const run = startDetachedRun('pod-engagement-verify', {
      trigger: 'manual',
      triggeredBy: body.actor ?? null,
      params: {
        pod_content_id: body.pod_content_id,
        participant_kind: body.participant_kind,
        participant_id: body.participant_id,
        ...(body.actor ? { actor: body.actor } : {}),
      },
    })
    yield* run.tail()
  }
}

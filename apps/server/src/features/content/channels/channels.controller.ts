import { BadRequestException, Body, Controller, Get, Post, UseGuards } from '@nestjs/common'
import { ApiOkResponse, ApiProperty } from '@nestjs/swagger'
import { IsOptional, IsString } from 'class-validator'
import { Mcp, Trpc } from '@silkweave/nestjs'
import { CHANNEL_PROFILE_DEFAULTS, COMPANY_AUTHOR, PROFILE_CHANNELS, channelProfiles, listVoiceLayers, readChannelProfilesFile, readUsers, readVoiceLayer, resetChannelProfile, setChannelProfile, writeVoiceLayer, type ChannelContentProfile } from '@silkweave/box-core'
import { AuthGuard } from '../../../auth/auth.guard.js'
import { Admin } from '../../../auth/auth.decorators.js'

// Settings → Channels: the two things that decide what a piece is allowed to look like, in one
// place. Until 2026-08-12 both were unmanageable from the app - the per-channel PROFILE was
// hardcoded TypeScript, and the VOICE styles were markdown you had to have a checkout to edit. A
// team that cannot change its own house style through the tool it uses every day changes it in Lark
// instead, and then the gate checks the old rules.
//
// Both keep their storage. Profiles overlay `config/channel-profiles.json` over the code defaults
// (see @silkweave/box-core content/profiles.ts for why an overlay rather than a copy, and why `publish` is not
// editable); voice styles stay markdown under `docs/identity/voice/`, edited IN PLACE, because
// /draft-content and /verify-content read those files directly from a checkout and moving them into
// the warehouse would fork the style contract from the thing that enforces it.
//
// GUARD LEVEL: admin, like the other configuration sections (schedules, rules, pods, data sources)
// and unlike presets. The distinction is what a mistake costs: a bad preset is a lens nobody opens,
// while a bad limit or a rewritten voice file silently changes what every future draft is checked
// against. The open `voice-read` MCP tool is untouched - skills still read the style layer without
// admin, they just cannot write it.

class ChannelProfileDto {
  @ApiProperty() channel!: string
  @ApiProperty() label!: string
  @ApiProperty() bodyKind!: string
  @ApiProperty({ type: Object }) limits!: Record<string, unknown>
  @ApiProperty() voiceNotes!: string
  @ApiProperty({ type: [String] }) requires!: string[]
  @ApiProperty({ type: [String], required: false }) recommends?: string[]
  @ApiProperty({ type: Object }) publish!: Record<string, unknown>
}

class ChannelConfigDto {
  @ApiProperty({ type: ChannelProfileDto, description: 'The profile in force - defaults with the tenant overlay applied' })
  profile!: ChannelProfileDto
  @ApiProperty({ type: ChannelProfileDto, description: 'What shipped, for the "reset to default" comparison' })
  defaults!: ChannelProfileDto
  @ApiProperty({ type: [String], description: 'Which fields this tenant has overlaid (empty = untouched)' })
  overridden!: string[]
}

class VoiceLayerDto {
  @ApiProperty({ required: false, nullable: true, description: 'ContentChannel, or null for a channel-independent layer' })
  channel!: string | null
  @ApiProperty({ required: false, nullable: true, description: "users.id / 'company', or null for the channel file itself" })
  author!: string | null
  @ApiProperty({ description: 'Instance-relative path (docs/identity/voice/…)' }) path!: string
  @ApiProperty({ description: 'Body length in characters - the inventory does not ship every file' })
  bytes!: number
}

class ChannelsConfigDto {
  @ApiProperty() generatedAt!: string
  @ApiProperty({ type: [ChannelConfigDto] }) channels!: ChannelConfigDto[]
  @ApiProperty({ type: [VoiceLayerDto], description: 'Every voice file on disk today' })
  voiceLayers!: VoiceLayerDto[]
  @ApiProperty({
    type: [String],
    description: "Ids an overlay may be written for: every internal users.id plus 'company' (the company page)",
  })
  authors!: string[]
}

// NOTE: @Mcp() input fields must have a concrete scalar/array JSON-schema `type`, so `limits`
// travels as a JSON object STRING (the board-nodes-set / preset-save precedent) and the two list
// fields as comma-separated strings. Omitting a field leaves it unchanged; sending '' clears the
// tenant's override and restores the shipped default for that field alone.
class SetChannelProfileDto {
  @ApiProperty({ enum: PROFILE_CHANNELS, description: 'Which channel to overlay' })
  @IsString() channel!: string
  @ApiProperty({ required: false, description: "Display label, e.g. 'LinkedIn'. '' restores the default." })
  @IsOptional() @IsString() label?: string
  @ApiProperty({ required: false, description: "Body shape: longform | medium | thread | short. '' restores the default." })
  @IsOptional() @IsString() bodyKind?: string
  @ApiProperty({
    required: false,
    description:
      'JSON object string of the limits, e.g. {"perUnitChars":3000,"units":[1200,2000],"unitKind":"chars"}. ' +
      "'' restores the default.",
  })
  @IsOptional() @IsString() limits?: string
  @ApiProperty({ required: false, description: "One-line channel style note. '' restores the default." })
  @IsOptional() @IsString() voiceNotes?: string
  @ApiProperty({
    required: false,
    description: "Comma-separated fields a piece MUST carry to verify, e.g. 'subreddit'. '' restores the default.",
  })
  @IsOptional() @IsString() requires?: string
  @ApiProperty({
    required: false,
    description: "Comma-separated recommended fields (missing → a verify warn, never a fail). '' restores the default.",
  })
  @IsOptional() @IsString() recommends?: string
}

class ChannelDto {
  @ApiProperty({ enum: PROFILE_CHANNELS }) @IsString() channel!: string
}

class VoiceLayerRefDto {
  @ApiProperty({ required: false, description: 'ContentChannel; omit for a channel-independent layer' })
  @IsOptional() @IsString() channel?: string
  @ApiProperty({ required: false, description: "users.id or 'company'; omit for the channel file itself" })
  @IsOptional() @IsString() author?: string
}

class VoiceLayerSaveDto extends VoiceLayerRefDto {
  @ApiProperty({ description: 'The full markdown body. An empty string is legal and means the layer says nothing.' })
  @IsString() content!: string
}

class VoiceFileDto {
  @ApiProperty() path!: string
  @ApiProperty() exists!: boolean
  @ApiProperty() content!: string
}

/** Which descriptive fields this tenant has actually overlaid, for the "reset" affordance. */
const overriddenFields = (channel: string): string[] => Object.keys(readChannelProfilesFile()[channel as never] ?? {})

const toProfileDto = (p: ChannelContentProfile): ChannelProfileDto => p as unknown as ChannelProfileDto

/** '' means "clear this override"; an omitted field means "leave it alone". The core layer reads
 *  `null` as the clear, so that is what an empty string becomes here. */
const clearable = (v: string | undefined): string | null | undefined => (v === undefined ? undefined : v.trim() || null)

/** A comma-separated list to the array core expects, with the same '' = clear contract. */
const listField = (v: string | undefined): string[] | null | undefined => {
  if (v === undefined) return undefined
  const items = v.split(',').map((s) => s.trim()).filter(Boolean)
  return items.length ? items : null
}

@Controller('channels')
@UseGuards(AuthGuard)
export class ChannelsController {
  /**
   * tRPC query `channelsConfig` - every channel's profile in force, what shipped underneath it, which
   * fields the team changed, plus the voice-file inventory and the ids an overlay may be written for.
   * One payload because the editor is one screen; the voice BODIES are not in it (a dozen markdown
   * files most of which nobody is looking at), they load per layer through `channelVoiceRead`.
   */
  @Get()
  @ApiOkResponse({ type: ChannelsConfigDto })
  @Trpc()
  async config(): Promise<ChannelsConfigDto> {
    const inForce = channelProfiles()
    const users = await readUsers()
    return {
      generatedAt: new Date().toISOString(),
      channels: PROFILE_CHANNELS.map((channel) => ({
        profile: toProfileDto(inForce[channel]),
        defaults: toProfileDto(CHANNEL_PROFILE_DEFAULTS[channel]),
        overridden: overriddenFields(channel),
      })),
      voiceLayers: listVoiceLayers() as VoiceLayerDto[],
      // COMPANY_AUTHOR is not a users row - it is the organisation's own identity (content/types.ts).
      // Listing it here keeps the picker honest.
      authors: [...users.map((u) => u.id), COMPANY_AUTHOR],
    }
  }

  /**
   * tRPC mutation `channelProfileSet` / MCP `channel-profile-set` - overlay one channel's descriptive
   * fields. `publish` is not settable by design: it describes what code exists (see the core module's
   * header), and a tenant that could flip `auto` would be able to promise a send nothing performs.
   */
  @Post('profile')
  @ApiOkResponse({ type: ChannelsConfigDto })
  @Trpc({ kind: 'mutation' })
  @Admin()
  @Mcp({ name: 'channel-profile-set' })
  async profileSet(@Body() body: SetChannelProfileDto): Promise<ChannelsConfigDto> {
    try {
      setChannelProfile(body.channel, {
        label: clearable(body.label),
        bodyKind: clearable(body.bodyKind),
        limits: body.limits === undefined ? undefined : body.limits.trim() ? JSON.parse(body.limits) : null,
        voiceNotes: clearable(body.voiceNotes),
        requires: listField(body.requires),
        recommends: listField(body.recommends),
      })
    } catch (e) {
      // The domain refuses unknown channels, out-of-vocabulary body kinds and unusable limits with a
      // message naming which - a 500 would strip exactly the part the caller needs to act on.
      throw new BadRequestException(e instanceof Error ? e.message : String(e))
    }
    return this.config()
  }

  /** tRPC mutation `channelProfileReset` / MCP `channel-profile-reset` - drop every override on one
   *  channel, putting it back to what the release ships. */
  @Post('profile/reset')
  @ApiOkResponse({ type: ChannelsConfigDto })
  @Trpc({ kind: 'mutation' })
  @Admin()
  @Mcp({ name: 'channel-profile-reset' })
  async profileReset(@Body() body: ChannelDto): Promise<ChannelsConfigDto> {
    try {
      resetChannelProfile(body.channel)
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : String(e))
    }
    return this.config()
  }

  /**
   * tRPC mutation `channelVoiceRead` - ONE voice layer's body, named by (channel, author) rather than
   * by a path so the client never composes a filename. The layered read every skill uses stays
   * `voice-read` on the content controller: that one answers "what rules apply to this draft", this
   * one answers "what does this file say", and an editor must not be shown four files merged.
   */
  @Post('voice/read')
  @ApiOkResponse({ type: VoiceFileDto })
  @Trpc({ kind: 'mutation' })
  async voiceRead(@Body() body: VoiceLayerRefDto): Promise<VoiceFileDto> {
    try {
      return readVoiceLayer(body)
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : String(e))
    }
  }

  /**
   * tRPC mutation `channelVoiceSave` / MCP `voice-write` - write one voice layer, creating it if it
   * does not exist. Whole-body writes, last-write-wins, no version precondition: the same posture as
   * DocSave, and the Box instance's git history is the undo.
   */
  @Post('voice')
  @ApiOkResponse({ type: VoiceFileDto })
  @Trpc({ kind: 'mutation' })
  @Admin()
  @Mcp({ name: 'voice-write' })
  async voiceSave(@Body() body: VoiceLayerSaveDto): Promise<VoiceFileDto> {
    try {
      return writeVoiceLayer({ channel: body.channel, author: body.author }, body.content)
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : String(e))
    }
  }
}

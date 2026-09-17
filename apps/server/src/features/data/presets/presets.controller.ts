import { BadRequestException, Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common'
import { ApiOkResponse, ApiProperty } from '@nestjs/swagger'
import { IsArray, IsIn, IsOptional, IsString } from 'class-validator'
import { Mcp, Trpc } from '@silkweave/nestjs'
import { PRESET_MODULES, deletePreset, readPresetsFile, reorderPresets, savePreset, seedPresets, updatePreset, type PresetRecord } from '@silkweave/box-core'
import { AuthGuard } from '../../../auth/auth.guard.js'
import type { PrincipalRequest } from '../../../auth/auth.decorators.js'

// Presets - the team's named lenses on Content, the CRM and Initiatives. One list per module, shared
// by everyone, editable by anyone internal. There is no such thing as a private preset and no such
// thing as a built-in one that cannot be changed (2026-08-12); storage is tenant config
// (config/presets.json), not the warehouse - see @silkweave/box-core's presets/presets.ts for why.
//
// GUARD LEVEL: any authenticated internal user, deliberately NOT admin (bare AuthGuard, the boards
// and planning-mutation precedent). A preset is an operating convention rather than configuration
// wired to credentials or data ownership, and admin-gating it would mean nobody but an admin could fix
// their own pipeline lens - which is the friction this whole surface exists to remove. Collaborators
// see none of it: a bare controller is internal-only.
//
// Concurrency is last-write-wins per preset name, attributed by `updated_by`, matching DocSave and the
// circuit boards. There is no version precondition and no 409: the loss window is two people naming
// a preset the same thing in the same minute, and the Box instance's git history is the recovery.

class PresetsDto {
  @ApiProperty() generatedAt!: string
  @ApiProperty({
    type: [String],
    description: 'Modules whose defaults have been seeded. The SPA reads this to know whether to send its seed.',
  })
  seeded!: string[]
  @ApiProperty({
    type: Object,
    description:
      'module id → its presets in the team order: {name, description, icon, state, order, updated_at, ' +
      "updated_by}. `state` is the module's own shape and is deliberately untyped here - the SPA owns " +
      'that vocabulary.',
  })
  modules!: Record<string, PresetRecord[]>
}

// The @Mcp() scalar-inputs constraint: `state` travels as a JSON object STRING, the
// `board-nodes-set` precedent.
class SavePresetDto {
  @ApiProperty({ enum: PRESET_MODULES, description: 'Which module this preset belongs to' })
  @IsString() module!: string
  @ApiProperty({ description: 'Preset name - saving over an existing one REPLACES it' })
  @IsString() name!: string
  @ApiProperty({ description: 'JSON object string of the module\'s view state, e.g. {"search":"","sort":"name"}' })
  @IsString() state!: string
  @ApiProperty({
    required: false,
    description: "Icon key from the dashboard's palette, e.g. 'rocket'. '' clears it back to the default.",
  })
  @IsOptional() @IsString() icon?: string
  @ApiProperty({ required: false, description: "One-liner shown under the name. Omit to keep the existing one; '' clears it." })
  @IsOptional() @IsString() description?: string
  @ApiProperty({ required: false, description: 'users.id performing this mutation (audit stamp; defaults to the authenticated principal)' })
  @IsOptional() @IsString() actor?: string
}

// Editing an EXISTING preset. Every field but `module`/`name` is optional and omitting one means
// "leave it alone", which is what lets the manage dialog send only what was touched - `icon: ''` is
// the explicit "back to the default", and it has to stay distinguishable from "not mentioned".
class UpdatePresetDto {
  @ApiProperty({ enum: PRESET_MODULES }) @IsString() module!: string
  @ApiProperty({ description: 'The preset to edit, by its CURRENT name' })
  @IsString() name!: string
  @ApiProperty({ required: false, description: 'New name - renames in place, refused if it collides' })
  @IsOptional() @IsString() new_name?: string
  @ApiProperty({ required: false, description: "Icon key, e.g. 'rocket'. '' clears it back to the default." })
  @IsOptional() @IsString() icon?: string
  @ApiProperty({ required: false, description: "One-liner shown under the name. '' clears it." })
  @IsOptional() @IsString() description?: string
  @ApiProperty({ required: false, description: "JSON object string of the module's view state - replaces what it shows" })
  @IsOptional() @IsString() state?: string
  @ApiProperty({ required: false, description: 'users.id performing this mutation (audit stamp; defaults to the authenticated principal)' })
  @IsOptional() @IsString() actor?: string
}

// No `actor`, on purpose: see reorderPresets - position is a property of the LIST, and stamping
// every preset with whoever dragged one would make "last saved by" lie.
class ReorderPresetsDto {
  @ApiProperty({ enum: PRESET_MODULES }) @IsString() module!: string
  @ApiProperty({ type: [String], description: 'Preset names in their new order; unmentioned ones keep their relative order at the end' })
  @IsArray() @IsString({ each: true }) names!: string[]
}

class DeletePresetDto {
  @ApiProperty({ enum: PRESET_MODULES }) @IsString() module!: string
  @ApiProperty({ description: 'Preset name to delete - shared, so it goes for everyone' })
  @IsString() name!: string
  @ApiProperty({ required: false, description: 'users.id performing this mutation (audit stamp; defaults to the authenticated principal)' })
  @IsOptional() @IsString() actor?: string
}

// The defaults arrive as a JSON ARRAY string for the same reason `state` does - one @Mcp scalar
// carrying a shape this layer has no vocabulary for.
class SeedPresetsDto {
  @ApiProperty({ enum: PRESET_MODULES }) @IsString() module!: string
  @ApiProperty({
    description:
      'JSON array string of {name, description?, icon?, state} - the module\'s built-in presets as the SPA declares them.',
  })
  @IsString() presets!: string
  @ApiProperty({
    required: false,
    enum: ['initial', 'restore'],
    description:
      "'initial' (default) does nothing once the module has been seeded; 'restore' adds back only the " +
      'names that are currently missing and never touches an existing preset.',
  })
  @IsOptional() @IsIn(['initial', 'restore']) mode?: 'initial' | 'restore'
  @ApiProperty({ required: false, description: 'users.id performing this mutation (audit stamp; defaults to the authenticated principal)' })
  @IsOptional() @IsString() actor?: string
}

/** The `state` string as an object, or a 400 that says which of the two ways it was wrong. */
function parseState(raw: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new BadRequestException('state must be a JSON object string, e.g. {"search":"","sort":"name"}')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BadRequestException('state must be a JSON OBJECT string - a preset is a record of axes')
  }
  return parsed as Record<string, unknown>
}

@Controller('presets')
@UseGuards(AuthGuard)
export class PresetsController {
  /**
   * tRPC query `presetsList` / MCP `presets` - every module's presets in one payload, plus which
   * modules have been seeded. All three modules come back together because the file is one file and a
   * few kB: a per-module read would buy one round trip's worth of nothing and give the SPA three
   * stores to keep in step.
   */
  @Get()
  @ApiOkResponse({ type: PresetsDto })
  @Trpc()
  @Mcp({ name: 'presets' })
  list(): PresetsDto {
    const file = readPresetsFile()
    return { generatedAt: new Date().toISOString(), seeded: file.seeded, modules: file.modules }
  }

  /**
   * tRPC mutation `presetsSave` / MCP `preset-save` - create or overwrite one named preset.
   * Overwrite IS the feature ("save changes to this preset"), so this is an upsert by name.
   */
  @Post()
  @ApiOkResponse({ type: PresetsDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'preset-save' })
  save(@Body() body: SavePresetDto, @Req() req: PrincipalRequest): PresetsDto {
    try {
      savePreset(
        body.module,
        body.name,
        parseState(body.state),
        body.actor ?? req.principal?.id,
        body.icon,
        body.description,
      )
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : String(e))
    }
    return this.list()
  }

  /**
   * tRPC mutation `presetsUpdate` / MCP `preset-update` - edit one existing preset's title, one-liner,
   * icon or state in place, keeping its position in the list.
   *
   * Separate from `save` because `name` is the identity: a title change through the upsert would
   * create a second preset and leave the original behind. Renaming onto a name that is already taken
   * is refused rather than merged - one of the two presets' state would have to lose.
   */
  @Post('update')
  @ApiOkResponse({ type: PresetsDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'preset-update' })
  update(@Body() body: UpdatePresetDto, @Req() req: PrincipalRequest): PresetsDto {
    try {
      updatePreset(
        body.module,
        body.name,
        {
          name: body.new_name,
          description: body.description,
          icon: body.icon,
          state: body.state === undefined ? undefined : parseState(body.state),
        },
        body.actor ?? req.principal?.id,
      )
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : String(e))
    }
    return this.list()
  }

  /**
   * tRPC mutation `presetsReorder` / MCP `preset-reorder` - the team's own order for one module's
   * presets, which is what the preset bar and the sidebar both read top to bottom.
   */
  @Post('reorder')
  @ApiOkResponse({ type: PresetsDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'preset-reorder' })
  reorder(@Body() body: ReorderPresetsDto): PresetsDto {
    try {
      reorderPresets(body.module, body.names)
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : String(e))
    }
    return this.list()
  }

  /**
   * tRPC mutation `presetsDelete` / MCP `preset-delete` - remove one named preset. Shared means
   * shared: it goes for the whole team. Deleting a name that is not there succeeds silently.
   */
  @Post('delete')
  @ApiOkResponse({ type: PresetsDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'preset-delete' })
  delete(@Body() body: DeletePresetDto): PresetsDto {
    try {
      deletePreset(body.module, body.name)
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : String(e))
    }
    return this.list()
  }

  /**
   * tRPC mutation `presetsSeed` / MCP `preset-seed` - install a module's built-in presets.
   *
   * The defaults live in the SPA because `state` is its vocabulary, so the SPA is what sends them:
   * every board load fires this with `mode: 'initial'`, which is a no-op the moment the module is in
   * `seeded`. The flag - not "the list is empty" - is the guard, so deleting every preset in a module
   * stays deleted rather than being helpfully undone on the next page load.
   */
  @Post('seed')
  @ApiOkResponse({ type: PresetsDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'preset-seed' })
  seed(@Body() body: SeedPresetsDto, @Req() req: PrincipalRequest): PresetsDto {
    let parsed: unknown
    try {
      parsed = JSON.parse(body.presets)
    } catch {
      throw new BadRequestException('presets must be a JSON array string of {name, description?, icon?, state}')
    }
    if (!Array.isArray(parsed)) throw new BadRequestException('presets must be a JSON ARRAY string')
    try {
      seedPresets(
        body.module,
        parsed.map((p) => {
          const entry = (p ?? {}) as { name?: unknown; description?: unknown; icon?: unknown; state?: unknown }
          if (typeof entry.name !== 'string' || !entry.state || typeof entry.state !== 'object') {
            throw new Error('each preset needs a name and a state object')
          }
          return {
            name: entry.name,
            description: typeof entry.description === 'string' ? entry.description : null,
            icon: typeof entry.icon === 'string' ? entry.icon : null,
            state: entry.state as Record<string, unknown>,
          }
        }),
        body.mode ?? 'initial',
        body.actor ?? req.principal?.id,
      )
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : String(e))
    }
    return this.list()
  }
}

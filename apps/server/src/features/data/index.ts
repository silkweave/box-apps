import { Module } from '@nestjs/common'
import { defineServerFeature } from '../../feature.js'
import { WarehouseModule } from './warehouse/warehouse.module.js'
import { IngestModule } from './ingest/ingest.module.js'
import { SignalsController } from './signals/signals.controller.js'
import { SourcesController } from './sources/sources.controller.js'
import { BoardsController } from './boards/boards.controller.js'
import { PresetsController } from './presets/presets.controller.js'
import { MaintenanceController } from './maintenance/maintenance.controller.js'

/** Signals, sources, pulls, circuit boards, presets, the warehouse's own tools, and the
 *  stealth-browser / Reddit-session diagnostics.
 *
 *  `MaintenanceController` was `apps/server/src/maintenance/` - a CORE directory - until
 *  2026-09-13, while every action in it calls data's reddit and CDP code. A core-only Box did not
 *  compile because of it. */
@Module({
  imports: [WarehouseModule, IngestModule],
  controllers: [SignalsController, SourcesController, BoardsController, PresetsController, MaintenanceController],
})
class DataModule {}

export default defineServerFeature({
  id: 'data',
  module: DataModule,
  // Corrected 2026-09-13: this list declared `CDP_URL` and `GITHUB_TOKEN`, and NO code read either
  // name. The browser pulls read CHROMATRIX_* (features/data/cdp.ts) and the github pulls take a
  // per-account token out of config/credentials.json, not the environment.
  env: [
    { name: 'CHROMATRIX_URL', doc: 'Stealth-browser (chromatrix) endpoint the browser pulls drive; defaults to http://127.0.0.1:8830' },
    { name: 'CHROMATRIX_IDENTITY', doc: 'Which logged-in browser profile the pulls borrow when a caller names none; defaults to "default"' },
    { name: 'CHROMATRIX_TOKEN', doc: 'Bearer for chromatrix; falls back to the token file cdp.ts names' },
  ],
})

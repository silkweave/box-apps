import { defineServerFeature } from '../../feature.js'
import { SinkModule } from './sink/sink.module.js'

/** The sink of markdown notes. */
export default defineServerFeature({ id: 'sink', module: SinkModule })

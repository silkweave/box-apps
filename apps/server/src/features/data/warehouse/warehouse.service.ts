import { Injectable } from '@nestjs/common'
import { withRead } from '@silkweave/box-core'

/**
 * Read-only access to the DuckDB warehouse for the dashboard. Delegates to @silkweave/box-core's `withRead`,
 * which opens an ephemeral read-only connection per query (with retry-on-lock) and closes it - so
 * the server never holds the file lock. Ingest writes (also ephemeral, serialized + retried) and
 * the read-only `warehouse` MCP server can all open the file in between. Rows come back JSON-safe.
 */
@Injectable()
export class WarehouseService {
  async query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
    return withRead<T>(sql)
  }
}

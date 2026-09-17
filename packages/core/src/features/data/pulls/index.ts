// Ingest actions - each pull/backfill defined once here as a streaming async generator. The server
// exposes them over tRPC + MCP, and the CLI proxy invokes them over /mcp. The warehouse (DuckDB) is
// the ground truth: pulls UPSERT snapshots + re-derive signals; backfills write history rows.
export { persist } from './types.js'
export * from './reddit-client.js'
export * from './github.js'
export * from './x.js'
export * from './reddit.js'
export * from './linkedin.js'
export * from './linkedin-client.js'
export * from './npm.js'
export * from './blog.js'
export * from './hackernews.js'
export * from './substack.js'
export * from './substack-client.js'
export * from './substack-session.js'

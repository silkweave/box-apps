#!/usr/bin/env node
// `pnpm dev` for the pair: keep the mirror live while Vite and Nest watch it.
//
// The mirror is written in place (chmod +w, write, chmod -w), so a watcher sees a `change` event
// rather than unlink+add and HMR behaves the way it does in box. Edit the truth at this root; the
// copy inside box/ is a build artifact with the write bit off.

import { spawn } from 'node:child_process'
import { watch } from 'node:fs'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { FAMILIES, box, compose, mirror, root } from './compose.ts'

compose()
console.log('dev: mirror composed; watching the four app directory families')

let pending: NodeJS.Timeout | undefined
const resync = () => {
  clearTimeout(pending)
  pending = setTimeout(() => {
    const s = mirror()
    if (s.copied || s.deleted) console.log(`dev: mirror ${s.copied} copied, ${s.deleted} removed`)
  }, 40)
}

for (const family of FAMILIES) {
  const dir = join(root, family)
  if (!existsSync(dir) || !statSync(dir).isDirectory()) continue
  watch(dir, { recursive: true }, resync)
}

const child = spawn('sh', ['-c', "pnpm -r --parallel --filter '@silkweave/box-server' --filter '@silkweave/box-web' run dev"], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, PATH: `${join(box, 'node_modules', '.bin')}:${process.env.PATH ?? ''}` },
})
child.on('exit', (code) => process.exit(code ?? 0))

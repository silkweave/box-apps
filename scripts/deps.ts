#!/usr/bin/env node
// The ten apps' npm dependencies, and where they are allowed to live.
//
//   pnpm deps           rewrite this root package.json's dependency blocks
//   pnpm deps --check   fail if they are stale, or if an app imports what it does not declare
//
// WHY HERE AND NOT IN THE SUBMODULE. Session 5 pruned the apps' 27 packages out of
// packages/core, apps/server and apps/web. Those three package.json files are tracked files of the
// `box` repo now, so writing them would dirty the submodule - exactly what the CI guard fails on,
// and the one direction of truth the split exists to protect. Instead the union of the apps'
// declarations lands on THIS manifest at the workspace root. Resolution from a real file at
// box/apps/web/src/features/crm/x.tsx walks box/apps/web/node_modules (core's deps), then
// box/node_modules, then box-apps/node_modules (the apps' deps). Nothing is hoisted or overridden.
//
// THE TOOLCHAIN IS NOT COPIED HERE. Declaring box's root devDependencies on this manifest
// re-resolves the tree; a fresh resolution picked typescript@7.0.2 for @swc-node/register (peer
// range ">= 4.3 < 7", pnpm only warns), which has no JS API, and typegen, schema:check and five
// server tests died with "Cannot read properties of undefined (reading 'Js')". Scripts prepend
// box/node_modules/.bin to PATH instead.
//
// A USER'S BOX IS THE OTHER PROJECTION. `box adopt` writes the same deps.json specs into the
// adopting Box's own apps/web/package.json, which that Box owns. Same declared source, same spec
// strings, two destinations.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appIds, box, root } from './compose.ts'
import { TREES, declarationOf, packageOf, runtimeOf, scanPackage, withTypesPackages } from '../box/packages/cli/src/deps.ts'

const BLOCKS = ['dependencies', 'devDependencies'] as const
const PKGS = ['packages/core', 'apps/server', 'apps/web'] as const

const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'))

/** packageName -> {spec, block, owners}, the union across every app and all three trees. */
export const declaredUnion = () => {
  const out = new Map<string, { spec: string; block: (typeof BLOCKS)[number]; owners: string[] }>()
  for (const id of appIds()) {
    const decl = declarationOf(id, root)
    for (const pkg of PKGS) {
      for (const block of BLOCKS) {
        for (const [name, spec] of Object.entries(decl[pkg]?.[block] ?? {})) {
          const seen = out.get(name)
          if (seen && seen.spec !== spec) {
            throw new Error(
              `${name} is declared at two different specs: ${seen.spec} by ${seen.owners.join(', ')} and ${spec} by ${id}.\n` +
                '  One version of a package, or the apps disagree about it on every Box that adopts both.',
            )
          }
          // devDependencies only win when nothing declares the package as a runtime dependency.
          if (seen && seen.block === 'dependencies') { seen.owners.push(id); continue }
          out.set(name, { spec, block, owners: [...(seen?.owners ?? []), id] })
        }
      }
    }
  }
  return out
}

const manifestBlocks = () => {
  const union = declaredUnion()
  const blocks: Record<string, Record<string, string>> = { dependencies: {}, devDependencies: {} }
  for (const [name, { spec, block }] of [...union].sort(([a], [b]) => a.localeCompare(b))) blocks[block][name] = spec
  return blocks
}

const manifest = () => {
  const boxPkg = readJson(join(box, 'package.json'))
  const b = manifestBlocks()
  return {
    name: 'silkweave-box-apps',
    private: true,
    version: '0.1.0',
    type: 'module',
    packageManager: boxPkg.packageManager,
    engines: boxPkg.engines,
    scripts: readJson(join(root, 'package.json')).scripts,
    dependencies: b.dependencies,
    devDependencies: b.devDependencies,
  }
}

/**
 * Rule 3': an app imports a package that resolves at this root but that the app does not declare.
 * It works here and breaks on a user's Box that adopts only that app. box's own rule 3 cannot see
 * this case, because on a user's Box the specs live in that Box's own manifests.
 */
const undeclaredImports = () => {
  const bad: string[] = []
  const ids = appIds()
  for (const pkg of PKGS) {
    const pkgManifest = readJson(join(box, pkg, 'package.json'))
    const scan = withTypesPackages(scanPackage(pkg, box), pkgManifest)
    const coreOwned = new Set([...Object.keys(pkgManifest.dependencies ?? {}), ...Object.keys(pkgManifest.devDependencies ?? {})])
    for (const [dep, owners] of scan.byFeature) {
      if (coreOwned.has(dep) || scan.inCore.has(dep)) continue
      // deps.ts's SPECIFIER_RE is deliberately loose and matches prose in comments; only judge
      // specifiers that actually resolve to an installed package.
      if (!existsSync(join(root, 'node_modules', dep)) && !existsSync(join(box, pkg, 'node_modules', dep))) continue
      for (const id of owners) {
        if (!ids.includes(id)) continue
        const declared = declarationOf(id, root)[pkg] ?? {}
        const has = BLOCKS.some((b) => Object.keys(declared[b] ?? {}).includes(dep) || Object.keys(declared[b] ?? {}).includes(runtimeOf(dep) ?? ''))
        if (!has) bad.push(`${id} imports ${dep} in ${pkg} but does not declare it in features/${id}/deps.json`)
      }
    }
  }
  return bad
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const check = process.argv.includes('--check')
  const target = join(root, 'package.json')
  const next = `${JSON.stringify(manifest(), null, 2)}\n`
  const current = existsSync(target) ? readFileSync(target, 'utf8') : ''
  if (check) {
    const problems = current === next ? [] : ['package.json is stale: run `pnpm deps`']
    problems.push(...undeclaredImports())
    if (problems.length) { console.error(problems.map((p) => `  ${p}`).join('\n')); process.exit(1) }
    const n = declaredUnion().size
    console.log(`deps: package.json current, ${n} app packages, no undeclared imports`)
  } else {
    writeFileSync(target, next)
    console.log(`deps: wrote ${declaredUnion().size} app packages to package.json`)
  }
}
export { manifest, undeclaredImports, packageOf, TREES }

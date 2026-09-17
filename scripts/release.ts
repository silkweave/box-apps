#!/usr/bin/env node
// Cut an app release: `pnpm release <id> <version>`.
//
// The tag is the only thing in the registry index that MUST exist in this repo: `box adopt` does a
// shallow sparse clone at `<id>-v<version>` and copies the four directories out of it. Because the
// truth is plain tracked files at the conventional paths, the tag's tree is already exactly what
// adopt wants; the gitlink and .gitmodules sit outside the four sparse patterns and are never
// initialised by an adopting Box.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { appIds, root } from './compose.ts'
import { tagFor } from '../box/packages/cli/src/registry.ts'

const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
const die = (message: string): never => { console.error(message); process.exit(1) }

const [id, version] = process.argv.slice(2)
if (!id || !version) die('usage: pnpm release <id> <version>')
if (!appIds().includes(id)) die(`"${id}" is not an app in this repo (${appIds().join(', ')})`)
if (!/^\d+\.\d+\.\d+$/.test(version)) die(`"${version}" is not a plain release version; adopt refuses prereleases and build metadata`)

const tag = tagFor(id, version)
if (git(['tag', '--list', tag])) die(`${tag} already exists. A published tag is what users fetch: never move one, cut the next version instead.`)
if (git(['status', '--porcelain'])) die('the working tree is dirty; commit or stash first')

const changelog = join(root, 'features', id, 'CHANGELOG.md')
if (!existsSync(changelog)) die(`features/${id}/CHANGELOG.md is missing. An adopted app has no update path, so the changelog is the only way a team can see what changed and apply it by hand.`)
const entry = new RegExp(`^## ${version.replace(/\./g, '\\.')}\\b`, 'm')
if (!entry.test(readFileSync(changelog, 'utf8'))) die(`features/${id}/CHANGELOG.md has no "## ${version}" section. Write it before tagging.`)

const appJson = join(root, 'features', id, 'app.json')
const app = JSON.parse(readFileSync(appJson, 'utf8'))
writeFileSync(appJson, `${JSON.stringify({ ...app, version }, null, 2)}\n`)
execFileSync('node', [join(root, 'scripts', 'registry.ts')], { cwd: root, stdio: 'inherit' })

git(['add', `features/${id}/app.json`, 'registry.json'])
git(['commit', '-m', `release(${id}): ${version}`])
git(['tag', '-a', tag, '-m', `${id} ${version}`])
console.log(`release: committed and tagged ${tag}. Push with: git push origin master ${tag}`)

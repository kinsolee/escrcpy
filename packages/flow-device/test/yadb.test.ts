import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveYadbPath } from '../src/index.js'

describe('resolveYadbPath', () => {
  it('prefers an explicit path, then YADB_PATH; empty strings disable yadb', () => {
    expect(resolveYadbPath('/x/yadb', { YADB_PATH: '/env/yadb' })).toBe('/x/yadb')
    expect(resolveYadbPath('', { YADB_PATH: '/env/yadb' })).toBe('')
    expect(resolveYadbPath(undefined, { YADB_PATH: '/env/yadb' })).toBe('/env/yadb')
    expect(resolveYadbPath(undefined, { YADB_PATH: '' })).toBe('')
  })

  it('finds the copy shipped beside agent.mjs and the workspace copy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'flow-yadb-'))
    const shipped = join(root, 'extra', 'common')
    await mkdir(join(shipped, 'yadb'), { recursive: true })
    await mkdir(join(shipped, 'flow-mcp'), { recursive: true })
    await writeFile(join(shipped, 'yadb', 'yadb'), '')
    expect(resolveYadbPath(undefined, {}, join(shipped, 'flow-mcp'))).toBe(join(shipped, 'yadb', 'yadb'))

    const repo = join(root, 'repo')
    const bundled = join(repo, 'desktop', 'electron', 'resources', 'extra', 'common', 'yadb')
    await mkdir(bundled, { recursive: true })
    await mkdir(join(repo, 'packages', 'flow-device', 'dist'), { recursive: true })
    await writeFile(join(bundled, 'yadb'), '')
    expect(resolveYadbPath(undefined, {}, join(repo, 'packages', 'flow-device', 'dist'))).toBe(join(bundled, 'yadb'))
  })
})

import { existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BUNDLED = join('extra', 'common', 'yadb', 'yadb')
const REPO_BUNDLED = join('desktop', 'electron', 'resources', BUNDLED)

/** Packaged Escrcpy installs whose bundled yadb the CLI and external agents can borrow. */
const INSTALLED = [
  join('/Applications', 'Escrcpy.app', 'Contents', 'Resources', BUNDLED),
  join('/opt', 'Escrcpy', 'resources', BUNDLED),
]

/**
 * yadb binary for callers outside the desktop app (CLI, standalone agent.mjs):
 * an explicit path wins and `''` disables yadb; otherwise YADB_PATH, then the
 * copy shipped next to the code (agent.mjs lives in extra/common/flow-mcp, the
 * binary in extra/common/yadb), the workspace copy, and finally an installed app.
 * Without it every dump falls back to uiautomator, which is ~4x slower.
 */
export function resolveYadbPath(explicit?: string, env: NodeJS.ProcessEnv = process.env, from: string = moduleDir()): string {
  if (explicit !== undefined)
    return explicit
  if (env.YADB_PATH !== undefined)
    return env.YADB_PATH
  return yadbCandidates(from).find(isFile) ?? ''
}

export function yadbCandidates(from: string): string[] {
  const candidates = [join(from, '..', 'yadb', 'yadb')]
  for (let dir = from; ; dir = dirname(dir)) {
    candidates.push(join(dir, REPO_BUNDLED))
    if (dirname(dir) === dir)
      break
  }
  return [...candidates, ...INSTALLED]
}

function moduleDir(): string {
  try {
    return dirname(fileURLToPath(import.meta.url))
  }
  catch {
    return process.cwd()
  }
}

function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile()
  }
  catch {
    return false
  }
}

import { HealError } from '../heal.js'
import { runPlaybookDefinition } from './runtime.js'
import type { PlaybookDefinition, PlaybookOptions, PlaybookResult } from './runtime.js'
import { tiktokShopLinks } from './tiktok-shop-links.js'

export * from './runtime.js'
export * from './tiktok-shop-links.js'

/** Built-in playbooks by id. Add new ones here. */
export const PLAYBOOKS: Readonly<Record<string, PlaybookDefinition>> = {
  [tiktokShopLinks.id]: tiktokShopLinks,
}

export function listPlaybooks(): Array<{ id: string, description: string, allowedPackages: string[] }> {
  return Object.values(PLAYBOOKS).map(({ id, description, allowedPackages }) => ({ id, description, allowedPackages }))
}

/** Runs a built-in playbook by id (or a custom definition). */
export function runPlaybook(playbook: string | PlaybookDefinition, options: PlaybookOptions): Promise<PlaybookResult> {
  const definition = typeof playbook === 'string' ? PLAYBOOKS[playbook] : playbook
  if (!definition)
    throw new HealError(`unknown playbook "${String(playbook)}"; available: ${Object.keys(PLAYBOOKS).join(', ')}`)
  return runPlaybookDefinition(definition, options)
}

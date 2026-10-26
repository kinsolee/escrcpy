import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseUiTree } from '../src/ui-tree.js'

export function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8')
}

export function fixtureTree(name: string) {
  return parseUiTree(fixture(name))
}

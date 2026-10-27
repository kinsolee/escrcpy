import { readFile, writeFile } from 'node:fs/promises'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { flowSchema } from './schema.js'
import type { FlowScript } from './schema.js'

export function parseFlow(source: string): FlowScript {
  const value: unknown = parseYaml(source)
  return flowSchema.parse(value)
}

export function stringifyFlow(flow: FlowScript): string {
  return stringifyYaml(flowSchema.parse(flow), { indent: 2, lineWidth: 120 })
}

export async function readFlow(path: string): Promise<FlowScript> {
  return parseFlow(await readFile(path, 'utf8'))
}

export async function writeFlow(path: string, flow: FlowScript): Promise<void> {
  await writeFile(path, stringifyFlow(flow), 'utf8')
}

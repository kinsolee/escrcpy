#!/usr/bin/env node
import { writeFile } from 'node:fs/promises'
import process from 'node:process'
import { parseArgs } from 'node:util'
import adbkit from '@devicefarmer/adbkit'
import { createAdbx } from '@escrcpy/adbx'
import type { Selector, Target, UiElement } from '@escrcpy/flow-device'
import { createFlowDevice, FlowDeviceError } from '@escrcpy/flow-device'

const HELP = `flow — record once, replay without a model (M0: device commands only)

Usage: flow <command> [options]

Commands:
  devices                       List connected devices
  dump [--xml] [--json]         Dump the screen and list its elements
  find <selector>               List elements matching a selector
  tap  <selector> | --x --y     Tap an element, or a 0~1 ratio point
  wait <selector> [--timeout]   Wait until an element appears
  text <string>                 Type into the focused field
  key  <name|code>              Send a key event (HOME, BACK, ENTER, …)
  screenshot -o <file>          Save a JPEG screenshot

Selector options:
  --text <s>  --desc <s>  --id <s>  --class <s>  --exact  --index <n>

Common options:
  -s, --serial <serial>   Device (default: ANDROID_SERIAL, or the only device)
  --no-yadb               Use plain adb even when YADB_PATH is set

Environment:
  ADB_PATH    adb binary (default: adb on PATH)
  YADB_PATH   yadb binary, enables faster dumps and Unicode input
`

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'serial': { type: 'string', short: 's' },
    'text': { type: 'string' },
    'desc': { type: 'string' },
    'id': { type: 'string' },
    'class': { type: 'string' },
    'exact': { type: 'boolean' },
    'index': { type: 'string' },
    'x': { type: 'string' },
    'y': { type: 'string' },
    'timeout': { type: 'string' },
    'output': { type: 'string', short: 'o' },
    'xml': { type: 'boolean' },
    'json': { type: 'boolean' },
    'no-yadb': { type: 'boolean' },
    'help': { type: 'boolean', short: 'h' },
  },
})

function selectorFromArgs(): Selector | undefined {
  const selector: Selector = {}
  if (values.text)
    selector.text = values.text
  if (values.desc)
    selector.content_desc = values.desc
  if (values.id)
    selector.resource_id = values.id
  if (values.class)
    selector.class_name = values.class
  if (values.exact)
    selector.exact = true
  if (values.index !== undefined)
    selector.index = Number(values.index)
  return Object.keys(selector).length ? selector : undefined
}

function targetFromArgs(): Target {
  if (values.x !== undefined || values.y !== undefined)
    return { x: Number(values.x), y: Number(values.y) }
  const selector = selectorFromArgs()
  if (!selector)
    throw new Error('Give a selector (--text/--desc/--id/--class) or --x and --y')
  return selector
}

function formatElement(e: UiElement): string {
  const flags = [
    e.clickable && 'clickable',
    e.scrollable && 'scrollable',
    e.focused && 'focused',
    e.checked && 'checked',
    e.selected && 'selected',
    e.enabled === false && 'disabled',
  ].filter(Boolean).join(',')
  const label = [
    e.text && `text=${JSON.stringify(e.text)}`,
    e.contentDesc && `desc=${JSON.stringify(e.contentDesc)}`,
    e.resourceId && `id=${e.resourceId}`,
  ].filter(Boolean).join(' ')
  return `#${String(e.id).padEnd(4)} ${e.type.padEnd(14)} (${e.centerX},${e.centerY}) ${label}${flags ? `  [${flags}]` : ''}`
}

async function main() {
  const command = positionals[0]
  if (!command || values.help) {
    process.stdout.write(HELP)
    return
  }

  // adbkit is CommonJS, so take Adb off the default export.
  const adb = adbkit.Adb.createClient(process.env.ADB_PATH ? { bin: process.env.ADB_PATH } : {})
  const adbx = createAdbx({ adb: adb as never, yadbPath: values['no-yadb'] ? '' : process.env.YADB_PATH })
  const device = createFlowDevice({ adbx })

  if (command === 'devices') {
    for (const d of await adbx.getDevices())
      console.log(`${d.id}\t${d.type}`)
    return
  }

  const serial = values.serial ?? process.env.ANDROID_SERIAL ?? await (async () => {
    const online = (await adbx.getDevices()).filter(d => d.type === 'device')
    if (online.length === 1)
      return online[0].id
    throw new Error(online.length ? `${online.length} devices connected; pick one with --serial` : 'No device connected')
  })()
  const via = adbx.yadb.isAvailable() ? 'yadb' : 'uiautomator'

  switch (command) {
    case 'dump': {
      const snap = await device.snapshot(serial)
      if (values.xml) {
        process.stdout.write(snap.xml)
        return
      }
      const elements = device.elements(snap)
      if (values.json) {
        console.log(JSON.stringify({ snapshotId: snap.id, app: snap.app, size: snap.tree.size, elements }, null, 2))
        return
      }
      console.log(`${snap.id}  ${snap.app ? `${snap.app.package}/${snap.app.activity}` : 'unknown app'}  ${snap.tree.size.width}x${snap.tree.size.height}  ${snap.tree.nodes.length} nodes, ${elements.length} elements  dump ${snap.dumpMs} ms via ${via}`)
      for (const e of elements)
        console.log(formatElement(e))
      return
    }
    case 'find': {
      const selector = selectorFromArgs()
      if (!selector)
        throw new Error('Give a selector (--text/--desc/--id/--class)')
      const { snapshot, matches } = await device.find(serial, selector, 'fresh')
      console.log(`${matches.length} match(es) in ${snapshot.id}`)
      for (const node of matches)
        console.log(`#${node.id} ${node.className} text=${JSON.stringify(node.text)} desc=${JSON.stringify(node.contentDesc)} id=${node.resourceId} bounds=[${node.bounds.left},${node.bounds.top}][${node.bounds.right},${node.bounds.bottom}]`)
      return
    }
    case 'tap': {
      const started = Date.now()
      const result = await device.tap(serial, targetFromArgs(), { snapshot: 'fresh' })
      const what = result.node ? `${result.node.className} ${JSON.stringify(result.node.text || result.node.contentDesc || result.node.resourceId)} (${result.matchCount} match)` : 'point'
      console.log(`tapped ${what} at (${result.point.x},${result.point.y}) = ratio (${result.ratio.x},${result.ratio.y}) in ${Date.now() - started} ms`)
      return
    }
    case 'wait': {
      const selector = selectorFromArgs()
      if (!selector)
        throw new Error('Give a selector (--text/--desc/--id/--class)')
      const result = await device.waitFor(serial, selector, { timeoutMs: values.timeout ? Number(values.timeout) : 10_000 })
      console.log(result.found
        ? `found after ${result.attempts} dump(s), ${result.elapsedMs} ms`
        : `not found after ${result.attempts} dump(s), ${result.elapsedMs} ms`)
      process.exitCode = result.found ? 0 : 1
      return
    }
    case 'text': {
      await device.inputText(serial, positionals.slice(1).join(' '))
      return
    }
    case 'key': {
      const code = await device.key(serial, positionals[1] ?? '')
      console.log(`sent key ${code}`)
      return
    }
    case 'screenshot': {
      if (!values.output)
        throw new Error('Give an output file with -o')
      const image = await device.screenshot(serial)
      await writeFile(values.output, image.data)
      console.log(`saved ${values.output} (${image.width}x${image.height}, from ${image.sourceWidth}x${image.sourceHeight})`)
      return
    }
    default:
      throw new Error(`Unknown command: ${command}. Run flow --help.`)
  }
}

main().catch((error) => {
  if (error instanceof FlowDeviceError && error.code === 'NOT_FOUND') {
    console.error(error.message)
    console.error('Visible elements:')
    for (const line of (error.details?.visible as string[] | undefined) ?? [])
      console.error(`  ${line}`)
  }
  else {
    console.error(error instanceof Error ? error.message : error)
  }
  process.exitCode = 1
})

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseUiTree } from '@escrcpy/flow-device'
import { afterEach, describe, expect, it } from 'vitest'
import { buildXlsx, extractRows, replayFlow } from '../src/index.js'

const node = (attrs: Record<string, string | boolean>, children = '') =>
  `<node ${Object.entries({ 'text': '', 'resource-id': '', 'class': 'android.widget.LinearLayout', 'clickable': 'false', 'bounds': '[0,0][100,100]', ...attrs }).map(([k, v]) => `${k}="${v}"`).join(' ')}>${children}</node>`

const text = (value: string, id: string, bounds = '[0,0][100,40]') => node({ 'text': value, 'resource-id': id, 'class': 'android.widget.TextView', bounds })

const SETTINGS_XML = `<hierarchy rotation="0">${node({ bounds: '[0,0][1080,2400]' }, node({ 'resource-id': 'x:id/list', 'class': 'androidx.RecyclerView', 'bounds': '[0,0][1080,2400]' }, [
  node({ bounds: '[0,0][1080,100]' }, text('Internet', 'android:id/title')),
  node({ clickable: 'true', bounds: '[0,100][1080,300]' }, text('Wi-Fi', 'android:id/title') + text('Network &amp; internet &gt; Internet', 'x:id/breadcrumb')),
  node({ clickable: 'true', bounds: '[0,300][1080,500]' }, text('Wi-Fi calling', 'android:id/title')),
  node({ clickable: 'true', bounds: '[0,500][0,500]' }, text('Hidden', 'android:id/title')),
].join('')))}</hierarchy>`

const spec = {
  list: { resource_id: 'x:id/list' },
  columns: { title: { resource_id: 'android:id/title' }, path: { resource_id: 'x:id/breadcrumb' } },
}

let dir: string | undefined
afterEach(async () => {
  if (dir)
    await rm(dir, { recursive: true, force: true })
  dir = undefined
})

describe('extractRows', () => {
  const tree = parseUiTree(SETTINGS_XML)

  it('reads one row per list child and decodes entities', () => {
    expect(extractRows(tree, { ...spec, row_clickable: true })).toEqual([
      { title: 'Wi-Fi', path: 'Network & internet > Internet' },
      { title: 'Wi-Fi calling', path: '' },
    ])
  })

  it('keeps section headers unless rows must be clickable', () => {
    expect(extractRows(tree, spec).map(row => row.title)).toEqual(['Internet', 'Wi-Fi', 'Wi-Fi calling'])
  })

  it('drops rows missing a required column', () => {
    expect(extractRows(tree, { ...spec, require: ['title', 'path'] }).map(row => row.title)).toEqual(['Wi-Fi'])
  })

  it('reads the whole screen as one row when no list is given', () => {
    const columns = { title: { resource_id: 'android:id/title' }, path: { resource_id: 'x:id/breadcrumb' } }
    expect(extractRows(tree, { columns })).toEqual([{ title: 'Internet', path: 'Network & internet > Internet' }])
    expect(extractRows(tree, { columns: { missing: { resource_id: 'x:id/nope' } } })).toEqual([])
  })

  it('rejects a missing list and unknown required columns', () => {
    expect(() => extractRows(tree, { ...spec, list: { resource_id: 'x:id/nope' } })).toThrow(/list container not found/)
    expect(() => extractRows(tree, { ...spec, require: ['nope'] })).toThrow(/unknown columns/)
  })
})

describe('buildXlsx', () => {
  it('produces a zip whose sheet contains the cells', () => {
    const buffer = buildXlsx([{ key: 'title', label: 'Title' }], [{ title: 'a < b & "c"' }, { title: 3 }])
    expect(buffer.subarray(0, 2).toString()).toBe('PK')
    const body = buffer.toString('latin1')
    expect(body).toContain('xl/worksheets/sheet1.xml')
    expect(body).toContain('a &lt; b &amp; &quot;c&quot;')
    expect(body).toContain('<v>3</v>')
  })
})

describe('replay extract step', () => {
  const tree = parseUiTree(SETTINGS_XML)
  const device = {
    waitFor: async () => ({ found: true }) as never,
    tap: async () => ({}) as never,
    inputText: async () => ({}) as never,
    key: async () => ({}) as never,
    swipe: async () => ({}) as never,
    snapshot: async () => ({ id: 'snap_1', serial: 's', createdAt: 0, tree, xml: '' }) as never,
  }
  const flow = (output: string) => ({
    version: 1 as const,
    name: 'extract-demo',
    vars: {},
    defaults: { settle: 0 },
    interrupts: [],
    steps: [{ id: 'read', do: 'extract' as const, with: { ...spec, row_clickable: true, output } }],
  })

  it('reports rows and writes json and xlsx outputs', async () => {
    dir = await mkdtemp(join(tmpdir(), 'flow-extract-'))
    const json = await replayFlow(flow('rows.json'), { serial: 's', device, outputDir: dir })
    expect(json.status).toBe('completed')
    expect(json.outputs?.read.rows).toHaveLength(2)
    expect(JSON.parse(await readFile(join(dir, 'rows.json'), 'utf8'))).toEqual(json.outputs?.read.rows)

    const xlsx = await replayFlow(flow('rows.xlsx'), { serial: 's', device, outputDir: dir })
    expect((await readFile(xlsx.outputs!.read.file!)).subarray(0, 2).toString()).toBe('PK')
  })

  it('refuses outputs outside the output directory', async () => {
    dir = await mkdtemp(join(tmpdir(), 'flow-extract-'))
    const report = await replayFlow(flow('../escape.json'), { serial: 's', device, outputDir: dir })
    expect(report.status).toBe('failed')
    expect(report.error).toMatch(/must stay inside/)
  })
})

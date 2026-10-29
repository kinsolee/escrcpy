import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface XlsxColumn {
  key: string
  label?: string
}

const encoder = new TextEncoder()

const CRC_TABLE = (() => {
  const table: number[] = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++)
      c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    table.push(c >>> 0)
  }
  return table
})()

function crc32(data: Uint8Array): number {
  let c = 0xFFFFFFFF
  for (const byte of data)
    c = CRC_TABLE[(c ^ byte) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}

function escapeXml(value: unknown): string {
  // Strip characters XML 1.0 forbids, then escape the markup characters.
  return String(value ?? '').replace(/[\u0000-\u0008\v\f\u000E-\u001F]/g, '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

function columnName(index: number): string {
  let name = ''
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26))
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name
  return name
}

function cell(value: unknown, ref: string, style = ''): string {
  const s = style ? ` s="${style}"` : ''
  if (typeof value === 'number' && Number.isFinite(value))
    return `<c r="${ref}"${s}><v>${value}</v></c>`
  return `<c r="${ref}" t="inlineStr"${s}><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`
}

function sheetXml(columns: XlsxColumn[], rows: Record<string, unknown>[]): string {
  const header = columns.map((col, i) => cell(col.label ?? col.key, `${columnName(i)}1`, '1')).join('')
  const body = rows.map((row, r) => {
    const cells = columns.map((col, i) => cell(row[col.key], `${columnName(i)}${r + 2}`)).join('')
    return `<row r="${r + 2}">${cells}</row>`
  }).join('')
  const widths = columns.map((col, i) => {
    const longest = Math.max((col.label ?? col.key).length, ...rows.map(row => String(row[col.key] ?? '').length))
    return `<col min="${i + 1}" max="${i + 1}" width="${Math.min(60, Math.max(12, longest + 2))}" customWidth="1"/>`
  }).join('')
  const last = `${columnName(columns.length - 1)}${rows.length + 1}`
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${last}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${widths}</cols><sheetData><row r="1">${header}</row>${body}</sheetData><autoFilter ref="A1:${last}"/></worksheet>`
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'

function workbookFiles(columns: XlsxColumn[], rows: Record<string, unknown>[], sheetName: string): Map<string, string> {
  return new Map([
    ['[Content_Types].xml', `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`],
    ['_rels/.rels', `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/_rels/workbook.xml.rels', `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ['xl/workbook.xml', `${XML_HEAD}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${escapeXml(sheetName.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Sheet1')}" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ['xl/styles.xml', `${XML_HEAD}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFD9EAF7"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs></styleSheet>`],
    ['xl/worksheets/sheet1.xml', sheetXml(columns, rows)],
  ])
}

/** Build a minimal stored (uncompressed) zip, which is a valid .xlsx container. */
function zip(files: Map<string, string>): Buffer {
  const chunks: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const [name, content] of files) {
    const nameBytes = encoder.encode(name)
    const data = encoder.encode(content)
    const crc = crc32(data)

    const local = new Uint8Array(30 + nameBytes.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034B50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(6, 0x0800, true) // UTF-8 names
    lv.setUint32(14, crc, true)
    lv.setUint32(18, data.length, true)
    lv.setUint32(22, data.length, true)
    lv.setUint16(26, nameBytes.length, true)
    local.set(nameBytes, 30)
    chunks.push(local, data)

    const entry = new Uint8Array(46 + nameBytes.length)
    const ev = new DataView(entry.buffer)
    ev.setUint32(0, 0x02014B50, true)
    ev.setUint16(4, 20, true)
    ev.setUint16(6, 20, true)
    ev.setUint16(8, 0x0800, true)
    ev.setUint32(16, crc, true)
    ev.setUint32(20, data.length, true)
    ev.setUint32(24, data.length, true)
    ev.setUint16(28, nameBytes.length, true)
    ev.setUint32(42, offset, true)
    entry.set(nameBytes, 46)
    central.push(entry)
    offset += local.length + data.length
  }
  const centralSize = central.reduce((sum, item) => sum + item.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054B50, true)
  ev.setUint16(8, files.size, true)
  ev.setUint16(10, files.size, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)
  return Buffer.concat([...chunks, ...central, end])
}

export function buildXlsx(columns: XlsxColumn[], rows: Record<string, unknown>[], sheetName = 'Sheet1'): Buffer {
  if (!columns.length)
    throw new Error('xlsx needs at least one column')
  return zip(workbookFiles(columns, rows, sheetName))
}

export async function writeXlsx(path: string, columns: XlsxColumn[], rows: Record<string, unknown>[], sheetName?: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, buildXlsx(columns, rows, sheetName))
}

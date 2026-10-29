import type { FlowScript, FlowStep } from './schema.js'

/**
 * Export to the coordinate-macro JSON the official Escrcpy Automation imports.
 * That executor has no selectors, so steps that rely on one are skipped and
 * reported; everything point-based (tap/swipe/input/key/wait/launch) maps 1:1.
 */

export interface AutomationStep {
  id: string
  name: string
  type: 'tap' | 'swipe' | 'input' | 'key' | 'wait' | 'launch'
  params: Record<string, unknown>
  loopCount: number
  delayBefore: number
  randomRange: number
  imageMatch: null
}

export interface AutomationScript {
  name: string
  description: string
  steps: AutomationStep[]
  variables: Array<{ name: string }>
  exportedAt: string
}

function numberArg(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function pointOf(step: FlowStep): { x: number, y: number } | undefined {
  for (const target of step.target ?? []) {
    if (target && typeof target === 'object' && 'point' in target && Array.isArray(target.point))
      return { x: target.point[0], y: target.point[1] }
  }
  return undefined
}

function automationStep(step: FlowStep): AutomationStep | undefined {
  const args = (step.with ?? {}) as Record<string, unknown>
  const delayBefore = typeof step.settle === 'number' ? step.settle : 0
  const base = { id: step.id, name: step.intent ?? step.id, loopCount: 1, delayBefore, randomRange: 0, imageMatch: null }
  switch (step.do) {
    case 'tap': {
      const point = pointOf(step)
      return point && { ...base, type: 'tap', params: { x: point.x, y: point.y } }
    }
    case 'swipe': {
      const from = args.from as { x?: number, y?: number } | undefined
      const to = args.to as { x?: number, y?: number } | undefined
      return from && to && {
        ...base,
        type: 'swipe',
        params: {
          startX: from.x,
          startY: from.y,
          endX: to.x,
          endY: to.y,
          duration: typeof args.duration_ms === 'number' ? args.duration_ms : 300,
        },
      }
    }
    case 'input_text':
      return { ...base, type: 'input', params: { text: String(args.text ?? '') } }
    case 'key':
      return { ...base, type: 'key', params: { keyCode: Number(args.key ?? args.keycode ?? 4) } }
    case 'sleep':
      return { ...base, type: 'wait', params: { duration: numberArg(args.duration_ms ?? args.ms) ?? 1000 } }
    case 'app_start':
      return { ...base, type: 'launch', params: { packageName: String(args.package ?? ''), forceStop: args.restart === true } }
    default:
      return undefined
  }
}

export function toAutomationScript(flow: FlowScript): { script: AutomationScript, skipped: string[] } {
  const steps: AutomationStep[] = []
  const skipped: string[] = []
  for (const step of flow.steps) {
    const mapped = automationStep(step)
    if (mapped)
      steps.push(mapped)
    else
      skipped.push(step.id)
  }
  return {
    script: {
      name: flow.name,
      description: flow.description ?? '',
      steps,
      variables: Object.keys(flow.vars ?? {}).map(name => ({ name })),
      exportedAt: new Date().toISOString(),
    },
    skipped,
  }
}

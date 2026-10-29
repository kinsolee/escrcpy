import { z } from 'zod'

export const FLOW_SCHEMA_VERSION = 1

export const selectorSchema = z.object({
  resource_id: z.string().min(1).optional(),
  text: z.string().min(1).optional(),
  content_desc: z.string().min(1).optional(),
  class_name: z.string().min(1).optional(),
  exact: z.boolean().optional(),
  index: z.number().int().optional(),
}).refine(value => ['resource_id', 'text', 'content_desc', 'class_name'].some(field => value[field as keyof typeof value] !== undefined), {
  message: 'Selector needs at least one of resource_id, text, content_desc, class_name',
})

export const pointTargetSchema = z.object({
  point: z.tuple([z.number(), z.number()]),
})

export const imageTargetSchema = z.object({
  image: z.string(),
  threshold: z.number().min(0).max(1).optional(),
})

export const targetSchema = z.union([selectorSchema, imageTargetSchema, pointTargetSchema])
export const targetListSchema = z.array(targetSchema).min(1)

export const appSchema = z.object({
  package: z.string(),
  activity: z.string().optional(),
})

export const recordedOnSchema = z.object({
  model: z.string().optional(),
  sdk: z.number().int().optional(),
  size: z.tuple([z.number(), z.number()]).optional(),
  trace: z.string().optional(),
})

export const flowVarSchema = z.object({
  required: z.boolean().optional(),
  description: z.string().optional(),
  default: z.unknown().optional(),
})

export const defaultsSchema = z.object({
  timeout: z.number().int().nonnegative().optional(),
  settle: z.number().int().nonnegative().optional(),
  pollInterval: z.number().int().nonnegative().optional(),
})

export const expectSchema = z.object({
  visible: z.union([targetSchema, targetListSchema]).optional(),
  app: appSchema.optional(),
}).passthrough()

export const actionSchema = z.enum([
  'app_start',
  'app_stop',
  'open_url',
  'tap',
  'long_press',
  'input_text',
  'key',
  'swipe',
  'scroll',
  'scroll_until',
  'wait_for',
  'assert',
  'extract',
  'sleep',
  'shell',
])

export const stepSchema = z.object({
  id: z.string().min(1),
  intent: z.string().optional(),
  do: actionSchema,
  target: targetListSchema.optional(),
  with: z.record(z.string(), z.unknown()).optional(),
  expect: expectSchema.optional(),
  /** Wait after this step, overriding `defaults.settle`. */
  settle: z.number().int().nonnegative().optional(),
  optional: z.boolean().optional(),
}).passthrough()

export const interruptSchema = z.object({
  // Point `when` conditions always match and model a blind dismiss tap; image conditions
  // stay excluded because probes cannot match them in M2.
  when: z.union([selectorSchema, pointTargetSchema, targetListSchema]),
  do: actionSchema.default('tap'),
  target: targetListSchema.optional(),
  with: z.record(z.string(), z.unknown()).optional(),
}).passthrough()

export const flowSchema = z.object({
  version: z.literal(FLOW_SCHEMA_VERSION),
  name: z.string().min(1),
  description: z.string().optional(),
  app: appSchema.optional(),
  recordedOn: recordedOnSchema.optional(),
  vars: z.record(z.string(), flowVarSchema).default({}),
  defaults: defaultsSchema.default({}),
  interrupts: z.array(interruptSchema).default([]),
  steps: z.array(stepSchema).min(1),
}).passthrough()

export type Selector = z.infer<typeof selectorSchema>
export type PointTarget = z.infer<typeof pointTargetSchema>
export type ImageTarget = z.infer<typeof imageTargetSchema>
export type Target = z.infer<typeof targetSchema>
export type Expect = z.infer<typeof expectSchema>
export type FlowVar = z.infer<typeof flowVarSchema>
export type FlowDefaults = z.infer<typeof defaultsSchema>
export type FlowStep = z.infer<typeof stepSchema>
export type FlowInterrupt = z.infer<typeof interruptSchema>
export type FlowScript = z.infer<typeof flowSchema>

export function isSelectorTarget(target: Target): target is Selector {
  return !('point' in target) && !('image' in target)
}

export function isPointTarget(target: Target): target is PointTarget {
  return 'point' in target
}

export function isImageTarget(target: Target): target is ImageTarget {
  return 'image' in target
}

export function selectorFromTarget(target: Target): Selector | undefined {
  return isSelectorTarget(target) ? target : undefined
}

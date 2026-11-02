import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { encodeScreenshot, screenFingerprint, withLease, withTimeout } from '@escrcpy/flow-device'
import type { DeviceLease, ForegroundApp, RatioPoint, UiTree } from '@escrcpy/flow-device'
import type { z } from 'zod'
import { HealError } from '../heal.js'
import { summarizeJevAnswer } from '../jev.js'
import type { JevAnswers, JevClient, JevNoulQuestion, JevQuestions, JevUsage } from '../jev.js'
import { encodeJevScreen, visualRiskCheck } from '../jev-vision.js'
import type { JevScreen } from '../jev-vision.js'
import { checkTapTarget, DEFAULT_FORBIDDEN_TEXTS, isBlackScreen, runVisionAgent } from '../vision-agent.js'
import type { VisionAgentDevice, VisionAgentResult } from '../vision-agent.js'
import type { VisionLlmClient, VisionLlmClientOptions, VisionLlmEndpoint } from '../vision-llm.js'
import { redactSecret } from '../vision-llm.js'

/**
 * Playbook runtime: code drives a known task as a state machine, Jev makes
 * the per-screen judgments (one fan-out request per observation), and the M8
 * vision agent takes over single steps only when Jev is unsure or the screen
 * is not what the playbook expects. Guardrails are the vision agent's:
 * foreground allow-list, forbidden-label taps (UI tree), plus a Jev visual
 * check for taps the UI tree cannot name.
 */

// ---------------------------------------------------------------------------
// Types

export interface PlaybookThresholds {
  /** Page-type Choice confidence needed to act on it. Default 0.85. */
  page: number
  /** Popup / panel Noul probability needed to treat it as present (and 1 - this for absent). Default 0.85. */
  popup: number
  /** Box confidence needed to tap a located control on confidence alone. Default 0.6. */
  box: number
  /**
   * Lower Box confidence accepted when the box also fits the target's expected region and size
   * (playbook-defined geometry). Default 0.15: on a Pixel 5a / TikTok 47.5, correct Share-icon
   * boxes came back at 0.42–0.59 and correct grid-card boxes at 0.19–0.35.
   */
  boxGeometry: number
  /** Presence Noul needed before a Box is trusted. Default 0.5. */
  present: number
  /** Visual forbidden-control Noul above which a tap is refused. Default 0.5. */
  visualRisk: number
}

export const DEFAULT_PLAYBOOK_THRESHOLDS: PlaybookThresholds = { page: 0.85, popup: 0.85, box: 0.6, boxGeometry: 0.15, present: 0.5, visualRisk: 0.5 }

/** Foreground packages that come and go on their own (Android's clipboard overlay after Copy link); the guard waits them out. */
export const TRANSIENT_FOREGROUND_PACKAGES = ['com.android.systemui']

export interface PlaybookFallbackOptions {
  endpoint?: VisionLlmEndpoint
  client?: VisionLlmClient
  llm?: VisionLlmClientOptions
  /** Steps per takeover; capped at 6. */
  maxSteps?: number
  /** Total takeovers per run. Default 6. */
  maxTakeovers?: number
}

export interface PlaybookOptions {
  serial: string
  params: unknown
  device: VisionAgentDevice
  jev: JevClient
  /** M8 vision agent used for single-step takeovers; `false` disables takeovers (a step that needs one fails the run). */
  fallback?: PlaybookFallbackOptions | false
  forbiddenTexts?: string[]
  thresholds?: Partial<PlaybookThresholds>
  /** Observation budget. Default 60. */
  maxSteps?: number
  /** Default 6 min. */
  timeBudgetMs?: number
  /** Delay after an action before the next observation. Default 900 ms. */
  settleMs?: number
  /** Default 2000 ms. */
  treeTimeoutMs?: number
  /** Default `restart`: force-stop and relaunch the app so every run starts from the same screen. */
  launch?: 'restart' | 'if-needed' | 'never'
  runDir?: string
  lease?: DeviceLease
  leaseHolder?: string
  signal?: AbortSignal
  onEvent?: (event: PlaybookEvent) => void
  /** Resolves a copied short link (default: follows redirects with fetch, stopping at the first URL matching `stopAt`). */
  resolveLink?: (url: string, stopAt?: RegExp) => Promise<string | undefined>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export type PlaybookStatus = 'done' | 'failed' | 'guardrail' | 'budget_exhausted' | 'aborted' | 'error'

export interface PlaybookStepRecord {
  index: number
  at: string
  goal: string
  screenshot?: string
  app?: ForegroundApp | null
  tree?: { elements: number, ms: number } | { error: string, ms: number }
  jev?: { latencyMs: number, attempts: number, endpoint: 'primary' | 'fallback', usage?: JevUsage, questions: string[], answers: Record<string, Record<string, unknown>> }
  /** What code concluded from the answers. */
  decision?: string
  actions: Array<Record<string, unknown>>
  guard?: Record<string, unknown>
  fallback?: { goal: string, status: string, success: boolean, reason: string, steps: number, modelCalls: number, tokens: { prompt: number, completion: number, total: number }, durationMs: number, reportPath?: string, verified?: boolean }
  error?: string
}

export interface PlaybookResult {
  status: PlaybookStatus
  success: boolean
  result?: unknown
  reason: string
  steps: number
  jevCalls: number
  jevLatencyMs: { total: number, p50: number, p90: number, max: number }
  jevTokens: { input: number, output: number }
  /** Single-step takeovers by the vision agent. */
  fallbacks: number
  fallbackFailures: number
  modelCalls: number
  tokens: { prompt: number, completion: number, total: number }
  clipboardReads: string[]
  guardrailBlocks: number
  visualGuardBlocks: number
  unverifiedTaps: number
  durationMs: number
  runDir?: string
  reportPath?: string
}

export type PlaybookEvent
  = | { type: 'step', step: PlaybookStepRecord }
    | { type: 'log', message: string }
    | { type: 'finish', result: PlaybookResult }

export interface PlaybookReport extends Omit<PlaybookResult, 'status'> {
  /** `running` until the run ends. A report still `running` (no `finishedAt`) whose `pid` is dead was killed. */
  status: PlaybookStatus | 'running'
  pid: number
  /** Last time the report was written; a heartbeat for readers. */
  updatedAt?: string
  version: 1
  kind: 'playbook'
  playbook: string
  serial: string
  params: unknown
  allowedPackages: string[]
  forbiddenTexts: string[]
  thresholds: PlaybookThresholds
  jevEndpoint: ReturnType<JevClient['describe']>
  fallbackModel?: { baseUrl: string, model: string, apiType: string }
  /** Every question asked during the run, by name (texts as sent; images replaced by their state name). */
  questionCatalog: Record<string, unknown>
  options: Record<string, unknown>
  startedAt: string
  finishedAt?: string
  stepLog: PlaybookStepRecord[]
}

export interface PlaybookOutcome {
  success: boolean
  result?: unknown
  reason: string
}

export interface PlaybookDefinition<P = any> {
  id: string
  description: string
  params: z.ZodType<P>
  allowedPackages: string[]
  run: (rt: PlaybookRuntime, params: P) => Promise<PlaybookOutcome>
}

export interface Observation<Q extends JevQuestions> {
  step: PlaybookStepRecord
  screen: JevScreen
  app?: ForegroundApp
  tree?: UiTree
  answers: JevAnswers<Q>
}

export interface TapOptions {
  settleMs?: number
  /** `always`: run the Jev visual forbidden-control check even when the UI tree names the target. */
  visualCheck?: 'auto' | 'always'
  /** Also ask, on the same crop, whether the ringed control is the intended one (refer to it as \`crop\`); refuse below 0.5. Implies `visualCheck: 'always'`. */
  confirm?: JevNoulQuestion
}

/** Judges a takeover on the next observation (may read the device, e.g. the clipboard). */
export type TakeoverCheck = (obs: Observation<any>) => boolean | Promise<boolean>

/** Ends the run from anywhere inside a playbook. */
export class PlaybookStop extends Error {
  constructor(readonly status: PlaybookStatus, message: string) {
    super(message)
    this.name = 'PlaybookStop'
  }
}

// ---------------------------------------------------------------------------
// Runtime

const MAX_WAKES = 3
const MAX_FALLBACK_STEPS = 6

function percentile(sorted: number[], p: number): number {
  if (!sorted.length)
    return 0
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
}

export class PlaybookRuntime {
  readonly serial: string
  readonly device: VisionAgentDevice
  readonly jev: JevClient
  readonly thresholds: PlaybookThresholds
  readonly allowed: string[]
  readonly forbidden: string[]
  readonly signal?: AbortSignal
  readonly now: () => number
  readonly sleep: (ms: number) => Promise<void>
  readonly settleMs: number
  readonly resolveLink: (url: string, stopAt?: RegExp) => Promise<string | undefined>
  readonly clipboardReads: string[] = []
  /** Exact strings a takeover may type (e.g. the search keyword). Empty: takeovers may not type. */
  allowedInput: string[] = []

  private readonly options: PlaybookOptions
  private readonly started: number
  private readonly deadline: number
  private readonly maxSteps: number
  private readonly treeTimeoutMs: number
  private readonly stepLog: PlaybookStepRecord[] = []
  private readonly report: PlaybookReport
  private readonly reportPath?: string
  private readonly jevLatencies: number[] = []
  private readonly jevTokens = { input: 0, output: 0 }
  private readonly tokens = { prompt: 0, completion: 0, total: 0 }
  private modelCalls = 0
  private fallbacks = 0
  private fallbackFailures = 0
  private consecutiveFallbackFailures = 0
  private pendingFallback?: { step: PlaybookStepRecord, ok: boolean, expect: TakeoverCheck }
  private guardrailBlocks = 0
  /** Taps refused by the Jev visual forbidden-control check. */
  visualGuardBlocks = 0
  private unverifiedTaps = 0
  private recoveries = 0
  private coldRecoveries = 0
  /** Every relaunch of the allowed app (cold-start bounces and recoveries). Playbooks compare it between observations to re-locate after one. */
  relaunches = 0
  private inAppSeen = false
  private wakes = 0
  private current?: PlaybookStepRecord

  constructor(readonly definition: PlaybookDefinition, options: PlaybookOptions) {
    this.options = options
    this.serial = options.serial
    this.device = options.device
    this.jev = options.jev
    this.thresholds = { ...DEFAULT_PLAYBOOK_THRESHOLDS, ...options.thresholds }
    this.allowed = definition.allowedPackages
    this.forbidden = [...DEFAULT_FORBIDDEN_TEXTS, ...(options.forbiddenTexts ?? [])]
    this.signal = options.signal
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
    this.settleMs = options.settleMs ?? 900
    this.resolveLink = options.resolveLink ?? resolveRedirects
    this.started = this.now()
    this.deadline = this.started + (options.timeBudgetMs ?? 6 * 60_000)
    this.maxSteps = options.maxSteps ?? 60
    this.treeTimeoutMs = options.treeTimeoutMs ?? 2000
    this.reportPath = options.runDir ? join(options.runDir, 'report.json') : undefined
    const fallbackClient = options.fallback ? options.fallback.client : undefined
    const fallbackModel = options.fallback
      ? (fallbackClient?.describe() ?? (options.fallback.endpoint ? { baseUrl: options.fallback.endpoint.baseUrl, model: options.fallback.endpoint.model, apiType: options.fallback.endpoint.apiType ?? 'messages' } : undefined))
      : undefined
    this.report = {
      version: 1,
      kind: 'playbook',
      playbook: definition.id,
      serial: this.serial,
      params: options.params,
      allowedPackages: this.allowed,
      forbiddenTexts: this.forbidden,
      thresholds: this.thresholds,
      jevEndpoint: this.jev.describe(),
      ...(fallbackModel ? { fallbackModel } : {}),
      questionCatalog: {},
      options: { maxSteps: this.maxSteps, timeBudgetMs: this.deadline - this.started, settleMs: this.settleMs, treeTimeoutMs: this.treeTimeoutMs, launch: options.launch ?? 'restart', fallback: options.fallback ? { maxSteps: Math.min(MAX_FALLBACK_STEPS, options.fallback.maxSteps ?? MAX_FALLBACK_STEPS), maxTakeovers: options.fallback.maxTakeovers ?? 6 } : false },
      startedAt: new Date(this.started).toISOString(),
      ...this.snapshot('error', false, 'running'),
      status: 'running',
      pid: process.pid,
      stepLog: this.stepLog,
    }
  }

  // ---- bookkeeping ------------------------------------------------------

  private snapshot(status: PlaybookStatus, success: boolean, reason: string, result?: unknown): PlaybookResult {
    const sorted = [...this.jevLatencies].sort((a, b) => a - b)
    return {
      status,
      success,
      ...(result !== undefined ? { result } : {}),
      reason,
      steps: this.stepLog.length,
      jevCalls: this.jevLatencies.length,
      jevLatencyMs: { total: sorted.reduce((sum, value) => sum + value, 0), p50: percentile(sorted, 0.5), p90: percentile(sorted, 0.9), max: sorted.at(-1) ?? 0 },
      jevTokens: { ...this.jevTokens },
      fallbacks: this.fallbacks,
      fallbackFailures: this.fallbackFailures,
      modelCalls: this.modelCalls,
      tokens: { ...this.tokens },
      clipboardReads: [...this.clipboardReads],
      guardrailBlocks: this.guardrailBlocks,
      visualGuardBlocks: this.visualGuardBlocks,
      unverifiedTaps: this.unverifiedTaps,
      durationMs: this.now() - this.started,
      ...(this.options.runDir ? { runDir: this.options.runDir, reportPath: this.reportPath } : {}),
    }
  }

  private redact(text: string): string {
    const key = this.options.fallback ? this.options.fallback.endpoint?.apiKey : undefined
    return redactSecret(text, key)
  }

  async persist(): Promise<void> {
    if (!this.reportPath)
      return
    Object.assign(this.report, { ...this.snapshot('error', this.report.success, this.report.reason, this.report.result), status: this.report.status, updatedAt: new Date(this.now()).toISOString() })
    const tmp = `${this.reportPath}.tmp`
    await writeFile(tmp, this.redact(JSON.stringify(this.report, null, 2)), 'utf8')
    await rename(tmp, this.reportPath)
  }

  log(message: string): void {
    this.emit({ type: 'log', message })
  }

  private emit(event: PlaybookEvent): void {
    try {
      this.options.onEvent?.(event)
    }
    catch {
      // A broken listener must not stop the run.
    }
  }

  private async commit(): Promise<void> {
    if (!this.current)
      return
    this.emit({ type: 'step', step: this.current })
    this.current = undefined
    await this.persist()
  }

  /** Adds a note on what code decided from the current observation. */
  decide(text: string): void {
    if (this.current)
      this.current.decision = this.current.decision ? `${this.current.decision}; ${text}` : text
  }

  checkBudget(): void {
    if (this.signal?.aborted)
      throw new PlaybookStop('aborted', 'aborted by caller')
    if (this.now() >= this.deadline)
      throw new PlaybookStop('budget_exhausted', `time budget of ${this.deadline - this.started} ms exhausted`)
  }

  private newStep(goal: string): PlaybookStepRecord {
    if (this.stepLog.length >= this.maxSteps)
      throw new PlaybookStop('budget_exhausted', `step budget of ${this.maxSteps} exhausted`)
    const step: PlaybookStepRecord = { index: this.stepLog.length + 1, at: new Date(this.now()).toISOString(), goal, actions: [] }
    this.stepLog.push(step)
    this.current = step
    return step
  }

  // ---- device helpers -----------------------------------------------------

  async foreground(): Promise<ForegroundApp | undefined> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const app = await withTimeout(this.device.foregroundApp(this.serial), 5000, 'foreground app lookup')
        if (app)
          return app
      }
      catch (error) {
        this.log(`foreground lookup failed: ${(error as Error).message}`)
      }
    }
    return undefined
  }

  /**
   * Foreground, waiting out a transient system overlay (Android's clipboard preview takes focus
   * for a few seconds after a copy): wait up to 2 s, dismiss it with BACK once, wait up to 2 s more.
   */
  async stableForeground(): Promise<ForegroundApp | undefined> {
    const transient = (app: ForegroundApp | undefined) => !!app && !this.isAllowed(app) && TRANSIENT_FOREGROUND_PACKAGES.includes(app.package)
    let app = await this.foreground()
    for (let wait = 0; wait < 4 && transient(app); wait++) {
      if (wait === 2) {
        this.action({ type: 'key', key: 'BACK', reason: `dismiss ${app!.package} overlay` })
        await this.device.key(this.serial, 'BACK')
      }
      await this.sleep(1000)
      app = await this.foreground()
    }
    return app
  }

  isAllowed(app: ForegroundApp | undefined): boolean {
    return !this.allowed.length || (!!app && this.allowed.includes(app.package))
  }

  private async readTree(): Promise<{ tree?: UiTree, info: PlaybookStepRecord['tree'] }> {
    if (!this.device.uiTree)
      return { info: { error: 'device has no UI tree capability', ms: 0 } }
    const started = this.now()
    try {
      const tree = await withTimeout(this.device.uiTree(this.serial), this.treeTimeoutMs, 'UI tree')
      return { tree, info: { elements: tree.nodes.length, ms: this.now() - started } }
    }
    catch (error) {
      return { info: { error: (error as Error).message, ms: this.now() - started } }
    }
  }

  private recordQuestions(questions: JevQuestions): void {
    for (const [name, question] of Object.entries(questions)) {
      if (!(name in this.report.questionCatalog))
        this.report.questionCatalog[name] = question
    }
  }

  /** Brings the first allowed app back once; a second escape ends the run with `guardrail`. */
  private async recover(app: ForegroundApp | undefined, step: PlaybookStepRecord): Promise<void> {
    // Cold start: until the app has been seen in front once, relaunches are free (up to 3);
    // TikTok sometimes drops back to the launcher right after a restart.
    if (!this.inAppSeen && this.coldRecoveries < 3) {
      this.coldRecoveries++
    }
    else {
      this.recoveries++
      if (this.recoveries > 1)
        throw new PlaybookStop('guardrail', `foreground left the allowed apps again (${app?.package ?? 'unknown'})`)
    }
    const pkg = this.allowed[0]
    this.relaunches++
    step.actions.push({ type: 'recover', from: app?.package ?? 'unknown', package: pkg })
    await this.device.startApp(this.serial, pkg)
    await this.sleep(Math.max(this.settleMs, 2000))
  }

  async start(): Promise<void> {
    if (this.options.runDir)
      await mkdir(this.options.runDir, { recursive: true })
    if (this.device.wake)
      await this.device.wake(this.serial).catch(error => this.log(`wake failed: ${(error as Error).message}`))
    const launch = this.options.launch ?? 'restart'
    if (this.allowed.length && launch !== 'never') {
      const app = await this.foreground()
      if (launch === 'restart' || !this.isAllowed(app)) {
        this.log(`launching ${this.allowed[0]}${launch === 'restart' ? ' (restart)' : ''}`)
        await this.device.startApp(this.serial, this.allowed[0], { restart: launch === 'restart' })
        await this.sleep(3000)
      }
    }
  }

  /**
   * One observation: screenshot, then foreground + UI tree + one Jev request
   * in parallel. Wakes a dark screen and relaunches the allowed app when the
   * foreground left it (each recorded as its own step). Evaluates the last
   * takeover's expectation against this observation.
   */
  async observe<const Q extends JevQuestions>(goal: string, questions: Q, state: Record<string, unknown> = {}): Promise<Observation<Q>> {
    await this.commit()
    for (;;) {
      this.checkBudget()
      const step = this.newStep(goal)
      const png = await withTimeout(this.device.screencap(this.serial), 15_000, 'screencap')
      const fingerprint = await (this.device.fingerprint ?? screenFingerprint)(png).catch(() => undefined)
      if (this.device.wake && this.wakes < MAX_WAKES && isBlackScreen(fingerprint)) {
        this.wakes++
        step.actions.push({ type: 'wake' })
        await this.device.wake(this.serial).catch(error => step.error = `wake failed: ${(error as Error).message}`)
        await this.commit()
        await this.sleep(1500)
        continue
      }
      const screen = await encodeJevScreen(png, this.device.encode ?? encodeScreenshot)
      if (this.options.runDir) {
        step.screenshot = `step-${String(step.index).padStart(3, '0')}.${screen.encoded.mimeType === 'image/png' ? 'png' : 'jpg'}`
        await writeFile(join(this.options.runDir, step.screenshot), screen.encoded.data)
      }
      this.recordQuestions(questions)
      const ask = async () => {
        try {
          return await this.jev.ask({ state: { ...state, screen: screen.image }, questions }, { signal: this.signal })
        }
        catch (error) {
          if (this.signal?.aborted)
            throw new PlaybookStop('aborted', 'aborted by caller')
          // The client already retried transient failures once; one more try after a pause.
          this.log(`Jev request failed (${(error as Error).message}); retrying once`)
          await this.sleep(1000)
          return this.jev.ask({ state: { ...state, screen: screen.image }, questions }, { signal: this.signal })
        }
      }
      const [observedApp, treeResult, response] = await Promise.all([this.foreground(), this.readTree(), ask().catch((error: Error) => error)])
      let app = observedApp
      step.app = app ?? null
      step.tree = treeResult.info
      if (response instanceof Error) {
        step.error = this.redact(`Jev failed: ${response.message}`)
        throw response instanceof PlaybookStop ? response : new PlaybookStop('error', step.error)
      }
      this.jevLatencies.push(response.latencyMs)
      if (response.usage) {
        this.jevTokens.input += response.usage.inputTokens
        this.jevTokens.output += response.usage.outputTokens
      }
      step.jev = {
        latencyMs: response.latencyMs,
        attempts: response.attempts,
        endpoint: response.endpoint,
        ...(response.usage ? { usage: response.usage } : {}),
        questions: Object.keys(questions),
        answers: Object.fromEntries(Object.entries(response.answers).map(([name, answer]) => [name, summarizeJevAnswer(answer as never)])),
      }
      if (!this.isAllowed(app)) {
        if (app && TRANSIENT_FOREGROUND_PACKAGES.includes(app.package)) {
          const settled = await this.stableForeground()
          if (this.isAllowed(settled)) {
            step.decision = `transient ${app.package} overlay had focus; observe again`
            continue
          }
          app = settled
        }
        step.decision = `foreground ${app?.package ?? 'unknown'} is not allowed`
        await this.recover(app, step)
        continue
      }
      this.inAppSeen = true
      const obs: Observation<Q> = { step, screen, app, tree: treeResult.tree, answers: response.answers as JevAnswers<Q> }
      if (this.pendingFallback) {
        const pending = this.pendingFallback
        this.pendingFallback = undefined
        const verified = pending.ok && await pending.expect(obs)
        if (pending.step.fallback)
          pending.step.fallback.verified = verified
        if (verified) {
          this.consecutiveFallbackFailures = 0
        }
        else {
          this.fallbackFailures++
          this.consecutiveFallbackFailures++
          if (this.consecutiveFallbackFailures >= 2)
            throw new PlaybookStop('failed', `two takeovers in a row did not reach their step's goal (last: ${pending.step.fallback?.goal ?? pending.step.goal})`)
        }
      }
      return obs
    }
  }

  // ---- actions --------------------------------------------------------------

  private action(record: Record<string, unknown>): Record<string, unknown> {
    const entry = { ...record }
    this.current?.actions.push(entry)
    return entry
  }

  /**
   * Taps a ratio point after the guardrails: foreground re-check, forbidden
   * labels from the observation's UI tree, and — when the tree is missing or
   * the target has no label — a Jev visual check of a crop around the point.
   * Returns false when the tap was refused.
   */
  async tap(obs: Observation<any>, ratio: RatioPoint, target: string, options: TapOptions = {}): Promise<boolean> {
    this.checkBudget()
    const entry = this.action({ type: 'tap', target, ratio: { x: Math.round(ratio.x * 1000) / 1000, y: Math.round(ratio.y * 1000) / 1000 } })
    const app = await this.stableForeground()
    if (!this.isAllowed(app)) {
      this.guardrailBlocks++
      entry.blocked = `foreground ${app?.package ?? 'unknown'} is not allowed; tap not executed`
      return false
    }
    const tree = obs.tree
    const point = tree ? { x: ratio.x * tree.size.width, y: ratio.y * tree.size.height } : { x: 0, y: 0 }
    const check = checkTapTarget(tree, point, this.forbidden)
    if (check.verdict === 'blocked') {
      this.guardrailBlocks++
      entry.blocked = `target "${check.label}" matches forbidden text "${check.term}"`
      return false
    }
    if (check.labels.length)
      entry.labels = check.labels.slice(0, 6)
    const always = options.visualCheck === 'always' || !!options.confirm
    if (always || check.verdict === 'unverified' || check.unlabeled) {
      try {
        const risk = await visualRiskCheck({ png: obs.screen.png, ratio, jev: this.jev, threshold: this.thresholds.visualRisk, confirm: options.confirm, signal: this.signal })
        this.jevLatencies.push(risk.jev.latencyMs)
        if (risk.jev.usage) {
          this.jevTokens.input += risk.jev.usage.inputTokens
          this.jevTokens.output += risk.jev.usage.outputTokens
        }
        entry.visualCheck = {
          probability: Math.round(risk.probability * 1000) / 1000,
          ...(risk.confirmed !== undefined ? { confirmed: Math.round(risk.confirmed * 1000) / 1000 } : {}),
          latencyMs: risk.jev.latencyMs,
          reason: always ? 'required for this target' : check.verdict === 'unverified' ? 'no UI tree' : 'unlabeled target',
        }
        if (risk.risky) {
          this.visualGuardBlocks++
          this.guardrailBlocks++
          entry.blocked = `visual check: the control looks like a social / purchase action (p=${risk.probability.toFixed(2)})`
          return false
        }
        if (risk.confirmed !== undefined && risk.confirmed < 0.5) {
          entry.blocked = `visual check: the ringed control is not the intended ${target} (p=${risk.confirmed.toFixed(2)})`
          return false
        }
      }
      catch (error) {
        this.unverifiedTaps++
        entry.visualCheck = { error: (error as Error).message }
        // A required check that cannot run fails closed.
        if (always) {
          entry.blocked = 'required visual check could not run; tap not executed'
          return false
        }
      }
    }
    const started = this.now()
    await this.device.tap(this.serial, ratio)
    entry.ms = this.now() - started
    await this.sleep(options.settleMs ?? this.settleMs)
    return true
  }

  /**
   * Sends a key. With `guard`, the live foreground is checked first (it must be an allowed app,
   * and the guard may refuse it, e.g. a launcher-level activity where BACK would leave the app);
   * returns false when the key was not sent.
   */
  async key(key: 'BACK' | 'HOME' | 'ENTER', reason?: string, options: { guard?: (app: ForegroundApp) => string | undefined } = {}): Promise<boolean> {
    this.checkBudget()
    const entry = this.action({ type: 'key', key, ...(reason ? { reason } : {}) })
    if (options.guard) {
      const app = await this.stableForeground()
      const refusal = !app || !this.isAllowed(app) ? `foreground ${app?.package ?? 'unknown'} is not allowed` : options.guard(app)
      if (refusal) {
        entry.blocked = `${key} not sent: ${refusal}`
        return false
      }
    }
    await this.device.key(this.serial, key)
    await this.sleep(this.settleMs)
    return true
  }

  async inputText(text: string): Promise<void> {
    this.checkBudget()
    this.action({ type: 'input_text', text })
    await this.device.inputText(this.serial, text)
    await this.sleep(Math.min(this.settleMs, 600))
  }

  async clearText(): Promise<boolean> {
    if (!this.device.clearText)
      return false
    this.action({ type: 'clear_text' })
    await this.device.clearText(this.serial)
    return true
  }

  async swipe(from: RatioPoint, to: RatioPoint, durationMs: number, reason?: string): Promise<void> {
    this.checkBudget()
    this.action({ type: 'swipe', from, to, durationMs, ...(reason ? { reason } : {}) })
    await this.device.swipe(this.serial, from, to, durationMs)
    await this.sleep(this.settleMs)
  }

  async readClipboard(): Promise<string> {
    if (!this.device.readClipboard)
      throw new PlaybookStop('error', 'clipboard is unavailable on this device (needs yadb)')
    const value = (await this.device.readClipboard(this.serial)).trim()
    this.clipboardReads.push(value)
    this.action({ type: 'read_clipboard', value: value.slice(0, 300) })
    return value
  }

  /** Polls the clipboard until it differs from `before` (a copy lands a moment after the tap). */
  async waitClipboardChange(before: string, timeoutMs = 8000): Promise<string> {
    const polls = Math.max(1, Math.ceil(timeoutMs / 500))
    for (let poll = 1; ; poll++) {
      const value = await this.readClipboard()
      if (value !== before || poll >= polls)
        return value
      await this.sleep(500)
    }
  }

  async writeClipboard(text: string): Promise<boolean> {
    if (!this.device.writeClipboard)
      return false
    await this.device.writeClipboard(this.serial, text)
    this.action({ type: 'write_clipboard', value: text })
    return true
  }

  /**
   * Hands this one step to the M8 vision agent (≤ 6 steps, same allow-list and
   * forbidden labels, typing restricted to `allowedInput`), then lets the next
   * observation judge it with `expect`. Two unverified takeovers in a row end
   * the run as failed.
   */
  async takeover(intent: string, expect: TakeoverCheck, why: string): Promise<VisionAgentResult | undefined> {
    this.checkBudget()
    const step = this.current
    const fallback = this.options.fallback
    if (!fallback)
      throw new PlaybookStop('failed', `step needs a takeover (${why}) but takeovers are disabled`)
    const maxTakeovers = fallback.maxTakeovers ?? 6
    if (this.fallbacks >= maxTakeovers)
      throw new PlaybookStop('failed', `takeover budget of ${maxTakeovers} exhausted (${why})`)
    this.fallbacks++
    const allowedInput = [...this.allowedInput]
    const guardedDevice: VisionAgentDevice = {
      ...this.device,
      inputText: async (serial, text) => {
        if (!allowedInput.includes(text.trim()))
          throw new HealError(`runtime refused to type ${JSON.stringify(text.slice(0, 40))}: during this step you may only type ${allowedInput.length ? allowedInput.map(value => JSON.stringify(value)).join(' or ') : 'nothing'}`)
        return this.device.inputText(serial, text)
      },
    }
    const goal = [
      intent,
      'This is one step of a larger scripted task: stop with done as soon as this step is complete, and do not continue beyond it.',
      allowedInput.length ? `Never change the search text: you may only type exactly ${allowedInput.map(value => JSON.stringify(value)).join(' or ')}.` : 'Do not type any text.',
    ].join(' ')
    const runDir = this.options.runDir ? join(this.options.runDir, `takeover-${this.fallbacks}`) : undefined
    this.log(`takeover ${this.fallbacks}: ${why}`)
    const result = await runVisionAgent({
      serial: this.serial,
      goal,
      allowedPackages: this.allowed,
      forbiddenTexts: this.options.forbiddenTexts,
      maxSteps: Math.min(MAX_FALLBACK_STEPS, fallback.maxSteps ?? MAX_FALLBACK_STEPS),
      timeBudgetMs: Math.max(10_000, Math.min(120_000, this.deadline - this.now())),
      launch: 'never',
      endpoint: fallback.endpoint,
      client: fallback.client,
      llm: fallback.llm,
      device: guardedDevice,
      jev: this.jev,
      signal: this.signal,
      now: this.now,
      sleep: this.sleep,
      ...(runDir ? { runDir } : {}),
      onEvent: event => event.type === 'log' && this.log(`takeover: ${event.message}`),
    })
    this.modelCalls += result.modelCalls
    this.tokens.prompt += result.tokens.prompt
    this.tokens.completion += result.tokens.completion
    this.tokens.total = this.tokens.prompt + this.tokens.completion
    this.guardrailBlocks += result.guardrailBlocks
    this.unverifiedTaps += result.unverifiedTaps
    if (result.status === 'aborted')
      throw new PlaybookStop('aborted', 'aborted by caller')
    if (result.status === 'guardrail')
      throw new PlaybookStop('guardrail', `takeover: ${result.reason}`)
    if (step) {
      step.fallback = { goal: intent, status: result.status, success: result.success, reason: result.reason, steps: result.steps, modelCalls: result.modelCalls, tokens: result.tokens, durationMs: result.durationMs, ...(result.reportPath ? { reportPath: result.reportPath } : {}) }
      this.pendingFallback = { step, ok: result.success, expect }
    }
    return result
  }

  // ---- run --------------------------------------------------------------------

  async run(params: unknown): Promise<PlaybookResult> {
    let result: PlaybookResult
    try {
      await this.start()
      const outcome = await this.definition.run(this, params)
      if (this.pendingFallback && !this.pendingFallback.ok)
        this.fallbackFailures++
      result = this.snapshot(outcome.success ? 'done' : 'failed', outcome.success, outcome.reason, outcome.result)
    }
    catch (error) {
      if (error instanceof PlaybookStop)
        result = this.snapshot(error.status, false, this.redact(error.message), this.partial)
      else if (this.signal?.aborted)
        result = this.snapshot('aborted', false, 'aborted by caller', this.partial)
      else
        result = this.snapshot('error', false, this.redact((error as Error).message), this.partial)
    }
    await this.commit().catch(() => {})
    Object.assign(this.report, result, { finishedAt: new Date(this.now()).toISOString() })
    if (result.result === undefined)
      delete this.report.result
    await this.persist().catch(() => {})
    this.emit({ type: 'finish', result })
    return result
  }

  /** Partial result a playbook keeps updated, reported when the run stops early. */
  partial: unknown
}

/**
 * Follows HTTP redirects (manual, ≤ 5 hops, 8 s each) and returns the first URL matching
 * `stopAt`, else the last one; undefined on failure. Stopping matters: a TikTok product page
 * itself redirects cookie-less clients on to /login.
 */
export async function resolveRedirects(url: string, stopAt?: RegExp): Promise<string | undefined> {
  let current = url
  try {
    for (let hop = 0; hop < 5; hop++) {
      if (stopAt?.test(current))
        return current
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 8000)
      let response: Response
      try {
        response = await fetch(current, { method: 'GET', redirect: 'manual', signal: controller.signal, headers: { 'user-agent': 'Mozilla/5.0 (Linux; Android 14) flow-playbook' } })
      }
      finally {
        clearTimeout(timer)
      }
      await response.body?.cancel().catch(() => {})
      const location = response.headers.get('location')
      if (response.status < 300 || response.status >= 400 || !location)
        return current
      current = new URL(location, current).toString()
    }
    return current
  }
  catch {
    return undefined
  }
}

/** Runs a playbook definition, holding the device lease when one is given. */
export async function runPlaybookDefinition(definition: PlaybookDefinition, options: PlaybookOptions): Promise<PlaybookResult> {
  const params = definition.params.parse(options.params)
  const run = () => new PlaybookRuntime(definition, { ...options, params }).run(params)
  if (options.lease)
    return withLease(options.lease, options.serial, { holder: options.leaseHolder ?? `playbook:${definition.id}` }, run)
  return run()
}

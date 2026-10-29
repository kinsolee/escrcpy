/**
 * Runs tasks one at a time per key, so gestures sent to the same device never interleave.
 * Different keys run in parallel. A failed task does not block the ones queued after it.
 */
export class KeyedQueue {
  private readonly tails = new Map<string, Promise<unknown>>()

  run<T>(key: string, task: () => Promise<T>, timeout?: { ms: number, label: string, onTimeout?: () => void }): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    const gate = previous.catch(() => {})
    const started = gate.then(task)
    const result = timeout
      ? gate.then(() => withTimeout(started, timeout.ms, timeout.label)).catch((error) => {
          if (error instanceof Error && error.message === `${timeout.label} timed out after ${timeout.ms} ms`)
            timeout.onTimeout?.()
          throw error
        })
      : started
    const tail = started.catch(() => {})
    this.tails.set(key, tail)
    void tail.then(() => {
      if (this.tails.get(key) === tail)
        this.tails.delete(key)
    })
    return result
  }

  /** Number of keys with work queued or running. */
  get size(): number {
    return this.tails.size
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

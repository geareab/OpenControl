import type { ControlEvent, ControlId, ControlPhase } from './types.js'
import { isControlId } from './types.js'

export interface TerminalSequenceBinding {
  readonly controlId: ControlId
  readonly sequence: Uint8Array
  readonly phase?: ControlPhase
}

/** JSON-safe representation used by the versioned OpenControl config. */
export interface SerializedTerminalSequenceBinding {
  readonly controlId: ControlId
  readonly sequenceBase64: string
  readonly phase?: ControlPhase
}

export type TerminalDecoderEmission =
  | { readonly kind: 'control'; readonly event: ControlEvent }
  | { readonly kind: 'passthrough'; readonly data: Buffer }

export interface TerminalSequenceDecoderOptions {
  readonly sourceId?: string
  /** Time to retain a byte sequence that could still become a control. */
  readonly ambiguityTimeoutMs?: number
}

interface NormalizedBinding {
  readonly controlId: ControlId
  readonly sequence: Buffer
  readonly phase: ControlPhase
}

const DEFAULT_AMBIGUITY_TIMEOUT_MS = 40
const VALID_PHASES: ReadonlySet<string> = new Set(['press', 'release', 'repeat'])

/** Encode arbitrary terminal bytes without passing them through UTF-8. */
export function terminalSequenceToBase64(sequence: Uint8Array): string {
  return Buffer.from(sequence).toString('base64')
}

/**
 * Decode canonical RFC 4648 base64. Node's Buffer decoder is deliberately
 * permissive, so validate first to catch corrupted or hand-edited config.
 */
export function terminalSequenceFromBase64(encoded: string): Buffer {
  if (encoded.length === 0) return Buffer.alloc(0)
  if (
    encoded.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
  ) {
    throw new Error('Terminal sequence must be canonical base64')
  }
  const decoded = Buffer.from(encoded, 'base64')
  if (decoded.toString('base64') !== encoded) {
    throw new Error('Terminal sequence must be canonical base64')
  }
  return decoded
}

export function serializeTerminalBindings(
  bindings: readonly TerminalSequenceBinding[],
): SerializedTerminalSequenceBinding[] {
  return bindings.map((binding) => ({
    controlId: binding.controlId,
    sequenceBase64: terminalSequenceToBase64(binding.sequence),
    ...(binding.phase === undefined ? {} : { phase: binding.phase }),
  }))
}

export function deserializeTerminalBindings(
  bindings: readonly SerializedTerminalSequenceBinding[],
): TerminalSequenceBinding[] {
  return bindings.map((binding) => {
    if (!isControlId(binding.controlId))
      throw new Error(`Unknown control ID: ${String(binding.controlId)}`)
    if (binding.phase !== undefined && !VALID_PHASES.has(binding.phase)) {
      throw new Error(`Unknown control phase: ${String(binding.phase)}`)
    }
    return {
      controlId: binding.controlId,
      sequence: terminalSequenceFromBase64(binding.sequenceBase64),
      ...(binding.phase === undefined ? {} : { phase: binding.phase }),
    }
  })
}

/**
 * Incrementally separates configured control sequences from ordinary terminal
 * input. Emissions preserve input order, including when passthrough bytes and
 * controls are interleaved in the same chunk.
 */
export class TerminalSequenceDecoder {
  readonly sourceId: string
  readonly ambiguityTimeoutMs: number

  private readonly bindings: readonly NormalizedBinding[]
  private pending = Buffer.alloc(0)
  private pendingSince: number | null = null

  constructor(
    bindings: readonly TerminalSequenceBinding[],
    options: TerminalSequenceDecoderOptions = {},
  ) {
    this.sourceId = options.sourceId ?? 'terminal'
    this.ambiguityTimeoutMs = options.ambiguityTimeoutMs ?? DEFAULT_AMBIGUITY_TIMEOUT_MS
    if (!Number.isFinite(this.ambiguityTimeoutMs) || this.ambiguityTimeoutMs < 0) {
      throw new Error('ambiguityTimeoutMs must be a non-negative finite number')
    }

    const seen = new Set<string>()
    this.bindings = bindings.map((binding) => {
      const sequence = Buffer.from(binding.sequence)
      if (sequence.length === 0) throw new Error('Terminal control sequences cannot be empty')
      const key = sequence.toString('hex')
      if (seen.has(key)) throw new Error(`Duplicate terminal control sequence: ${key}`)
      seen.add(key)
      return {
        controlId: binding.controlId,
        sequence,
        phase: binding.phase ?? 'press',
      }
    })
  }

  get pendingBytes(): Buffer {
    return Buffer.from(this.pending)
  }

  /** Deadline to pass to a timer, or null when no ambiguous bytes are held. */
  get flushDeadline(): number | null {
    return this.pendingSince === null ? null : this.pendingSince + this.ambiguityTimeoutMs
  }

  push(chunk: Uint8Array, now = Date.now()): TerminalDecoderEmission[] {
    const emissions: TerminalDecoderEmission[] = []
    this.append(emissions, this.flushExpired(now))
    if (chunk.length === 0) return emissions

    if (this.pending.length === 0) this.pendingSince = now
    this.pending = Buffer.concat([this.pending, Buffer.from(chunk)])
    this.process(emissions, now, false)
    return emissions
  }

  /** Flush pending bytes only after the advertised ambiguity deadline. */
  flushExpired(now = Date.now()): TerminalDecoderEmission[] {
    if (this.pendingSince === null || now < this.pendingSince + this.ambiguityTimeoutMs) return []
    return this.flush(now)
  }

  /** Force resolution at end-of-input or when an external timer fires. */
  flush(now = Date.now()): TerminalDecoderEmission[] {
    const emissions: TerminalDecoderEmission[] = []
    this.process(emissions, now, true)
    return emissions
  }

  private process(emissions: TerminalDecoderEmission[], now: number, force: boolean): void {
    while (this.pending.length > 0) {
      const candidates = this.bindings.filter((binding) =>
        startsWith(binding.sequence, this.pending),
      )
      const exact = candidates.find((binding) => binding.sequence.length === this.pending.length)
      const hasLongerCandidate = candidates.some(
        (binding) => binding.sequence.length > this.pending.length,
      )

      if (exact && (!hasLongerCandidate || force)) {
        this.emitControl(emissions, exact, now)
        this.clearPending()
        continue
      }

      if (candidates.length > 0 && !force) {
        if (this.pendingSince === null) this.pendingSince = now
        return
      }

      const exactPrefix = this.longestExactPrefix()
      if (exactPrefix) {
        this.emitControl(emissions, exactPrefix, now)
        this.consume(exactPrefix.sequence.length, now)
        continue
      }

      if (force) {
        this.emitPassthrough(emissions, this.pending)
        this.clearPending()
        continue
      }

      this.emitPassthrough(emissions, this.pending.subarray(0, 1))
      this.consume(1, now)
    }
  }

  private longestExactPrefix(): NormalizedBinding | undefined {
    let longest: NormalizedBinding | undefined
    for (const binding of this.bindings) {
      if (!startsWith(this.pending, binding.sequence)) continue
      if (!longest || binding.sequence.length > longest.sequence.length) longest = binding
    }
    return longest
  }

  private consume(count: number, now: number): void {
    this.pending = this.pending.subarray(count)
    this.pendingSince = this.pending.length === 0 ? null : now
  }

  private clearPending(): void {
    this.pending = Buffer.alloc(0)
    this.pendingSince = null
  }

  private emitControl(
    emissions: TerminalDecoderEmission[],
    binding: NormalizedBinding,
    timestamp: number,
  ): void {
    emissions.push({
      kind: 'control',
      event: {
        controlId: binding.controlId,
        phase: binding.phase,
        sourceId: this.sourceId,
        timestamp,
      },
    })
  }

  private emitPassthrough(emissions: TerminalDecoderEmission[], bytes: Uint8Array): void {
    if (bytes.length === 0) return
    const previous = emissions.at(-1)
    if (previous?.kind === 'passthrough') {
      emissions[emissions.length - 1] = {
        kind: 'passthrough',
        data: Buffer.concat([previous.data, Buffer.from(bytes)]),
      }
      return
    }
    emissions.push({ kind: 'passthrough', data: Buffer.from(bytes) })
  }

  private append(
    destination: TerminalDecoderEmission[],
    source: readonly TerminalDecoderEmission[],
  ): void {
    for (const emission of source) {
      if (emission.kind === 'passthrough') this.emitPassthrough(destination, emission.data)
      else destination.push(emission)
    }
  }
}

/** True when `prefix` is a byte-for-byte prefix of `value`. */
function startsWith(value: Uint8Array, prefix: Uint8Array): boolean {
  if (prefix.length > value.length) return false
  for (let index = 0; index < prefix.length; index += 1) {
    if (value[index] !== prefix[index]) return false
  }
  return true
}

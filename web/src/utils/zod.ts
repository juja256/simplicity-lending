import { z as zod } from 'zod'

function coerceToNumber(value: unknown): unknown {
  if (value === null || value === undefined) return 0
  if (typeof value === 'number') return value
  if (typeof value === 'string') return Number(value)
  return value
}

export const blockHeightSchema = zod.preprocess(
  coerceToNumber,
  zod.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
)

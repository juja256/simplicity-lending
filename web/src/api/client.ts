import axios, { AxiosError, type AxiosRequestConfig } from 'axios'
import type { z as zod } from 'zod'

// No app imports (React, `import.meta.env`) here: the private lending scan runs this client in
// Node too (the e2e script).
import { ApiAbortError, ApiError, ApiTimeoutError, ApiValidationError } from './errors'

export const DEFAULT_TIMEOUT_MS = 30_000

export interface RequestParams {
  signal?: AbortSignal
}

const apiClient = axios.create({ timeout: DEFAULT_TIMEOUT_MS })

apiClient.interceptors.response.use(undefined, (error: AxiosError) =>
  Promise.reject(toApiError(error)),
)

function toApiError(error: AxiosError): ApiError {
  if (error.code === AxiosError.ECONNABORTED || error.code === AxiosError.ETIMEDOUT) {
    return new ApiTimeoutError(undefined, { cause: error })
  }
  if (error.code === AxiosError.ERR_CANCELED) {
    return new ApiAbortError(undefined, { cause: error })
  }
  if (error.response) {
    const { status, statusText, data } = error.response
    const body = typeof data === 'string' ? data : safeStringify(data)
    return new ApiError(`API error: ${status} ${statusText}`, { status, body, cause: error })
  }
  return new ApiError(error.message, { cause: error })
}

function safeStringify(data: unknown): string {
  if (data === null || data === undefined) return ''
  try {
    return JSON.stringify(data)
  } catch {
    return String(data)
  }
}

function parseWithSchema<Schema extends zod.ZodTypeAny>(
  data: unknown,
  schema: Schema,
  url: string,
): zod.output<Schema> {
  const parsed = schema.safeParse(data)
  if (!parsed.success) {
    const validationError = new ApiValidationError(
      `Response validation failed for ${url}: ${parsed.error.message}`,
      parsed.error.issues,
    )
    // What ErrorHandler.processWithoutFeedback does, without its React imports.
    console.error(validationError)
    throw validationError
  }
  return parsed.data
}

function isZodSchema(value: unknown): value is zod.ZodTypeAny {
  return typeof (value as { safeParse?: unknown } | undefined)?.safeParse === 'function'
}

export async function requestJson<Schema extends zod.ZodTypeAny>(
  url: string,
  schema: Schema,
  config?: AxiosRequestConfig,
): Promise<zod.output<Schema>> {
  const { data } = await apiClient.request<unknown>({ ...config, url })
  return parseWithSchema(data, schema, url)
}

/** POSTs `body` as JSON and parses the JSON response with `schema`. */
export async function postJson<Schema extends zod.ZodTypeAny>(
  url: string,
  body: unknown,
  schema: Schema,
  config?: AxiosRequestConfig,
): Promise<zod.output<Schema>> {
  const { data } = await apiClient.request<unknown>({ ...config, url, method: 'POST', data: body })
  return parseWithSchema(data, schema, url)
}

/** PUTs `body` as JSON and parses the JSON response with `schema`. */
export async function putJson<Schema extends zod.ZodTypeAny>(
  url: string,
  body: unknown,
  schema: Schema,
  config?: AxiosRequestConfig,
): Promise<zod.output<Schema>> {
  const { data } = await apiClient.request<unknown>({ ...config, url, method: 'PUT', data: body })
  return parseWithSchema(data, schema, url)
}

/** DELETEs with `body` as JSON, for endpoints that answer with no content (`204`). */
export async function deleteJson(
  url: string,
  body: unknown,
  config?: AxiosRequestConfig,
): Promise<void> {
  await apiClient.request<unknown>({ ...config, url, method: 'DELETE', data: body })
}

export function requestText(url: string, config?: AxiosRequestConfig): Promise<string>
export function requestText<Schema extends zod.ZodTypeAny>(
  url: string,
  schema: Schema,
  config?: AxiosRequestConfig,
): Promise<zod.output<Schema>>
export async function requestText<Schema extends zod.ZodTypeAny>(
  url: string,
  schemaOrConfig?: Schema | AxiosRequestConfig,
  maybeConfig?: AxiosRequestConfig,
): Promise<string | zod.output<Schema>> {
  const schema = isZodSchema(schemaOrConfig) ? schemaOrConfig : undefined
  const config = schema ? maybeConfig : (schemaOrConfig as AxiosRequestConfig | undefined)
  const { data } = await apiClient.request<string>({ ...config, url, responseType: 'text' })
  const text = typeof data === 'string' ? data.trim() : ''
  return schema ? parseWithSchema(text, schema, url) : text
}

export async function requestBytes(url: string, config?: AxiosRequestConfig): Promise<Uint8Array> {
  const { data } = await apiClient.request<ArrayBuffer>({
    ...config,
    url,
    responseType: 'arraybuffer',
  })
  return new Uint8Array(data)
}

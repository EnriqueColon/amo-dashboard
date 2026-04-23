/**
 * Normalize caught values to Error for display.
 * Prevents "[object Event]" when a Promise rejects with an Event (e.g. from fetch/abort).
 */
export function normalizeToError(value: unknown): Error {
  if (value instanceof Error) return value
  if (typeof value === "string") return new Error(value)
  if (value && typeof value === "object" && "message" in value && typeof (value as Error).message === "string") {
    return value as Error
  }
  // Event, DOMException, or other non-Error rejection
  const msg = value instanceof Event ? `Request failed (${value.type})` : "An unexpected error occurred"
  return new Error(msg)
}

/**
 * Get a user-friendly message from any caught value.
 */
export function getErrorMessage(value: unknown): string {
  return normalizeToError(value).message
}

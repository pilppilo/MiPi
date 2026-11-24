/** Go's plan errors survive inside the wrapped pi-ai message. HTTP 429 alone is also used for transient throttles. */
export function goLimit(text: string): { resetAt?: number } | undefined {
  if (/^\s*(?:HTTP\s+)?(?:400|401|402)\b/i.test(text)) return undefined;
  return /\b(?:GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached)\b/i.test(text)
    ? {}
    : undefined;
}

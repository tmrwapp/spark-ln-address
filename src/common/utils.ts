export function getDomainFromBaseUrl(baseUrl: string): string {
  try {
    const url = new URL(baseUrl)
    return url.hostname
  } catch {
    throw new Error(`Invalid PUBLIC_BASE_URL: ${baseUrl}`)
  }
}

export function normalizeUsername(username: string): string {
  const normalized = username.toLowerCase().trim()
  if (!/^[a-z0-9._-]{1,30}$/.test(normalized)) {
    throw new Error('Username must be 1-30 characters, lowercase alphanumeric with ._-')
  }
  return normalized
}

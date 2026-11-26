// The official TextBee SDK uses process-global fetch. Constrain its credentialed
// requests in this standalone process so redirects never forward an API key.
export function installUpstreamFetchPolicy(baseUrl, timeoutMs = 30000) {
  const base = new URL(baseUrl)
  const original = globalThis.fetch
  globalThis.fetch = (input, init = {}) => {
    const request = input instanceof Request ? input : undefined
    const headers = new Headers(init.headers ?? request?.headers)
    if (!headers.has('x-api-key')) return original(input, init)
    const target = new URL(request ? request.url : input)
    if (target.origin !== base.origin || !target.pathname.startsWith(`${base.pathname}/`) || target.username || target.password) {
      throw new Error('Credentialed request outside configured TextBee API blocked')
    }
    const signals = [request?.signal, init.signal, AbortSignal.timeout(timeoutMs)].filter(Boolean)
    return original(input, { ...init, redirect: 'error', signal: AbortSignal.any(signals) })
  }
  return () => { globalThis.fetch = original }
}

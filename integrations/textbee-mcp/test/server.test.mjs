import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { once } from 'node:events'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createGateway, configFromEnv } from '../src/server.mjs'
import { installUpstreamFetchPolicy } from '../src/upstream-fetch.mjs'

const keyA = 'test-key-a-not-a-real-secret'
const keyB = 'test-key-b-not-a-real-secret'
const calls = []
let api, gateway, url, config, restoreFetch, authStatus = 200, messageMode = 'normal'

async function listen(server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return `http://127.0.0.1:${server.address().port}`
}
async function close(server) {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
async function connect(key = keyA) {
  const client = new Client({ name: 'test-only', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { 'x-textbee-api-key': key } },
  }))
  return client
}
const rpc = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }
function post(headers = {}, body = JSON.stringify(rpc)) {
  return fetch(url, { method: 'POST', headers: {
    'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers,
  }, body })
}

before(async () => {
  api = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const key = req.headers['x-api-key']
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined
    calls.push({ path: req.url, key, body, method: req.method })
    res.setHeader('content-type', 'application/json')
    if (authStatus !== 200) { res.statusCode = authStatus; res.end('{}'); return }
    if (![keyA, keyB].includes(key)) { res.statusCode = 401; res.end('{}'); return }
    if (req.url === '/api/v1/gateway/devices') {
      res.end(JSON.stringify({ data: [{ _id: key === keyA ? 'device-a' : 'device-b', name: 'Test phone', enabled: true }] }))
    } else if (req.url.startsWith('/api/v1/gateway/messages')) {
      if (messageMode === 'redirect') {
        res.writeHead(302, { location: '/credential-leak' }); res.end(); return
      }
      if (messageMode === 'echo-key') {
        res.writeHead(400); res.end(JSON.stringify({ message: `Do not expose ${key}` })); return
      }
      res.end(JSON.stringify({ data: [{ _id: 'msg-test', message: 'Fixture reply', direction: 'received', sender: '+15550000000' }], meta: { total: 1 } }))
    } else if (req.url === '/api/v1/gateway/send-sms' && req.method === 'POST') {
      res.end(JSON.stringify({ data: { successCount: 1, failureCount: 0 } }))
    } else { res.statusCode = 404; res.end('{}') }
  })
  const apiUrl = await listen(api)
  config = configFromEnv({ TEXTBEE_BASE_URL: apiUrl, MCP_PUBLIC_URL: 'http://127.0.0.1/mcp' })
  restoreFetch = installUpstreamFetchPolicy(config.baseUrl)
  gateway = createGateway(config)
  url = `${await listen(gateway)}/mcp`
})
after(async () => { await close(gateway); await close(api); restoreFetch() })

test('requires explicit self-hosted configuration and rejects credential-bearing URLs', () => {
  assert.throws(() => configFromEnv({}), /Set TEXTBEE/)
  assert.throws(() => configFromEnv({ TEXTBEE_BASE_URL: 'https://user:secret@example.com', MCP_PUBLIC_URL: 'https://example.com/mcp' }), /credentials/)
  assert.throws(() => configFromEnv({ TEXTBEE_BASE_URL: 'http://example.com', MCP_PUBLIC_URL: 'https://example.com/mcp' }), /HTTPS/)
  assert.equal(config.baseUrl.endsWith('/api/v1'), true)
})

test('missing keys are rejected without contacting the API', async () => {
  const count = calls.length
  assert.equal((await post()).status, 401)
  assert.equal(calls.length, count)
})

test('invalid keys, revoked keys, rate limits and upstream failures fail closed', async () => {
  const invalid = await post({ 'x-textbee-api-key': 'invalid-secret-fixture' })
  assert.equal(invalid.status, 401)
  assert.ok(!(await invalid.text()).includes('invalid-secret-fixture'))
  try {
    for (const [upstream, expected] of [[401, 401], [403, 401], [429, 429], [500, 502]]) {
      authStatus = upstream
      assert.equal((await post({ 'x-textbee-api-key': keyA })).status, expected)
    }
  } finally { authStatus = 200 }
})

test('rejects foreign origins and unknown Host values before API access', async () => {
  const count = calls.length
  assert.equal((await post({ 'x-textbee-api-key': keyA, origin: 'https://untrusted.example' })).status, 403)
  const status = await new Promise((resolve, reject) => {
    const req = request(url, { method: 'POST', headers: { host: 'untrusted.example' } }, res => {
      res.resume(); resolve(res.statusCode)
    })
    req.on('error', reject); req.end('{}')
  })
  assert.equal(status, 403)
  assert.equal(calls.length, count)
})

test('malformed JSON, oversized bodies, non-JSON and GET fail clearly', async () => {
  assert.equal((await post({ 'x-textbee-api-key': keyA }, '{')).status, 400)
  assert.equal((await post({ 'x-textbee-api-key': keyA }, 'a'.repeat(300000))).status, 413)
  assert.equal((await post({ 'x-textbee-api-key': keyA, 'content-type': 'text/plain' })).status, 415)
  assert.equal((await fetch(url, { headers: { 'x-textbee-api-key': keyA } })).status, 405)
})

test('real MCP client initializes and discovers the three official tools', async () => {
  const client = await connect()
  try {
    const result = await client.listTools()
    assert.deepEqual(result.tools.map(t => t.name).sort(), ['get_messages', 'list_devices', 'send_sms'])
    assert.equal(result.tools.find(t => t.name === 'send_sms').annotations.idempotentHint, false)
    assert.ok(!JSON.stringify(result).includes(keyA))
  } finally { await client.close() }
})

test('device reads isolate callers and never reuse another account key', async () => {
  const a = await connect(keyA), b = await connect(keyB)
  try {
    const [ra, rb] = await Promise.all([
      a.callTool({ name: 'list_devices', arguments: {} }),
      b.callTool({ name: 'list_devices', arguments: {} }),
    ])
    assert.ok(!ra.isError && !rb.isError)
    assert.match(ra.content[0].text, /device-a/)
    assert.doesNotMatch(ra.content[0].text, /device-b/)
    assert.match(rb.content[0].text, /device-b/)
    assert.doesNotMatch(rb.content[0].text, /device-a/)
  } finally { await a.close(); await b.close() }
})

test('message reads reach the configured API with filters', async () => {
  const client = await connect()
  try {
    const result = await client.callTool({ name: 'get_messages', arguments: { direction: 'received', limit: 5 } })
    assert.ok(!result.isError, JSON.stringify(result))
    assert.match(result.content[0].text, /Fixture reply/)
    const call = calls.findLast(c => c.path.startsWith('/api/v1/gateway/messages'))
    assert.equal(call.key, keyA)
    assert.match(call.path, /limit=5/)
  } finally { await client.close() }
})

test('send tool forwards exactly once to a mock API; no real SMS is sent', async () => {
  const client = await connect()
  const count = calls.filter(c => c.method === 'POST').length
  try {
    const result = await client.callTool({ name: 'send_sms', arguments: {
      recipients: ['+15550000000'], message: 'Mock message only', device_id: 'device-a',
    } })
    assert.ok(!result.isError, JSON.stringify(result))
    const sends = calls.filter(c => c.method === 'POST')
    assert.equal(sends.length, count + 1)
    assert.deepEqual(sends.at(-1).body, { recipients: ['+15550000000'], message: 'Mock message only', deviceId: 'device-a' })
    assert.equal(sends.at(-1).key, keyA)
  } finally { await client.close() }
})


test('credentialed requests cannot change upstream host', () => {
  assert.throws(() => fetch('https://untrusted.example/api/v1/gateway/devices', {
    headers: { 'x-api-key': keyA },
  }), /outside configured/)
})

test('tool calls do not follow an upstream redirect', async () => {
  const client = await connect()
  try {
    messageMode = 'redirect'
    const result = await client.callTool({ name: 'get_messages', arguments: {} })
    assert.equal(result.isError, true)
    assert.ok(!calls.some(c => c.path === '/credential-leak'))
  } finally { messageMode = 'normal'; await client.close() }
})

test('upstream errors cannot reflect API keys into tool results', async () => {
  const client = await connect()
  try {
    messageMode = 'echo-key'
    const result = await client.callTool({ name: 'get_messages', arguments: {} })
    assert.equal(result.isError, true)
    assert.ok(!JSON.stringify(result).includes(keyA))
    assert.match(result.content[0].text, /redacted/)
  } finally { messageMode = 'normal'; await client.close() }
})

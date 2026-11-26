import { configFromEnv, createGateway } from './server.mjs'
import { installUpstreamFetchPolicy } from './upstream-fetch.mjs'

try {
  const config = configFromEnv()
  installUpstreamFetchPolicy(config.baseUrl)
  const gateway = createGateway(config)
  gateway.listen(config.port, config.host, () => {
    console.error(`TextBee MCP listening on ${config.host}:${config.port}; route /mcp`)
  })
  gateway.on('error', () => {
    console.error('TextBee MCP listener could not start')
    process.exitCode = 1
  })
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      gateway.close(() => process.exit(0))
      setTimeout(() => process.exit(0), 5000).unref()
    })
  }
} catch {
  console.error('Invalid MCP configuration; check TEXTBEE_BASE_URL, MCP_PUBLIC_URL, HOST and PORT')
  process.exitCode = 1
}

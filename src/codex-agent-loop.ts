import { isKnownAgent, readAgentRuntime } from './web/agent-config.js'
import { runCodexDispatcherLoop } from './web/codex-exec-dispatcher.js'

const name = process.argv[2]?.trim() ?? ''
if (!name || !isKnownAgent(name)) {
  console.error('usage: codex-agent-loop <registered-agent-name>')
  process.exit(2)
}
if (readAgentRuntime(name) !== 'codex-exec') {
  console.error(`agent '${name}' is not configured for the codex-exec runtime`)
  process.exit(2)
}

await runCodexDispatcherLoop(name)

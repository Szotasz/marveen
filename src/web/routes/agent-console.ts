import { isSessionRunning, capturePane } from '../agent-process.js'
import { MAIN_CHANNELS_SESSION } from '../main-agent.js'
import { json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

interface AgentInfo {
  id: string
  displayName: string
  sessionName: string
  isRunning: boolean
}

const AGENT_INFO: Record<string, AgentInfo> = {
  marveen: {
    id: 'marveen',
    displayName: 'Marveen',
    sessionName: MAIN_CHANNELS_SESSION,
    isRunning: false,
  },
  agrolanc: {
    id: 'agrolanc',
    displayName: 'Sales Mariska',
    sessionName: 'agent-agrolanc',
    isRunning: false,
  },
  coder: {
    id: 'coder',
    displayName: 'Cody a kódmester',
    sessionName: 'agent-coder',
    isRunning: false,
  },
  mutacsi: {
    id: 'mutacsi',
    displayName: 'Műtacsi',
    sessionName: 'agent-mutacsi',
    isRunning: false,
  },
  tanulo: {
    id: 'tanulo',
    displayName: 'Tanító Tóni',
    sessionName: 'agent-tanulo',
    isRunning: false,
  },
}

function getSessionName(agentId: string): string | null {
  const info = AGENT_INFO[agentId]
  return info ? info.sessionName : null
}

function getAgentIdFromSessionName(sessionName: string): string | null {
  for (const [agentId, info] of Object.entries(AGENT_INFO)) {
    if (info.sessionName === sessionName) return agentId
  }
  return null
}

function getCaptureLines(output: string | null, lineCount: number = 50): string {
  if (!output) return '[no output]'
  const lines = output.split('\n')
  const lastLines = lines.slice(Math.max(0, lines.length - lineCount))
  return lastLines.join('\n')
}

export async function tryHandleAgentConsole(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  // GET /api/agent-console/agents
  if (path === '/api/agent-console/agents' && method === 'GET') {
    const agents = Object.values(AGENT_INFO).map(info => ({
      id: info.id,
      displayName: info.displayName,
      sessionName: info.sessionName,
      isRunning: isSessionRunning(info.sessionName),
    }))
    json(res, agents)
    return true
  }

  // GET /api/agent-console/:session_name
  const consoleMatch = path.match(/^\/api\/agent-console\/([^/]+)$/)
  if (consoleMatch && method === 'GET') {
    const sessionName = decodeURIComponent(consoleMatch[1])
    const agentId = getAgentIdFromSessionName(sessionName)

    if (!agentId) {
      json(res, { error: `Unknown session: ${sessionName}` }, 404)
      return true
    }

    const agentInfo = AGENT_INFO[agentId]
    const isRunning = isSessionRunning(agentInfo.sessionName)
    const rawOutput = isRunning ? capturePane(sessionName) : null
    const output = getCaptureLines(rawOutput, 50)

    json(res, {
      agentId,
      sessionName,
      isRunning,
      output,
      lineCount: rawOutput ? rawOutput.split('\n').length : 0,
      lastUpdate: Date.now(),
    })
    return true
  }

  return false
}

import { readEnvFile } from '../env.js'
import { logger } from '../logger.js'
import { listAgentNames } from './agent-config.js'

export interface SubtaskSuggestion {
  title: string
  description: string
  assignee: string | null
  priority: 'low' | 'normal' | 'high' | 'urgent'
}

export interface BreakdownResult {
  subtasks: SubtaskSuggestion[]
  provider: 'anthropic' | 'gemini'
}

const SYSTEM_PROMPT = `You are a project management assistant that breaks down kanban cards into actionable subtasks.

Given a kanban card's title, description, and context, produce 3-5 concrete subtasks.

Rules:
- Each subtask must be independently completable
- Subtasks should cover the full scope of the parent card
- Suggest an assignee from the available team members when the task clearly matches their role
- Use priority: "normal" unless the subtask is blocking or urgent
- Keep titles under 80 characters
- Descriptions should be 1-2 sentences explaining what to do

Respond with ONLY a JSON array of objects with these fields:
- title (string)
- description (string)
- assignee (string or null)
- priority ("low" | "normal" | "high" | "urgent")

No markdown fences, no explanation, just the JSON array.`

function buildUserPrompt(title: string, description: string | null, agents: string[]): string {
  const parts = [`Card title: ${title}`]
  if (description) parts.push(`Description: ${description}`)
  parts.push(`Available team members: ${agents.join(', ')}`)
  return parts.join('\n')
}

async function callAnthropic(apiKey: string, userPrompt: string): Promise<SubtaskSuggestion[]> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 200)}`)
  }
  const data = await res.json() as { content: Array<{ type: string; text: string }> }
  const text = data.content.find(b => b.type === 'text')?.text ?? '[]'
  return JSON.parse(text) as SubtaskSuggestion[]
}

async function callGemini(apiKey: string, userPrompt: string): Promise<SubtaskSuggestion[]> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ parts: [{ text: userPrompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.3,
      },
    }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Gemini API ${res.status}: ${body.slice(0, 200)}`)
  }
  const data = await res.json() as {
    candidates: Array<{ content: { parts: Array<{ text: string }> } }>
  }
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '[]'
  return JSON.parse(text) as SubtaskSuggestion[]
}

function validateSubtasks(raw: unknown): SubtaskSuggestion[] {
  if (!Array.isArray(raw)) throw new Error('LLM response is not an array')
  if (raw.length < 1 || raw.length > 10) throw new Error(`Expected 1-10 subtasks, got ${raw.length}`)
  const validPriorities = new Set(['low', 'normal', 'high', 'urgent'])
  return raw.map((item: any, i: number) => {
    if (!item.title || typeof item.title !== 'string') throw new Error(`Subtask ${i}: missing title`)
    if (!item.description || typeof item.description !== 'string') throw new Error(`Subtask ${i}: missing description`)
    return {
      title: item.title.slice(0, 120),
      description: item.description.slice(0, 500),
      assignee: typeof item.assignee === 'string' ? item.assignee : null,
      priority: validPriorities.has(item.priority) ? item.priority : 'normal',
    }
  })
}

export async function generateBreakdown(title: string, description: string | null): Promise<BreakdownResult> {
  const env = readEnvFile()
  const anthropicKey = env['ANTHROPIC_API_KEY']
  const geminiKey = env['GOOGLE_API_KEY']

  const agents = listAgentNames()
  const userPrompt = buildUserPrompt(title, description, ['Szabolcs', 'Marveen', ...agents])

  if (anthropicKey) {
    try {
      const raw = await callAnthropic(anthropicKey, userPrompt)
      return { subtasks: validateSubtasks(raw), provider: 'anthropic' }
    } catch (err) {
      logger.warn({ err }, 'Anthropic breakdown failed, trying Gemini fallback')
    }
  }

  if (geminiKey) {
    const raw = await callGemini(geminiKey, userPrompt)
    return { subtasks: validateSubtasks(raw), provider: 'gemini' }
  }

  throw new Error('No API key available (ANTHROPIC_API_KEY or GOOGLE_API_KEY required in .env)')
}

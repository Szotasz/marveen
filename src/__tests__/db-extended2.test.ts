import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { APP_TZ } from '../config.js'
import {
  initDatabase, getDb,
  // Session
  getSession, setSession, incrementSessionCount, clearSession,
  // Memory
  saveAgentMemory, searchMemories, touchMemory, touchMemoriesAccessed,
  decayMemories, getMemoriesForChat, getMemoryStats, updateMemory,
  appendDailyLog, getDailyLog, getDailyLogDates,
  // Background tasks
  createBackgroundTaskAtomic, getRunningBackgroundTasks, finishBackgroundTask,
  getBackgroundTasks, getBackgroundTask, countRunningBackgroundTasks, markOrphanedTasksFailed,
  // Scheduled tasks
  createTask, getDueTasks, updateTaskAfterRun, listTasks, deleteTask,
  pauseTask, resumeTask, getTask, updateTask,
  // Kanban extended
  listKanbanCardsSummary, markKanbanCardDispatched, unarchiveKanbanCard,
  listArchivedKanbanCards, listKanbanProjects, archiveKanbanCard, createKanbanCard,
  // Task runs
  appendTaskRun, listTaskRunHistory, getActiveScheduledTaskCount,
  // Telegram history
  saveTelegramMessage, getTelegramHistory,
  // Ideas
  listIdeas, createIdea, updateIdea, deleteIdea, listIdeaCategories,
  getIdeaComments, addIdeaComment, logIdeaStatusChange, getIdeaStatusLog,
  revertIdeaFromKanban,
  // Vault SSH
  listVaultSshKeys, getVaultSshKey, createVaultSshKey, deleteVaultSshKey,
  computeSshKeyStatus, listVaultSshServers, getVaultSshServer,
  createVaultSshServer, updateVaultSshServer, deleteVaultSshServer,
} from '../db.js'

beforeAll(() => {
  initDatabase(':memory:')
  // telegram_history is not in the baseline migration — create it for tests
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS telegram_history (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id    TEXT NOT NULL,
      message_id TEXT NOT NULL,
      user_id    TEXT,
      direction  TEXT NOT NULL CHECK(direction IN ('in','out')),
      text       TEXT NOT NULL,
      ts         INTEGER NOT NULL,
      UNIQUE(chat_id, message_id)
    )
  `)
})

afterAll(() => {
  const db = getDb()
  db.exec("DELETE FROM sessions WHERE chat_id LIKE 'test-sess-%'")
  db.exec("DELETE FROM memories WHERE agent_id LIKE 'db2-test-%'")
  db.exec("DELETE FROM daily_logs WHERE agent_id LIKE 'db2-test-%'")
  db.exec("DELETE FROM background_tasks WHERE agent_id LIKE 'db2-test-%'")
  db.exec("DELETE FROM scheduled_tasks WHERE chat_id LIKE 'db2-test-%'")
  db.exec("DELETE FROM kanban_cards WHERE id LIKE 'db2-card-%'")
  db.exec("DELETE FROM task_runs WHERE name LIKE 'db2-task-%'")
  db.exec("DELETE FROM telegram_history WHERE chat_id LIKE 'db2-tg-%'")
  db.exec("DELETE FROM idea_box WHERE id LIKE 'db2-idea-%'")
  db.exec("DELETE FROM vault_ssh_keys WHERE id LIKE 'db2-key-%'")
  db.exec("DELETE FROM vault_ssh_servers WHERE id LIKE 'db2-srv-%'")
})

// --- Session management ---

describe('session functions', () => {
  it('setSession + getSession roundtrip', () => {
    setSession('test-sess-1', 'sess-abc', 3)
    const s = getSession('test-sess-1')
    expect(s?.sessionId).toBe('sess-abc')
    expect(s?.messageCount).toBe(3)
  })

  it('getSession returns undefined for unknown chatId', () => {
    expect(getSession('test-sess-unknown-x99')).toBeUndefined()
  })

  it('incrementSessionCount increments and returns new count', () => {
    setSession('test-sess-2', 'sess-def', 0)
    const count = incrementSessionCount('test-sess-2')
    expect(count).toBe(1)
    const count2 = incrementSessionCount('test-sess-2')
    expect(count2).toBe(2)
  })

  it('clearSession removes the session', () => {
    setSession('test-sess-3', 'sess-ghi', 5)
    clearSession('test-sess-3')
    expect(getSession('test-sess-3')).toBeUndefined()
  })
})

// --- Memory functions ---

describe('memory functions', () => {
  beforeAll(() => {
    saveAgentMemory('db2-test-memo', 'Active task about integration tests', 'hot', 'testing,unit')
    saveAgentMemory('db2-test-memo', 'Config preference: use vitest', 'warm', 'vitest,config')
    saveAgentMemory('db2-test-memo', 'Old decision log', 'cold', 'history')
  })

  it('searchMemories returns results for matching query', () => {
    const results = searchMemories('integration', 'chat-x', 3)
    // FTS search on agent memories - may return empty if no chat-specific memories
    expect(Array.isArray(results)).toBe(true)
  })

  it('touchMemory updates accessed_at', () => {
    const mems = getMemoriesForChat('chat-x', 10)
    saveAgentMemory('db2-test-touch', 'Touchable memory', 'hot', '')
    const all = getDb().prepare("SELECT id FROM memories WHERE agent_id = 'db2-test-touch'").all() as { id: number }[]
    if (all.length > 0) {
      expect(() => touchMemory(all[0].id)).not.toThrow()
    }
  })

  it('touchMemoriesAccessed with empty ids is a no-op', () => {
    expect(() => touchMemoriesAccessed([])).not.toThrow()
  })

  it('touchMemoriesAccessed updates accessed_at for given ids', () => {
    const all = getDb().prepare("SELECT id FROM memories WHERE agent_id = 'db2-test-touch'").all() as { id: number }[]
    if (all.length > 0) {
      expect(() => touchMemoriesAccessed(all.map(r => r.id))).not.toThrow()
    }
  })

  it('decayMemories runs without throwing', () => {
    expect(() => decayMemories()).not.toThrow()
  })

  it('getMemoriesForChat returns memories', () => {
    const mems = getMemoriesForChat('chat-x', 5)
    expect(Array.isArray(mems)).toBe(true)
  })

  it('getMemoryStats returns totals', () => {
    const stats = getMemoryStats()
    expect(typeof stats.total).toBe('number')
    expect(typeof stats.withEmbedding).toBe('number')
    expect(typeof stats.byAgent).toBe('object')
    expect(typeof stats.byTier).toBe('object')
    expect(stats.total).toBeGreaterThan(0)
  })

  it('getMemoryStats.withEmbedding counts embedding_blob, not just the legacy JSON column', () => {
    const db = getDb()
    // Simulate the post-0005-migration state: a memory whose vector lives in the
    // binary embedding_blob column, with the legacy `embedding` JSON column NULL.
    const before = getMemoryStats().withEmbedding
    // 768-dim to satisfy the vec_memories(embedding FLOAT[768]) insert trigger.
    const buf = Buffer.from(new Float32Array(768).fill(0.1).buffer)
    db.prepare(
      "INSERT INTO memories (chat_id, content, sector, salience, created_at, accessed_at, agent_id, category, embedding, embedding_blob) VALUES ('c', 'blob-only vector', 'semantic', 1.0, unixepoch(), unixepoch(), 'stat-blob-test', 'warm', NULL, ?)"
    ).run(buf)
    expect(getMemoryStats().withEmbedding).toBe(before + 1)
  })

  it('updateMemory updates content and returns true', () => {
    const all = getDb().prepare("SELECT id FROM memories WHERE agent_id = 'db2-test-memo' LIMIT 1").all() as { id: number }[]
    if (all.length > 0) {
      const ok = updateMemory(all[0].id, 'Updated content text', 'warm', 'db2-test-memo', 'updated')
      expect(ok).toBe(true)
    }
  })

  it('updateMemory returns false for non-existent id', () => {
    const ok = updateMemory(999999, 'no such mem', 'hot')
    expect(ok).toBe(false)
  })
})

// --- Daily logs ---

describe('daily log functions', () => {
  it('appendDailyLog + getDailyLog roundtrip', () => {
    appendDailyLog('db2-test-logs', 'First log entry')
    appendDailyLog('db2-test-logs', 'Second log entry')
    const today = new Date().toLocaleDateString('en-CA', { timeZone: APP_TZ })
    const logs = getDailyLog('db2-test-logs', today)
    expect(logs.length).toBeGreaterThanOrEqual(2)
    expect(logs[0].content).toBe('First log entry')
  })

  it('getDailyLogDates returns distinct dates', () => {
    const dates = getDailyLogDates('db2-test-logs')
    expect(Array.isArray(dates)).toBe(true)
    expect(dates.length).toBeGreaterThanOrEqual(1)
  })

  it('getDailyLog returns empty array for unknown agent', () => {
    const logs = getDailyLog('unknown-agent-x99', '2020-01-01')
    expect(logs).toEqual([])
  })
})

// --- Background tasks ---

describe('background task functions', () => {
  it('createBackgroundTaskAtomic creates a task when under concurrency limit', () => {
    const task = createBackgroundTaskAtomic('db2-bg-1', 'db2-test-agent', 'run tests', 'sess-x', 5)
    expect(task).not.toBeNull()
    expect(task?.id).toBe('db2-bg-1')
    expect(task?.status).toBe('running')
  })

  it('createBackgroundTaskAtomic returns null when at concurrency limit', () => {
    // maxConcurrent=0 means no slots available
    const task = createBackgroundTaskAtomic('db2-bg-zero', 'db2-test-agent', 'blocked', 'sess-y', 0)
    expect(task).toBeNull()
  })

  it('getRunningBackgroundTasks returns running tasks', () => {
    const tasks = getRunningBackgroundTasks()
    expect(tasks.some(t => t.id === 'db2-bg-1')).toBe(true)
  })

  it('getBackgroundTask retrieves a task by id', () => {
    const t = getBackgroundTask('db2-bg-1')
    expect(t?.agent_id).toBe('db2-test-agent')
  })

  it('countRunningBackgroundTasks returns correct count', () => {
    const count = countRunningBackgroundTasks('db2-test-agent')
    expect(count).toBeGreaterThanOrEqual(1)
  })

  it('finishBackgroundTask marks task as done', () => {
    finishBackgroundTask('db2-bg-1', 'done', 'output text')
    const t = getBackgroundTask('db2-bg-1')
    expect(t?.status).toBe('done')
    expect(t?.output).toBe('output text')
  })

  it('getBackgroundTasks can filter by agentId and includeFinished', () => {
    const all = getBackgroundTasks('db2-test-agent', true)
    expect(all.some(t => t.id === 'db2-bg-1')).toBe(true)
    const running = getBackgroundTasks('db2-test-agent', false)
    expect(running.every(t => t.status === 'running')).toBe(true)
  })

  it('markOrphanedTasksFailed returns a count', () => {
    const count = markOrphanedTasksFailed()
    expect(typeof count).toBe('number')
  })
})

// --- Scheduled tasks ---

describe('scheduled task functions', () => {
  const taskId = 'db2-sched-1'

  it('createTask + getTask roundtrip', () => {
    const nextRun = Math.floor(Date.now() / 1000) + 3600
    createTask(taskId, 'db2-test-chat', 'daily check', '0 9 * * *', nextRun)
    const t = getTask(taskId)
    expect(t?.id).toBe(taskId)
    expect(t?.status).toBe('active')
  })

  it('listTasks returns the created task', () => {
    const tasks = listTasks()
    expect(tasks.some(t => t.id === taskId)).toBe(true)
  })

  it('getDueTasks returns tasks with next_run in the past', () => {
    const pastRun = Math.floor(Date.now() / 1000) - 60
    createTask('db2-sched-due', 'db2-test-chat', 'overdue', '* * * * *', pastRun)
    const due = getDueTasks()
    expect(due.some(t => t.id === 'db2-sched-due')).toBe(true)
  })

  it('updateTaskAfterRun updates last_run and next_run', () => {
    const newNext = Math.floor(Date.now() / 1000) + 7200
    updateTaskAfterRun(taskId, newNext, 'success')
    const t = getTask(taskId)
    expect(t?.next_run).toBe(newNext)
    expect(t?.last_result).toBe('success')
  })

  it('pauseTask pauses and resumeTask resumes', () => {
    const paused = pauseTask(taskId)
    expect(paused).toBe(true)
    expect(getTask(taskId)?.status).toBe('paused')
    const resumed = resumeTask(taskId)
    expect(resumed).toBe(true)
    expect(getTask(taskId)?.status).toBe('active')
  })

  it('updateTask changes prompt and schedule', () => {
    const newNext = Math.floor(Date.now() / 1000) + 3600
    const ok = updateTask(taskId, 'new prompt', '0 10 * * *', newNext)
    expect(ok).toBe(true)
    expect(getTask(taskId)?.prompt).toBe('new prompt')
  })

  it('deleteTask removes the task', () => {
    const ok = deleteTask('db2-sched-due')
    expect(ok).toBe(true)
    expect(getTask('db2-sched-due')).toBeUndefined()
  })

  it('getActiveScheduledTaskCount returns count and nextRun', () => {
    const result = getActiveScheduledTaskCount()
    expect(typeof result.count).toBe('number')
    // nextRun is null if no active tasks, or a number
    expect(result.nextRun === null || typeof result.nextRun === 'number').toBe(true)
  })
})

// --- Kanban extended ---

describe('kanban extended functions', () => {
  it('listKanbanCardsSummary returns cards with required fields', () => {
    createKanbanCard({ id: 'db2-card-1', title: 'Test card', status: 'planned', priority: 'normal' })
    const summary = listKanbanCardsSummary()
    expect(Array.isArray(summary)).toBe(true)
    const card = summary.find(c => c.id === 'db2-card-1')
    expect(card?.title).toBe('Test card')
  })

  it('markKanbanCardDispatched marks a card as dispatched', () => {
    const ok = markKanbanCardDispatched('db2-card-1')
    expect(ok).toBe(true)
    const db = getDb()
    const row = db.prepare("SELECT dispatched_at FROM kanban_cards WHERE id = 'db2-card-1'").get() as any
    expect(row?.dispatched_at).not.toBeNull()
  })

  it('archiveKanbanCard archives a card', () => {
    const ok = archiveKanbanCard('db2-card-1')
    expect(ok).toBe(true)
  })

  it('unarchiveKanbanCard restores an archived card', () => {
    const ok = unarchiveKanbanCard('db2-card-1')
    expect(ok).toBe(true)
    const db = getDb()
    const row = db.prepare("SELECT archived_at FROM kanban_cards WHERE id = 'db2-card-1'").get() as any
    expect(row?.archived_at).toBeNull()
  })

  it('listArchivedKanbanCards returns archived cards', () => {
    archiveKanbanCard('db2-card-1')
    const archived = listArchivedKanbanCards({ limit: 100 })
    expect(archived.some(c => c.id === 'db2-card-1')).toBe(true)
  })

  it('listKanbanProjects returns project list', () => {
    createKanbanCard({ id: 'db2-card-2', title: 'Project card', status: 'planned', priority: 'high', project: 'my-project' })
    const projects = listKanbanProjects()
    expect(projects).toContain('my-project')
  })
})

// --- Task runs ---

describe('task run functions', () => {
  it('appendTaskRun inserts a run entry', () => {
    appendTaskRun('db2-task-heartbeat', 'jarvis', 'fired')
    const history = listTaskRunHistory('db2-task-heartbeat', 10)
    expect(history.length).toBeGreaterThanOrEqual(1)
    expect(history[0].status).toBe('fired')
  })

  it('listTaskRunHistory returns tokens_est as null or number', () => {
    const history = listTaskRunHistory('db2-task-heartbeat', 10)
    expect(history[0].tokens_est === null || typeof history[0].tokens_est === 'number').toBe(true)
  })
})

// --- Telegram history ---

describe('telegram history functions', () => {
  it('saveTelegramMessage + getTelegramHistory roundtrip', () => {
    saveTelegramMessage('db2-tg-chat1', 'msg-1', 'in', 'Hello from user', 'user-999')
    saveTelegramMessage('db2-tg-chat1', 'msg-2', 'out', 'Hello back!', undefined)
    const history = getTelegramHistory('db2-tg-chat1', 50)
    expect(history.length).toBeGreaterThanOrEqual(2)
    expect(history.some(h => h.text === 'Hello from user')).toBe(true)
  })

  it('INSERT OR IGNORE prevents duplicate message_ids', () => {
    saveTelegramMessage('db2-tg-chat1', 'msg-1', 'in', 'Duplicate attempt')
    const history = getTelegramHistory('db2-tg-chat1', 50)
    const msgOnes = history.filter(h => h.message_id === 'msg-1')
    expect(msgOnes.length).toBe(1)
  })

  it('getTelegramHistory returns empty for unknown chat', () => {
    const history = getTelegramHistory('db2-tg-unknown-x99', 10)
    expect(history).toEqual([])
  })
})

// --- Ideas ---

describe('idea box functions', () => {
  it('createIdea + listIdeas roundtrip', () => {
    createIdea({ id: 'db2-idea-1', title: 'Great idea', description: 'Details here', category: 'Fejlesztes', status: 'new', source: 'jarvis', kanban_id: null, impact: 4, effort: 2 })
    const ideas = listIdeas()
    expect(ideas.some(i => i.id === 'db2-idea-1')).toBe(true)
  })

  it('listIdeas filters by status', () => {
    const newIdeas = listIdeas({ status: 'new' })
    expect(newIdeas.some(i => i.id === 'db2-idea-1')).toBe(true)
    const reviewedIdeas = listIdeas({ status: 'reviewed' })
    expect(reviewedIdeas.some(i => i.id === 'db2-idea-1')).toBe(false)
  })

  it('listIdeas filters by category', () => {
    const cats = listIdeas({ category: 'Fejlesztes' })
    expect(cats.some(i => i.id === 'db2-idea-1')).toBe(true)
  })

  it('updateIdea updates fields', () => {
    const ok = updateIdea('db2-idea-1', { status: 'reviewed', title: 'Updated idea', impact: 5 })
    expect(ok).toBe(true)
    const ideas = listIdeas({ status: 'reviewed' })
    const idea = ideas.find(i => i.id === 'db2-idea-1')
    expect(idea?.title).toBe('Updated idea')
    expect(idea?.impact).toBe(5)
  })

  it('listIdeaCategories returns known categories', () => {
    const cats = listIdeaCategories()
    expect(cats).toContain('Fejlesztes')
  })

  it('addIdeaComment + getIdeaComments roundtrip', () => {
    const comment = addIdeaComment('db2-idea-1', 'rick', 'This is a great idea!')
    expect(comment.idea_id).toBe('db2-idea-1')
    expect(comment.author).toBe('rick')
    const comments = getIdeaComments('db2-idea-1')
    expect(comments.some(c => c.content === 'This is a great idea!')).toBe(true)
  })

  it('logIdeaStatusChange + getIdeaStatusLog roundtrip', () => {
    logIdeaStatusChange('db2-idea-1', 'new', 'reviewed', 'rick', 'Looks good')
    const log = getIdeaStatusLog('db2-idea-1')
    expect(log.some(l => l.to_status === 'reviewed' && l.actor === 'rick')).toBe(true)
  })

  it('revertIdeaFromKanban reverts a kanban idea to reviewed', () => {
    createIdea({ id: 'db2-idea-2', title: 'Kanban idea', description: null, category: 'Egyeb', status: 'kanban', source: 'dave', kanban_id: 'db2-card-k1', impact: null, effort: null })
    const reverted = revertIdeaFromKanban('db2-card-k1')
    expect(reverted).toBe('db2-idea-2')
    const ideas = listIdeas()
    const idea = ideas.find(i => i.id === 'db2-idea-2')
    expect(idea?.status).toBe('reviewed')
    expect(idea?.kanban_id).toBeNull()
  })

  it('revertIdeaFromKanban returns null for unknown kanban card', () => {
    const result = revertIdeaFromKanban('no-such-card')
    expect(result).toBeNull()
  })

  it('deleteIdea removes the idea', () => {
    const ok = deleteIdea('db2-idea-1')
    expect(ok).toBe(true)
    const ideas = listIdeas()
    expect(ideas.some(i => i.id === 'db2-idea-1')).toBe(false)
  })
})

// --- Vault SSH ---

describe('vault SSH functions', () => {
  it('computeSshKeyStatus returns "missing" for null key', () => {
    const server: any = { ssh_key_id: null }
    expect(computeSshKeyStatus(server)).toBe('missing')
  })

  it('computeSshKeyStatus returns "ok" for non-null key', () => {
    const server: any = { ssh_key_id: 'key-123' }
    expect(computeSshKeyStatus(server)).toBe('ok')
  })

  it('createVaultSshKey + getVaultSshKey roundtrip', () => {
    const key = createVaultSshKey({
      id: 'db2-key-1',
      label: 'Test Key',
      username: 'root',
      vault_key_id: 'vault-key-abc',
      public_key: 'ssh-rsa AAAAB3N...',
      fingerprint: 'SHA256:abc',
      key_type: 'ed25519',
    })
    expect(key.id).toBe('db2-key-1')
    const retrieved = getVaultSshKey('db2-key-1')
    expect(retrieved?.label).toBe('Test Key')
  })

  it('listVaultSshKeys returns created key', () => {
    const keys = listVaultSshKeys()
    expect(keys.some(k => k.id === 'db2-key-1')).toBe(true)
  })

  it('deleteVaultSshKey removes key and unassigns servers', () => {
    const result = deleteVaultSshKey('db2-key-1')
    expect(result.deleted).toBe(true)
    expect(result.unassigned).toBeGreaterThanOrEqual(0)
    expect(getVaultSshKey('db2-key-1')).toBeUndefined()
  })

  it('createVaultSshServer + getVaultSshServer roundtrip', () => {
    const server = createVaultSshServer({
      id: 'db2-srv-1',
      name: 'Test Server',
      host: '192.168.1.1',
      port: 22,
      username: 'deploy',
      description: 'Test server',
    })
    expect(server.id).toBe('db2-srv-1')
    expect(server.ssh_key_id).toBeNull()
    const retrieved = getVaultSshServer('db2-srv-1')
    expect(retrieved?.name).toBe('Test Server')
  })

  it('listVaultSshServers returns created server', () => {
    const servers = listVaultSshServers()
    expect(servers.some(s => s.id === 'db2-srv-1')).toBe(true)
  })

  it('updateVaultSshServer updates fields', () => {
    const ok = updateVaultSshServer('db2-srv-1', { port: 2222, description: 'Updated' })
    expect(ok).toBe(true)
    const srv = getVaultSshServer('db2-srv-1')
    expect(srv?.port).toBe(2222)
    expect(srv?.description).toBe('Updated')
  })

  it('deleteVaultSshServer removes server', () => {
    const ok = deleteVaultSshServer('db2-srv-1')
    expect(ok).toBe(true)
    expect(getVaultSshServer('db2-srv-1')).toBeUndefined()
  })
})

// AUTO-GENERATED -- do not edit manually
// Source: docs/openapi.yaml (1.0.0)
// Generator: scripts/generate-sdk.mjs
// Run `npm run generate:sdk` to regenerate after spec changes.

// -------------------------------------------------------------------------
// Component schemas
// -------------------------------------------------------------------------

export interface Error {
  /** Human-readable error description */
  error: string;
}

export interface OkResponse {
  ok: boolean;
}

export interface Memory {
  id: number;
  /** Owning agent id, or "import" for imported shadow rows */
  agent_id: string;
  content: string;
  category: 'hot' | 'warm' | 'cold' | 'shared';
  keywords?: string | null;
  /** Unix timestamp (seconds) */
  created_at: number;
  /** Unix timestamp (seconds) */
  accessed_at: number;
  /** Unix timestamp (seconds) */
  updated_at?: number;
  /** Only included when agent filter active. True when the memory was updated after the agent's last read.
 */
  is_stale?: boolean;
  /** Human-readable created_at (localised) */
  created_label?: string;
  /** Human-readable accessed_at (localised) */
  accessed_label?: string;
}

export interface MemoryLink {
  src_id: number;
  dst_id: number;
  weight: number;
  created_at?: number;
}

export interface AgentMessage {
  id: number;
  from_agent: string;
  to_agent: string;
  content: string;
  status: 'pending' | 'delivered' | 'done' | 'failed';
  result?: string | null;
  origin_note?: string | null;
  created_at: number;
  delivered_at?: number | null;
  completed_at?: number | null;
  trace_id?: string | null;
  span_id?: string | null;
}

export interface KanbanCard {
  /** 8-character hex id */
  id: string;
  /** Human-facing sequential number */
  seq?: number;
  title: string;
  description?: string | null;
  status: 'planned' | 'in_progress' | 'waiting' | 'done';
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  assignee?: string | null;
  parent_id?: string | null;
  project?: string | null;
  created_at?: number;
  updated_at?: number;
  dispatched_at?: number | null;
}

export interface KanbanComment {
  id: number;
  card_id: string;
  author: string;
  content: string;
  created_at: number;
}

export interface Approval {
  /** UUID */
  id: string;
  agent_id: string;
  category: string;
  action_description: string;
  /** Optional JSON payload for the action */
  action_payload?: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'timeout';
  resolved_by?: string | null;
  timeout_at?: number | null;
  created_at: number;
  resolved_at?: number | null;
}

export interface BlackboardRow {
  /** 8-character hex id */
  id: string;
  agent_id: string;
  /** Kanban card id (optional reference) */
  task_ref?: string | null;
  status: 'active' | 'done' | 'blocked';
  summary: string;
  updated_at: number;
}

export interface BlackboardHistoryRow {
  /** Auto-increment primary key */
  id: number;
  agent_id: string;
  /** Kanban card id at the time of the write */
  task_ref?: string | null;
  status: 'active' | 'done' | 'blocked';
  summary: string;
  /** Unix timestamp of when this transition was recorded */
  created_at: number;
}

export interface SkillUsageSummaryRow {
  skill_name: string;
  /** Unix timestamp of most recent use */
  last_used_at: number;
  total_count: number;
  count_30d: number;
  count_90d: number;
}

export interface DailyLog {
  agent_id?: string;
  date?: string;
  entries?: {
    content?: string;
    created_at?: number;
  }[];
}

// -------------------------------------------------------------------------
// Utility types
// -------------------------------------------------------------------------

/** Generic paginated response wrapper (not yet used by the spec but available for consumers) */
export type PaginatedResponse<T> = { items: T[]; total: number; cursor?: string }

// -------------------------------------------------------------------------
// Per-operation request / response aliases
// -------------------------------------------------------------------------

export type ListMemoriesResponse = Memory[]

export type ListStaleMemoriesResponse = Memory[]

export type ListMemoryLinksResponse = MemoryLink[]

export type RecordMemoryReadEventRequest = {
  agent_id: string;
  memory_id: number;
  context?: 'heartbeat' | 'search' | 'direct';
} | {
  reads: ({
    agent_id: string;
    memory_id: number;
    context?: 'heartbeat' | 'search' | 'direct';
  })[];
}
export type RecordMemoryReadEventResponse = OkResponse

export type ResortMemoriesResponse = OkResponse & Record<string, unknown>

export type MaintainMemoryLinksResponse = OkResponse & Record<string, unknown>

export type GetMemoryResponse = Memory

export type UpdateMemoryResponse = OkResponse

export type DeleteMemoryResponse = OkResponse

export type GetMemoryVersionsResponse = Record<string, unknown>[]

export type GetMemoryDetailResponse = Memory & {
  read_count?: number;
  neighbors?: Record<string, unknown>[];
  tier_history?: Record<string, unknown>[];
  import_meta?: Record<string, unknown> | null;
}

export type ListMessagesResponse = AgentMessage[]

export type SendMessageResponse = AgentMessage

export type ListMessageThreadsResponse = Record<string, unknown>[]

export type GetMessageBacklogResponse = Record<string, unknown>[]

export type UpdateMessageStatusResponse = OkResponse

export type ListKanbanCardsResponse = KanbanCard[]

export type CreateKanbanCardResponse = KanbanCard

export type GetKanbanCardResponse = KanbanCard

export type UpdateKanbanCardResponse = OkResponse

export type DeleteKanbanCardResponse = OkResponse

export type MoveKanbanCardResponse = OkResponse

export type ListKanbanCardCommentsResponse = KanbanComment[]

export type AddKanbanCardCommentResponse = KanbanComment

export type ListKanbanLabelsResponse = Record<string, unknown>[]

export type ListKanbanProjectsResponse = Record<string, unknown>[]

export type ListKanbanAssigneesResponse = string[]

export type ListArchivedKanbanCardsResponse = KanbanCard[]

export type ListApprovalsResponse = Approval[]

export type CreateApprovalResponse = Approval

export type GetApprovalResponse = Approval

export type ResolveApprovalResponse = Approval

export type ListBlackboardResponse = BlackboardRow[]

export type ListBlackboardHistoryResponse = BlackboardHistoryRow[]

export type GetDailyLogResponse = DailyLog

export type AppendDailyLogResponse = OkResponse

export type ListDailyLogDatesResponse = string[]

export type ListSkillUsageResponse = {
  id?: number;
  agent_id?: string;
  skill_name?: string;
  trigger_type?: 'tool_call' | 'skill_read';
  session_id?: string | null;
  created_at?: number;
}[]

export type RecordSkillUsageResponse = OkResponse

export type GetSkillUsageSummaryResponse = SkillUsageSummaryRow[]

export type GetSkillUsageStatsResponse = Record<string, unknown>[]

export type ListGlobalSkillsResponse = {
  name?: string;
  label?: string;
  description?: string;
  keywords?: string[];
  mtime?: number;
}[]

export type ListLocalSkillsResponse = Record<string, unknown>[]

export type ListAgentsResponse = {
  id?: string;
  display_name?: string;
  model?: string;
  running?: boolean;
}[]

export type UpdateAgentConfigResponse = OkResponse

export type DeleteAgentResponse = OkResponse

export type ListSchedulesResponse = Record<string, unknown>[]

export type ListPendingSchedulesResponse = Record<string, unknown>[]

export type ListScheduledAgentsResponse = string[]

export type ListIdeasResponse = Record<string, unknown>[]

export type ListIdeaCategoriesResponse = string[]

export type ListArtifactsResponse = Record<string, unknown>[]

export type ListTokenUsageResponse = Record<string, unknown>[]

export type RecordTokenUsageResponse = OkResponse

export type GetTokenUsageSummaryResponse = Record<string, unknown>[]

export type GetTokenUsageTimelineResponse = Record<string, unknown>[]

export type GetTokenUsageModelDistResponse = Record<string, unknown>[]

export type GetTokenUsageToolStatsResponse = Record<string, unknown>[]

export type ListConnectorsResponse = Record<string, unknown>[]

export type RefreshConnectorsResponse = OkResponse

export type ListExternalPathsResponse = string[]

export type AddExternalPathResponse = OkResponse

export type RemoveExternalPathResponse = OkResponse

export type ListGithubReposResponse = Record<string, unknown>[]

export type ListRecallDatesResponse = string[]

export type UpdateAutonomyLevelResponse = OkResponse

export type ListBackgroundTasksResponse = Record<string, unknown>[]

export type ListToolLogResponse = Record<string, unknown>[]

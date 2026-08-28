/**
 * Static registry of known MCP servers and their tools.
 *
 * Used by agent-scaffold to generate per-agent permissions.deny entries for
 * every MCP tool that is NOT in the agent's mcpScope allowlist. A tool-name
 * deny is enforced even under --dangerously-skip-permissions (deny is checked
 * before the bypass allow), so this is the fail-closed enforcement layer for
 * per-agent MCP capability scoping.
 *
 * Adding a new MCP server: append it here. Removing a tool from a server that
 * an agent is already allowed: add it to the server list so it can be denied
 * for agents that don't declare it in their mcpScope.
 *
 * Agent names are NOT present here. This registry is agent-agnostic.
 */

export const MCP_TOOL_REGISTRY: Record<string, readonly string[]> = {
  github: [
    'add_issue_comment',
    'create_branch',
    'create_issue',
    'create_or_update_file',
    'create_pull_request',
    'create_pull_request_review',
    'create_repository',
    'fork_repository',
    'get_file_contents',
    'get_issue',
    'get_pull_request',
    'get_pull_request_comments',
    'get_pull_request_files',
    'get_pull_request_reviews',
    'get_pull_request_status',
    'list_commits',
    'list_issues',
    'list_pull_requests',
    'merge_pull_request',
    'push_files',
    'search_code',
    'search_issues',
    'search_repositories',
    'search_users',
    'update_issue',
    'update_pull_request_branch',
  ],
  gitlab: [
    'approve_merge_request',
    'cancel_pipeline',
    'cancel_pipeline_job',
    'create_branch',
    'create_issue',
    'create_issue_note',
    'create_label',
    'create_merge_request',
    'create_merge_request_note',
    'create_merge_request_thread',
    'create_milestone',
    'create_or_update_file',
    'create_pipeline',
    'create_repository',
    'delete_branch',
    'delete_issue',
    'delete_label',
    'delete_milestone',
    'delete_wiki_page',
    'fork_repository',
    'get_branch',
    'get_commit',
    'get_commit_diff',
    'get_file_blame',
    'get_file_contents',
    'get_issue',
    'get_label',
    'get_merge_request',
    'get_merge_request_diffs',
    'get_merge_request_notes',
    'get_milestone',
    'get_pipeline',
    'get_pipeline_job',
    'get_pipeline_job_output',
    'get_project',
    'get_repository_tree',
    'get_user',
    'get_wiki_page',
    'list_branches',
    'list_commits',
    'list_issues',
    'list_labels',
    'list_merge_request_changed_files',
    'list_merge_requests',
    'list_milestones',
    'list_pipeline_jobs',
    'list_pipelines',
    'list_projects',
    'list_wiki_pages',
    'merge_merge_request',
    'protect_branch',
    'push_files',
    'retry_pipeline',
    'search_repositories',
    'unapprove_merge_request',
    'unprotect_branch',
    'update_issue',
    'update_label',
    'update_merge_request',
    'update_wiki_page',
    'whoami',
  ],
}

/**
 * Tools that should always be denied regardless of mcpScope, because they are
 * destructive or irreversible. Operators can opt out by not including these in
 * their deny list, but the scaffold includes them by default when mcpScope is
 * declared. Exported so the UI (the mcp-catalog) can surface them as
 * "dangerous" with a warning.
 */
export const MCP_DANGEROUS_TOOLS: readonly string[] = [
  'mcp__github__push_files',
  'mcp__github__create_pull_request',
  'mcp__github__merge_pull_request',
  'mcp__github__fork_repository',
  'mcp__github__create_repository',
  'mcp__gitlab__push_files',
  'mcp__gitlab__merge_merge_request',
  'mcp__gitlab__delete_branch',
  'mcp__gitlab__delete_issue',
  'mcp__gitlab__delete_label',
  'mcp__gitlab__delete_milestone',
  'mcp__gitlab__delete_wiki_page',
  'mcp__gitlab__fork_repository',
]

/**
 * Resolved MCP scope: per-server tool allow lists, or null when unmanaged.
 * "*" means all tools for that server are allowed.
 */
export type McpScope = Record<string, string[] | '*'> | null

/**
 * Parse and validate the mcpScope field from agent-config.json.
 * Returns null when the field is absent (unmanaged = backward-compat mode).
 * Unknown server names are kept as-is (forward-compat).
 */
export function parseMcpScope(raw: unknown): McpScope {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) return null
  const scope: Record<string, string[] | '*'> = {}
  for (const [server, tools] of Object.entries(raw as Record<string, unknown>)) {
    if (tools === '*') {
      scope[server] = '*'
    } else if (Array.isArray(tools) && tools.every(t => typeof t === 'string')) {
      scope[server] = tools as string[]
    }
    // invalid entries silently dropped (forward-compat)
  }
  return scope
}

/**
 * Build the list of MCP tool deny entries for a given scope and registry.
 *
 * When scope is null (unmanaged): returns [] -- no MCP denies generated.
 * When scope is defined: every tool in the registry that is NOT in the scope
 * gets an explicit deny entry in "mcp__<server>__<tool>" format.
 *
 * Pure function: no side effects, fully unit-testable with synthetic fixtures.
 */
export function buildMcpDenyList(scope: McpScope, registry: Record<string, readonly string[]>): string[] {
  if (scope === null) return []
  const deny: string[] = []
  for (const [server, tools] of Object.entries(registry)) {
    const allowed = scope[server]
    if (allowed === '*') continue // entire server allowed
    const allowedSet = new Set(Array.isArray(allowed) ? allowed : [])
    for (const tool of tools) {
      if (!allowedSet.has(tool)) {
        deny.push(`mcp__${server}__${tool}`)
      }
    }
  }
  return deny
}

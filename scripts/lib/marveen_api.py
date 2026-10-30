#!/usr/bin/env python3
"""marveen_api.py -- the dashboard-API calls an agent's CLAUDE.md prescribes, without `$(cat token)`.

WHY (#2232): every recipe in a sub-agent's CLAUDE.md was a `curl ... -H "Authorization: Bearer
$(cat <token file>)"` line. A strict-profile agent runs under `defaultMode: dontAsk`, where a
command substitution never matches the allow-list, so each of those calls was auto-denied: the
agent could not save or search memory, write the daily log, verify a system directive, close a
message or ask for an approval. This helper reads the token itself, so the allow-listed command
line carries no substitution, and every payload comes from a FILE, never from shell
interpolation of the agent's text.

The token never appears in an argv: it is read here and sent in a request header by urllib, so
`ps` (which shows other users' argv on this host) cannot see it.

Entry point: scripts/marveen-api.sh (the allow-listed command), which runs this file. The
`message` verb is handled there, by the existing scripts/agent-msg.sh.

Exit codes: 0 = HTTP 2xx; 1 = the server answered with a non-2xx status (the body is printed to
stderr); 2 = usage error or no token, nothing was sent; 3 = the dashboard could not be reached or did not answer.
"""
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CATEGORIES = ('hot', 'warm', 'cold', 'shared')
NAME_RE = re.compile(r'^[a-z0-9][a-z0-9-]{0,63}$')
ID_RE = re.compile(r'^[0-9]{1,18}$')
APPROVAL_ID_RE = re.compile(r'^[A-Za-z0-9_-]{1,64}$')
CATEGORY_KEY_RE = re.compile(r'^[a-z][a-z0-9_]{1,63}$')
HASH_RE = re.compile(r'^[A-Za-z0-9:_-]{8,128}$')
# a card id is one path segment: no '/', '.', '?' or '#', so it cannot leave /api/kanban/<id>/
CARD_ID_RE = re.compile(r'^[A-Za-z0-9_-]{1,64}$')
# the status set belongs to the server; this only keeps the value one plain token
STATUS_RE = re.compile(r'^[a-z][a-z_]{1,31}$')
PRIORITIES = ('low', 'normal', 'high', 'urgent')

USAGE = """usage: bash scripts/marveen-api.sh <verb> [args]
  message <from> <to> <content-file> [--priority high|normal]
  message-close <id> [--result-file <file>] [--no-notify] [--failed]
  directive-verify <msg-id>
  memory-search <agent> <query> [--category hot|warm|cold|shared] [--strict] [--date <expr>] [--since <day>] [--until <day>] [--limit <n>]
  memory-save <agent> <hot|warm|cold|shared> <keywords> <content-file>
  memory-list <agent> <hot|warm|cold|shared> [--limit <n>]
  memory-move <memory-id> <hot|warm|cold|shared> <updated-by>
  memory-update <memory-id> <updated-by> <content-file>
  daily-log <agent> <content-file>
  taskstate-save <agent> <json-file>
  approval-request <agent> <category-key> <timeout-seconds> <description-file> [--content-hash <h>]
  approval-status <approval-id>
  approval-consume <approval-id> <category-key> <consumer> [--content-hash <h>]
  skill-propose <skill-name> <skill-md-file> [--reason-file <file>]
  kanban-list
  kanban-create <assignee> <low|normal|high|urgent> <title-file>
  kanban-move <card-id> <status> [--expected-status <s>] [--evidence-file <file>] [--actor <name>]
  kanban-claim <card-id> <agent> [--ttl <seconds>]
  kanban-release <card-id> <agent>
  kanban-comment <card-id> <author> <content-file>
  agents-list
A <content-file> is a path, or - for stdin. Write it with your file tool first: never put the text on the command line."""


class UsageError(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    # urllib forwards every request header, Authorization included, to a redirect target on any
    # host. The dashboard never redirects an API call, so a 3xx is answered as a failure instead.
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


OPENER = urllib.request.build_opener(NoRedirect)


def fail_usage(msg):
    raise UsageError(msg)


LOOPBACK_HOSTS = ('localhost', '127.0.0.1', '::1')
TOKEN_FILE_NAME = '.dashboard-token'


def env_file_values(*keys):
    """The install's own .env values for these keys (an agent's environment cannot change them)."""
    out = {}
    try:
        with open(os.path.join(BASE, '.env'), encoding='utf-8') as f:
            for line in f:
                k, sep, v = line.partition('=')
                if sep and k.strip() in keys and k.strip() not in out:
                    out[k.strip()] = v.strip().strip('"\'')
    except OSError:
        pass
    return out


def check_env():
    """Refuses an environment that would send the token elsewhere; None when it is fine.

    The token goes to MARVEEN_API_BASE and comes from MARVEEN_TOKEN_FILE, and both are plain
    environment. A base is accepted only on loopback, or when it is exactly this install's own
    AGENT_API_ORIGIN or DASHBOARD_PUBLIC_URL from its .env (a remote agent's route). The token file
    must be a .dashboard-token, so the helper cannot send another file's first line as a header."""
    base = os.environ.get('MARVEEN_API_BASE')
    if base:
        b = base.strip().rstrip('/')
        u = urllib.parse.urlsplit(b)
        on_loopback = u.scheme in ('http', 'https') and u.hostname in LOOPBACK_HOSTS
        configured = {v.rstrip('/') for v in env_file_values('AGENT_API_ORIGIN', 'DASHBOARD_PUBLIC_URL').values() if v}
        if not on_loopback and b not in configured:
            return (f'MARVEEN_API_BASE={b} is neither loopback nor this install\'s AGENT_API_ORIGIN or '
                    'DASHBOARD_PUBLIC_URL (.env); nothing was sent.')
    token_file = os.environ.get('MARVEEN_TOKEN_FILE')
    if token_file and os.path.basename(token_file) != TOKEN_FILE_NAME:
        return f'MARVEEN_TOKEN_FILE must name a {TOKEN_FILE_NAME} file; nothing was sent.'
    return None


def api_base():
    base = os.environ.get('MARVEEN_API_BASE')
    if base:
        return base.strip().rstrip('/')
    port = os.environ.get('MARVEEN_WEB_PORT') or os.environ.get('WEB_PORT') or env_file_values('WEB_PORT').get('WEB_PORT')
    return f'http://localhost:{port or 3420}'


def read_token():
    path = os.environ.get('MARVEEN_TOKEN_FILE') or os.path.join(BASE, 'store', '.dashboard-token')
    try:
        with open(path, encoding='utf-8') as f:
            token = f.read().strip()
    except OSError as e:
        print(f'FAIL: no readable token file at {path} ({e.strerror}); nothing was sent.', file=sys.stderr)
        sys.exit(2)
    if not token:
        print(f'FAIL: the token file at {path} is empty; nothing was sent.', file=sys.stderr)
        sys.exit(2)
    return token


def read_text(path):
    if path == '-':
        return sys.stdin.read()
    try:
        with open(path, encoding='utf-8') as f:
            return f.read()
    except OSError as e:
        fail_usage(f'cannot read {path}: {e.strerror}')


def take_flag(args, flag):
    if flag in args:
        args.remove(flag)
        return True
    return False


def take_opt(args, opt):
    if opt in args:
        i = args.index(opt)
        if i + 1 >= len(args):
            fail_usage(f'{opt} needs a value')
        value = args[i + 1]
        del args[i:i + 2]
        return value
    return None


def check(value, rx, what):
    if not rx.fullmatch(value or ''):
        fail_usage(f'invalid {what}: {value!r}')
    return value


def check_category(value):
    if value not in CATEGORIES:
        fail_usage(f'invalid category: {value!r} (one of {", ".join(CATEGORIES)})')
    return value


def positional(args, n, verb):
    extra = [a for a in args if a.startswith('--')]
    if extra:
        fail_usage(f'{verb}: unknown option(s): {" ".join(extra)}')
    if len(args) != n:
        fail_usage(f'{verb}: expected {n} argument(s), got {len(args)}')
    return args


def build_request(verb, args):
    """(method, path, body or None, extra headers, flags) for one verb. Pure: no IO except reading files."""
    args = list(args)
    headers = {}
    if verb == 'message-close':
        result_file = take_opt(args, '--result-file')
        no_notify = take_flag(args, '--no-notify')
        failed = take_flag(args, '--failed')
        (msg_id,) = positional(args, 1, verb)
        check(msg_id, ID_RE, 'message id')
        body = {'status': 'failed' if failed else 'done'}
        if no_notify:
            body['notify'] = False
        if result_file is not None:
            body['result'] = read_text(result_file)
        return 'PUT', f'/api/messages/{msg_id}', body, headers, {}
    if verb == 'directive-verify':
        (msg_id,) = positional(args, 1, verb)
        check(msg_id, ID_RE, 'message id')
        return 'GET', f'/api/messages/{msg_id}', None, headers, {}
    if verb == 'memory-search':
        category = take_opt(args, '--category')
        strict = take_flag(args, '--strict')
        date = take_opt(args, '--date')
        since = take_opt(args, '--since')
        until = take_opt(args, '--until')
        limit = take_opt(args, '--limit')
        agent, query = positional(args, 2, verb)
        check(agent, NAME_RE, 'agent name')
        q = {'agent': agent, 'q': query}
        if category is not None:
            q['category'] = check_category(category)
        if strict:
            q['strict'] = '1'
        if date is not None:
            q['date'] = date
        if since is not None:
            q['since'] = since
        if until is not None:
            q['until'] = until
        if limit is not None:
            q['limit'] = check(limit, ID_RE, 'limit')
        return 'GET', '/api/memories?' + urllib.parse.urlencode(q), None, headers, {'search_header': True}
    if verb == 'memory-save':
        agent, category, keywords, content_file = positional(args, 4, verb)
        check(agent, NAME_RE, 'agent name')
        body = {'agent_id': agent, 'content': read_text(content_file), 'category': check_category(category), 'keywords': keywords}
        if not body['content'].strip():
            fail_usage('memory-save: the content is empty')
        headers['X-Agent-Id'] = agent
        return 'POST', '/api/memories', body, headers, {}
    if verb == 'memory-list':
        limit = take_opt(args, '--limit')
        agent, category = positional(args, 2, verb)
        check(agent, NAME_RE, 'agent name')
        q = {'agent': agent, 'category': check_category(category), 'limit': check(limit or '40', ID_RE, 'limit')}
        return 'GET', '/api/memories?' + urllib.parse.urlencode(q), None, headers, {}
    if verb == 'memory-move':
        mem_id, category, updated_by = positional(args, 3, verb)
        check(mem_id, ID_RE, 'memory id')
        check(updated_by, NAME_RE, 'updated-by name')
        headers['X-Agent-Id'] = updated_by
        # category-only PATCH: no agent_id, which would hand the row to another agent
        return 'PATCH', f'/api/memories/{mem_id}', {'category': check_category(category), 'updated_by': updated_by}, headers, {}
    if verb == 'memory-update':
        mem_id, updated_by, content_file = positional(args, 3, verb)
        check(mem_id, ID_RE, 'memory id')
        check(updated_by, NAME_RE, 'updated-by name')
        content = read_text(content_file)
        if not content.strip():
            fail_usage('memory-update: the content is empty')
        headers['X-Agent-Id'] = updated_by
        return 'PUT', f'/api/memories/{mem_id}', {'content': content, 'updated_by': updated_by}, headers, {}
    if verb == 'daily-log':
        agent, content_file = positional(args, 2, verb)
        check(agent, NAME_RE, 'agent name')
        content = read_text(content_file)
        if not content.strip():
            fail_usage('daily-log: the content is empty')
        return 'POST', '/api/daily-log', {'agent_id': agent, 'content': content}, headers, {}
    if verb == 'taskstate-save':
        # #2338: the PreCompact hook's task-state save, the last raw-curl recipe. The record is a
        # JSON object (summary, doneSteps, alreadyDelegated, nextAction, pendingDecision); it is
        # parsed here so a broken file fails loudly before anything is sent.
        agent, json_file = positional(args, 2, verb)
        check(agent, NAME_RE, 'agent name')
        try:
            record = json.loads(read_text(json_file))
        except ValueError as e:
            fail_usage(f'taskstate-save: {json_file} is not valid JSON ({e})')
        if not isinstance(record, dict) or not record:
            fail_usage('taskstate-save: the file must hold a non-empty JSON object')
        headers['X-Agent-Id'] = agent
        return 'POST', f'/api/agent-taskstate/{agent}', record, headers, {}
    if verb == 'approval-request':
        content_hash = take_opt(args, '--content-hash')
        agent, category, timeout, description_file = positional(args, 4, verb)
        check(agent, NAME_RE, 'agent name')
        check(category, CATEGORY_KEY_RE, 'category key')
        check(timeout, ID_RE, 'timeout seconds')
        body = {'agent_id': agent, 'category': category, 'action_description': read_text(description_file), 'timeout_seconds': int(timeout)}
        if content_hash is not None:
            body['content_hash'] = check(content_hash, HASH_RE, 'content hash')
        return 'POST', '/api/approvals', body, headers, {}
    if verb == 'approval-status':
        (approval_id,) = positional(args, 1, verb)
        check(approval_id, APPROVAL_ID_RE, 'approval id')
        return 'GET', f'/api/approvals/{approval_id}', None, headers, {}
    if verb == 'approval-consume':
        content_hash = take_opt(args, '--content-hash')
        approval_id, category, consumer = positional(args, 3, verb)
        check(approval_id, APPROVAL_ID_RE, 'approval id')
        check(category, CATEGORY_KEY_RE, 'category key')
        check(consumer, NAME_RE, 'consumer name')
        body = {'category': category, 'consumer': consumer}
        if content_hash is not None:
            body['content_hash'] = check(content_hash, HASH_RE, 'content hash')
        return 'POST', f'/api/approvals/{approval_id}/consume', body, headers, {}
    if verb == 'skill-propose':
        reason_file = take_opt(args, '--reason-file')
        name, skill_md_file = positional(args, 2, verb)
        check(name, NAME_RE, 'skill name')
        body = {'name': name, 'skill_md': read_text(skill_md_file)}
        if not body['skill_md'].strip():
            fail_usage('skill-propose: the SKILL.md is empty')
        if reason_file is not None:
            body['reason'] = read_text(reason_file)
        return 'POST', '/api/skills/propose', body, headers, {}
    if verb == 'kanban-list':
        positional(args, 0, verb)
        return 'GET', '/api/kanban', None, headers, {}
    if verb == 'agents-list':
        positional(args, 0, verb)
        return 'GET', '/api/agents', None, headers, {}
    if verb == 'kanban-create':
        assignee, priority, title_file = positional(args, 3, verb)
        check(assignee, NAME_RE, 'agent name')
        if priority not in PRIORITIES:
            fail_usage(f'invalid priority: {priority!r} (one of {", ".join(PRIORITIES)})')
        title = read_text(title_file).strip()
        if not title:
            fail_usage('kanban-create: the title is empty')
        if len(title) > 300:
            fail_usage('kanban-create: the title is longer than 300 characters (the board would cut it)')
        return 'POST', '/api/kanban', {'title': title, 'status': 'planned', 'assignee': assignee, 'priority': priority}, headers, {}
    if verb == 'kanban-move':
        expected = take_opt(args, '--expected-status')
        evidence_file = take_opt(args, '--evidence-file')
        actor = take_opt(args, '--actor')
        card, status = positional(args, 2, verb)
        check(card, CARD_ID_RE, 'card id')
        body = {'status': check(status, STATUS_RE, 'status')}
        if expected is not None:
            body['expected_status'] = check(expected, STATUS_RE, 'status')
        if evidence_file is not None:
            body['evidence'] = read_text(evidence_file)
            if not body['evidence'].strip():
                fail_usage('kanban-move: the evidence is empty')
        if actor is not None:
            body['actor'] = check(actor, NAME_RE, 'agent name')
        return 'POST', f'/api/kanban/{card}/move', body, headers, {}
    if verb in ('kanban-claim', 'kanban-release'):
        ttl = take_opt(args, '--ttl') if verb == 'kanban-claim' else None
        card, agent = positional(args, 2, verb)
        check(card, CARD_ID_RE, 'card id')
        body = {'agent': check(agent, NAME_RE, 'agent name')}
        if ttl is not None:
            body['ttl_seconds'] = int(check(ttl, ID_RE, 'ttl'))
        return 'POST', f'/api/kanban/{card}/{verb.split("-")[1]}', body, headers, {}
    if verb == 'kanban-comment':
        card, author, content_file = positional(args, 3, verb)
        check(card, CARD_ID_RE, 'card id')
        check(author, NAME_RE, 'agent name')
        content = read_text(content_file)
        if not content.strip():
            fail_usage('kanban-comment: the content is empty')
        return 'POST', f'/api/kanban/{card}/comments', {'author': author, 'content': content}, headers, {}
    fail_usage(f'unknown verb: {verb!r}')


def main(argv):
    if not argv or argv[0] in ('-h', '--help'):
        print(USAGE)
        return 0 if argv else 2
    refused = check_env()
    if refused:
        print(f'FAIL: {refused}', file=sys.stderr)
        return 2
    if argv[0] == '--check-env':
        # marveen-api.sh asks this before it hands the message verb to agent-msg.sh, which reads
        # the same two variables.
        return 0
    verb, rest = argv[0], argv[1:]
    try:
        method, path, body, headers, flags = build_request(verb, rest)
    except UsageError as e:
        print(f'FAIL: {e}\n{USAGE}', file=sys.stderr)
        return 2
    token = read_token()
    data = json.dumps(body).encode('utf-8') if body is not None else None
    req = urllib.request.Request(api_base() + path, data=data, method=method)
    req.add_header('Authorization', f'Bearer {token}')
    if data is not None:
        req.add_header('Content-Type', 'application/json')
    for k, v in headers.items():
        req.add_header(k, v)
    try:
        with OPENER.open(req, timeout=30) as resp:
            status, text, resp_headers = resp.status, resp.read().decode('utf-8', 'replace'), resp.headers
    except urllib.error.HTTPError as e:
        status, text, resp_headers = e.code, e.read().decode('utf-8', 'replace'), e.headers
    except (urllib.error.URLError, OSError) as e:
        if isinstance(e, TimeoutError) or isinstance(getattr(e, 'reason', None), TimeoutError):
            # The request may have been sent and processed; only the answer is missing.
            print(f'FAIL: the dashboard at {api_base()} did not answer in 30 s; read back before you retry a write.', file=sys.stderr)
            return 3
        print(f'FAIL: the dashboard at {api_base()} could not be reached ({getattr(e, "reason", e)}).', file=sys.stderr)
        return 3
    if flags.get('search_header'):
        # The search answers leniently; the label travels only in this header (#1374). Its ABSENCE
        # is printed too: a missing header is a request that failed, not an empty result.
        label = resp_headers.get('X-Memory-Search') if resp_headers else None
        print(f'X-Memory-Search: {label}' if label else 'X-Memory-Search: MISSING (the search did not run as asked)')
    if 200 <= status < 300:
        print(text)
        return 0
    print(f'FAIL: HTTP {status}: {text[:500]}', file=sys.stderr)
    return 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))

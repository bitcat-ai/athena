import { randomUUID } from 'node:crypto';
import type { CoderFetch } from '../src/main/coder-api';

interface FakeWorkspace {
  id: string;
  name: string;
  template: string;
  transition: 'start' | 'stop' | 'delete';
  status: string;
  /** Polls until the agent reports ready after the build is running. */
  agent: number;
}
const next: Record<string, string> = {
  pending: 'starting',
  starting: 'running',
  stopping: 'stopped',
  deleting: 'deleted',
};

/** A Coder deployment in memory, reduced to the requests Athena makes. */
export function fakeCoder(token = 'test-token') {
  const workspaces = new Map<string, FakeWorkspace>();
  const state = {
    token,
    username: 'tester',
    down: false,
    templates: [
      { id: 'tpl-node', name: 'node', display_name: 'Node 工作区' },
      { id: 'tpl-old', name: 'old', deprecated: true },
      { id: 'tpl-bare', name: 'bare' },
    ],
    /** Templates whose builds end as failed. */
    failing: new Set<string>(),
    /** Templates without an agent. */
    agentless: new Set<string>(),
    requests: [] as string[],
  };
  const view = (workspace: FakeWorkspace) => ({
    id: workspace.id,
    name: workspace.name,
    owner_name: state.username,
    template_name: workspace.template,
    template_display_name: state.templates.find((item) => item.name === workspace.template)
      ?.display_name,
    latest_build: {
      status: workspace.status,
      transition: workspace.transition,
      resources: [
        {
          agents:
            workspace.status !== 'running' || state.agentless.has(workspace.template)
              ? []
              : [
                  {
                    name: 'main',
                    status: workspace.agent > 1 ? 'connecting' : 'connected',
                    lifecycle_state: workspace.agent > 0 ? 'starting' : 'ready',
                  },
                ],
        },
      ],
    },
  });
  /** A build moves one step each time its workspace is read by id. */
  const advance = (workspace: FakeWorkspace) => {
    if (workspace.status === 'running' && workspace.agent > 0) workspace.agent--;
    else if (workspace.status === 'starting' && state.failing.has(workspace.template))
      workspace.status = 'failed';
    else workspace.status = next[workspace.status] ?? workspace.status;
  };
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  const fetch: CoderFetch = async (url, init) => {
    if (state.down) throw new TypeError('fetch failed');
    const { pathname, search } = new URL(url);
    const method = init.method ?? 'GET';
    state.requests.push(`${method} ${pathname}${search}`);
    const headers = init.headers as Record<string, string>;
    if (headers['Coder-Session-Token'] !== state.token)
      return json(401, { message: 'Invalid session token' });
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    if (method === 'GET' && pathname === '/api/v2/users/me')
      return json(200, { id: 'user-1', username: state.username });
    if (method === 'GET' && pathname === '/api/v2/templates') return json(200, state.templates);
    if (method === 'GET' && pathname === '/api/v2/workspaces')
      return json(200, {
        workspaces: [...workspaces.values()]
          .filter((workspace) => workspace.status !== 'deleted')
          .map(view),
      });
    if (method === 'POST' && pathname === '/api/v2/users/me/workspaces') {
      const template = state.templates.find((item) => item.id === body.template_id);
      if (!template) return json(400, { message: 'Template not found' });
      if (
        [...workspaces.values()].some(
          (item) => item.name === body.name && item.status !== 'deleted',
        )
      )
        return json(409, { message: 'Workspace already exists' });
      const workspace: FakeWorkspace = {
        id: randomUUID(),
        name: body.name,
        template: template.name,
        transition: 'start',
        status: 'pending',
        agent: 2,
      };
      workspaces.set(workspace.id, workspace);
      return json(201, view(workspace));
    }
    const byName = pathname.match(/^\/api\/v2\/users\/me\/workspace\/([^/]+)$/);
    if (method === 'GET' && byName) {
      const workspace = [...workspaces.values()].find(
        (item) => item.name === decodeURIComponent(byName[1]) && item.status !== 'deleted',
      );
      return workspace
        ? json(200, view(workspace))
        : json(404, { message: 'Resource not found or you do not have access to this resource' });
    }
    const byId = pathname.match(/^\/api\/v2\/workspaces\/([^/]+)(\/builds)?$/);
    const workspace = byId && workspaces.get(decodeURIComponent(byId[1]));
    if (byId && !workspace) return json(404, { message: 'Resource not found' });
    if (workspace && method === 'GET' && !byId![2]) {
      advance(workspace);
      // As Coder does: a deleted workspace is gone, not missing.
      if (workspace.status === 'deleted') return json(410, { message: 'Workspace was deleted' });
      return json(200, view(workspace));
    }
    if (workspace && method === 'POST' && byId![2]) {
      if (workspace.status in next)
        return json(409, { message: 'A workspace build is already active.' });
      workspace.transition = body.transition;
      workspace.status =
        body.transition === 'start'
          ? 'pending'
          : body.transition === 'stop'
            ? 'stopping'
            : 'deleting';
      workspace.agent = 2;
      return json(201, { id: randomUUID() });
    }
    return json(404, { message: 'Route not found' });
  };
  return {
    state,
    workspaces,
    fetch,
    byName: (name: string) =>
      [...workspaces.values()].find((item) => item.name === name && item.status !== 'deleted'),
    /** Puts a workspace there as if it had been made earlier. */
    add(name: string, status = 'running', template = 'node') {
      const workspace: FakeWorkspace = {
        id: randomUUID(),
        name,
        template,
        transition: status === 'running' ? 'start' : 'stop',
        status,
        agent: 0,
      };
      workspaces.set(workspace.id, workspace);
      return workspace;
    },
  };
}

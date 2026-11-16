import { z } from 'zod/v4';
import { redact } from './sandbox-client';

export type CoderFetch = (url: string, init: RequestInit) => Promise<Response>;

// Only the fields Athena reads; Coder adds fields freely between releases.
const Agent = z.object({
  name: z.string(),
  status: z.string(),
  lifecycle_state: z.string().optional(),
});
const Workspace = z.object({
  id: z.string(),
  name: z.string(),
  owner_name: z.string(),
  template_name: z.string().optional(),
  template_display_name: z.string().optional(),
  latest_build: z.object({
    status: z.string(),
    transition: z.string(),
    resources: z.array(z.object({ agents: z.array(Agent).nullish() })).nullish(),
  }),
});
const Template = z.object({
  id: z.string(),
  name: z.string(),
  display_name: z.string().optional(),
  description: z.string().optional(),
  deprecated: z.boolean().optional(),
});

export type CoderWorkspace = z.output<typeof Workspace>;
export type CoderTemplate = z.output<typeof Template>;
export type CoderTransition = 'start' | 'stop' | 'delete';

export class CoderApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** RFC 1918 and loopback hosts, where a deployment may still run without TLS. */
export function isPrivateHost(hostname: string): boolean {
  if (['localhost', '[::1]'].includes(hostname)) return true;
  const parts = hostname.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
    return false;
  const [a, b] = parts;
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** Normalizes a user-entered deployment address to an origin. */
export function coderOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(value.trim()) ? value.trim() : `https://${value.trim()}`);
  } catch {
    throw new Error('Coder 地址格式不正确');
  }
  // Plain http only for private networks; the settings page marks such a connection.
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isPrivateHost(url.hostname)))
    throw new Error('Coder 地址必须使用 HTTPS（内网地址可以使用 HTTP）');
  if (url.username || url.password) throw new Error('Coder 地址不能包含账号信息');
  return url.origin;
}

export function workspaceAgent(workspace: CoderWorkspace) {
  for (const resource of workspace.latest_build.resources ?? [])
    for (const agent of resource.agents ?? []) return agent;
  return undefined;
}

export class CoderApi {
  constructor(
    readonly origin: string,
    private readonly token: string,
    private readonly fetch: CoderFetch,
    private readonly timeoutMs = 15_000,
  ) {}

  /** For text that came from outside: the token must not travel on into a message or a log. */
  private clean(text: string) {
    return redact(text.split(this.token).join('[hidden]'));
  }
  private async call<T>(
    method: string,
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.fetch(this.origin + path, {
        method,
        headers: {
          Accept: 'application/json',
          'Coder-Session-Token': this.token,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new CoderApiError(
        `无法连接 Coder（${this.origin}）：${this.clean((error as Error).message)}`,
        0,
      );
    }
    const text = await response.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = undefined;
    }
    if (!response.ok) {
      if (response.status === 401)
        throw new CoderApiError('Coder 令牌无效或已过期，请重新填写', 401);
      const detail =
        json && typeof json === 'object' ? (json as { message?: unknown }).message : undefined;
      throw new CoderApiError(
        `Coder 请求失败（${response.status}）${typeof detail === 'string' ? `：${this.clean(detail).slice(0, 300)}` : ''}`,
        response.status,
      );
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success)
      throw new CoderApiError('Coder 返回的数据无法识别，请确认地址指向 Coder', response.status);
    return parsed.data;
  }

  me() {
    return this.call('GET', '/api/v2/users/me', z.object({ id: z.string(), username: z.string() }));
  }
  templates() {
    return this.call('GET', '/api/v2/templates', z.array(Template));
  }
  /** Every workspace of the token's own user. */
  async workspaces(): Promise<CoderWorkspace[]> {
    const { workspaces } = await this.call(
      'GET',
      '/api/v2/workspaces?q=owner%3Ame',
      z.object({ workspaces: z.array(Workspace).nullish() }),
    );
    return workspaces ?? [];
  }
  workspace(id: string) {
    return this.call('GET', `/api/v2/workspaces/${encodeURIComponent(id)}`, Workspace);
  }
  /** The user's workspace of that name, unless there is none (a deleted one counts as none). */
  async workspaceByName(name: string): Promise<CoderWorkspace | undefined> {
    try {
      return await this.call(
        'GET',
        `/api/v2/users/me/workspace/${encodeURIComponent(name)}`,
        Workspace,
      );
    } catch (error) {
      if (error instanceof CoderApiError && error.status === 404) return undefined;
      throw error;
    }
  }
  createWorkspace(templateId: string, name: string) {
    return this.call('POST', '/api/v2/users/me/workspaces', Workspace, {
      template_id: templateId,
      name,
    });
  }
  async build(id: string, transition: CoderTransition) {
    await this.call('POST', `/api/v2/workspaces/${encodeURIComponent(id)}/builds`, z.unknown(), {
      transition,
    });
  }
}

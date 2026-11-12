import { randomUUID } from 'node:crypto';
import type { BrowserTool, ToolResult } from '../shared/types';

export const repositoryTools: BrowserTool[] = [
  {
    name: 'workbench_repository_checkout',
    description:
      '测试分支推送后，从真实远端重新拉取并核对提交，返回用于新目录复测的 Git bundle。保留原目录，在前后端独立沙箱的新目录安装、构建、启动验证；不再次修改或推送代码。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'workbench_repository_resolve',
    description:
      '通过已配置的仓库映射 MCP 服务，根据当前网站和业务模块查找真实 Git 仓库、基线提交和独立沙箱 checkout 指引。先读取网站和业务操作手册。',
    inputSchema: {
      type: 'object',
      properties: { website_url: { type: 'string' }, module: { type: 'string' } },
      required: ['website_url', 'module'],
      additionalProperties: false,
    },
  },
  {
    name: 'workbench_repository_publish',
    description:
      '让仓库 MCP 服务校验前后端沙箱上传的 Git commit bundle，合并到已授权的测试分支并推送真实远端。仅在用户授权提交且检查通过后调用；不发布生产。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

/** Focused, opt-in local repository registry; credentials remain outside model inputs. */
export class RepositoryMcp {
  private initialized = false;
  constructor(
    private endpoint: string,
    private token: string,
  ) {
    const url = new URL(endpoint);
    if (
      url.protocol !== 'http:' ||
      url.hostname !== '127.0.0.1' ||
      url.username ||
      url.password ||
      !token
    )
      throw new Error('仓库 MCP 必须使用有凭据的本机回环地址');
  }
  private async request(method: string, params: unknown, signal: AbortSignal) {
    const id = method.startsWith('notifications/') ? undefined : randomUUID();
    const response = await fetch(this.endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
    });
    if (!response.ok) throw new Error(`仓库 MCP HTTP ${response.status}`);
    if (id === undefined && response.status === 204) return {};
    const raw = await response.text();
    if (raw.length > 1024 * 1024) throw new Error('仓库 MCP 返回过大');
    const value = JSON.parse(raw);
    if (value.jsonrpc !== '2.0' || value.id !== id || value.error)
      throw new Error('仓库 MCP 请求失败，请先核对状态后重试');
    return value.result;
  }
  async call(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    if (!repositoryTools.some((tool) => tool.name === name)) throw new Error('未知仓库工具');
    if (!this.initialized) {
      await this.request(
        'initialize',
        {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'athena-repository', version: '1' },
        },
        signal,
      );
      await this.request('notifications/initialized', {}, signal);
      const listed = await this.request('tools/list', {}, signal);
      if (
        !repositoryTools.every((tool) =>
          listed.tools?.some((item: { name: string }) => item.name === tool.name),
        )
      )
        throw new Error('仓库 MCP 缺少所需工具');
      this.initialized = true;
    }
    const result = await this.request('tools/call', { name, arguments: args }, signal);
    if (!Array.isArray(result?.content)) throw new Error('仓库 MCP 结果格式无效');
    return {
      text: result.content
        .filter((item: { type: string }) => item.type === 'text')
        .map((item: { text: string }) => item.text)
        .join('\n'),
      isError: result.isError === true,
    };
  }
}

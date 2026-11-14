import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import type { BrowserTool, ToolResult } from '../shared/types';

const exec = promisify(execFile);
const COMPONENTS = ['frontend', 'backend'] as const;
export type RepositoryComponent = (typeof COMPONENTS)[number];
export interface ComponentSource {
  repository: string;
  /** Directory of the component inside the repository; "." is the repository itself. */
  root: string;
  branch?: string;
}
/** Which code a website's pages come from, as the user confirmed it. */
export interface RepositoryMapping {
  id: string;
  origin: string;
  module: string;
  application?: string;
  components: Partial<Record<RepositoryComponent, ComponentSource>>;
  /** Where the mapping was found: a document link, or the user. */
  source?: string;
  confirmedAt: number;
}
export interface RepositoryServiceOptions {
  /** Shows the user what is about to be remembered or pushed; nothing happens without a yes. */
  approve(request: { title: string; detail: string; target?: string }): Promise<boolean>;
  /** Accepts local paths as repository addresses. Only tests need this. */
  allowLocal?: boolean;
  onChange?(): void;
}

const componentSchema = (label: string) => ({
  type: 'object',
  description: `${label}代码所在的仓库和目录。只在登记或更正映射时提供。`,
  properties: {
    repository: { type: 'string', description: 'Git 仓库地址（https 或 ssh），不含凭据' },
    root: { type: 'string', description: '组件在仓库内的目录；整个仓库用 "."' },
    branch: { type: 'string', description: '基线分支；省略时使用仓库默认分支' },
  },
  required: ['repository', 'root'],
  additionalProperties: false,
});
export const repositoryServiceTools: BrowserTool[] = [
  {
    name: 'workbench_repository_checkout',
    description:
      '测试分支推送后，从真实远端重新拉取并核对提交，返回用于新目录复测的 Git bundle。保留原目录，在前后端独立沙箱的新目录安装、构建、启动验证；不再次修改或推送代码。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'workbench_repository_resolve',
    description:
      '按网站和业务模块定位页面对应的真实 Git 仓库，返回基线提交和供前后端独立沙箱克隆的 Git bundle 地址。已登记的映射直接返回。未登记时先在知识库里查到这个系统的代码仓库和前后端目录（workbench_feishu_search/read，或记忆里的知识），再带上 frontend、backend 和 source（依据的文档链接，或“用户告知”）调用；用户在卡片上确认后登记并记住。知识库里找不到时询问用户，不要猜测仓库地址。',
    inputSchema: {
      type: 'object',
      properties: {
        website_url: { type: 'string' },
        module: { type: 'string', description: '业务模块；整个网站共用一套代码时可省略' },
        application: { type: 'string', description: '系统或应用的名称' },
        frontend: componentSchema('前端'),
        backend: componentSchema('后端'),
        source: { type: 'string', description: '这条映射的依据：文档链接，或“用户告知”' },
      },
      required: ['website_url'],
      additionalProperties: false,
    },
  },
  {
    name: 'workbench_repository_publish',
    description:
      '校验前后端沙箱上传的 Git commit bundle，合并到新的测试分支并推送真实远端。每次推送都由用户在卡片上确认；不合并主干，不发布生产。仅在用户要求提交且检查通过后调用。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

interface Source {
  key: string;
  repository: string;
  mirror: string;
  branch: string;
  base: string;
  components: RepositoryComponent[];
}
interface Publication {
  repository: string;
  branch: string;
  commit: string;
  components: Partial<Record<RepositoryComponent, string>>;
}
interface Session {
  conversationId: string;
  mapping: RepositoryMapping;
  token: string;
  directory: string;
  branch: string;
  sources: Source[];
  /** Files a sandbox may download, by the name in the transfer address. */
  downloads: Map<string, string>;
  uploads: Set<RepositoryComponent>;
  publishing?: boolean;
  published?: Publication[];
  checkout?: Array<Publication & { bundleUrl: string }>;
}

const bounded = (value: unknown, max: number, label: string, optional = false) => {
  if (optional && (value === undefined || value === null || value === '')) return '';
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f]/.test(value))
    throw new Error(label + '无效');
  return value.trim();
};
const sha = (value: string, length = 12) =>
  createHash('sha256').update(value).digest('hex').slice(0, length);
const json = (value: unknown, isError = false): ToolResult => ({
  text: JSON.stringify(value),
  ...(isError ? { isError } : {}),
});

/**
 * Finds the code behind a website from mappings the user confirmed, hands it to the sandboxes as
 * Git bundles, and takes their commits back to a test branch. Cloning and pushing happen here
 * with the user's own Git access; a sandbox only ever sees a transfer address.
 */
export class RepositoryService {
  private mappings: RepositoryMapping[] | undefined;
  private sessions = new Map<string, Session>();
  private byToken = new Map<string, Session>();
  private server: Server | undefined;
  private listening: Promise<number> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private identity: string[] | undefined;
  constructor(
    private directory: string,
    private options: RepositoryServiceOptions,
  ) {}

  /** Git work shares mirrors and a working clone per conversation, so it runs one at a time. */
  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => {});
    return run;
  }
  private async git(cwd: string | undefined, args: string[], signal?: AbortSignal) {
    try {
      const { stdout } = await exec('git', [...(cwd ? ['-C', cwd] : []), ...args], {
        env: {
          ...process.env,
          // A missing credential fails the call instead of waiting on a prompt nobody sees.
          GIT_TERMINAL_PROMPT: '0',
          GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -oBatchMode=yes',
        },
        maxBuffer: 16 * 1024 * 1024,
        timeout: 300_000,
        signal,
      });
      return stdout.trim();
    } catch (error) {
      signal?.throwIfAborted();
      const detail = String((error as { stderr?: string }).stderr || (error as Error).message)
        .trim()
        .split('\n')
        .filter((line) => !/^hint:/.test(line))
        .slice(-3)
        .join(' ')
        .slice(-400);
      throw new Error('Git 操作失败：' + detail);
    }
  }
  /** Merges on this machine are made as the user; a machine without an identity gets a neutral one. */
  private async author() {
    if (this.identity) return this.identity;
    const read = (key: string) =>
      exec('git', ['config', '--get', key])
        .then((result) => result.stdout.trim())
        .catch(() => '');
    const name = (await read('user.name')) || 'Athena',
      email = (await read('user.email')) || 'athena@localhost';
    return (this.identity = ['-c', 'user.name=' + name, '-c', 'user.email=' + email]);
  }
  private address(value: unknown): string {
    const url = bounded(value, 300, '仓库地址');
    if (/\s|\\/.test(url) || url.startsWith('-')) throw new Error('仓库地址无效');
    if (
      /^https?:\/\/[^/@\s]+\/\S+$/.test(url) ||
      /^ssh:\/\/(?:[\w.-]+@)?[\w.-]+(?::\d+)?\/\S+$/.test(url) ||
      /^[\w.-]+@[\w.-]+:[\w./~-]+$/.test(url) ||
      (this.options.allowLocal && path.isAbsolute(url))
    )
      return url;
    throw new Error('仓库地址需为 https 或 ssh 的 Git 地址，且不能包含凭据');
  }
  private component(value: unknown): ComponentSource | undefined {
    if (value === undefined || value === null) return;
    if (typeof value !== 'object' || Array.isArray(value)) throw new Error('组件信息无效');
    const input = value as Record<string, unknown>;
    const root =
      bounded(input.root, 200, '组件目录')
        .replace(/^\.\/+/, '')
        .replace(/\/+$/, '') || '.';
    if (
      root !== '.' &&
      root.split('/').some((part) => !/^[\w@+][\w.@+-]*$/.test(part) || part.startsWith('.git'))
    )
      throw new Error('组件目录需为仓库内的相对路径');
    const branch = bounded(input.branch, 120, '分支', true);
    if (branch && (!/^[\w][\w./-]*$/.test(branch) || /\.\.|\/$|\.lock$/.test(branch)))
      throw new Error('分支名称无效');
    return { repository: this.address(input.repository), root, ...(branch ? { branch } : {}) };
  }

  private file() {
    return path.join(this.directory, 'mappings.json');
  }
  private async load() {
    if (this.mappings) return this.mappings;
    try {
      const value = JSON.parse(await readFile(this.file(), 'utf8'));
      this.mappings = Array.isArray(value.mappings) ? value.mappings : [];
    } catch {
      this.mappings = [];
    }
    return this.mappings!;
  }
  private async save() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = this.file() + '.' + randomUUID();
    await writeFile(temporary, JSON.stringify({ version: 1, mappings: this.mappings }, null, 2), {
      mode: 0o600,
    });
    await rename(temporary, this.file());
    this.options.onChange?.();
  }
  async list(): Promise<RepositoryMapping[]> {
    return structuredClone(await this.load());
  }
  async forget(id: string) {
    const mappings = await this.load();
    this.mappings = mappings.filter((mapping) => mapping.id !== id);
    if (this.mappings.length !== mappings.length) await this.save();
  }
  /** The mapping for a module, or the only one a website has when the module is not known by name. */
  private async find(origin: string, module: string) {
    const site = (await this.load()).filter((mapping) => mapping.origin === origin);
    return (
      site.find((mapping) => mapping.module === module) ??
      site.find((mapping) => mapping.module === '') ??
      (site.length === 1 ? site[0] : undefined)
    );
  }

  async call(
    name: string,
    args: Record<string, unknown>,
    context: { conversationId: string; signal: AbortSignal },
  ): Promise<ToolResult> {
    if (name === 'workbench_repository_resolve') return this.resolve(args, context);
    if (name === 'workbench_repository_publish') return this.serialize(() => this.publish(context));
    if (name === 'workbench_repository_checkout')
      return this.serialize(() => this.checkout(context));
    throw new Error('未知仓库工具');
  }

  private async resolve(
    args: Record<string, unknown>,
    context: { conversationId: string; signal: AbortSignal },
  ): Promise<ToolResult> {
    let origin: string;
    try {
      const url = new URL(bounded(args.website_url, 2000, '网站地址'));
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
      origin = url.origin;
    } catch {
      throw new Error('网站地址无效');
    }
    const module = bounded(args.module, 80, '业务模块', true);
    const proposed = {
      frontend: this.component(args.frontend),
      backend: this.component(args.backend),
    };
    let mapping = await this.find(origin, module);
    let before: RepositoryMapping[] | undefined;
    if (proposed.frontend || proposed.backend) {
      const components = JSON.parse(JSON.stringify(proposed)) as RepositoryMapping['components'];
      if (!mapping || JSON.stringify(mapping.components) !== JSON.stringify(components)) {
        const application = bounded(args.application, 80, '应用名称', true);
        const source = bounded(args.source, 500, '映射依据', true);
        const lines = COMPONENTS.flatMap((component) => {
          const item = components[component];
          return item
            ? [
                `${component === 'frontend' ? '前端' : '后端'}：${item.repository}`,
                `      目录 ${item.root}${item.branch ? '，分支 ' + item.branch : ''}`,
              ]
            : [];
        });
        const approved = await this.options.approve({
          title: '登记页面与代码仓库的对应关系',
          detail: [
            `网站：${origin}${module ? '（' + module + '）' : ''}`,
            ...lines,
            `依据：${source || '未说明'}`,
            '确认后 Athena 会记住这条对应关系，并用你本机的 Git 权限拉取代码到独立沙箱。',
          ].join('\n'),
          target: origin,
        });
        context.signal.throwIfAborted();
        if (!approved)
          return json({
            registered: false,
            reason: '用户没有确认这条仓库映射',
            next: '向用户说明并询问正确的仓库，不要换一个地址重试。',
          });
        const stored = (before = await this.load());
        const replaced = stored.find((item) => item.origin === origin && item.module === module);
        mapping = {
          id: replaced?.id ?? randomUUID(),
          origin,
          module,
          ...(application ? { application } : {}),
          components,
          ...(source ? { source } : {}),
          confirmedAt: Date.now(),
        };
        this.mappings = [...stored.filter((item) => item !== replaced), mapping];
        await this.save();
      }
    }
    if (!mapping)
      return json({
        registered: false,
        website: origin,
        module,
        reason: '这个网站还没有登记代码仓库',
        next: '在知识库里检索这个系统的代码仓库、前后端目录和基线分支，再带 frontend、backend 和 source 重新调用；找不到时询问用户。不要猜测仓库地址。',
      });
    const found = mapping;
    return this.serialize(async () => {
      try {
        return json(await this.describe(await this.open(found, context)));
      } catch (error) {
        // A mapping that never produced code is not worth remembering.
        if (before && !context.signal.aborted) {
          this.mappings = before;
          await this.save();
        }
        throw error;
      }
    });
  }

  private async listen(): Promise<number> {
    this.listening ??= new Promise<number>((resolve, reject) => {
      const server = createServer((request, response) => void this.transfer(request, response));
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        this.server = server;
        resolve((server.address() as AddressInfo).port);
      });
    });
    return this.listening;
  }
  private async transferUrl(session: Session, name: string) {
    return `http://host.docker.internal:${await this.listen()}/transfer/${session.token}/${name}`;
  }
  /** The sandboxes' side: bundles go out, commit bundles come in; the address is the permission. */
  private async transfer(request: IncomingMessage, response: ServerResponse) {
    response.setHeader('content-type', 'application/json');
    try {
      const match = /^\/transfer\/([a-f0-9]{48})\/([\w.-]{1,80})$/.exec(
        new URL(request.url ?? '/', 'http://localhost').pathname,
      );
      const session = match && this.byToken.get(match[1]);
      if (!session || request.headers.origin) {
        response.writeHead(403).end();
        return;
      }
      const name = match[2];
      const file = session.downloads.get(name);
      if (request.method === 'GET' && file) {
        response.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': (await stat(file)).size,
        });
        createReadStream(file).pipe(response);
        return;
      }
      const component = COMPONENTS.find((item) => item === name);
      if (request.method !== 'POST' || !component || !session.mapping.components[component]) {
        response.writeHead(404).end();
        return;
      }
      if (session.publishing || session.published) {
        response
          .writeHead(409)
          .end(JSON.stringify({ error: 'This test branch is already published' }));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 32 * 1024 * 1024) throw new Error('Bundle too large');
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      if (!/^# v[23] git bundle/.test(bytes.subarray(0, 16).toString()))
        throw new Error('Not a Git bundle');
      await writeFile(path.join(session.directory, component + '.upload'), bytes, { mode: 0o600 });
      session.uploads.add(component);
      response.end(JSON.stringify({ uploaded: component, bytes: size }));
    } catch (error) {
      if (!response.headersSent) response.writeHead(400);
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Failed' }));
    }
  }

  /** Brings the mapped repositories up to date and prepares what this conversation's sandboxes clone. */
  private async open(
    mapping: RepositoryMapping,
    context: { conversationId: string; signal: AbortSignal },
  ): Promise<Session> {
    const previous = this.sessions.get(context.conversationId);
    if (
      previous &&
      !previous.published &&
      JSON.stringify(previous.mapping) === JSON.stringify(mapping)
    )
      return previous;
    const { signal } = context;
    const token = randomBytes(24).toString('hex');
    const directory = path.join(
      this.directory,
      'sessions',
      sha(context.conversationId, 16),
      token.slice(0, 12),
    );
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const sources: Source[] = [];
    const downloads = new Map<string, string>();
    for (const component of COMPONENTS) {
      const item = mapping.components[component];
      if (!item) continue;
      let source = sources.find((entry) => entry.repository === item.repository);
      if (source && item.branch && item.branch !== source.branch)
        throw new Error('同一仓库的前后端需使用同一基线分支');
      if (!source) {
        const key = sha(item.repository);
        const mirror = path.join(this.directory, 'mirrors', key + '.git');
        await mkdir(path.dirname(mirror), { recursive: true, mode: 0o700 });
        if (!(await stat(mirror).catch(() => undefined)))
          await this.git(undefined, ['init', '--quiet', '--bare', mirror], signal);
        let branch = item.branch;
        if (!branch) {
          const head = await this.git(
            mirror,
            ['ls-remote', '--symref', '--', item.repository, 'HEAD'],
            signal,
          );
          branch = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(head)?.[1];
          if (!branch) throw new Error('无法确定仓库默认分支，请在映射里写明分支');
        }
        await this.git(
          mirror,
          [
            'fetch',
            '--quiet',
            '--no-tags',
            '--force',
            '--',
            item.repository,
            `+refs/heads/${branch}:refs/heads/${branch}`,
          ],
          signal,
        );
        const base = await this.git(mirror, ['rev-parse', `refs/heads/${branch}`], signal);
        const bundle = path.join(directory, key + '.bundle');
        // HEAD travels in the bundle so a plain clone checks the baseline out.
        await this.git(mirror, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`], signal);
        await this.git(
          mirror,
          ['bundle', 'create', '--quiet', bundle, `refs/heads/${branch}`, 'HEAD'],
          signal,
        );
        downloads.set(key + '.bundle', bundle);
        source = { key, repository: item.repository, mirror, branch, base, components: [] };
        sources.push(source);
      }
      if (
        item.root !== '.' &&
        (await this.git(
          source.mirror,
          ['cat-file', '-t', `${source.base}:${item.root}`],
          signal,
        ).catch(() => '')) !== 'tree'
      )
        throw new Error(`仓库里没有目录 ${item.root}，请核对映射`);
      source.components.push(component);
    }
    if (!sources.length) throw new Error('映射里没有可用的组件');
    const slug = mapping.module
      .replace(/[^A-Za-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase();
    const session: Session = {
      conversationId: context.conversationId,
      mapping: structuredClone(mapping),
      token,
      directory,
      branch: `athena/${slug || 'change'}-${randomBytes(4).toString('hex')}`,
      sources,
      downloads,
      uploads: new Set(),
    };
    if (previous) this.byToken.delete(previous.token);
    this.sessions.set(context.conversationId, session);
    this.byToken.set(token, session);
    return session;
  }
  private async describe(session: Session) {
    const { mapping } = session;
    const author = await this.author();
    const components: Record<string, unknown> = {};
    for (const source of session.sources)
      for (const component of source.components)
        components[component] = {
          target: component,
          repository: source.repository,
          root: mapping.components[component]!.root,
          branch: source.branch,
          baseCommit: source.base,
          bundleUrl: await this.transferUrl(session, source.key + '.bundle'),
          uploadUrl: await this.transferUrl(session, component),
        };
    return {
      registered: true,
      website: mapping.origin,
      module: mapping.module,
      ...(mapping.application ? { application: mapping.application } : {}),
      ...(mapping.source ? { source: mapping.source } : {}),
      targetBranch: session.branch,
      components,
      author: {
        name: author[1].slice('user.name='.length),
        email: author[3].slice('user.email='.length),
      },
      instructions:
        '每个组件使用它自己的 target 沙箱：用 Node fetch 把 bundleUrl 下载为 /workspace/base.bundle，再 git clone /workspace/base.bundle /workspace/repo，核对 git rev-parse HEAD 等于 baseCommit。只修改该组件 root 目录里的文件。安装、测试、构建命令以仓库自带的 README、package.json、pom.xml 等为准，并核对最终退出码；服务监听 0.0.0.0:$PORT，前端访问后端用 http://host.docker.internal:<后端服务端口>。用户要求提交时：按 author 设置 git config user.name / user.email 后提交，git bundle create /workspace/<target>.bundle <baseCommit>..HEAD，再用 Node fetch 把 bundle 以 POST 二进制上传到 uploadUrl；上传完成后调用 workbench_repository_publish，由宿主校验、合并，并在用户确认后推送测试分支 targetBranch。仓库凭据只留在宿主，不进入沙箱。',
    };
  }

  private async publish(context: { conversationId: string; signal: AbortSignal }) {
    const session = this.sessions.get(context.conversationId);
    if (!session) throw new Error('请先调用 workbench_repository_resolve 定位仓库');
    if (session.published) return json({ published: session.published });
    if (!session.uploads.size) throw new Error('沙箱尚未上传任何 Git bundle');
    const { signal } = context;
    const author = await this.author();
    const prepared: Array<{ source: Source; work: string; publication: Publication }> = [];
    for (const source of session.sources) {
      const uploaded = source.components.filter((component) => session.uploads.has(component));
      if (!uploaded.length) continue;
      const work = path.join(session.directory, 'publish-' + source.key);
      await rm(work, { recursive: true, force: true });
      await this.git(
        undefined,
        ['clone', '--quiet', '--no-hardlinks', source.mirror, work],
        signal,
      );
      const run = (...args: string[]) => this.git(work, args, signal);
      await run('checkout', '--quiet', '-b', session.branch, source.base);
      const commits: Publication['components'] = {};
      for (const component of uploaded) {
        const root = session.mapping.components[component]!.root;
        const bundle = path.join(session.directory, component + '.upload');
        await run('bundle', 'verify', '--quiet', bundle);
        await run('fetch', '--quiet', bundle, `+HEAD:refs/heads/incoming/${component}`);
        const commit = await run('rev-parse', `incoming/${component}`);
        await run('merge-base', '--is-ancestor', source.base, commit).catch(() => {
          throw new Error('提交不是在登记的基线之上创建的');
        });
        const files = (await run('diff', '--name-only', '-z', source.base, commit))
          .split('\0')
          .filter(Boolean);
        if (
          !files.length ||
          files.some(
            (file) =>
              (root !== '.' && !file.startsWith(root + '/')) ||
              file.split('/').some((part) => part.startsWith('.git')),
          )
        )
          throw new Error(`${component} 的提交为空或超出组件目录 ${root}`);
        const changed = new Set(files);
        const tree = (await run('ls-tree', '-r', '-z', commit)).split('\0').filter(Boolean);
        if (
          tree.some((line) => {
            const [meta, file] = line.split('\t');
            return changed.has(file) && !/^100(?:644|755) /.test(meta);
          })
        )
          throw new Error('不允许符号链接或子模块');
        commits[component] = commit;
      }
      for (const component of uploaded)
        await this.git(
          work,
          [...author, 'merge', '--quiet', '--no-ff', '--no-edit', `incoming/${component}`],
          signal,
        );
      prepared.push({
        source,
        work,
        publication: {
          repository: source.repository,
          branch: session.branch,
          commit: await run('rev-parse', 'HEAD'),
          components: commits,
        },
      });
    }
    const approved = await this.options.approve({
      title: '推送测试分支',
      detail: [
        ...prepared.flatMap(({ source, publication }) => [
          `仓库：${source.repository}`,
          `      新分支 ${publication.branch}（基线 ${source.branch} ${source.base.slice(0, 10)}）`,
          `      包含 ${Object.keys(publication.components).join('、')} 的提交`,
        ]),
        '只新建这个测试分支；不合并主干，不发布生产。',
      ].join('\n'),
      target: session.branch,
    });
    signal.throwIfAborted();
    if (!approved) return json({ published: false, reason: '用户没有允许这次推送' }, true);
    session.publishing = true;
    try {
      for (const { source, work, publication } of prepared) {
        await this.git(
          work,
          ['push', '--quiet', '--', source.repository, `HEAD:refs/heads/${publication.branch}`],
          // A push that has started is left to finish; its result is checked against the remote.
          undefined,
        );
        const remote = await this.git(work, [
          'ls-remote',
          '--',
          source.repository,
          `refs/heads/${publication.branch}`,
        ]);
        if (remote.split(/\s/)[0] !== publication.commit) throw new Error('远端提交核对失败');
      }
      session.published = prepared.map((item) => item.publication);
    } finally {
      session.publishing = false;
    }
    return json({ published: session.published });
  }

  private async checkout(context: { conversationId: string; signal: AbortSignal }) {
    const session = this.sessions.get(context.conversationId);
    if (!session?.published) throw new Error('测试分支尚未推送，不能获取复测代码');
    if (!session.checkout) {
      const proof: NonNullable<Session['checkout']> = [];
      for (const publication of session.published) {
        const key = sha(publication.repository);
        const target = path.join(session.directory, 'verify-' + key);
        await rm(target, { recursive: true, force: true });
        await this.git(
          undefined,
          [
            'clone',
            '--quiet',
            '--single-branch',
            '--branch',
            publication.branch,
            '--',
            publication.repository,
            target,
          ],
          context.signal,
        );
        if ((await this.git(target, ['rev-parse', 'HEAD'], context.signal)) !== publication.commit)
          throw new Error('远端提交已变化，请先核对');
        const name = `published-${key}.bundle`;
        const bundle = path.join(session.directory, name);
        await this.git(target, ['bundle', 'create', '--quiet', bundle, 'HEAD'], context.signal);
        session.downloads.set(name, bundle);
        proof.push({ ...publication, bundleUrl: await this.transferUrl(session, name) });
      }
      session.checkout = proof;
    }
    return json({
      repositories: session.checkout,
      instructions:
        '在对应组件的沙箱里把 bundleUrl 下载并克隆到新的 /workspace/verify 目录，核对 git rev-parse HEAD 等于 commit，再按仓库自带的命令安装、构建、启动并复测；保留原 /workspace/repo 不变，不再修改或推送代码。',
    });
  }

  async dispose() {
    this.server?.closeAllConnections();
    this.server?.close();
    this.server = undefined;
    this.listening = undefined;
    this.sessions.clear();
    this.byToken.clear();
  }
}

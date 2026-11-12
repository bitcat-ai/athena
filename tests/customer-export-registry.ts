import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { repositoryTools } from '../src/main/repository-mcp';

const exec = promisify(execFile);
export const demoRepository = 'https://github.com/Dylan-Nihilo/athena-customer-materials-demo.git';
export async function startRepositoryRegistry(
  directory: string,
  baseline: string,
  websiteUrl: string,
  repository = demoRepository,
) {
  await mkdir(directory, { recursive: true });
  const git = async (cwd: string, args: string[], signal?: AbortSignal) =>
    (
      await exec(
        'git',
        [
          '-c',
          'user.name=Athena Demo',
          '-c',
          'user.email=athena-demo@example.test',
          '-C',
          cwd,
          ...args,
        ],
        { maxBuffer: 2 * 1024 * 1024, timeout: 90_000, signal },
      )
    ).stdout.trim();
  const checkout = path.join(directory, 'publish');
  await exec('git', ['clone', '--no-hardlinks', baseline, checkout]);
  await git(checkout, ['remote', 'set-url', 'origin', repository]);
  const base = await git(checkout, ['rev-parse', 'HEAD']);
  const branch = 'demo/customer-export-' + randomBytes(4).toString('hex');
  await git(checkout, ['checkout', '-b', branch]);
  await git(checkout, [
    'bundle',
    'create',
    path.join(directory, 'baseline.bundle'),
    'main',
    'HEAD',
  ]);
  const token = randomBytes(32).toString('hex'),
    transfer = randomBytes(24).toString('hex');
  const audit: Array<Record<string, unknown>> = [];
  const uploads = new Set<string>();
  let published:
    | {
        commit: string;
        branch: string;
        repository: string;
        componentCommits: Record<string, string>;
      }
    | undefined;
  let publishing: Promise<typeof published> | undefined;
  const publish = async (signal: AbortSignal) => {
    if (published) return published;
    if (publishing) return publishing;
    publishing = (async () => {
      const run = (...args: string[]) => git(checkout, args, signal);
      const commits: Record<string, string> = {};
      for (const component of ['frontend', 'backend']) {
        if (!uploads.has(component)) throw new Error('需要两个沙箱分别上传 Git bundle');
        const bundle = path.join(directory, component + '.bundle');
        await run('bundle', 'verify', bundle);
        await run('fetch', bundle, `HEAD:refs/heads/incoming/${component}`);
        const commit = await run('rev-parse', `incoming/${component}`);
        await run('merge-base', '--is-ancestor', base, commit);
        const files = (await run('diff', '--name-only', base, commit)).split('\n').filter(Boolean);
        if (
          !files.length ||
          files.some(
            (file) =>
              !file.startsWith(component + '/') ||
              file.split('/').some((part) => part.startsWith('.git')),
          )
        )
          throw new Error('提交超出组件目录');
        const tree = await run('ls-tree', '-r', commit, ...files);
        if (
          tree
            .split('\n')
            .some((line) => !line.startsWith('100644 ') && !line.startsWith('100755 '))
        )
          throw new Error('不允许符号链接或子模块');
        commits[component] = commit;
      }
      for (const component of ['frontend', 'backend'])
        await run('merge', '--no-ff', '--no-edit', commits[component]);
      const commit = await run('rev-parse', 'HEAD');
      await run('push', 'origin', `HEAD:refs/heads/${branch}`);
      const remote = await run('ls-remote', 'origin', `refs/heads/${branch}`);
      if (remote.split(/\s/)[0] !== commit) throw new Error('远端提交核对失败');
      published = { commit, branch, repository, componentCommits: commits };
      audit.push({ action: 'remote-verified', ...published, at: Date.now() });
      return published;
    })().finally(() => {
      publishing = undefined;
    });
    return publishing;
  };
  let port = 0;
  let checkoutProof:
    | {
        commit: string;
        branch: string;
        repository: string;
        bundleUrl: string;
        instructions: string;
      }
    | undefined;
  const checkoutPublished = async (signal: AbortSignal) => {
    if (!published) throw new Error('测试分支尚未推送，不能获取复测代码');
    if (checkoutProof) return checkoutProof;
    const target = path.join(directory, 'verify-checkout');
    await exec('git', ['clone', '--branch', published.branch, repository, target], {
      timeout: 90_000,
      signal,
    });
    const commit = await git(target, ['rev-parse', 'HEAD'], signal);
    if (commit !== published.commit) throw new Error('远端提交已变化，请先核对');
    await git(
      target,
      ['bundle', 'create', path.join(directory, 'published.bundle'), 'HEAD'],
      signal,
    );
    checkoutProof = {
      commit,
      branch: published.branch,
      repository,
      bundleUrl: `http://host.docker.internal:${port}/transfer/${transfer}/published.bundle`,
      instructions:
        '在 frontend/backend 各自沙箱 /workspace/verify 新目录克隆此 bundle，核对 git rev-parse HEAD。前端 npm ci && npm run build；后端 mvn -B -Dmaven.repo.local=/workspace/.m2 test package。启动两个服务，再用 agent-browser 复测下载与筛选，保留原 /workspace/repo 不变。',
    };
    audit.push({
      action: 'checkout-verified',
      commit,
      branch: published.branch,
      repository,
      at: Date.now(),
    });
    return checkoutProof;
  };
  const pending = new Set<AbortController>();
  const server = createServer(async (req, res) => {
    const controller = new AbortController();
    pending.add(controller);
    res.once('finish', () => pending.delete(controller));
    res.once('close', () => {
      if (!res.writableEnded) controller.abort();
      pending.delete(controller);
    });
    res.setHeader('content-type', 'application/json');
    if (req.headers.origin) {
      res.writeHead(403).end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const transferRoot = '/transfer/' + transfer + '/';
    try {
      if (
        (url.pathname === transferRoot + 'baseline.bundle' ||
          (checkoutProof && url.pathname === transferRoot + 'published.bundle')) &&
        req.method === 'GET'
      ) {
        res.setHeader('content-type', 'application/octet-stream');
        res.end(
          await readFile(
            path.join(
              directory,
              url.pathname.endsWith('/published.bundle') ? 'published.bundle' : 'baseline.bundle',
            ),
          ),
        );
        return;
      }
      const component = url.pathname.startsWith(transferRoot)
        ? url.pathname.slice(transferRoot.length)
        : '';
      if (['frontend', 'backend'].includes(component) && req.method === 'POST') {
        if (uploads.has(component)) {
          res
            .writeHead(409)
            .end(JSON.stringify({ error: 'Bundle already uploaded; call publish to reconcile' }));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 4 * 1024 * 1024) throw new Error('Bundle too large');
          chunks.push(chunk);
        }
        const bytes = Buffer.concat(chunks);
        if (
          !bytes.subarray(0, 16).toString().startsWith('# v2 git bundle') &&
          !bytes.subarray(0, 16).toString().startsWith('# v3 git bundle')
        )
          throw new Error('Not a Git bundle');
        await writeFile(path.join(directory, component + '.bundle'), bytes, {
          flag: 'wx',
          mode: 0o600,
        });
        uploads.add(component);
        audit.push({ action: 'bundle-uploaded', component, bytes: size, at: Date.now() });
        res.end(JSON.stringify({ uploaded: component, bytes: size }));
        return;
      }
      if (
        url.pathname !== '/mcp' ||
        req.method !== 'POST' ||
        req.headers.authorization !== `Bearer ${token}`
      ) {
        res.writeHead(403).end();
        return;
      }
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 64_000) throw new Error('Request too large');
      }
      const message = JSON.parse(raw);
      let result: unknown;
      audit.push({
        method: message.method,
        tool: message.params?.name,
        arguments: message.params?.arguments,
        at: Date.now(),
      });
      if (message.method === 'notifications/initialized' && message.id === undefined) {
        res.writeHead(204).end();
        return;
      }
      if (message.method === 'initialize')
        result = {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'meridian-repository-registry', version: '1' },
        };
      else if (message.method === 'tools/list') result = { tools: repositoryTools };
      else if (message.method === 'tools/call') {
        try {
          const name = message.params?.name,
            args = message.params?.arguments;
          let value: unknown;
          if (name === 'workbench_repository_resolve') {
            if (
              new URL(args.website_url).origin !== new URL(websiteUrl).origin ||
              args.module !== 'customers'
            )
              throw new Error('网站与模块未注册');
            value = {
              application: 'meridian-crm',
              module: 'customers',
              repository,
              baseCommit: base,
              targetBranch: branch,
              components: {
                frontend: { root: 'frontend', runtime: 'Node 24 / npm / Git', target: 'frontend' },
                backend: { root: 'backend', runtime: 'Java 21 / Maven / Git', target: 'backend' },
              },
              bundleUrl: `http://host.docker.internal:${port}${transferRoot}baseline.bundle`,
              uploadUrls: Object.fromEntries(
                ['frontend', 'backend'].map((c) => [
                  c,
                  `http://host.docker.internal:${port}${transferRoot}${c}`,
                ]),
              ),
              instructions:
                '在各 target 沙箱用 Node fetch 下载 baseline.bundle 到 /workspace/base.bundle，再 git clone --branch main /workspace/base.bundle /workspace/repo。origin 改为 repository URL，仅保留地址，不注入 GitHub 凭据。两个沙箱分别仅修改自己的 frontend/ 或 backend/ 目录；git config user.name/email 使用 Athena Demo / athena-demo@example.test；提交后 git bundle create /workspace/<target>.bundle HEAD，并用 Node fetch POST 二进制 bundle 到对应 uploadUrls。两个上传均成功后调用 publish，由宿主验证、合并和推送。前端 BACKEND_URL 用 http://host.docker.internal:<后端服务端口>。Maven 使用 -Dmaven.repo.local=/workspace/.m2，Java 服务监听 PORT=4173。',
            };
          } else if (name === 'workbench_repository_publish')
            value = await publish(controller.signal);
          else if (name === 'workbench_repository_checkout')
            value = await checkoutPublished(controller.signal);
          else throw new Error('Unknown tool');
          result = { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false };
        } catch (error) {
          result = { content: [{ type: 'text', text: String(error) }], isError: true };
        }
      } else throw new Error('Unknown MCP method');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    } catch (error) {
      res.writeHead(400).end(JSON.stringify({ error: String(error) }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
  return {
    endpoint: `http://127.0.0.1:${port}/mcp`,
    token,
    base,
    branch,
    audit,
    get published() {
      return published;
    },
    close: () => {
      for (const controller of pending) controller.abort();
      server.closeAllConnections();
      server.close();
    },
  };
}

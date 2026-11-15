import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { LocalSandbox, type SandboxCallContext } from '../src/main/local-sandbox';

export async function startCustomerRuntime(
  source: string,
  directory: string,
  phase: string,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const context: SandboxCallContext = {
    conversationId: phase,
    turnId: phase,
    signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
  };
  const sandbox = (kind: string) =>
    new LocalSandbox(
      path.join(directory, kind),
      path.resolve('packages/athena-sandbox/athena-sandbox.mjs'),
      () => {},
      {
        image: kind === 'frontend' ? 'athena-sandbox-node:1' : 'athena-sandbox-java:1',
        dockerfile: path.resolve(
          'resources/sandbox',
          kind === 'frontend' ? 'node.Dockerfile' : 'java.Dockerfile',
        ),
      },
    );
  const frontend = sandbox('frontend'),
    backend = sandbox('backend');
  const builds: Record<string, unknown> = {};
  const walk = async (directory: string): Promise<string[]> => {
    const result: string[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (['node_modules', 'target', 'dist', '.git'].includes(entry.name)) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) result.push(...(await walk(file)));
      else if (entry.isFile()) result.push(file);
    }
    return result;
  };
  const build = async (component: string, instance: LocalSandbox, command: string) => {
    const files = await Promise.all(
      (await walk(path.join(source, component))).map(async (file) => ({
        path: path.join('repo', path.relative(source, file)),
        content: await readFile(file, 'utf8'),
      })),
    );
    for (let index = 0; index < files.length; index += 20)
      await instance.write(context, files.slice(index, index + 20));
    console.log(`[${phase}] ${component}: installing dependencies and building`);
    let result = await instance.run(context, command, 30, 1200);
    while (result.command.status === 'running') {
      console.log(`[${phase}] ${component}: command ${result.command.id} running`);
      result = await instance.result(context, result.command.id, 30);
    }
    builds[component] = result;
    assert.equal(result.command.exitCode, 0, result.output);
    console.log(`[${phase}] ${component}: build exit 0`);
  };
  try {
    await Promise.all([
      build(
        'frontend',
        frontend,
        'cd repo/frontend && npm ci --no-audit --no-fund && npm run build',
      ),
      build(
        'backend',
        backend,
        'cd repo/backend && mvn -B -Dmaven.repo.local=/workspace/.m2 test package',
      ),
    ]);
    const backendService = await backend.service(
      context,
      'cd repo/backend && java -jar target/customer-service-1.0.0.jar',
      '/api/health',
    );
    const backendAddress = backendService.url.replace('127.0.0.1', 'host.docker.internal');
    const frontendService = await frontend.service(
      context,
      `cd repo/frontend && BACKEND_URL=${backendAddress} npm run dev`,
    );
    const list = await (await fetch(frontendService.url + '/api/customers')).json();
    assert.equal(list.total, 15);
    return {
      frontendUrl: frontendService.url,
      backendUrl: backendService.url,
      builds,
      containers: { frontend: await frontend.status(phase), backend: await backend.status(phase) },
      close: async () => {
        controller.abort();
        await Promise.all([frontend.dispose(), backend.dispose()]);
      },
    };
  } catch (error) {
    controller.abort();
    await Promise.all([frontend.dispose(), backend.dispose()]);
    throw error;
  }
}

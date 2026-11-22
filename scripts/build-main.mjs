import { build, context } from 'esbuild';
import { chmod, copyFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
async function preparePty() {
  const platform = process.platform + '-' + process.arch;
  if (process.platform !== 'win32') {
    const native = path.join('dist/main/prebuilds', platform);
    const prebuilt = path.join('node_modules/node-pty/prebuilds', platform);
    const source = existsSync(path.join(prebuilt, 'pty.node'))
      ? prebuilt
      : 'node_modules/node-pty/build/Release';
    await mkdir(native, { recursive: true });
    await copyFile(path.join(source, 'pty.node'), path.join(native, 'pty.node'));
    if (process.platform === 'darwin') {
      await copyFile(path.join(source, 'spawn-helper'), path.join(native, 'spawn-helper'));
      await chmod(path.join(native, 'spawn-helper'), 0o755);
    }
  }
}

const options = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  minify: true,
  external: ['electron'],
};
const preloads = ['src/main/preload.ts', 'src/main/native-terminal-preload.ts'];
export async function buildMain() {
  await preparePty();
  await build({
    ...options,
    entryPoints: ['src/main/main.ts'],
    outfile: 'dist/main/main.cjs',
    sourcemap: true,
  });
  await build({
    ...options,
    entryPoints: preloads,
    outdir: 'dist/main',
    outExtension: { '.js': '.cjs' },
  });
}

export async function watchMain(onBuild) {
  await preparePty();
  const compiler = await context({
    ...options,
    entryPoints: ['src/main/main.ts', ...preloads],
    outdir: 'dist/main',
    outExtension: { '.js': '.cjs' },
    sourcemap: true,
    write: false,
    logLevel: 'warning',
    plugins: [
      {
        name: 'athena-dev-reload',
        setup(plugin) {
          plugin.onEnd((result) => onBuild(result.errors.length ? undefined : result.outputFiles));
        },
      },
    ],
  });
  await compiler.watch();
  return compiler;
}
if (process.argv[1]?.endsWith('build-main.mjs')) await buildMain();

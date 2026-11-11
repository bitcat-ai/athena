/** 显式指定文档的真实只读检查；不调用模型或收发消息。 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { FeishuDocuments, feishuResource } from '../src/main/feishu-documents';

const urls = process.argv.slice(2);
if (process.env.WORKBENCH_FEISHU_READ_ACCEPTANCE !== '1' || !urls.length || urls.length > 5)
  throw new Error(
    '请先确认 1 至 5 个真实文档链接，显式启用 WORKBENCH_FEISHU_READ_ACCEPTANCE=1 后传入',
  );
urls.forEach(feishuResource);
const directory = await mkdtemp(path.join(tmpdir(), 'athena-feishu-read-'));
const output = path.resolve('test-results/feishu-documents-live');
try {
  const reader = new FeishuDocuments(directory);
  const sources = [];
  for (const url of urls) {
    const { content, ...metadata } = await reader.read(url);
    assert(content.trim() && metadata.untrusted && /^[a-f0-9]{64}$/.test(metadata.sha256));
    sources.push({ ...metadata, characters: content.length });
  }
  await mkdir(output, { recursive: true });
  await writeFile(
    path.join(output, 'verification.json'),
    JSON.stringify({ at: new Date().toISOString(), sources }, null, 2),
    { mode: 0o600 },
  );
  process.stdout.write(JSON.stringify({ passed: true, documents: sources.length, output }) + '\n');
} finally {
  await rm(directory, { recursive: true, force: true });
}

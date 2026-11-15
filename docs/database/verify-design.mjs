// Design checks only: synthetic data in a new temporary directory, never userData.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';

const directory = mkdtempSync(path.join(tmpdir(), 'athena-db-design-'));
const filename = path.join(directory, 'candidate.sqlite3');
const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const checks = [];
const db = new DatabaseSync(filename);
let other;
const run = (sql, ...values) => db.prepare(sql).run(...values);
const get = (sql, ...values) => db.prepare(sql).get(...values);
const rejected = (fn) => assert.throws(fn, /constraint|cannot store|message image/i);
function transaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
async function check(name, fn) { await fn(); checks.push(name); }
function message(id, conversation = 'conversation-a', ordinal = 0, role = 'assistant') {
  run('INSERT INTO messages(id,conversation_id,ordinal,role,text,created_at,status) VALUES (?,?,?,?,?,100,?)', id, conversation, ordinal, role, '', 'streaming');
}
function usage(id, messageId = id) {
  run('INSERT INTO usage_records(id,message_id,agent,started_at,status,source,observed,partial) VALUES (?,?,?,100,?,?,0,1)', id, messageId, 'codex', 'running', 'live');
}

try {
  const version = get('SELECT sqlite_version() AS value').value;
  const [major, minor, patch] = version.split('.').map(Number);
  assert.ok(major > 3 || (major === 3 && (minor > 51 || (minor === 51 && patch >= 3))), 'Use the verified Electron SQLite runtime (>= 3.51.3), not the older system SQLite for WAL checks.');
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF;');

  await check('connection pragmas, version and transactional schema migration', () => {
    assert.equal(get('PRAGMA foreign_keys').foreign_keys, 1);
    assert.equal(get('PRAGMA journal_mode').journal_mode, 'wal');
    assert.equal(get('PRAGMA synchronous').synchronous, 2);
    transaction(() => {
      db.exec(schema);
      run('INSERT INTO schema_migrations VALUES (1,?,100)', hash(schema));
      db.exec('PRAGMA user_version=1');
    });
    assert.equal(get('PRAGMA user_version').user_version, 1);
    assert.equal(get('SELECT checksum FROM schema_migrations WHERE version=1').checksum, hash(schema));
  });

  run('INSERT INTO workspaces VALUES (?,?)', 'workspace-a', '/synthetic/project-a');
  run('INSERT INTO workspaces VALUES (?,?)', 'workspace-b', '/synthetic/project-b');
  run('INSERT INTO app_state(id,selected_workspace_id,settings_json,usage_since,usage_updated_at) VALUES (1,?,?,100,100)', 'workspace-a', '{"agent":"codex"}');
  run('INSERT INTO conversations(id,workspace_id,scope_kind,title,updated_at,history_order) VALUES (?,?,?,?,100,0)', 'conversation-a', 'workspace-a', 'workspace', '页面任务');
  run('INSERT INTO conversations(id,workspace_id,scope_kind,title,updated_at,history_order) VALUES (?,?,?,?,100,1)', 'conversation-b', 'workspace-b', 'workspace', '另一个任务');
  message('assistant-a');
  message('assistant-b', 'conversation-b');

  await check('foreign keys, ordering, required keys and JSON root types', () => {
    rejected(() => message('orphan', 'missing'));
    rejected(() => message('same-order'));
    rejected(() => run('INSERT INTO workspaces VALUES (NULL,?)', '/synthetic/invalid'));
    rejected(() => run('UPDATE app_state SET settings_json=NULL'));
    rejected(() => run('UPDATE app_state SET settings_json=?', '[]'));
    rejected(() => run('UPDATE app_state SET settings_json=?', '{invalid'));
    rejected(() => run('DELETE FROM workspaces WHERE id=?', 'workspace-a'));
    rejected(() => run('UPDATE messages SET role=? WHERE id=?', 'system', 'assistant-a'));
  });

  await check('legacy unscoped history and missing agent are preserved', () => {
    run('INSERT INTO conversations(id,scope_kind,title,updated_at,history_order) VALUES (?,?,?,100,2)', 'legacy', 'legacy-unscoped', '旧记录');
    const row = get('SELECT workspace_id,agent FROM conversations WHERE id=?', 'legacy');
    assert.equal(row.workspace_id, null);
    assert.equal(row.agent, null);
    rejected(() => run('UPDATE conversations SET scope_kind=? WHERE id=?', 'workspace', 'legacy'));
    assert.equal(get("SELECT COALESCE(agent,'codex') AS effective FROM conversations WHERE id='legacy'").effective, 'codex');
  });

  await check('archive restoration preserves records and deterministic remote-chat routing order', () => {
    run('UPDATE conversations SET remote_chat_id=?,archived_at=200 WHERE id=?', 'chat-a', 'conversation-a');
    run('INSERT INTO conversations(id,workspace_id,scope_kind,title,updated_at,history_order,remote_chat_id) VALUES (?,?,?,?,200,3,?)', 'remote-new', 'workspace-a', 'workspace', '归档后新对话', 'chat-a');
    run('UPDATE conversations SET archived_at=NULL WHERE id=?', 'conversation-a');
    assert.equal(get("SELECT id FROM conversations WHERE workspace_id=? AND remote_chat_id=? AND archived_at IS NULL ORDER BY history_order DESC LIMIT 1", 'workspace-a', 'chat-a').id, 'remote-new');
    assert.equal(get("SELECT count(*) AS n FROM conversations WHERE remote_chat_id='chat-a' AND archived_at IS NULL").n, 2);
    rejected(() => run('UPDATE conversations SET history_order=3 WHERE id=?', 'conversation-a'));
  });

  await check('message plus usage acceptance is all-or-nothing', () => {
    assert.throws(() => transaction(() => {
      message('rolled-back', 'conversation-a', 1);
      usage('rolled-back');
      run('UPDATE messages SET status=? WHERE id=?', 'invented-success', 'rolled-back');
    }));
    assert.equal(get('SELECT count(*) AS n FROM messages WHERE id=?', 'rolled-back').n, 0);
    assert.equal(get('SELECT count(*) AS n FROM usage_records WHERE id=?', 'rolled-back').n, 0);
  });

  await check('unknown usage remains NULL; explicit zero and cumulative snapshots survive', () => {
    usage('assistant-a');
    run('UPDATE usage_records SET output_tokens=0, baseline_json=?, last_total_json=? WHERE id=?', '{"totalTokens":null}', '{"totalTokens":123}', 'assistant-a');
    const row = get('SELECT input_tokens,output_tokens,baseline_json,last_total_json FROM usage_records WHERE id=?', 'assistant-a');
    assert.equal(row.input_tokens, null);
    assert.equal(row.output_tokens, 0);
    assert.equal(JSON.parse(row.baseline_json).totalTokens, null);
    assert.equal(JSON.parse(row.last_total_json).totalTokens, 123);
    rejected(() => run('UPDATE usage_records SET total_tokens=-1 WHERE id=?', 'assistant-a'));
    rejected(() => run('UPDATE usage_records SET input_tokens=? WHERE id=?', 'unknown', 'assistant-a'));
    rejected(() => run('UPDATE usage_records SET message_id=? WHERE id=?', 'assistant-b', 'assistant-a'));
  });

  await check('stored integers remain readable under the JavaScript Number contract', () => {
    run('UPDATE usage_records SET total_tokens=? WHERE id=?', Number.MAX_SAFE_INTEGER, 'assistant-a');
    assert.equal(get("SELECT total_tokens FROM usage_records WHERE id='assistant-a'").total_tokens, Number.MAX_SAFE_INTEGER);
    rejected(() => run('UPDATE usage_records SET total_tokens=? WHERE id=?', 9007199254740992n, 'assistant-a'));
    rejected(() => run('UPDATE messages SET created_at=? WHERE id=?', 9007199254740992n, 'assistant-a'));
    run('UPDATE usage_records SET total_tokens=NULL WHERE id=?', 'assistant-a');
  });

  await check('call IDs are unique within a message, not across independent messages', () => {
    const add = (id) => run('INSERT INTO tool_calls(message_id,call_id,ordinal,name,status) VALUES (?,?,0,?,?)', id, 'call-1', 'web_act', 'running');
    add('assistant-a'); add('assistant-b'); rejected(() => add('assistant-a'));
    assert.equal(get('SELECT input_json FROM tool_calls WHERE message_id=?', 'assistant-a').input_json, null);
  });

  await check('image count, per-image bytes and aggregate bytes are enforced', () => {
    const add = (id, ordinal, bytes) => run('INSERT INTO message_images VALUES (?,?,?,?,?,zeroblob(?))', 'assistant-a', id, ordinal, id, 'image/png', bytes);
    for (let i = 0; i < 4; i++) add(`small-${i}`, i, 1);
    rejected(() => add('fifth', 4, 1));
    run('INSERT INTO message_images VALUES (?,?,?,?,?,zeroblob(2)) ON CONFLICT(message_id,image_id) DO UPDATE SET data=excluded.data', 'assistant-a', 'small-0', 0, 'small-0', 'image/png');
    assert.equal(get('SELECT length(data) AS n FROM message_images WHERE image_id=?', 'small-0').n, 2);
    run('DELETE FROM message_images WHERE message_id=?', 'assistant-a');
    add('large-1', 0, 5 * 1024 * 1024); add('large-2', 1, 5 * 1024 * 1024);
    rejected(() => add('one-byte-too-many', 2, 1));
    rejected(() => run('UPDATE message_images SET data=zeroblob(?) WHERE image_id=?', 5 * 1024 * 1024 + 1, 'large-1'));
    rejected(() => run('UPDATE message_images SET mime_type=? WHERE image_id=?', 'text/plain', 'large-1'));
    run('DELETE FROM message_images WHERE message_id=?', 'assistant-a');
    for (let i = 0; i < 4; i++) add(`quarter-${i}`, i, 2621440);
    rejected(() => run('INSERT OR REPLACE INTO message_images VALUES (?,?,?,?,?,zeroblob(?))', 'assistant-a', 'quarter-0', 0, 'quarter-0', 'image/png', 5242880));
    assert.equal(get("SELECT sum(length(data)) AS bytes FROM message_images WHERE message_id='assistant-a'").bytes, 10485760);
  });

  await check('memory provenance and global business keys reject NULL loopholes', () => {
    const sql = 'INSERT INTO learned_items(id,ordinal,kind,title,body,enabled,basis,evidence,source,origin_conversation_key,created_at,updated_at,revisions) VALUES (?,?,?,?,?,1,?,?,?,?,100,100,0)';
    run(sql, 'memory-a', 0, 'rule', '保留记录', '按用户指示处理', 'said', '用户明确要求保留', null, 'conversation-a');
    rejected(() => run(sql, 'memory-b', 1, 'rule', '保留记录', '其他内容', 'said', '用户再次明确要求', null, 'conversation-a'));
    rejected(() => run(sql, 'memory-c', 2, 'rule', '缺少依据', '不能存', 'said', null, null, 'conversation-a'));
    rejected(() => run(sql, 'memory-d', 3, 'rule', '网页指令', '不能存', 'source', null, 'https://example.invalid', 'conversation-a'));
  });

  await check('recording selection and rule injection preserve array order independently of clocks', () => {
    run('INSERT INTO recordings(id,history_order,title,started_at) VALUES (?,0,?,500)', 'old-recording', '旧录制');
    run('INSERT INTO recordings(id,history_order,title,started_at) VALUES (?,1,?,100)', 'recording-a', '时钟回退后的新录制');
    assert.equal(get('SELECT id FROM recordings ORDER BY history_order DESC LIMIT 1').id, 'recording-a');
    run('INSERT INTO learned_items(id,ordinal,kind,title,body,enabled,basis,evidence,origin_conversation_key,created_at,updated_at,revisions) VALUES (?,1,?,?,?,1,?,?,?,50,50,0)', 'memory-order-test', 'rule', '后记录的规范', '不以时间重排', 'said', '用户明确要求次序', 'conversation-a');
    assert.deepEqual(db.prepare("SELECT id FROM learned_items WHERE kind='rule' ORDER BY ordinal").all().map(r => r.id), ['memory-a','memory-order-test']);
    run("DELETE FROM learned_items WHERE id='memory-order-test'");
    run("DELETE FROM recordings WHERE id='old-recording'");
  });

  await check('repository component ownership and mapping uniqueness', () => {
    transaction(() => {
      run('INSERT INTO repository_mappings(id,origin,module,confirmed_at) VALUES (?,?,?,100)', 'mapping-a', 'https://example.invalid', '');
      run('INSERT INTO repository_components VALUES (?,?,?,?,?)', 'mapping-a', 'frontend', 'https://example.invalid/repo.git', '.', null);
      assert.equal(get('SELECT count(*) AS n FROM repository_components WHERE mapping_id=?', 'mapping-a').n, 1);
    });
    rejected(() => run('INSERT INTO repository_components VALUES (?,?,?,?,?)', 'missing', 'backend', 'repo', '.', null));
    rejected(() => run('INSERT INTO repository_components VALUES (?,?,?,?,?)', 'mapping-a', 'worker', 'repo', '.', null));
    rejected(() => run('INSERT INTO repository_mappings(id,origin,module,confirmed_at) VALUES (?,?,?,100)', 'mapping-b', 'https://example.invalid', ''));
  });

  await check('knowledge snapshots require both authority and root; separate identities do not merge', () => {
    for (const authority of ['identity-a', 'identity-b']) {
      run('INSERT INTO knowledge_indexes(authority_key,root_url,updated_at,partial) VALUES (?,?,100,0)', authority, 'https://example.invalid/doc');
      run('INSERT INTO knowledge_documents VALUES (?,?,?,?,?,?,?,?)', authority, 'https://example.invalid/doc', 'https://example.invalid/doc', '资料', 'docx', authority, null, hash(authority));
    }
    rejected(() => run('INSERT INTO knowledge_documents VALUES (?,?,?,?,?,?,?,?)', null, 'https://example.invalid/doc', 'x', '资料', 'docx', 'bad', null, hash('bad')));
    rejected(() => run('INSERT INTO knowledge_documents VALUES (?,?,?,?,?,?,?,?)', 'unknown', 'https://example.invalid/doc', 'x', '资料', 'docx', 'bad', null, hash('bad')));
    assert.equal(get('SELECT count(*) AS n FROM knowledge_documents').n, 2);
  });

  await check('artifact readiness and inbox deduplication have explicit integrity checks', () => {
    rejected(() => run('INSERT INTO artifacts(id,kind,path,ownership,state,created_at) VALUES (?,?,?,?,?,100)', 'bad-artifact', 'prd', 'test.md', 'managed', 'ready'));
    run('INSERT INTO artifacts(id,message_id,origin_message_key,kind,path,ownership,state,created_at) VALUES (?,?,?,?,?,?,?,100)', 'pending-artifact', 'assistant-a', 'assistant-a', 'prd', 'missing.md', 'managed', 'pending');
    const key = hash('synthetic-app:synthetic-message');
    run('INSERT INTO feishu_inbox VALUES (?,?,?,?,?,?)', key, 'running', Buffer.from('synthetic-ciphertext'), 1, 100, 'assistant-a');
    rejected(() => run('INSERT INTO feishu_inbox VALUES (?,?,?,?,?,?)', key, 'pending', Buffer.from('synthetic-ciphertext'), 1, 100, null));
    rejected(() => run('UPDATE feishu_inbox SET ciphertext=?', 'plaintext-string'));
  });

  await check('late updates cannot overwrite a newer or terminal message', () => {
    const sql = "UPDATE messages SET text=?,revision=revision+1 WHERE id=? AND revision=? AND status='streaming'";
    assert.equal(run(sql, 'first', 'assistant-a', 0).changes, 1);
    assert.equal(run(sql, 'stale', 'assistant-a', 0).changes, 0);
    transaction(() => {
      run("UPDATE messages SET status='done',ended_at=200,revision=revision+1 WHERE id='assistant-a'");
      run("UPDATE usage_records SET status='completed',ended_at=200 WHERE id='assistant-a'");
    });
    assert.equal(run(sql, 'late', 'assistant-a', 2).changes, 0);
    assert.equal(get("SELECT text FROM messages WHERE id='assistant-a'").text, 'first');
  });

  await check('recovery records interruption without replaying work', () => {
    usage('assistant-b');
    run('INSERT INTO execution_events(message_id,event_id,ordinal,task_key,at,kind,status) VALUES (?,?,0,?,100,?,?)', 'assistant-b', 'prior-event', 'assistant-b', 'operation', 'running');
    const recover = () => transaction(() => {
      const pending = db.prepare("UPDATE messages SET status='error',revision=revision+1 WHERE role='assistant' AND status='streaming' RETURNING id").all();
      for (const row of pending) {
        run("UPDATE tool_calls SET status='error',output=? WHERE message_id=? AND status='running'", 'Interrupted; result unknown', row.id);
        const ordinal = get('SELECT COALESCE(max(ordinal),-1)+1 AS next FROM execution_events WHERE message_id=?', row.id).next;
        run('INSERT INTO execution_events(message_id,event_id,ordinal,task_key,at,kind,status,evidence_json) VALUES (?,?,?,?,300,?,?,?)', row.id, `recovery-${row.id}`, ordinal, row.id, 'finished', 'failed', '{"reason":"interrupted"}');
      }
      run("UPDATE usage_records SET status='interrupted',partial=1 WHERE status='running'");
      run("UPDATE feishu_inbox SET state='unknown' WHERE state IN ('pending','running')");
      return pending.length;
    });
    assert.equal(recover(), 1); assert.equal(recover(), 0);
    assert.equal(get("SELECT ordinal FROM execution_events WHERE event_id='recovery-assistant-b'").ordinal, 1);
    assert.equal(get("SELECT duration_ms FROM tool_calls WHERE message_id='assistant-b'").duration_ms, null);
    assert.equal(get('SELECT state FROM feishu_inbox').state, 'unknown');
  });

  await check('deleting a conversation removes owned content and preserves independent records', () => {
    run('INSERT INTO recording_steps(recording_id,id,ordinal,kind,description,at,url,source) VALUES (?,?,0,?,?,100,?,?)', 'recording-a', 'step-a', 'click', '点击', 'https://example.invalid', 'human');
    run('INSERT INTO web_sessions(id,message_id,origin_message_key,started_at,status) VALUES (?,?,?,100,?)', 'web-a', 'assistant-a', 'assistant-a', 'finished');
    transaction(() => run('DELETE FROM conversations WHERE id=?', 'conversation-a'));
    assert.equal(get("SELECT count(*) AS n FROM messages WHERE id='assistant-a'").n, 0);
    assert.equal(get("SELECT count(*) AS n FROM message_images WHERE message_id='assistant-a'").n, 0);
    assert.equal(get("SELECT message_id FROM usage_records WHERE id='assistant-a'").message_id, null);
    assert.equal(get('SELECT count(*) AS n FROM recordings').n, 1);
    assert.equal(get('SELECT count(*) AS n FROM learned_items').n, 1);
    assert.equal(get("SELECT origin_message_key,message_id FROM web_sessions WHERE id='web-a'").origin_message_key, 'assistant-a');
    assert.equal(get("SELECT message_id FROM artifacts WHERE id='pending-artifact'").message_id, null);
  });

  await check('import manifests prevent a changed source from silently being reimported', () => {
    const claim = (key, digest) => {
      const existing = get('SELECT checksum FROM import_sources WHERE source_key=?', key);
      if (existing) { assert.equal(existing.checksum, digest, 'source changed'); return false; }
      transaction(() => run('INSERT INTO import_sources VALUES (?,?,10,1,100)', key, digest));
      return true;
    };
    assert.equal(claim('workspace.json', hash('fixture')), true);
    assert.equal(claim('workspace.json', hash('fixture')), false);
    assert.throws(() => claim('workspace.json', hash('changed')), /source changed/);
  });

  await check('WAL supports a reader while another connection holds a bounded write lock', () => {
    other = new DatabaseSync(filename);
    other.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=30;');
    db.exec('BEGIN IMMEDIATE');
    try {
      run("UPDATE messages SET text='uncommitted' WHERE id='assistant-b'");
      assert.notEqual(other.prepare("SELECT text FROM messages WHERE id='assistant-b'").get().text, 'uncommitted');
      assert.throws(() => other.exec('BEGIN IMMEDIATE'), /locked|busy/i);
    } finally { db.exec('ROLLBACK'); other.close(); other = undefined; }
  });

  await check('backup is a complete snapshot; external-file manifest detects missing or changed files', async () => {
    const bytes = Buffer.from('# Synthetic PRD\n');
    const source = path.join(directory, 'prd.md'); writeFileSync(source, bytes);
    run('INSERT INTO artifacts(id,kind,path,ownership,state,bytes,sha256,created_at) VALUES (?,?,?,?,?,?,?,100)', 'ready-artifact', 'prd', 'prd.md', 'managed', 'ready', bytes.length, hash(bytes));
    const target = path.join(directory, 'snapshot.sqlite3');
    await backup(db, target);
    const copy = new DatabaseSync(target, { readOnly: true });
    try {
      assert.equal(copy.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.deepEqual(copy.prepare('PRAGMA foreign_key_check').all(), []);
      const manifest = copy.prepare("SELECT path,bytes,sha256 FROM artifacts WHERE state='ready' AND ownership='managed'").all();
      assert.equal(manifest.length, 1);
      const copied = path.join(directory, 'backup-prd.md'); copyFileSync(source, copied);
      const verify = () => { const data = readFileSync(copied); assert.equal(data.length, manifest[0].bytes); assert.equal(hash(data), manifest[0].sha256); };
      verify(); writeFileSync(copied, 'changed'); assert.throws(verify); rmSync(copied); assert.throws(verify);
      run('INSERT INTO recordings(id,history_order,title,started_at) VALUES (?,2,?,400)', 'after-backup', '备份后新增');
      assert.equal(copy.prepare("SELECT count(*) AS n FROM recordings WHERE id='after-backup'").get().n, 0);
    } finally { copy.close(); }
  });

  await check('future database versions are refused and integrity checks cover both storage and relations', () => {
    const supported = () => assert.ok(get('PRAGMA user_version').user_version <= 1, 'unsupported future database');
    supported(); db.exec('PRAGMA user_version=2'); assert.throws(supported, /unsupported future/); db.exec('PRAGMA user_version=1');
    assert.equal(get('PRAGMA integrity_check').integrity_check, 'ok');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  });

  console.log(JSON.stringify({ scope: 'schema/design checks with synthetic temporary data; no application integration or user-data migration', engine: { electron: process.versions.electron, node: process.versions.node, sqlite: version }, schema: 'docs/database/schema.sql', schemaSha256: hash(schema), checksPassed: checks.length, checks }, null, 2));
} finally {
  other?.close(); db.close(); rmSync(directory, { recursive: true, force: true });
}

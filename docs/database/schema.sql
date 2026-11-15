-- Proposed schema v1. Design artifact only; Athena does not load this file.
-- The owner enables foreign_keys and starts a transaction before applying it.

CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version BETWEEN 1 AND 2147483647),
  checksum TEXT NOT NULL CHECK (length(checksum) = 64 AND checksum NOT GLOB '*[^0-9a-f]*'),
  applied_at INTEGER NOT NULL CHECK (applied_at BETWEEN 0 AND 9007199254740991)
) STRICT;

CREATE TABLE import_sources (
  source_key TEXT PRIMARY KEY NOT NULL CHECK (length(source_key) > 0),
  checksum TEXT NOT NULL CHECK (length(checksum) = 64 AND checksum NOT GLOB '*[^0-9a-f]*'),
  byte_count INTEGER NOT NULL CHECK (byte_count BETWEEN 0 AND 9007199254740991),
  record_count INTEGER NOT NULL CHECK (record_count BETWEEN 0 AND 9007199254740991),
  imported_at INTEGER NOT NULL CHECK (imported_at BETWEEN 0 AND 9007199254740991)
) STRICT;

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  path TEXT NOT NULL UNIQUE CHECK (length(path) > 0)
) STRICT;

CREATE TABLE app_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  selected_workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  workspace_mode TEXT CHECK (workspace_mode IN ('project', 'personal')),
  settings_json TEXT NOT NULL CHECK (json_valid(settings_json) AND json_type(settings_json) = 'object'),
  onboarding_json TEXT CHECK (onboarding_json IS NULL OR (json_valid(onboarding_json) AND json_type(onboarding_json) = 'object')),
  learning_enabled INTEGER NOT NULL DEFAULT 1 CHECK (learning_enabled IN (0, 1)),
  usage_since INTEGER NOT NULL CHECK (usage_since BETWEEN 0 AND 9007199254740991),
  usage_updated_at INTEGER NOT NULL CHECK (usage_updated_at BETWEEN 0 AND 9007199254740991)
) STRICT;

CREATE TABLE conversations (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE RESTRICT,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('workspace', 'legacy-unscoped')),
  title TEXT NOT NULL,
  updated_at INTEGER NOT NULL CHECK (updated_at BETWEEN 0 AND 9007199254740991),
  history_order INTEGER NOT NULL UNIQUE CHECK (history_order BETWEEN 0 AND 9007199254740991),
  archived_at INTEGER CHECK (archived_at IS NULL OR archived_at BETWEEN 0 AND 9007199254740991),
  agent TEXT CHECK (agent IN ('codex', 'claude', 'gemini', 'pi', 'cursor', 'opencode')),
  agent_session_id TEXT,
  remote_chat_id TEXT CHECK (remote_chat_id IS NULL OR length(remote_chat_id) > 0),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json) AND json_type(metadata_json) = 'object'),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision BETWEEN 0 AND 9007199254740991),
  CHECK ((scope_kind = 'workspace' AND workspace_id IS NOT NULL) OR (scope_kind = 'legacy-unscoped' AND workspace_id IS NULL))
) STRICT;

CREATE INDEX conversations_open_scope ON conversations(workspace_id, updated_at DESC, id) WHERE archived_at IS NULL;
CREATE INDEX conversations_workspace ON conversations(workspace_id);
CREATE INDEX conversations_archived ON conversations(archived_at DESC, id) WHERE archived_at IS NOT NULL;
CREATE INDEX conversations_remote_open ON conversations(workspace_id, remote_chat_id, history_order DESC)
  WHERE remote_chat_id IS NOT NULL AND archived_at IS NULL;

CREATE TABLE messages (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 9007199254740991),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at BETWEEN 0 AND 9007199254740991),
  status TEXT CHECK (status IN ('streaming', 'done', 'error')),
  source TEXT CHECK (source IN ('desktop', 'feishu')),
  ended_at INTEGER CHECK (ended_at IS NULL OR ended_at BETWEEN 0 AND 9007199254740991),
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json) AND json_type(details_json) = 'object'),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision BETWEEN 0 AND 9007199254740991),
  UNIQUE (conversation_id, ordinal)
) STRICT;

CREATE TABLE tool_calls (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  call_id TEXT NOT NULL CHECK (length(call_id) > 0),
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 9007199254740991),
  name TEXT NOT NULL CHECK (length(name) > 0),
  input_json TEXT CHECK (input_json IS NULL OR json_valid(input_json)),
  status TEXT NOT NULL CHECK (status IN ('running', 'done', 'error')),
  output TEXT,
  started_at INTEGER CHECK (started_at IS NULL OR started_at BETWEEN 0 AND 9007199254740991),
  finished_at INTEGER CHECK (finished_at IS NULL OR finished_at BETWEEN 0 AND 9007199254740991),
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms BETWEEN 0 AND 9007199254740991),
  exit_code INTEGER CHECK (exit_code IS NULL OR exit_code BETWEEN -9007199254740991 AND 9007199254740991),
  PRIMARY KEY (message_id, call_id),
  UNIQUE (message_id, ordinal)
) STRICT;

CREATE TABLE execution_events (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL CHECK (length(event_id) > 0),
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 9007199254740991),
  task_key TEXT NOT NULL CHECK (length(task_key) > 0),
  at INTEGER NOT NULL CHECK (at BETWEEN 0 AND 9007199254740991),
  kind TEXT NOT NULL CHECK (kind IN ('started','plan','operation','observation','checkpoint','recovery','human-help','artifact','cancelled','finished')),
  status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','blocked')),
  observation_key TEXT,
  outcome TEXT CHECK (outcome IN ('verified','not_applied','unknown')),
  evidence_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(evidence_json) AND json_type(evidence_json) = 'object'),
  PRIMARY KEY (message_id, event_id),
  UNIQUE (message_id, ordinal)
) STRICT;

CREATE INDEX execution_events_kind ON execution_events(message_id, kind, ordinal);

CREATE TABLE message_images (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  image_id TEXT NOT NULL CHECK (length(image_id) > 0),
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 9007199254740991),
  name TEXT NOT NULL CHECK (length(name) > 0),
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/png','image/jpeg','image/webp')),
  data BLOB NOT NULL CHECK (length(data) > 0 AND length(data) <= 5242880),
  PRIMARY KEY (message_id, image_id),
  UNIQUE (message_id, ordinal)
) STRICT;

CREATE TRIGGER message_images_insert_limit BEFORE INSERT ON message_images
WHEN (SELECT count(*) FROM message_images WHERE message_id = NEW.message_id AND image_id <> NEW.image_id) >= 4
  OR COALESCE((SELECT sum(length(data)) FROM message_images WHERE message_id = NEW.message_id AND image_id <> NEW.image_id), 0) + length(NEW.data) > 10485760
BEGIN SELECT RAISE(ABORT, 'message image aggregate limit'); END;

CREATE TRIGGER message_images_update_limit BEFORE UPDATE ON message_images
WHEN (SELECT count(*) FROM message_images WHERE message_id = NEW.message_id AND NOT (message_id = OLD.message_id AND image_id = OLD.image_id)) >= 4
  OR COALESCE((SELECT sum(length(data)) FROM message_images WHERE message_id = NEW.message_id AND NOT (message_id = OLD.message_id AND image_id = OLD.image_id)), 0) + length(NEW.data) > 10485760
BEGIN SELECT RAISE(ABORT, 'message image aggregate limit'); END;

CREATE TABLE usage_records (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  message_id TEXT UNIQUE REFERENCES messages(id) ON DELETE SET NULL,
  agent TEXT NOT NULL CHECK (agent IN ('codex','claude','gemini','pi','cursor','opencode','unknown')),
  started_at INTEGER NOT NULL CHECK (started_at BETWEEN 0 AND 9007199254740991),
  ended_at INTEGER CHECK (ended_at IS NULL OR ended_at BETWEEN 0 AND 9007199254740991),
  status TEXT NOT NULL CHECK (status IN ('running','completed','cancelled','failed','interrupted','untracked')),
  source TEXT NOT NULL CHECK (source IN ('live','legacy')),
  thread_id TEXT,
  turn_id TEXT,
  requested_model TEXT,
  model TEXT,
  effort TEXT,
  input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens BETWEEN 0 AND 9007199254740991),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens BETWEEN 0 AND 9007199254740991),
  cached_input_tokens INTEGER CHECK (cached_input_tokens IS NULL OR cached_input_tokens BETWEEN 0 AND 9007199254740991),
  cache_write_input_tokens INTEGER CHECK (cache_write_input_tokens IS NULL OR cache_write_input_tokens BETWEEN 0 AND 9007199254740991),
  reasoning_output_tokens INTEGER CHECK (reasoning_output_tokens IS NULL OR reasoning_output_tokens BETWEEN 0 AND 9007199254740991),
  total_tokens INTEGER CHECK (total_tokens IS NULL OR total_tokens BETWEEN 0 AND 9007199254740991),
  observed INTEGER NOT NULL CHECK (observed IN (0,1)),
  partial INTEGER NOT NULL CHECK (partial IN (0,1)),
  baseline_json TEXT CHECK (baseline_json IS NULL OR (json_valid(baseline_json) AND json_type(baseline_json) = 'object')),
  last_total_json TEXT CHECK (last_total_json IS NULL OR (json_valid(last_total_json) AND json_type(last_total_json) = 'object')),
  models_json TEXT CHECK (models_json IS NULL OR (json_valid(models_json) AND json_type(models_json) = 'array')),
  issues_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(issues_json) AND json_type(issues_json) = 'array'),
  pricing_json TEXT CHECK (pricing_json IS NULL OR (json_valid(pricing_json) AND json_type(pricing_json) = 'object')),
  CHECK (message_id IS NULL OR message_id = id)
) STRICT;

CREATE INDEX usage_records_date ON usage_records(started_at, id);
CREATE INDEX usage_records_agent_date ON usage_records(agent, started_at);
CREATE INDEX usage_records_model_date ON usage_records(model, started_at);
CREATE INDEX usage_records_native_turn ON usage_records(thread_id, turn_id) WHERE thread_id IS NOT NULL AND turn_id IS NOT NULL;

CREATE TABLE recordings (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  history_order INTEGER NOT NULL UNIQUE CHECK (history_order BETWEEN 0 AND 9007199254740991),
  title TEXT NOT NULL,
  started_at INTEGER NOT NULL CHECK (started_at BETWEEN 0 AND 9007199254740991),
  ended_at INTEGER CHECK (ended_at IS NULL OR ended_at BETWEEN 0 AND 9007199254740991),
  summary TEXT,
  shared_session_key TEXT,
  part INTEGER CHECK (part IS NULL OR part BETWEEN 0 AND 9007199254740991)
) STRICT;
CREATE INDEX recordings_recent ON recordings(started_at DESC, id);

CREATE TABLE recording_steps (
  recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  id TEXT NOT NULL CHECK (length(id) > 0),
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 9007199254740991),
  kind TEXT NOT NULL CHECK (kind IN ('navigate','click','fill','select','key','scroll','edit','undo','control')),
  description TEXT NOT NULL,
  at INTEGER NOT NULL CHECK (at BETWEEN 0 AND 9007199254740991),
  url TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('human','agent')),
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json) AND json_type(details_json) = 'object'),
  PRIMARY KEY (recording_id, id),
  UNIQUE (recording_id, ordinal)
) STRICT;

CREATE TABLE web_sessions (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  origin_message_key TEXT,
  started_at INTEGER NOT NULL CHECK (started_at BETWEEN 0 AND 9007199254740991),
  status TEXT NOT NULL,
  summary_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(summary_json) AND json_type(summary_json) = 'object')
) STRICT;
CREATE INDEX web_sessions_message ON web_sessions(message_id);
CREATE INDEX web_sessions_recent ON web_sessions(started_at DESC, id);

CREATE TABLE web_dispatches (
  session_id TEXT NOT NULL REFERENCES web_sessions(id) ON DELETE CASCADE,
  dispatch_id INTEGER NOT NULL CHECK (dispatch_id BETWEEN 1 AND 9007199254740991),
  created_at INTEGER NOT NULL CHECK (created_at BETWEEN 0 AND 9007199254740991),
  tool_name TEXT NOT NULL CHECK (length(tool_name) > 0),
  page_key TEXT,
  target_key TEXT,
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms BETWEEN 0 AND 9007199254740991),
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json) AND json_type(details_json) = 'object'),
  PRIMARY KEY (session_id, dispatch_id)
) STRICT;

CREATE TABLE learned_items (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  ordinal INTEGER NOT NULL UNIQUE CHECK (ordinal BETWEEN 0 AND 9007199254740991),
  kind TEXT NOT NULL CHECK (kind IN ('rule','knowledge')),
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  body TEXT NOT NULL CHECK (length(trim(body)) > 0),
  scope_origin TEXT CHECK (scope_origin IS NULL OR length(scope_origin) > 0),
  enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
  basis TEXT NOT NULL CHECK (basis IN ('said','did','source')),
  evidence TEXT,
  source TEXT,
  origin_conversation_key TEXT NOT NULL CHECK (length(origin_conversation_key) > 0),
  conversation_title TEXT,
  created_at INTEGER NOT NULL CHECK (created_at BETWEEN 0 AND 9007199254740991),
  updated_at INTEGER NOT NULL CHECK (updated_at BETWEEN 0 AND 9007199254740991),
  revisions INTEGER NOT NULL CHECK (revisions BETWEEN 0 AND 9007199254740991),
  CHECK ((basis IN ('said','did') AND evidence IS NOT NULL AND length(trim(evidence)) >= 4)
    OR (basis = 'source' AND source IS NOT NULL AND length(trim(source)) > 0)),
  CHECK (kind <> 'rule' OR basis IN ('said','did'))
) STRICT;
CREATE UNIQUE INDEX learned_items_business_key ON learned_items(kind, COALESCE(scope_origin, ''), title);
CREATE INDEX learned_items_context ON learned_items(enabled, kind, scope_origin, updated_at DESC);

CREATE TABLE repository_mappings (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  origin TEXT NOT NULL CHECK (length(origin) > 0),
  module TEXT NOT NULL,
  application TEXT,
  source TEXT,
  confirmed_at INTEGER NOT NULL CHECK (confirmed_at BETWEEN 0 AND 9007199254740991),
  UNIQUE (origin, module)
) STRICT;

CREATE TABLE repository_components (
  mapping_id TEXT NOT NULL REFERENCES repository_mappings(id) ON DELETE CASCADE,
  component TEXT NOT NULL CHECK (component IN ('frontend','backend')),
  repository TEXT NOT NULL CHECK (length(repository) > 0),
  root TEXT NOT NULL CHECK (length(root) > 0),
  branch TEXT,
  PRIMARY KEY (mapping_id, component)
) STRICT;

CREATE TABLE knowledge_indexes (
  authority_key TEXT NOT NULL CHECK (length(authority_key) > 0),
  root_url TEXT NOT NULL CHECK (length(root_url) > 0),
  updated_at INTEGER NOT NULL CHECK (updated_at BETWEEN 0 AND 9007199254740991),
  partial INTEGER NOT NULL CHECK (partial IN (0,1)),
  failures_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(failures_json) AND json_type(failures_json) = 'array'),
  PRIMARY KEY (authority_key, root_url)
) STRICT;

CREATE TABLE knowledge_documents (
  authority_key TEXT NOT NULL,
  root_url TEXT NOT NULL,
  url TEXT NOT NULL CHECK (length(url) > 0),
  title TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  content TEXT NOT NULL,
  revision INTEGER CHECK (revision IS NULL OR revision BETWEEN 0 AND 9007199254740991),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY (authority_key, root_url, url),
  FOREIGN KEY (authority_key, root_url) REFERENCES knowledge_indexes(authority_key, root_url) ON DELETE CASCADE
) STRICT;

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  origin_message_key TEXT,
  origin_conversation_key TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('prd','download','sandbox','other')),
  path TEXT NOT NULL CHECK (length(path) > 0),
  ownership TEXT NOT NULL CHECK (ownership IN ('managed','external')),
  state TEXT NOT NULL CHECK (state IN ('pending','ready','missing')),
  bytes INTEGER CHECK (bytes IS NULL OR bytes BETWEEN 0 AND 9007199254740991),
  sha256 TEXT CHECK (sha256 IS NULL OR (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*')),
  created_at INTEGER NOT NULL CHECK (created_at BETWEEN 0 AND 9007199254740991),
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json) AND json_type(details_json) = 'object'),
  CHECK (state <> 'ready' OR (bytes IS NOT NULL AND sha256 IS NOT NULL))
) STRICT;
CREATE INDEX artifacts_message ON artifacts(message_id);
CREATE INDEX artifacts_pending ON artifacts(state, created_at) WHERE state <> 'ready';

CREATE TABLE feishu_inbox (
  dedup_key TEXT PRIMARY KEY NOT NULL CHECK (length(dedup_key) = 64 AND dedup_key NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL CHECK (state IN ('pending','running','done','failed','unknown')),
  ciphertext BLOB NOT NULL CHECK (length(ciphertext) > 0),
  envelope_version INTEGER NOT NULL CHECK (envelope_version BETWEEN 1 AND 2147483647),
  received_at INTEGER NOT NULL CHECK (received_at BETWEEN 0 AND 9007199254740991),
  message_id TEXT REFERENCES messages(id) ON DELETE SET NULL
) STRICT;
CREATE INDEX feishu_inbox_message ON feishu_inbox(message_id);
CREATE INDEX feishu_inbox_state ON feishu_inbox(state, received_at);

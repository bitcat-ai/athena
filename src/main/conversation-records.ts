import { isArchived, type Conversation } from '../shared/types';

/** 保存对话记录的工作区存储：这里只用到对话列表和落盘。 */
export interface ConversationStore {
  data: { conversations: Conversation[] };
  save(): Promise<void>;
}

/** 已归档或已删除的对话不能准备连接，也不能继续发送。 */
export function assertOpenConversation(conversations: Conversation[], conversation: Conversation) {
  if (!conversations.includes(conversation)) throw new Error('找不到这个对话');
  if (isArchived(conversation)) throw new Error('这个对话已归档，恢复后才能继续');
}

function inWorkspace(conversation: Conversation, workspace: string) {
  return !conversation.workspace || conversation.workspace === workspace;
}

/** 默认打开的对话：优先上次选中的，其次是当前工作目录里的第一段；归档的不参与。 */
export function defaultConversation(
  conversations: Conversation[],
  workspace: string,
  selectedId: string | undefined,
): Conversation | undefined {
  const open = conversations.filter((item) => !isArchived(item) && inWorkspace(item, workspace));
  return open.find((item) => item.id === selectedId) ?? open[0];
}

/** 飞书会话对应的对话；归档后不再接收新消息。 */
export function feishuConversation(
  conversations: Conversation[],
  workspace: string,
  chatId: string,
): Conversation | undefined {
  return conversations.find(
    (item) => item.remoteChatId === chatId && item.workspace === workspace && !isArchived(item),
  );
}

function find(store: ConversationStore, id: string) {
  const conversation = store.data.conversations.find((item) => item.id === id);
  if (!conversation) throw new Error('找不到这个对话');
  return conversation;
}

/**
 * 归档或恢复一段对话。写入磁盘后才算完成；写入失败时撤回改动。
 * 正在执行任务的对话不能归档：先用停止按钮结束任务，或等它完成。
 */
export async function setConversationArchived(
  store: ConversationStore,
  id: string,
  archived: boolean,
  runningId: string | undefined,
  now = Date.now(),
): Promise<Conversation> {
  const conversation = find(store, id);
  if (archived && runningId === id)
    throw new Error('这个对话的任务还在进行，请先停止或等待完成后再归档');
  const previous = conversation.archivedAt;
  if (archived) conversation.archivedAt = previous ?? now;
  else delete conversation.archivedAt;
  try {
    await store.save();
  } catch (error) {
    if (previous === undefined) delete conversation.archivedAt;
    else conversation.archivedAt = previous;
    throw error;
  }
  return conversation;
}

/**
 * 删除 Athena 保存的这段对话记录，不触碰 CLI 自己的历史。
 * 正在执行任务的对话不能删除：先用停止按钮结束任务，或等它完成。
 */
export async function deleteConversationRecord(
  store: ConversationStore,
  id: string,
  runningId: string | undefined,
): Promise<Conversation> {
  const conversation = find(store, id);
  if (runningId === id) throw new Error('这个对话的任务还在进行，请先停止或等待完成后再删除');
  const conversations = store.data.conversations;
  const index = conversations.indexOf(conversation);
  conversations.splice(index, 1);
  try {
    await store.save();
  } catch (error) {
    conversations.splice(Math.min(index, conversations.length), 0, conversation);
    throw error;
  }
  return conversation;
}

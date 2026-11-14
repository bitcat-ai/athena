/** A working rule the user set, or a fact a task confirmed, kept for later conversations. */
export interface LearnedItem {
  id: string;
  kind: 'rule' | 'knowledge';
  title: string;
  body: string;
  /** Origin of the website the item is about; absent when it applies everywhere. */
  scope?: string;
  enabled: boolean;
  /** What it rests on: the user's own words, something the user did, or a named source. */
  basis: 'said' | 'did' | 'source';
  /** The words or the action, as they were found in the conversation. */
  evidence?: string;
  source?: string;
  conversationId: string;
  conversationTitle?: string;
  createdAt: number;
  updatedAt: number;
  revisions: number;
}
/** Which code a website's pages come from, as shown next to what was learned. */
export interface LearnedRepository {
  id: string;
  origin: string;
  module: string;
  application?: string;
  components: Partial<
    Record<'frontend' | 'backend', { repository: string; root: string; branch?: string }>
  >;
  source?: string;
  confirmedAt: number;
}
export interface LearningState {
  /** Whether conversations may add to what is kept and get it as context. */
  enabled: boolean;
  items: LearnedItem[];
  repositories: LearnedRepository[];
}

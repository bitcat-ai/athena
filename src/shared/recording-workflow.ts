export interface RecordingWorkflow {
  revision: string;
  goal: string;
  steps: Array<{ note: string; stepIds: string[] }>;
  parameters?: Array<{ name: string; example: string; stepIds: string[] }>;
  questions: Array<{ question: string; stepIds: string[]; answer?: string }>;
}

/**
 * Public interfaces for Task 6 long-horizon memory (see DESIGN.md).
 * Task 3 tool surface + Task 4 typed trajectory events + Task 6 memory tiers.
 */

// ---------------------------------------------------------------- Task 3 loop
export type ToolName =
  | 'read_file'
  | 'list_dir'
  | 'grep'
  | 'propose_edit'
  | 'run_test'
  | 'remember_fact'
  | 'finish';

export interface ToolCall {
  id: string;
  name: ToolName;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  id: string;
  ok: boolean;
  output: string;
  truncated?: boolean;
}

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface WorkingMessage {
  role: MessageRole;
  content: string;
  tokens: number;
  step: number;
  toolCall?: ToolCall;
}

// ------------------------------------------------------------ Memory strategies
export type MemoryStrategy =
  | 'no_memory'
  | 'naive_truncation'
  | 'summarization_only'
  | 'tiered_memory';

export const MEMORY_STRATEGIES: MemoryStrategy[] = [
  'no_memory',
  'naive_truncation',
  'summarization_only',
  'tiered_memory',
];

// --------------------------------------------------------------- Memory tiers
export interface EpisodicSummary {
  id: string;
  fromStep: number;
  toStep: number;
  text: string;
  preservedFacts: string[];
}

export interface PersistentFact {
  id: string;
  key: string;
  text: string;
  step: number;
  runId: string;
  /** Monotonic sequence number: implicit recency / staleness signal. */
  seq: number;
  active: boolean;
  supersededBy?: string;
}

export interface RetrievalQuery {
  text: string;
  topK: number;
}

export interface RetrievedFact {
  fact: PersistentFact;
  score: number;
}

// ---------------------------------------------------------------- Checkpoint
export interface ExecutionCheckpoint {
  task: string;
  strategy: MemoryStrategy;
  stepIndex: number;
  completedWork: string[];
  decisions: string[];
  pendingToolCall?: ToolCall;
  executedCallIds: string[];
  compactionCount: number;
  episodic: EpisodicSummary[];
  /** Script position for executors whose pointer can lag stepIndex. */
  scriptCursor?: number;
  /** Serialized [name, args] strings so stuck-loop detection survives compaction. */
  recentCalls?: string[];
  updatedAt: number;
}

// ------------------------------------------------- Drivers and executors
export interface ProposedStep {
  name: ToolName;
  args: Record<string, unknown>;
}

export interface DriverContext {
  task: string;
  stepIndex: number;
  workingSummary: string;
  retrievedFacts: string[];
  completedWork: string[];
  decisions: string[];
}

/** Chooses the next tool call: scripted (deterministic) or live (Ollama). */
export interface ModelDriver {
  nextCall(ctx: DriverContext): Promise<ProposedStep>;
}

export interface ExecutorRuntime {
  persistent: import('./memory/persistent.js').PersistentMemoryStore;
  decisions: string[];
  completedWork: string[];
  stepIndex: number;
}

export interface StepOutcome {
  output: string;
  ok: boolean;
  done: boolean;
  answer: string;
  completes?: string;
  /** False when a live call missed the scripted step (pointer must not advance). */
  matched?: boolean;
}

/** Turns a chosen call into a result: scripted, script-matching, or live fs. */
export interface StepExecutor {
  peek(pointer: number): ScriptStep | null;
  execute(call: ToolCall, step: ScriptStep | null, rt: ExecutorRuntime): Promise<StepOutcome>;
}

// ------------------------------------------------- Deterministic scenario set
export type ScenarioCategory =
  | 'standard_long_horizon'
  | 'recall_dependent'
  | 'memory_pollution';

export interface ScriptStep {
  tool: ToolName;
  args: Record<string, unknown>;
  output: string;
  ok?: boolean;
  /** Work item id completed by this step (used for resume-correctness). */
  completes?: string;
}

export interface GoldenScenario {
  id: string;
  category: ScenarioCategory;
  task: string;
  steps: ScriptStep[];
  /** 1-indexed step after which the process is killed to test cold restart. */
  killAfterStep?: number;
  /** Kill lands between pending-log and tool execution (the ugly timing). */
  killMidToolCall?: boolean;
  recallCheck?: { query: string; mustContain: string };
  /** Strings that must NOT appear in the final answer (pollution cases). */
  staleStrings?: string[];
}

// ---------------------------------------------------------------- Eval output
export interface ScenarioResult {
  scenarioId: string;
  category: ScenarioCategory;
  strategy: MemoryStrategy;
  /** live = Ollama drove the calls; deterministic = scripted fallback. */
  mode: 'live' | 'deterministic';
  toolCallErrors: number;
  completed: boolean;
  resumeCorrect: boolean | null;
  budgetAdherent: boolean;
  maxUsageRatio: number;
  compactions: number;
  recallCorrect: boolean | null;
  polluted: boolean | null;
  finalAnswer: string;
  stepsExecuted: number;
}

export interface StrategyMetrics {
  strategy: MemoryStrategy;
  resumeCorrectness: number | null;
  contextBudgetAdherence: number;
  recallAccuracy: number | null;
  memoryPollutionRate: number | null;
  completionRate: number;
  scenarios: number;
}

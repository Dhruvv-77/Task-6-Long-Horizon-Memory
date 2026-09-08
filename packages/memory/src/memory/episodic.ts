import { estimateTokens } from '../config.js';
import type { EpisodicSummary, ToolCall, WorkingMessage } from '../types.js';
import type { PersistentMemoryStore } from './persistent.js';
import type { WorkingMemory } from './working.js';

export const COMPACTION_MARKER = '[EPISODIC MEMORY COMPACTION]';

interface ExtractedFact {
  key: string;
  text: string;
  step: number;
}

function slug(text: string): string {
  const words = text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 0);
  return words.slice(0, 5).join('-') || 'fact';
}

/**
 * Pull load-bearing lines out of messages about to be compacted:
 * `decision:` / `constraint:` lines, plus explicit `remember_fact` tool calls.
 */
export function extractFacts(messages: WorkingMessage[]): ExtractedFact[] {
  const out: ExtractedFact[] = [];
  for (const m of messages) {
    for (const line of m.content.split('\n')) {
      const match = line.match(/^\s*(decision|constraint)\s*:\s*(.+?)\s*$/i);
      if (match) {
        out.push({ key: `${match[1].toLowerCase()}:${slug(match[2])}`, text: match[2], step: m.step });
      }
    }
    const call: ToolCall | undefined = m.toolCall;
    if (call?.name === 'remember_fact') {
      const key = call.arguments['key'];
      const text = call.arguments['text'];
      if (typeof key === 'string' && typeof text === 'string') {
        out.push({ key, text, step: m.step });
      }
    }
  }
  return out;
}

function preview(message: WorkingMessage): string {
  if (message.role === 'tool') {
    const lines = message.content.split('\n').length;
    return `[tool output: ${message.content.length} chars, ${lines} lines]`;
  }
  // Tool-call envelopes describe the action, never the argument payloads:
  // exact payloads (e.g. a remembered fact) must not leak into the summary.
  if (message.toolCall) return `[tool call: ${message.toolCall.name}]`;
  const firstLine = message.content.split('\n')[0];
  return firstLine.length > 120 ? `${firstLine.slice(0, 120)}…` : firstLine;
}

/**
 * Keeps the number of summary system messages bounded: the newest `keepFull`
 * summaries stay intact, everything older condenses into a single digest that
 * retains only step ranges and preserved facts. Re-rolling is safe because the
 * digest carries its facts in the same `Preserved:` shape it reads back.
 */
export function rollUpSummaries(working: WorkingMemory, keepFull = 1): void {
  const located = working.messages
    .map((m, index) => ({ m, index }))
    .filter(({ m }) => m.role === 'system' && m.content.startsWith(COMPACTION_MARKER));
  if (located.length <= keepFull + 1) return;

  const olds = located.slice(0, located.length - keepFull);
  const fromSteps: number[] = [];
  const toSteps: number[] = [];
  const facts: string[] = [];
  for (const { m } of olds) {
    const range = m.content.match(/Steps (\d+)–(\d+)/);
    if (range) {
      fromSteps.push(Number(range[1]));
      toSteps.push(Number(range[2]));
    }
    const preserved = m.content.match(/^Preserved: (.*)$/m);
    if (preserved && preserved[1] !== 'none') {
      for (const f of preserved[1].split(';').map((s) => s.trim()).filter(Boolean)) {
        if (!facts.includes(f)) facts.push(f);
      }
    }
  }
  const digest: WorkingMessage = {
    role: 'system',
    content:
      `${COMPACTION_MARKER} DIGEST of ${olds.length} older summaries ` +
      `(Steps ${Math.min(...fromSteps)}–${Math.max(...toSteps)}).\n` +
      `Preserved: ${facts.length > 0 ? facts.join('; ') : 'none'}`,
    tokens: 0,
    step: Math.max(...toSteps),
  };
  digest.tokens = estimateTokens(digest.content);

  const oldIndexes = new Set(olds.map(({ index }) => index));
  const [first] = olds;
  working.messages = working.messages.filter((_, index) => !oldIndexes.has(index));
  // Nothing is ever removed before the oldest summary, so its original index
  // is still the right chronological slot in the filtered array.
  const at = Math.min(first.index, working.messages.length);
  working.messages.splice(at, 0, digest);
}

/**
 * Compaction, not truncation: collapse the oldest non-system messages (by step
 * order, keeping the two newest) into a single summary system message plus an
 * EpisodicSummary. When `persistFacts` is set, load-bearing facts are written
 * to persistent memory *before* anything is discarded (the tiered strategy);
 * otherwise they live only in the summary (the summarization-only strategy).
 */
export function compactOldestMessages(
  working: WorkingMemory,
  persistent: PersistentMemoryStore,
  runId: string,
  persistFacts: boolean,
): EpisodicSummary | null {
  const nonSystem = working.messages
    .map((m, index) => ({ m, index }))
    .filter(({ m }) => m.role !== 'system')
    .sort((a, b) => a.m.step - b.m.step || a.index - b.index);
  if (nonSystem.length <= 2) return null;

  const keep = new Set(nonSystem.slice(-2).map(({ index }) => index));
  const compacted = nonSystem.filter(({ index }) => !keep.has(index)).map(({ m }) => m);
  const steps = compacted.map((m) => m.step);
  const fromStep = Math.min(...steps);
  const toStep = Math.max(...steps);

  const extracted = extractFacts(compacted);
  const preservedFacts: string[] = [];
  const notedKeys: string[] = [];
  if (persistFacts) {
    for (const f of extracted) {
      persistent.remember(f.key, f.text, f.step);
      preservedFacts.push(f.text);
    }
  } else {
    // Summarization-only notes THAT facts were recorded without retaining
    // their exact content — this is precisely what such summaries lose.
    for (const f of extracted) {
      if (!notedKeys.includes(f.key)) notedKeys.push(f.key);
    }
  }

  const summary: EpisodicSummary = {
    id: `ep-${fromStep}-${toStep}-${runId}`,
    fromStep,
    toStep,
    text:
      `${COMPACTION_MARKER} Steps ${fromStep}–${toStep} ` +
      `(${compacted.length} messages compacted into this note).\n` +
      compacted.map((m) => `- ${preview(m)}`).join('\n') +
      `\nPreserved: ${preservedFacts.length > 0 ? preservedFacts.join('; ') : 'none'}` +
      (notedKeys.length > 0 ? `\nNoted (content dropped): ${notedKeys.join(', ')}` : ''),
    preservedFacts,
  };

  working.messages = working.messages.filter(
    (m, index) => m.role === 'system' || keep.has(index),
  );
  const summaryMessage: WorkingMessage = {
    role: 'system',
    content: summary.text,
    tokens: estimateTokens(summary.text),
    step: toStep,
  };
  // Appended at the end so summaries stay in chronological order (roll-up
  // treats the last summary as the newest).
  working.messages.push(summaryMessage);
  return summary;
}

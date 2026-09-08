import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TOP_K,
  DEFAULT_WORKING_CONFIG,
  EVAL_WORKING_CONFIG,
  RRF_K,
  estimateTokens,
} from '../src/config.js';

describe('estimateTokens', () => {
  it('estimates zero tokens for empty text', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('uses ceil(chars/4)', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });
});

describe('working memory defaults', () => {
  it('caps production working memory', () => {
    expect(DEFAULT_WORKING_CONFIG.maxTokens).toBe(4000);
    expect(DEFAULT_WORKING_CONFIG.maxMessages).toBe(12);
    expect(DEFAULT_WORKING_CONFIG.compactionThreshold).toBe(0.75);
  });

  it('uses smaller caps for fast deterministic evals', () => {
    expect(EVAL_WORKING_CONFIG.maxTokens).toBe(1500);
    expect(EVAL_WORKING_CONFIG.maxMessages).toBe(8);
    expect(EVAL_WORKING_CONFIG.compactionThreshold).toBe(0.7);
  });

  it('uses RRF k=60 per the Task 2 brief', () => {
    expect(RRF_K).toBe(60);
    expect(DEFAULT_TOP_K).toBe(5);
  });
});

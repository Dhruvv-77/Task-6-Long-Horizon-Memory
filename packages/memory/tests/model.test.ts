import { describe, expect, it } from 'vitest';
import { ModelError, OllamaClient, type FetchFn } from '../src/agent/model.js';

function stubFetch(payload: unknown, ok = true): FetchFn {
  return (async () => ({
    ok,
    status: ok ? 200 : 500,
    json: async () => payload,
  })) as FetchFn;
}

const CTX = {
  task: 'rename the auth module',
  stepIndex: 0,
  workingSummary: 'listed src/auth, found 4 files',
  retrievedFacts: [],
  completedWork: [],
  decisions: [],
};

describe('OllamaClient.chooseCall', () => {
  it('takes the single native tool call', async () => {
    const client = new OllamaClient({
      fetchFn: stubFetch({
        message: {
          tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a.ts' } } }],
        },
      }),
    });
    const call = await client.chooseCall(CTX, ['read_file', 'finish']);
    expect(call).toEqual({ name: 'read_file', args: { path: 'a.ts' } });
  });

  it('takes the first call when the model returns several (one action per turn)', async () => {
    const client = new OllamaClient({
      fetchFn: stubFetch({
        message: {
          tool_calls: [
            { function: { name: 'grep', arguments: { pattern: 'auth' } } },
            { function: { name: 'read_file', arguments: { path: 'b.ts' } } },
          ],
        },
      }),
    });
    const call = await client.chooseCall(CTX, ['grep', 'read_file']);
    expect(call.name).toBe('grep');
  });

  it('falls back to a JSON block when the model answers in text', async () => {
    const client = new OllamaClient({
      fetchFn: stubFetch({
        message: { content: 'I will read the file\n```json\n{"name": "read_file", "arguments": {"path": "a.ts"}}\n```' },
      }),
    });
    const call = await client.chooseCall(CTX, ['read_file', 'finish']);
    expect(call).toEqual({ name: 'read_file', args: { path: 'a.ts' } });
  });

  it('parses function-call syntax (qwen style)', async () => {
    const client = new OllamaClient({
      fetchFn: stubFetch({ message: { content: 'grep {"pattern": "logout", "path": "src"}' } }),
    });
    const call = await client.chooseCall(CTX, ['grep', 'read_file']);
    expect(call).toEqual({ name: 'grep', args: { pattern: 'logout', path: 'src' } });
  });

  it('finds a call buried after reasoning prose', async () => {
    const client = new OllamaClient({
      fetchFn: stubFetch({
        message: { content: 'The test needs logout. I will check usage first.\nread_file {"path": "src/auth.js"}' },
      }),
    });
    const call = await client.chooseCall(CTX, ['read_file']);
    expect(call).toEqual({ name: 'read_file', args: { path: 'src/auth.js' } });
  });

  it('rejects garbage text as a tool-call error', async () => {
    const client = new OllamaClient({ fetchFn: stubFetch({ message: { content: 'looks good to me!' } }) });
    await expect(client.chooseCall(CTX, ['read_file'])).rejects.toBeInstanceOf(ModelError);
  });

  it('rejects unknown tool names', async () => {
    const client = new OllamaClient({
      fetchFn: stubFetch({
        message: { tool_calls: [{ function: { name: 'run_shell', arguments: {} } }] },
      }),
    });
    await expect(client.chooseCall(CTX, ['read_file'])).rejects.toBeInstanceOf(ModelError);
  });

  it('surfaces HTTP failures as model errors', async () => {
    const client = new OllamaClient({ fetchFn: stubFetch({}, false) });
    await expect(client.chooseCall(CTX, ['read_file'])).rejects.toBeInstanceOf(ModelError);
  });
});

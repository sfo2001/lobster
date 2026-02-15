import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createDefaultRegistry } from '../src/commands/registry.js';

function streamOf(items: any[]) {
  return (async function* () {
    for (const item of items) yield item;
  })();
}

async function collect(iterable: AsyncIterable<any>) {
  const items = [];
  for await (const item of iterable) items.push(item);
  return items;
}

test('llm_task.invoke posts to /tools/invoke (clawd) and normalizes result', async () => {
  const registry = createDefaultRegistry();
  const cmd = registry.get('llm_task.invoke');
  assert.ok(cmd, 'llm_task.invoke should be registered');
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'lobster-cache-'));

  const bodyLog: any[] = [];
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/tools/invoke') {
      res.writeHead(404);
      res.end('nope');
      return;
    }
    let buf = '';
    req.setEncoding('utf8');
    req.on('data', (d) => (buf += d));
    req.on('end', () => {
      const parsed = JSON.parse(buf || '{}');
      bodyLog.push(parsed);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          result: {
            ok: true,
            result: {
              runId: 'task_1',
              model: parsed.args?.model,
              prompt: parsed.args?.prompt,
              output: {
                text: 'done',
                data: { summary: 'hello world' },
              },
              usage: { inputTokens: 12, outputTokens: 2, totalTokens: 14 },
            },
          },
        }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  try {
    const result = await cmd.run({
      input: streamOf([{ kind: 'text', text: 'doc' }]),
      args: {
        _: [],
        token: 'test-token',
        model: 'claude-3-sonnet',
        prompt: 'Summarize',
      },
      ctx: baseCtx({ LOBSTER_CACHE_DIR: cacheDir, CLAWD_URL: `http://localhost:${port}` }, registry),
    } as any);

    const items = await collect(result.output!);
    assert.equal(items.length, 1);
    const payload = items[0];
    assert.equal(payload.kind, 'llm_task.invoke');
    assert.equal(payload.runId, 'task_1');
    assert.equal(payload.output.data.summary, 'hello world');
    assert.equal(payload.model, 'claude-3-sonnet');
    assert.equal(payload.source, 'clawd');
    assert.equal(payload.cached, false);
    assert.ok(payload.cacheKey);

    assert.equal(bodyLog.length, 1);
    assert.equal(bodyLog[0].tool, 'llm-task');
    assert.equal(bodyLog[0].action, 'invoke');
    assert.equal(bodyLog[0].args.prompt, 'Summarize');
    assert.equal(bodyLog[0].args.model, 'claude-3-sonnet');
    // artifacts are mapped to input; single artifact is unwrapped
    assert.equal(bodyLog[0].args.input, 'doc');
    assert.ok(!('artifacts' in bodyLog[0].args), 'artifacts should not be sent to gateway');
    assert.ok(!('artifactHashes' in bodyLog[0].args), 'artifactHashes should not be sent to gateway');
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
    await closeServer(server);
  }
});

test('llm_task.invoke retries when schema validation fails', async () => {
  const registry = createDefaultRegistry();
  const cmd = registry.get('llm_task.invoke');
  assert.ok(cmd);
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'lobster-cache-'));

  let calls = 0;
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/tools/invoke') {
      res.writeHead(404);
      res.end();
      return;
    }
    calls += 1;
    const valid = calls >= 2;
    const payload = {
      ok: true,
      result: {
        ok: true,
        result: {
          runId: `attempt_${calls}`,
          output: valid ? { data: { decision: 'send' } } : { data: { foo: 'bar' } },
        },
      },
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  try {
    const result = await cmd.run({
      input: streamOf([]),
      args: {
        _: [],
        model: 'claude-3-opus',
        prompt: 'Decide',
        'output-schema': '{"type":"object","required":["decision"]}',
        'max-validation-retries': 2,
      },
      ctx: baseCtx({ LOBSTER_CACHE_DIR: cacheDir, CLAWD_URL: `http://localhost:${port}` }, registry),
    } as any);

    const items = await collect(result.output!);
    assert.equal(items.length, 1);
    assert.equal(items[0].runId, 'attempt_2');
    assert.equal(items[0].output.data.decision, 'send');
    assert.equal(calls, 2);
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
    await closeServer(server);
  }
});

test('llm_task.invoke persists to run state so resume skips remote call', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'lobster-state-'));
  const registry = createDefaultRegistry();
  const cmd = registry.get('llm_task.invoke');
  assert.ok(cmd);

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/tools/invoke') {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    let buf = '';
    req.setEncoding('utf8');
    req.on('data', (d) => (buf += d));
    req.on('end', () => {
      void buf;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ ok: true, result: { ok: true, result: { runId: 'state_run', output: { data: { ok: true } } } } }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  const cacheDir = await mkdtemp(path.join(tmpdir(), 'lobster-cache-'));
  const ctxEnv = { LOBSTER_STATE_DIR: stateDir, LOBSTER_CACHE_DIR: cacheDir };

  try {
    const first = await cmd.run({
      input: streamOf([{ foo: 'bar' }]),
      args: {
        _: [],
        model: 'claude',
        prompt: 'Do thing',
        'state-key': 'run123',
      },
      ctx: baseCtx({ ...ctxEnv, CLAWD_URL: `http://localhost:${port}` }, registry),
    } as any);
    const firstItems = await collect(first.output!);
    assert.equal(firstItems[0].source, 'clawd');

    await closeServer(server);

    const second = await cmd.run({
      input: streamOf([{ foo: 'bar' }]),
      args: {
        _: [],
        model: 'claude',
        prompt: 'Do thing',
        'state-key': 'run123',
      },
      ctx: baseCtx({ ...ctxEnv, CLAWD_URL: `http://localhost:${port}` }, registry),
    } as any);
    const secondItems = await collect(second.output!);
    assert.equal(secondItems.length, 1);
    assert.equal(secondItems[0].source, 'run_state');
  } finally {
    await rm(stateDir, { recursive: true, force: true });
    await rm(cacheDir, { recursive: true, force: true });
    await closeServer(server);
  }
});

test('llm_task.invoke reuses file cache when URL unavailable', async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'lobster-cache-'));
  const registry = createDefaultRegistry();
  const cmd = registry.get('llm_task.invoke');
  assert.ok(cmd);

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/tools/invoke') {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    let buf = '';
    req.setEncoding('utf8');
    req.on('data', (d) => (buf += d));
    req.on('end', () => {
      void buf;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ ok: true, result: { ok: true, result: { runId: 'cache_run', output: { text: 'cached' } } } }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  const ctxEnv = { LOBSTER_CACHE_DIR: cacheDir, CLAWD_URL: `http://localhost:${port}` };

  try {
    const first = await cmd.run({
      input: streamOf([]),
      args: {
        _: [],
        model: 'claude',
        prompt: 'Cache me',
      },
      ctx: baseCtx({ ...ctxEnv, CLAWD_URL: `http://localhost:${port}` }, registry),
    } as any);
    const firstItems = await collect(first.output!);
    assert.equal(firstItems[0].source, 'clawd');

    await closeServer(server);

    const second = await cmd.run({
      input: streamOf([]),
      args: {
        _: [],
        model: 'claude',
        prompt: 'Cache me',
      },
      ctx: baseCtx({ ...ctxEnv, CLAWD_URL: `http://localhost:${port}` }, registry),
    } as any);
    const secondItems = await collect(second.output!);
    assert.equal(secondItems.length, 1);
    assert.equal(secondItems[0].source, 'cache');
    assert.equal(secondItems[0].cached, true);
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
    await closeServer(server);
  }
});

test('llm_task.invoke uses CLAWD_URL (/tools/invoke) without requiring --url/--model', async () => {
  const registry = createDefaultRegistry();
  const cmd = registry.get('llm_task.invoke');
  assert.ok(cmd);

  const cacheDir = await mkdtemp(path.join(tmpdir(), 'lobster-cache-'));

  const bodyLog: any[] = [];
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/tools/invoke') {
      res.writeHead(404);
      res.end('not found');
      return;
    }

    let buf = '';
    req.setEncoding('utf8');
    req.on('data', (d) => (buf += d));
    req.on('end', () => {
      const parsed = JSON.parse(buf || '{}');
      bodyLog.push(parsed);

      // This is the Clawdbot tool router envelope.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          result: {
            ok: true,
            result: {
              runId: 'task_clawd_1',
              output: { data: { hello: 'world' } },
            },
          },
        }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  try {
    const result = await cmd.run({
      input: streamOf([{ kind: 'text', text: 'doc' }]),
      args: {
        _: [],
        // no url, no model
        prompt: 'Summarize',
        refresh: true,
      },
      ctx: baseCtx({ CLAWD_URL: `http://localhost:${port}`, LOBSTER_CACHE_DIR: cacheDir }, registry),
    } as any);

    const items = await collect(result.output!);
    assert.equal(items.length, 1);
    assert.equal(items[0].source, 'clawd');
    assert.equal(items[0].cached, false);
    assert.equal(items[0].runId, 'task_clawd_1');
    assert.equal(items[0].output.data.hello, 'world');

    assert.equal(bodyLog.length, 1);
    assert.equal(bodyLog[0].tool, 'llm-task');
    assert.equal(bodyLog[0].action, 'invoke');
    assert.equal(bodyLog[0].args.prompt, 'Summarize');
    // artifactHashes are stripped (lobster-internal, not sent to gateway)
    assert.ok(!('artifactHashes' in bodyLog[0].args), 'artifactHashes should not be sent');
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
    await closeServer(server);
  }
});

test('llm_task.invoke handles openclaw gateway content/details format', async () => {
  const registry = createDefaultRegistry();
  const cmd = registry.get('llm_task.invoke');
  assert.ok(cmd);
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'lobster-cache-'));

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/tools/invoke') {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    let buf = '';
    req.setEncoding('utf8');
    req.on('data', (d) => (buf += d));
    req.on('end', () => {
      void buf;
      // Actual openclaw gateway format: outer envelope wraps content/details directly
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          result: {
            content: [{ type: 'text', text: JSON.stringify({ queries: ['q1', 'q2'] }, null, 2) }],
            details: {
              json: { queries: ['q1', 'q2'] },
              provider: 'autorouter',
              model: 'standard',
            },
          },
        }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  try {
    const result = await cmd.run({
      input: streamOf([]),
      args: {
        _: [],
        prompt: 'Generate queries',
        refresh: true,
      },
      ctx: baseCtx({ CLAWD_URL: `http://localhost:${port}`, LOBSTER_CACHE_DIR: cacheDir }, registry),
    } as any);

    const items = await collect(result.output!);
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, 'llm_task.invoke');
    assert.equal(items[0].source, 'clawd');
    assert.equal(items[0].cached, false);
    assert.deepEqual(items[0].output.data, { queries: ['q1', 'q2'] });
    assert.equal(items[0].output.format, 'json');
    assert.equal(items[0].model, 'standard');
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
    await closeServer(server);
  }
});

test('llm_task.invoke maps artifacts to input and outputSchema to schema', async () => {
  const registry = createDefaultRegistry();
  const cmd = registry.get('llm_task.invoke');
  assert.ok(cmd);
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'lobster-cache-'));

  const bodyLog: any[] = [];
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/tools/invoke') {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    let buf = '';
    req.setEncoding('utf8');
    req.on('data', (d) => (buf += d));
    req.on('end', () => {
      const parsed = JSON.parse(buf || '{}');
      bodyLog.push(parsed);
      // Return gateway format so the test completes
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          result: {
            content: [{ type: 'text', text: '{"extracted": true}' }],
            details: { json: { extracted: true }, provider: 'test', model: 'test-model' },
          },
        }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  try {
    const result = await cmd.run({
      input: streamOf([{ kind: 'json', data: { url: 'https://example.com', snippet: 'test content' } }]),
      args: {
        _: [],
        prompt: 'Extract sources',
        model: 'claude-3-sonnet',
        'output-schema': '{"type":"object","required":["extracted"]}',
        'max-output-tokens': '4096',
        refresh: true,
      },
      ctx: baseCtx({ CLAWD_URL: `http://localhost:${port}`, LOBSTER_CACHE_DIR: cacheDir }, registry),
    } as any);

    await collect(result.output!);

    assert.equal(bodyLog.length, 1);
    const args = bodyLog[0].args;

    // Argument mapping: artifacts -> input
    assert.ok('input' in args, 'args should have input field');
    assert.ok(!('artifacts' in args), 'args should not have artifacts field');
    assert.ok(!('artifactHashes' in args), 'args should not have artifactHashes field');

    // The single artifact's data should be unwrapped (not wrapped in array)
    assert.deepEqual(args.input, { url: 'https://example.com', snippet: 'test content' });

    // Argument mapping: outputSchema -> schema
    assert.ok('schema' in args, 'args should have schema field');
    assert.ok(!('outputSchema' in args), 'args should not have outputSchema field');
    assert.deepEqual(args.schema, { type: 'object', required: ['extracted'] });

    // Argument mapping: maxOutputTokens -> maxTokens
    assert.equal(args.maxTokens, 4096);
    assert.ok(!('maxOutputTokens' in args), 'args should not have maxOutputTokens field');

    // Fields that are lobster-internal should not be sent
    assert.ok(!('schemaVersion' in args), 'args should not have schemaVersion field');
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
    await closeServer(server);
  }
});

test('llm_task.invoke sends multiple artifacts as input array', async () => {
  const registry = createDefaultRegistry();
  const cmd = registry.get('llm_task.invoke');
  assert.ok(cmd);
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'lobster-cache-'));

  const bodyLog: any[] = [];
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/tools/invoke') {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    let buf = '';
    req.setEncoding('utf8');
    req.on('data', (d) => (buf += d));
    req.on('end', () => {
      bodyLog.push(JSON.parse(buf || '{}'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          result: { ok: true, result: { runId: 'multi', output: { data: { ok: true } } } },
        }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  try {
    const result = await cmd.run({
      input: streamOf([
        { kind: 'text', text: 'first' },
        { kind: 'text', text: 'second' },
      ]),
      args: { _: [], prompt: 'Summarize all', refresh: true },
      ctx: baseCtx({ CLAWD_URL: `http://localhost:${port}`, LOBSTER_CACHE_DIR: cacheDir }, registry),
    } as any);

    await collect(result.output!);

    assert.equal(bodyLog.length, 1);
    const args = bodyLog[0].args;
    // Multiple artifacts should be sent as array, not unwrapped
    assert.ok(Array.isArray(args.input), 'input should be an array for multiple artifacts');
    assert.deepEqual(args.input, ['first', 'second']);
    assert.ok(!('artifacts' in args), 'artifacts should not be sent');
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
    await closeServer(server);
  }
});

test('llm_task.invoke omits input when no artifacts provided', async () => {
  const registry = createDefaultRegistry();
  const cmd = registry.get('llm_task.invoke');
  assert.ok(cmd);
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'lobster-cache-'));

  const bodyLog: any[] = [];
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/tools/invoke') {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    let buf = '';
    req.setEncoding('utf8');
    req.on('data', (d) => (buf += d));
    req.on('end', () => {
      bodyLog.push(JSON.parse(buf || '{}'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          result: { ok: true, result: { runId: 'empty', output: { data: { ok: true } } } },
        }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  try {
    const result = await cmd.run({
      input: streamOf([]),
      args: { _: [], prompt: 'Do something', refresh: true },
      ctx: baseCtx({ CLAWD_URL: `http://localhost:${port}`, LOBSTER_CACHE_DIR: cacheDir }, registry),
    } as any);

    await collect(result.output!);

    assert.equal(bodyLog.length, 1);
    const args = bodyLog[0].args;
    assert.ok(!('input' in args), 'input should not be set when no artifacts');
    assert.ok(!('artifacts' in args), 'artifacts should not be sent');
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
    await closeServer(server);
  }
});

test('llm_task.invoke falls back to tryParseJson when details.json absent', async () => {
  const registry = createDefaultRegistry();
  const cmd = registry.get('llm_task.invoke');
  assert.ok(cmd);
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'lobster-cache-'));

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/tools/invoke') {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    let buf = '';
    req.setEncoding('utf8');
    req.on('data', (d) => (buf += d));
    req.on('end', () => {
      void buf;
      // Gateway format without details.json -- text is valid JSON
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          result: {
            content: [{ type: 'text', text: '{"key":"val"}' }],
            details: { provider: 'test', model: 'fallback-model' },
          },
        }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  try {
    const result = await cmd.run({
      input: streamOf([]),
      args: { _: [], prompt: 'Parse it', refresh: true },
      ctx: baseCtx({ CLAWD_URL: `http://localhost:${port}`, LOBSTER_CACHE_DIR: cacheDir }, registry),
    } as any);

    const items = await collect(result.output!);
    assert.equal(items.length, 1);
    assert.deepEqual(items[0].output.data, { key: 'val' });
    assert.equal(items[0].output.format, 'json');
    assert.equal(items[0].model, 'fallback-model');
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
    await closeServer(server);
  }
});

test('llm_task.invoke yields text format when text is not JSON and no details.json', async () => {
  const registry = createDefaultRegistry();
  const cmd = registry.get('llm_task.invoke');
  assert.ok(cmd);
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'lobster-cache-'));

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/tools/invoke') {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    let buf = '';
    req.setEncoding('utf8');
    req.on('data', (d) => (buf += d));
    req.on('end', () => {
      void buf;
      // Gateway format: plain text response, no details.json
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          result: {
            content: [{ type: 'text', text: 'plain english response' }],
            details: { provider: 'test', model: 'text-model' },
          },
        }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  try {
    const result = await cmd.run({
      input: streamOf([]),
      args: { _: [], prompt: 'Explain', refresh: true },
      ctx: baseCtx({ CLAWD_URL: `http://localhost:${port}`, LOBSTER_CACHE_DIR: cacheDir }, registry),
    } as any);

    const items = await collect(result.output!);
    assert.equal(items.length, 1);
    assert.equal(items[0].output.text, 'plain english response');
    assert.equal(items[0].output.data, null);
    assert.equal(items[0].output.format, 'text');
    assert.equal(items[0].model, 'text-model');
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
    await closeServer(server);
  }
});

test('llm_task.invoke handles gateway content with no text-type items', async () => {
  const registry = createDefaultRegistry();
  const cmd = registry.get('llm_task.invoke');
  assert.ok(cmd);
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'lobster-cache-'));

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/tools/invoke') {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    let buf = '';
    req.setEncoding('utf8');
    req.on('data', (d) => (buf += d));
    req.on('end', () => {
      void buf;
      // Gateway format: content has items but none with type 'text'
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          result: {
            content: [{ type: 'image', data: 'base64...' }],
            details: { json: { extracted: true }, model: 'vision-model' },
          },
        }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  try {
    const result = await cmd.run({
      input: streamOf([]),
      args: { _: [], prompt: 'Describe', refresh: true },
      ctx: baseCtx({ CLAWD_URL: `http://localhost:${port}`, LOBSTER_CACHE_DIR: cacheDir }, registry),
    } as any);

    const items = await collect(result.output!);
    assert.equal(items.length, 1);
    assert.equal(items[0].output.text, null);
    // data comes from details.json even without text items
    assert.deepEqual(items[0].output.data, { extracted: true });
    assert.equal(items[0].output.format, 'json');
    assert.equal(items[0].model, 'vision-model');
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
    await closeServer(server);
  }
});

test('llm_task.invoke sends maxTokens:0 when max-output-tokens is 0', async () => {
  const registry = createDefaultRegistry();
  const cmd = registry.get('llm_task.invoke');
  assert.ok(cmd);
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'lobster-cache-'));

  const bodyLog: any[] = [];
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/tools/invoke') {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    let buf = '';
    req.setEncoding('utf8');
    req.on('data', (d) => (buf += d));
    req.on('end', () => {
      bodyLog.push(JSON.parse(buf || '{}'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          result: { ok: true, result: { runId: 'zero', output: { data: {} } } },
        }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  try {
    const result = await cmd.run({
      input: streamOf([]),
      args: { _: [], prompt: 'Test', 'max-output-tokens': '0', refresh: true },
      ctx: baseCtx({ CLAWD_URL: `http://localhost:${port}`, LOBSTER_CACHE_DIR: cacheDir }, registry),
    } as any);

    await collect(result.output!);

    assert.equal(bodyLog.length, 1);
    const args = bodyLog[0].args;
    assert.equal(args.maxTokens, 0, 'maxTokens should be 0 (falsy but finite)');
    assert.ok(!('maxOutputTokens' in args), 'maxOutputTokens should not be sent');
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
    await closeServer(server);
  }
});

test('llm_task.invoke passes raw artifact as input when no data or text property', async () => {
  const registry = createDefaultRegistry();
  const cmd = registry.get('llm_task.invoke');
  assert.ok(cmd);
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'lobster-cache-'));

  const bodyLog: any[] = [];
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/tools/invoke') {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    let buf = '';
    req.setEncoding('utf8');
    req.on('data', (d) => (buf += d));
    req.on('end', () => {
      bodyLog.push(JSON.parse(buf || '{}'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          result: { ok: true, result: { runId: 'raw', output: { data: {} } } },
        }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  try {
    const result = await cmd.run({
      input: streamOf([{ kind: 'binary', uri: 'file:///tmp/x.bin' }]),
      args: { _: [], prompt: 'Process', refresh: true },
      ctx: baseCtx({ CLAWD_URL: `http://localhost:${port}`, LOBSTER_CACHE_DIR: cacheDir }, registry),
    } as any);

    await collect(result.output!);

    assert.equal(bodyLog.length, 1);
    const args = bodyLog[0].args;
    // Artifact has neither .data nor .text, so the raw object is passed through
    assert.deepEqual(args.input, { kind: 'binary', uri: 'file:///tmp/x.bin' });
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
    await closeServer(server);
  }
});

function baseCtx(envOverrides: Record<string, string>, registry?) {
  return {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: { ...process.env, ...envOverrides },
    registry: registry ?? null,
    mode: 'tool',
    render: { json() {}, lines() {} },
  };
}

async function closeServer(server: http.Server) {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

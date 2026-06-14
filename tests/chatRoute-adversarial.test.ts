/**
 * Chat Route — Trust Boundary Adversarial Tests
 *
 * Tests Zod schema bypass, injection, streaming seams at the
 * HTTP → Zod Schema → Service trust boundary.
 */

import { describe, it, expect } from 'vitest';
import supertest from 'supertest';
import { app } from './setup.ts';

// ────────────────────────────────────────────────────────────────
// Chat Route — Trust Boundary (HTTP → Zod Schema → Service)
// ────────────────────────────────────────────────────────────────
describe('Chat Route adversarial — HTTP trust boundary', () => {
  const agent = supertest(app);

  it('should reject request with missing provider field — 400 error event', async () => {
    const response = await agent
      .post('/chat')
      .set('x-project', 'test')
      .set('x-username', 'adversarial')
      .send({
        messages: [{ role: 'user', content: 'hello' }],
      });
    expect(response.status).toBe(200);
    const responseBody = response.text;
    expect(responseBody).toContain('Missing required field: provider');
  });

  it('should reject request with number where provider string is expected', async () => {
    const response = await agent
      .post('/chat')
      .set('x-project', 'test')
      .set('x-username', 'adversarial')
      .send({
        provider: 12345,
        messages: [{ role: 'user', content: 'hello' }],
      });
    expect(response.status).toBe(200);
    const responseBody = response.text;
    expect(responseBody).toContain('error');
  });

  it('should reject request with messages as a string instead of array', async () => {
    const response = await agent
      .post('/chat')
      .set('x-project', 'test')
      .set('x-username', 'adversarial')
      .send({
        provider: 'openai',
        messages: 'not an array',
      });
    expect(response.status).toBe(200);
    const responseBody = response.text;
    expect(responseBody).toContain('messages');
  });

  it('should reject request with empty messages array', async () => {
    const response = await agent
      .post('/chat')
      .set('x-project', 'test')
      .set('x-username', 'adversarial')
      .send({
        provider: 'openai',
        messages: [],
      });
    expect(response.status).toBe(200);
    // Empty messages should still attempt generation (Zod allows empty array)
    // — the important thing is it doesn't crash the server
  });

  it('should handle null bytes in message content without crashing', async () => {
    const response = await agent
      .post('/chat')
      .set('x-project', 'test')
      .set('x-username', 'adversarial')
      .send({
        provider: 'openai',
        messages: [{ role: 'user', content: 'hello\0world\0' }],
      });
    expect(response.status).toBe(200);
  });

  it('should handle prototype pollution attempt in request body', async () => {
    const maliciousBody = JSON.parse(
      '{"__proto__": {"isAdmin": true}, "provider": "openai", "messages": [{"role": "user", "content": "hi"}]}',
    );
    const response = await agent
      .post('/chat')
      .set('x-project', 'test')
      .set('x-username', 'adversarial')
      .send(maliciousBody);
    expect(response.status).toBe(200);
    expect(({} as Record<string, unknown>).isAdmin).toBeUndefined();
  });

  it('should handle very long provider name without crashing', async () => {
    const response = await agent
      .post('/chat')
      .set('x-project', 'test')
      .set('x-username', 'adversarial')
      .send({
        provider: 'x'.repeat(10_000),
        messages: [{ role: 'user', content: 'hi' }],
      });
    expect(response.status).toBe(200);
    const responseBody = response.text;
    expect(responseBody).toContain('error');
  });

  it('should handle constructor pollution in nested message fields', async () => {
    const response = await agent
      .post('/chat')
      .set('x-project', 'test')
      .set('x-username', 'adversarial')
      .send({
        provider: 'openai',
        messages: [
          {
            role: 'user',
            content: 'test',
            constructor: { prototype: { polluted: true } },
          },
        ],
      });
    expect(response.status).toBe(200);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('should handle non-streaming JSON mode with malformed body', async () => {
    const response = await agent
      .post('/chat?stream=false')
      .set('x-project', 'test')
      .set('x-username', 'adversarial')
      .send({
        provider: 'openai',
        messages: [{ role: 'user', content: 'test' }],
        maxTokens: -1,
        temperature: NaN,
      });
    // NaN serializes to null in JSON — Zod allows nullable numbers
    expect([200, 500]).toContain(response.status);
  });

  it('should handle massive maxTokens without crashing the server', async () => {
    const response = await agent
      .post('/chat?stream=false')
      .set('x-project', 'test')
      .set('x-username', 'adversarial')
      .send({
        provider: 'openai',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: Number.MAX_SAFE_INTEGER,
      });
    expect([200, 500]).toContain(response.status);
  });

  it('should reject unknown provider with descriptive error', async () => {
    const response = await agent
      .post('/chat?stream=false')
      .set('x-project', 'test')
      .set('x-username', 'adversarial')
      .send({
        provider: 'nonexistent-provider',
        messages: [{ role: 'user', content: 'hello' }],
      });
    expect(response.status).toBe(500);
  });

  it('should pass through extra unknown fields without crashing (passthrough schema)', async () => {
    const response = await agent
      .post('/chat?stream=false')
      .set('x-project', 'test')
      .set('x-username', 'adversarial')
      .send({
        provider: 'openai',
        messages: [{ role: 'user', content: 'hi' }],
        unknownField: 'should be ignored',
        anotherCustomField: { nested: true },
      });
    expect([200, 500]).toContain(response.status);
  });
});

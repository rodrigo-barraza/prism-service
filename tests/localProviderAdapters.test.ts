import { vi, describe, it, expect, beforeEach } from 'vitest';
import './setup.ts';
import { createOllamaProvider } from '../src/providers/ollama.ts';
import { createVllmProvider } from '../src/providers/vllm.ts';
import { createLlamaCppProvider } from '../src/providers/llama-cpp.ts';
import { ChatMessage } from '../src/types/provider.ts';

describe('Local Provider Adapters (Ollama, vLLM, Llama-cpp)', () => {
  let fetchSpy: any;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, 'fetch');
  });

  describe('Ollama Provider', () => {
    it('sends correct chat payload and parses response', async () => {
      const provider = createOllamaProvider('http://localhost:11434');

      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          message: { role: 'assistant', content: 'Hello from Ollama', thinking: 'Hmm...' },
          prompt_eval_count: 50,
          eval_count: 25,
        }),
      });

      const messages: ChatMessage[] = [
        { role: 'user', content: 'Hello', images: ['data:image/png;base64,iVBORw0K'] }
      ];

      const result = await provider.generateText(messages, 'llama3', { temperature: 0.8 });

      expect(fetchSpy).toHaveBeenCalled();
      const chatCall = fetchSpy.mock.calls.find((call: any) => String(call[0]).includes('/api/chat'));
      expect(chatCall).toBeDefined();
      const requestConfig = chatCall[1];
      const requestBody = JSON.parse(requestConfig.body);
      
      expect(requestBody.model).toBe('llama3');
      expect(requestBody.messages[0].images[0]).toBe('iVBORw0K');
      expect(requestBody.options.temperature).toBe(0.8);
      
      expect(result.text).toBe('Hello from Ollama');
      expect(result.thinking).toBe('Hmm...');
      expect(result.usage).toEqual({ inputTokens: 50, outputTokens: 25 });
    });

    it('lists models and maps loaded status correctly', async () => {
      const provider = createOllamaProvider('http://localhost:11434');

      // First fetch /api/tags
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          models: [{ name: 'llama3:latest', model: 'llama3:latest' }]
        })
      });
      // Second fetch /api/ps
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          models: [{ name: 'llama3:latest', model: 'llama3:latest', size_vram: 5000000 }]
        })
      });

      const result = await provider.listModels!();
      expect(result.models).toHaveLength(1);
      expect(result.models[0].key).toBe('llama3:latest');
      expect(result.models[0].loaded_instances).toBeDefined();
      expect(result.models[0].loaded_instances![0].id).toBe('llama3:latest');
    });
  });

  describe('vLLM Provider', () => {
    it('applies temporary system message rewrite for Qwen3.6 and sends extensions', async () => {
      const provider = createVllmProvider('http://localhost:8000');

      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'vLLM output' } }],
          usage: { prompt_tokens: 30, completion_tokens: 15 }
        })
      });

      const messages: ChatMessage[] = [
        { role: 'system', content: 'Leading system' },
        { role: 'user', content: 'Hello' },
        { role: 'system', content: 'Mid-conversation system' }
      ];

      // Use a model containing qwen3.6 in name to trigger temporary patch
      await provider.generateText(messages, 'qwen3.6-7b', { topK: 10, thinkingEnabled: true });

      const vllmCall = fetchSpy.mock.calls.find((call: any) => String(call[0]).includes('/v1/chat/completions'));
      expect(vllmCall).toBeDefined();
      const requestConfig = vllmCall[1];
      const requestBody = JSON.parse(requestConfig.body);

      expect(requestBody.messages).toHaveLength(3);
      // Leading system preserved
      expect(requestBody.messages[0].role).toBe('system');
      // Mid system converted to user
      expect(requestBody.messages[2].role).toBe('user');
      expect(requestBody.top_k).toBe(10);
      expect(requestBody.chat_template_kwargs).toEqual({ enable_thinking: true });
    });

    it('generates embeddings correctly', async () => {
      const provider = createVllmProvider('http://localhost:8000');

      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ embedding: [0.1, 0.2, 0.3] }]
        })
      });

      const result = await provider.generateEmbedding!('hello', 'text-embed-model');
      expect(result.embedding).toEqual([0.1, 0.2, 0.3]);
      expect(result.dimensions).toBe(3);
    });
  });

  describe('Llama-cpp Provider', () => {
    it('supports basic chat completion', async () => {
      const provider = createLlamaCppProvider('http://localhost:8080');

      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'llama-cpp output' } }],
          usage: { prompt_tokens: 12, completion_tokens: 6 }
        })
      });

      const result = await provider.generateText([{ role: 'user', content: 'Hi' }], 'gguf-model');
      expect(result.text).toBe('llama-cpp output');
      expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 6 });
    });
  });
});

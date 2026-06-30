import { vi, describe, it, expect, beforeEach } from 'vitest';
import './setup.ts';
import { createOllamaProvider } from '../src/providers/ollama.ts';
import { createVllmProvider } from '../src/providers/vllm.ts';
import { createLlamaCppProvider } from '../src/providers/llama-cpp.ts';
import { ChatMessage } from '../src/types/provider.ts';

// Mock context length discovery so it doesn't consume fetch mocks.
// Discovery is tested in its own dedicated test suite.
vi.mock('../src/utils/ContextLengthDiscovery.ts', () => ({
  discoverContextLength: vi.fn().mockResolvedValue(undefined),
}));

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

    it('supports streaming chat completion and unloads other models if running', async () => {
      const provider = createOllamaProvider('http://localhost:11434');

      // 1. fetch /api/ps (indicates running-model is active)
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          models: [{ name: 'other-model' }]
        })
      });
      // 2. fetch /api/generate (unloads other-model)
      fetchSpy.mockResolvedValueOnce({
        ok: true
      });
      // 3. fetch /api/chat (stream request)
      const mockStream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"message": {"content": "Hello"}, "done": false}\n'));
          controller.enqueue(new TextEncoder().encode('{"done": true, "prompt_eval_count": 30, "eval_count": 15, "eval_duration": 1000000000}\n'));
          controller.close();
        }
      });
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        body: mockStream
      });

      const stream = provider.generateTextStream([{ role: 'user', content: 'Hi' }], 'llama3');
      const chunks = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }

      expect(chunks[0]).toEqual({
        type: 'status',
        message: 'Unloading other-model…'
      });
      expect(chunks[1]).toBe('Hello');
      expect(chunks[2]).toEqual({
        type: 'usage',
        usage: { inputTokens: 30, outputTokens: 15 }
      });
      
      // Verify unloading call was made
      const unloadCall = fetchSpy.mock.calls.find((call: any) => String(call[0]).includes('/api/generate'));
      expect(unloadCall).toBeDefined();
    });

    it('supports captioning images', async () => {
      const provider = createOllamaProvider('http://localhost:11434');

      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          message: { content: 'ollama caption' },
          prompt_eval_count: 15,
          eval_count: 10
        })
      });

      const result = await provider.captionImage!(
        ['data:image/png;base64,iVBORw0K'],
        'Describe image',
        'llava'
      );
      expect(result.text).toBe('ollama caption');
      expect(result.usage).toEqual({ inputTokens: 15, outputTokens: 10 });
    });

    it('throws ProviderError on failure paths', async () => {
      const provider = createOllamaProvider('http://localhost:11434');

      fetchSpy.mockRejectedValue(new Error('Connection refused'));

      await expect(provider.generateText([], 'llama3')).rejects.toThrow('Connection refused');
      await expect(provider.captionImage!([], 'Describe', 'llava')).rejects.toThrow('Connection refused');
      await expect(provider.listModels!()).rejects.toThrow('Connection refused');
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

    it('supports streaming chat completions', async () => {
      const provider = createVllmProvider('http://localhost:8000');

      const mockStream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"choices": [{"delta": {"content": "Hello"}}]}\n\n'));
          controller.enqueue(new TextEncoder().encode('data: {"choices": [], "usage": {"prompt_tokens": 10, "completion_tokens": 5}}\n\n'));
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          controller.close();
        }
      });

      fetchSpy.mockResolvedValueOnce({
        ok: true,
        body: mockStream,
      });

      const stream = provider.generateTextStream([{ role: 'user', content: 'Hi' }], 'qwen3.6-7b');
      const chunks = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }

      expect(chunks[0]).toBe('Hello');
      expect(chunks[1]).toEqual({
        type: 'usage',
        usage: { inputTokens: 10, outputTokens: 5 }
      });
    });

    it('supports captioning images', async () => {
      const provider = createVllmProvider('http://localhost:8000');

      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'vllm caption' } }],
          usage: { prompt_tokens: 15, completion_tokens: 10 }
        })
      });

      const result = await provider.captionImage!(
        ['data:image/png;base64,iVBORw0K'],
        'Describe image',
        'qwen-vl'
      );
      expect(result.text).toBe('vllm caption');
      expect(result.usage).toEqual({ inputTokens: 15, outputTokens: 10 });
    });

    it('lists models', async () => {
      const provider = createVllmProvider('http://localhost:8000');

      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ id: 'qwen3.6-7b' }]
        })
      });

      const result = await provider.listModels!();
      expect(result.models).toHaveLength(1);
      expect(result.models[0].key).toBe('qwen3.6-7b');
    });

    it('throws ProviderError on failure paths', async () => {
      const provider = createVllmProvider('http://localhost:8000');

      fetchSpy.mockRejectedValue(new Error('vLLM connection error'));

      await expect(provider.generateText([], 'qwen3.6-7b')).rejects.toThrow('vLLM connection error');
      await expect(provider.captionImage!([], 'Describe', 'qwen-vl')).rejects.toThrow('vLLM connection error');
      await expect(provider.generateEmbedding!('hello', 'embed-model')).rejects.toThrow('vLLM connection error');
      await expect(provider.listModels!()).rejects.toThrow('vLLM connection error');
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

    it('supports streaming chat completion', async () => {
      const provider = createLlamaCppProvider('http://localhost:8080');

      const mockStream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"choices": [{"delta": {"content": "Hello"}}]}\n\n'));
          controller.enqueue(new TextEncoder().encode('data: {"choices": [], "usage": {"prompt_tokens": 10, "completion_tokens": 5}}\n\n'));
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          controller.close();
        }
      });

      fetchSpy.mockResolvedValueOnce({
        ok: true,
        body: mockStream,
      });

      const stream = provider.generateTextStream([{ role: 'user', content: 'Hi' }], 'gguf-model');
      const chunks = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }

      expect(chunks[0]).toBe('Hello');
      expect(chunks[1]).toEqual({
        type: 'usage',
        usage: { inputTokens: 10, outputTokens: 5 }
      });
    });

    it('supports captioning images', async () => {
      const provider = createLlamaCppProvider('http://localhost:8080');

      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'llama-cpp caption' } }],
          usage: { prompt_tokens: 20, completion_tokens: 10 }
        })
      });

      const result = await provider.captionImage!(
        ['data:image/png;base64,iVBORw0K'],
        'Describe',
        'gguf-vision-model'
      );
      expect(result.text).toBe('llama-cpp caption');
      expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 10 });
    });

    it('lists models', async () => {
      const provider = createLlamaCppProvider('http://localhost:8080');

      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ id: 'gguf-model-1' }]
        })
      });

      const result = await provider.listModels!();
      expect(result.models).toHaveLength(1);
      expect(result.models[0].key).toBe('gguf-model-1');
    });

    it('checks health', async () => {
      const provider = createLlamaCppProvider('http://localhost:8080');

      // Success
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'ok',
          slots_idle: 4,
          slots_processing: 1
        })
      });

      const healthResult = await provider.checkHealth!();
      expect(healthResult.ok).toBe(true);
      expect(healthResult.slotsIdle).toBe(4);
      expect(healthResult.slotsProcessing).toBe(1);

      // Unreachable / Error
      fetchSpy.mockRejectedValueOnce(new Error('Network error'));
      const unhealthyResult = await provider.checkHealth!();
      expect(unhealthyResult.ok).toBe(false);
      expect(unhealthyResult.status).toBe('unreachable');
    });

    it('throws ProviderError on failure paths', async () => {
      const provider = createLlamaCppProvider('http://localhost:8080');

      fetchSpy.mockRejectedValue(new Error('llama-cpp connection error'));

      await expect(provider.generateText([], 'gguf-model')).rejects.toThrow('llama-cpp connection error');
      await expect(provider.captionImage!([], 'Describe', 'gguf-vision-model')).rejects.toThrow('llama-cpp connection error');
      await expect(provider.listModels!()).rejects.toThrow('llama-cpp connection error');
    });
  });
});

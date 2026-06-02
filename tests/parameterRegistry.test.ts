import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { app } from './setup.ts';
import { getParameterDescriptors, getAgentDefaults } from '../src/services/ParameterRegistry.ts';

describe('ParameterRegistry', () => {
  it('should return all parameter descriptors', () => {
    const descriptors = getParameterDescriptors();
    expect(Array.isArray(descriptors)).toBe(true);
    expect(descriptors.length).toBeGreaterThan(0);

    // Verify key fields on a well-known parameter descriptor
    const temperatureDescriptor = descriptors.find((descriptor) => descriptor.key === 'temperature');
    expect(temperatureDescriptor).toBeDefined();
    expect(temperatureDescriptor?.label).toBe('Temperature');
    expect(temperatureDescriptor?.controlType).toBe('slider');
    expect(temperatureDescriptor?.dataType).toBe('number');
    expect(temperatureDescriptor?.defaultValue).toBe(1.0);
    expect(temperatureDescriptor?.agentDefault).toBe(0);
    expect(temperatureDescriptor?.group).toBe('sampling');
  });

  it('should build a map of agent-optimized default values', () => {
    const agentDefaults = getAgentDefaults();
    expect(agentDefaults).toHaveProperty('temperature', 0);
    expect(agentDefaults).toHaveProperty('maxTokens', 16384);
    expect(agentDefaults).toHaveProperty('topP', 1.0);
    expect(agentDefaults).toHaveProperty('frequencyPenalty', 0);
    expect(agentDefaults).toHaveProperty('presencePenalty', 0);
    expect(agentDefaults).toHaveProperty('reasoningEffort', 'high');
  });
});

describe('GET /config - Parameter Descriptors integration', () => {
  it('returns parameter descriptors inside the config payload', async () => {
    const response = await request(app)
      .get('/config')
      .expect(200);

    expect(response.body).toHaveProperty('parameterDescriptors');
    expect(Array.isArray(response.body.parameterDescriptors)).toBe(true);
    expect(response.body.parameterDescriptors.length).toBeGreaterThan(0);

    const maxTokensDescriptor = response.body.parameterDescriptors.find(
      (descriptor: any) => descriptor.key === 'maxTokens'
    );
    expect(maxTokensDescriptor).toBeDefined();
    expect(maxTokensDescriptor.agentDefault).toBe(16384);
    expect(maxTokensDescriptor.defaultValue).toBe(2048);
  });
});

describe('Chat Pipeline - Agent defaults resolution', () => {
  it('should apply agent default parameters when not explicitly sent in agent mode', async () => {
    // We mock/spy on the provider.generateText or provider.generateTextStream
    // of openai to see what options it gets called with.
    // In our supertest setup.ts, the provider is retrieved via `getProvider("openai")`
    // which delegates to MOCK_GENERATE_TEXT/MOCK_GENERATE_TEXT_STREAM.
    const { MOCK_GENERATE_TEXT_STREAM } = await import('./setup.ts');
    MOCK_GENERATE_TEXT_STREAM.mockClear();

    await request(app)
      .post('/chat')
      .set('Authorization', 'Bearer test-secret')
      .send({
        provider: 'openai',
        model: 'gpt-5.5',
        agent: 'CODING',
        messages: [{ role: 'user', content: 'hello' }],
      })
      .expect(200);

    // Get the arguments of the mock call
    expect(MOCK_GENERATE_TEXT_STREAM).toHaveBeenCalled();
    const calls = MOCK_GENERATE_TEXT_STREAM.mock.calls;
    const lastCall = calls[calls.length - 1];
    
    // The structure of call arguments to generateTextStream or generateText:
    // generateTextStream(messages, model, options, signal)
    const optionsPassed = lastCall[2];
    expect(optionsPassed).toBeDefined();
    expect(optionsPassed.temperature).toBe(0);
    expect(optionsPassed.maxTokens).toBe(16384);
    expect(optionsPassed.reasoningEffort).toBe('high');
  });

  it('should respect explicitly sent parameters in agent mode and not override them', async () => {
    const { MOCK_GENERATE_TEXT_STREAM } = await import('./setup.ts');
    MOCK_GENERATE_TEXT_STREAM.mockClear();

    await request(app)
      .post('/chat')
      .set('Authorization', 'Bearer test-secret')
      .send({
        provider: 'openai',
        model: 'gpt-5.5',
        agent: 'CODING',
        temperature: 0.7,
        maxTokens: 5000,
        messages: [{ role: 'user', content: 'hello' }],
      })
      .expect(200);

    expect(MOCK_GENERATE_TEXT_STREAM).toHaveBeenCalled();
    const calls = MOCK_GENERATE_TEXT_STREAM.mock.calls;
    const lastCall = calls[calls.length - 1];
    
    const optionsPassed = lastCall[2];
    expect(optionsPassed).toBeDefined();
    expect(optionsPassed.temperature).toBe(0.7);
    expect(optionsPassed.maxTokens).toBe(5000);
  });

  it('should NOT apply agent default parameters for standard chat sessions (no agent)', async () => {
    const { MOCK_GENERATE_TEXT_STREAM } = await import('./setup.ts');
    MOCK_GENERATE_TEXT_STREAM.mockClear();

    await request(app)
      .post('/chat')
      .set('Authorization', 'Bearer test-secret')
      .send({
        provider: 'openai',
        model: 'gpt-5.5',
        messages: [{ role: 'user', content: 'hello' }],
      })
      .expect(200);

    expect(MOCK_GENERATE_TEXT_STREAM).toHaveBeenCalled();
    const calls = MOCK_GENERATE_TEXT_STREAM.mock.calls;
    const lastCall = calls[calls.length - 1];
    
    const optionsPassed = lastCall[2];
    expect(optionsPassed).toBeDefined();
    // In standard chat mode, we don't automatically fill agent defaults
    expect(optionsPassed.temperature).toBeUndefined();
    expect(optionsPassed.maxTokens).toBeUndefined();
    expect(optionsPassed.reasoningEffort).toBeUndefined();
  });
});

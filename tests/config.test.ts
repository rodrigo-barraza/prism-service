import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from './setup.ts';
import ToolOrchestratorService from '../src/services/ToolOrchestratorService.ts';

beforeAll(() => {
  vi.spyOn(ToolOrchestratorService, 'getClientToolSchemas').mockReturnValue([
    {
      name: "enter_plan_mode",
      description: "Enter plan mode",
      domain: "Reasoning",
      system: true,
    },
    {
      name: "save_memory",
      description: "Save memory",
      domain: "Reasoning",
      system: true,
    },
  ]);
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe('GET /config', () => {

  it('returns the full config catalog', async () => {
    const res = await request(app)
      .get('/config')
      .expect(200);

    expect(res.body).toHaveProperty('providers');
    expect(res.body).toHaveProperty('providerList');
    expect(res.body).toHaveProperty('textToText');
    expect(res.body).toHaveProperty('textToSpeech');
    expect(res.body).toHaveProperty('textToImage');
    expect(res.body).toHaveProperty('imageToText');
    expect(res.body).toHaveProperty('embedding');
  });

  it('textToText has models and defaults', async () => {
    const res = await request(app)
      .get('/config')
      .expect(200);

    expect(res.body.textToText).toHaveProperty('models');
    expect(res.body.textToText).toHaveProperty('defaults');
    expect(typeof res.body.textToText.models).toBe('object');
    expect(typeof res.body.textToText.defaults).toBe('object');
  });

  it('textToSpeech has models, defaults, voices, and defaultVoices', async () => {
    const res = await request(app)
      .get('/config')
      .expect(200);

    expect(res.body.textToSpeech).toHaveProperty('models');
    expect(res.body.textToSpeech).toHaveProperty('defaults');
    expect(res.body.textToSpeech).toHaveProperty('voices');
    expect(res.body.textToSpeech).toHaveProperty('defaultVoices');
  });

  it('textToImage has models and defaults', async () => {
    const res = await request(app)
      .get('/config')
      .expect(200);

    expect(res.body.textToImage).toHaveProperty('models');
    expect(res.body.textToImage).toHaveProperty('defaults');
  });

  it('imageToText has models and defaults', async () => {
    const res = await request(app)
      .get('/config')
      .expect(200);

    expect(res.body.imageToText).toHaveProperty('models');
    expect(res.body.imageToText).toHaveProperty('defaults');
  });

  it('embedding has models and defaults', async () => {
    const res = await request(app)
      .get('/config')
      .expect(200);

    expect(res.body.embedding).toHaveProperty('models');
    expect(res.body.embedding).toHaveProperty('defaults');
  });

  it('providerList contains all known providers', async () => {
    const res = await request(app)
      .get('/config')
      .expect(200);

    const list = res.body.providerList;
    expect(list).toContain('openai');
    expect(list).toContain('anthropic');
    expect(list).toContain('google');
    expect(list).toContain('elevenlabs');
    expect(list).toContain('inworld');
  });
});

describe('GET /config/agents', () => {
  it('returns the list of agents with core agentic tools included for non-Lupos agents', async () => {
    const res = await request(app)
      .get('/config/agents')
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    
    const codingAgent = res.body.find((a: any) => a.id === 'CODING');
    expect(codingAgent).toBeDefined();
    // Coding agent is wildcard and has all tools enabled
    expect(codingAgent.enabledToolNames).toContain('*');
    expect(codingAgent.toolCount).toBe(-1);

    const luposAgent = res.body.find((a: any) => a.id === 'LUPOS');
    expect(luposAgent).toBeDefined();
    // Lupos agent explicitly enables core agentic tools in its persona
    expect(luposAgent.enabledToolNames).toContain('enter_plan_mode');
    expect(luposAgent.enabledToolNames).toContain('save_memory');
  });
});

describe('GET /config/tools', () => {
  it('returns all tools by default', async () => {
    const res = await request(app)
      .get('/config/tools')
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.some((t: any) => t.name === 'enter_plan_mode')).toBe(true);
  });

  it('includes core agentic tools when filtered by a non-Lupos agent like CODING', async () => {
    const res = await request(app)
      .get('/config/tools?agent=CODING')
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    // Should contain agentic tools
    expect(res.body.some((t: any) => t.name === 'enter_plan_mode')).toBe(true);
  });

  it('includes explicitly enabled core agentic tools when filtered by LUPOS', async () => {
    const res = await request(app)
      .get('/config/tools?agent=LUPOS')
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    // Lupos explicitly enables enter_plan_mode in its persona
    expect(res.body.some((t: any) => t.name === 'enter_plan_mode')).toBe(true);
    // Lupos also has save_memory
    expect(res.body.some((t: any) => t.name === 'save_memory')).toBe(true);
  });

  it('preserves system: true for whitelisted core agentic tools returned for LUPOS agent', async () => {
    const res = await request(app)
      .get('/config/tools?agent=LUPOS')
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    const saveMemory = res.body.find((t: any) => t.name === 'save_memory');
    expect(saveMemory).toBeDefined();
    // System flag should be preserved as true
    expect(saveMemory.system).toBe(true);
  });
});

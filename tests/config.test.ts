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
      name: "upsert_memory",
      description: "Create memory",
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
  it('returns the list of agents with core system tools included for non-Lupos agents', async () => {
    const res = await request(app)
      .get('/config/agents')
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    
    const codingAgent = res.body.find((a: any) => a.id === 'CODING');
    expect(codingAgent).toBeDefined();
    // Non-Lupos agent should have core system tools like enter_plan_mode
    expect(codingAgent.enabledToolNames).toContain('enter_plan_mode');
    expect(codingAgent.toolCount).toBeGreaterThan(0);

    const luposAgent = res.body.find((a: any) => a.id === 'LUPOS');
    expect(luposAgent).toBeDefined();
    // Lupos agent should NOT have core system tools like enter_plan_mode
    expect(luposAgent.enabledToolNames).not.toContain('enter_plan_mode');
    // But Lupos agent SHOULD have explicitly whitelisted system tools like upsert_memory
    expect(luposAgent.enabledToolNames).toContain('upsert_memory');
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

  it('includes core system tools when filtered by a non-Lupos agent like CODING', async () => {
    const res = await request(app)
      .get('/config/tools?agent=CODING')
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    // Should contain system tools
    expect(res.body.some((t: any) => t.name === 'enter_plan_mode')).toBe(true);
  });

  it('does NOT include non-whitelisted core system tools when filtered by LUPOS, but includes whitelisted ones', async () => {
    const res = await request(app)
      .get('/config/tools?agent=LUPOS')
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    // Lupos does not have enter_plan_mode
    expect(res.body.some((t: any) => t.name === 'enter_plan_mode')).toBe(false);
    // But Lupos has upsert_memory since we whitelisted it
    expect(res.body.some((t: any) => t.name === 'upsert_memory')).toBe(true);
  });

  it('preserves system: true for whitelisted core system tools returned for LUPOS agent', async () => {
    const res = await request(app)
      .get('/config/tools?agent=LUPOS')
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    const upsertMemory = res.body.find((t: any) => t.name === 'upsert_memory');
    expect(upsertMemory).toBeDefined();
    // System flag should be preserved as true
    expect(upsertMemory.system).toBe(true);
  });
});

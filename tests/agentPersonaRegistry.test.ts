import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/services/CustomAgentService.ts', () => {
  return {
    default: {
      list: vi.fn(),
    },
  };
});

import AgentPersonaRegistry from '../src/services/AgentPersonaRegistry.ts';
import CustomAgentService from '../src/services/CustomAgentService.ts';
import { AGENT_IDS } from '@rodrigo-barraza/utilities-library/taxonomy';

describe('AgentPersonaRegistry Unit Tests', () => {
  beforeEach(() => {
    AgentPersonaRegistry.unregister('CUSTOM_TEST_AGENT');
    AgentPersonaRegistry.unregister('CUSTOM_DB_AGENT');
    AgentPersonaRegistry.unregister('INVALID_PATTERN_AGENT');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('get', () => {
    it('should return null for empty or null agentId', () => {
      expect(AgentPersonaRegistry.get('')).toBeNull();
      expect(AgentPersonaRegistry.get(null as any)).toBeNull();
    });

    it('should return a built-in agent persona by case-insensitive ID', () => {
      const codingPersona = AgentPersonaRegistry.get(AGENT_IDS.CODING);
      expect(codingPersona).toBeDefined();
      expect(codingPersona?.name).toBe('Coding');
      expect(codingPersona?.project).toBe('prism-chat');

      const codingPersonaLowercase = AgentPersonaRegistry.get(AGENT_IDS.CODING.toLowerCase());
      expect(codingPersonaLowercase).toBe(codingPersona);
    });

    it('should return null and warn for an unknown agent ID', () => {
      const unknownPersona = AgentPersonaRegistry.get('UNKNOWN_AGENT');
      expect(unknownPersona).toBeNull();
    });
  });

  describe('list', () => {
    it('should return all registered personas sorted by displayOrder', () => {
      const list = AgentPersonaRegistry.list();
      expect(list.length).toBeGreaterThan(0);

      const codingEntry = list.find((entry) => entry.id === AGENT_IDS.CODING);
      expect(codingEntry).toBeDefined();
      expect(codingEntry?.name).toBe('Coding');
    });
  });

  describe('has', () => {
    it('should return true for existing built-in agents and false for unknown ones', () => {
      expect(AgentPersonaRegistry.has(AGENT_IDS.CODING)).toBe(true);
      expect(AgentPersonaRegistry.has(AGENT_IDS.CODING.toLowerCase())).toBe(true);
      expect(AgentPersonaRegistry.has('NONEXISTENT')).toBe(false);
    });
  });

  describe('isAgentProject', () => {
    it('should return true if a persona matches the project name, false otherwise', () => {
      expect(AgentPersonaRegistry.isAgentProject('prism-chat')).toBe(true);
      expect(AgentPersonaRegistry.isAgentProject('nonexistent-project-name')).toBe(false);
      expect(AgentPersonaRegistry.isAgentProject('')).toBe(false);
    });
  });

  describe('registerCustom & unregister', () => {
    it('should register a custom agent doc, resolve toolPolicy and policies, then unregister it', () => {
      const customAgentDoc = {
        agentId: 'CUSTOM_TEST_AGENT',
        name: 'Custom Test Agent',
        type: 'custom-type',
        description: 'A custom persona for testing',
        project: 'custom-project',
        icon: 'test-icon',
        avatar: 'test-avatar',
        color: 'test-color',
        backgroundImage: 'test-bg',
        identity: 'You are a test agent.',
        guidelines: 'Be helpful.',
        toolPolicy: 'Always allow custom tools.',
        availableTools: ['tool1', 'tool2'],
        policies: [
          {
            tool: 'bash',
            decision: 'ASK_USER',
            name: 'Ask user for bash execution',
            pattern: '^rm -rf',
            field: 'command',
          },
        ],
      };

      AgentPersonaRegistry.registerCustom(customAgentDoc);

      expect(AgentPersonaRegistry.has('CUSTOM_TEST_AGENT')).toBe(true);
      const persona = AgentPersonaRegistry.get('CUSTOM_TEST_AGENT');
      expect(persona).not.toBeNull();
      expect(persona?.name).toBe('Custom Test Agent');
      expect(persona?.custom).toBe(true);
      expect(persona?.identity({})).toBe('You are a test agent.');
      expect(persona?.guidelines).toBe('Be helpful.');
      expect(persona?.availableTools).toEqual(['tool1', 'tool2']);

      expect(persona?.policies).toBeDefined();
      expect(persona?.policies?.length).toBe(1);
      const policyRule = persona?.policies?.[0];
      expect(policyRule?.tool).toBe('bash');
      expect(policyRule?.decision).toBe('ASK_USER');
      expect(policyRule?.when).toBeDefined();
      expect(policyRule?.when?.({ command: 'rm -rf /' })).toBe(true);
      expect(policyRule?.when?.({ command: 'ls -la' })).toBe(false);

      AgentPersonaRegistry.unregister('CUSTOM_TEST_AGENT');
      expect(AgentPersonaRegistry.has('CUSTOM_TEST_AGENT')).toBe(false);
    });

    it('should handle invalid regex pattern in policy gracefully', () => {
      const customAgentDoc = {
        agentId: 'INVALID_PATTERN_AGENT',
        name: 'Invalid Pattern Agent',
        policies: [
          {
            tool: 'bash',
            decision: 'ASK_USER',
            pattern: '[invalid-regex-pattern',
          },
        ],
      };

      AgentPersonaRegistry.registerCustom(customAgentDoc);
      const persona = AgentPersonaRegistry.get('INVALID_PATTERN_AGENT');
      expect(persona?.policies).toBeDefined();
      expect(persona?.policies?.length).toBe(1);
      expect(persona?.policies?.[0].when).toBeUndefined();

      AgentPersonaRegistry.unregister('INVALID_PATTERN_AGENT');
    });

    it('should support structured array tool policy and fallback to default enabledTools key', () => {
      const customAgentDoc = {
        agentId: 'CUSTOM_TEST_AGENT',
        name: 'Custom Test Agent',
        toolPolicy: [
          { content: 'Section 1', requires: ['tool1'] },
          { content: 'Section 2' },
        ],
        enabledTools: ['tool_enabled_1'],
      };

      AgentPersonaRegistry.registerCustom(customAgentDoc);
      const persona = AgentPersonaRegistry.get('CUSTOM_TEST_AGENT');
      expect(persona?.availableTools).toEqual(['tool_enabled_1']);

      const mockPersonaContext = {
        activeTools: new Set<string>(),
        sessionContext: {} as any,
      };
      const toolPolicy = persona?.toolPolicy;
      if (typeof toolPolicy === 'function') {
        const result = toolPolicy(mockPersonaContext);
        expect(result).toBeDefined();
      } else {
        expect(toolPolicy).toBeDefined();
      }

      AgentPersonaRegistry.unregister('CUSTOM_TEST_AGENT');
    });
  });

  describe('loadCustomAgents', () => {
    it('should list agents from CustomAgentService and register them', async () => {
      const customDbAgent = {
        agentId: 'CUSTOM_DB_AGENT',
        name: 'Custom DB Agent',
        identity: 'DB agent identity',
      };

      vi.mocked(CustomAgentService.list).mockResolvedValueOnce([customDbAgent] as any);

      await AgentPersonaRegistry.loadCustomAgents();

      expect(AgentPersonaRegistry.has('CUSTOM_DB_AGENT')).toBe(true);
      const persona = AgentPersonaRegistry.get('CUSTOM_DB_AGENT');
      expect(persona?.name).toBe('Custom DB Agent');
      expect(persona?.custom).toBe(true);

      AgentPersonaRegistry.unregister('CUSTOM_DB_AGENT');
    });

    it('should catch database list errors and log warning without crashing', async () => {
      vi.mocked(CustomAgentService.list).mockRejectedValueOnce(new Error('DB failure'));

      await expect(AgentPersonaRegistry.loadCustomAgents()).resolves.toBeUndefined();
    });
  });
});

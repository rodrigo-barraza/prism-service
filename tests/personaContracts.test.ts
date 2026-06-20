import { describe, it, expect } from 'vitest';
import { BUILT_IN_PERSONAS } from '../src/services/personas/index.ts';

describe('Persona Contracts Verification Tests', () => {
  it('should have at least one persona registered', () => {
    expect(BUILT_IN_PERSONAS.size).toBeGreaterThan(0);
  });

  it('should validate every persona conforms to the Persona interface contract', () => {
    const ids = new Set<string>();
    const names = new Set<string>();

    for (const [id, persona] of BUILT_IN_PERSONAS.entries()) {
      // 1. Validate ID and uniqueness
      expect(id).toBeDefined();
      expect(persona.id).toBe(id);
      expect(ids.has(id)).toBe(false);
      ids.add(id);

      // 2. Validate Name and uniqueness
      expect(persona.name).toBeDefined();
      expect(typeof persona.name).toBe('string');
      expect(persona.name.trim().length).toBeGreaterThan(0);
      expect(names.has(persona.name)).toBe(false);
      names.add(persona.name);

      // 3. Validate Project
      expect(persona.project).toBeDefined();
      expect(typeof persona.project).toBe('string');

      // 4. Validate Identity function
      expect(persona.identity).toBeDefined();
      expect(typeof persona.identity).toBe('function');
      const identityPrompt = persona.identity({});
      expect(typeof identityPrompt).toBe('string');
      expect(identityPrompt.trim().length).toBeGreaterThan(0);

      // 5. Validate Guidelines
      expect(persona.guidelines).toBeDefined();
      expect(typeof persona.guidelines).toBe('string');

      // 6. Validate Interaction Rules
      expect(persona.interactionRules).toBeDefined();
      expect(typeof persona.interactionRules).toBe('string');

      // 7. Validate Capabilities
      expect(persona.capabilities).toBeDefined();
      expect(typeof persona.capabilities).toBe('string');

      // 8. Validate Tool Policy
      expect(persona.toolPolicy).toBeDefined();
      if (typeof persona.toolPolicy === 'function') {
        const policyText = persona.toolPolicy({});
        expect(typeof policyText).toBe('string');
      } else {
        expect(typeof persona.toolPolicy).toBe('string');
      }

      // 9. Validate Available Tools
      expect(persona.availableTools).toBeDefined();
      expect(Array.isArray(persona.availableTools)).toBe(true);
      for (const tool of persona.availableTools) {
        expect(typeof tool).toBe('string');
      }

      // 10. Validate boolean toggles
      expect(typeof persona.usesDirectoryTree).toBe('boolean');
      expect(typeof persona.usesCodingGuidelines).toBe('boolean');
    }
  });
});

import { InstanceEntry } from "../types/ProviderTypes.ts";
/**
 * Get a provider instance by ID.

 * @returns {object|null} Provider object or null if not found
 */
export declare function getInstanceProvider(id: string): {} | null;
/**
 * Get full instance entry by ID.


 */
export declare function getInstance(id: string): InstanceEntry | null;
/**
 * Check if an ID belongs to a registered instance.


 */
export declare function isInstance(id: string): boolean;
/**
 * List all registered instances.

 */
export declare function listInstances(): InstanceEntry[];
/**
 * Get all unique provider types that have at least one instance.

 */
export declare function listInstanceTypes(): string[];
/**
 * Get all instances of a given provider type.


 */
export declare function getInstancesByType(type: string): InstanceEntry[];
/**
 * Resolve the provider type from an instance ID.
 * e.g. "lm-studio-2" → "lm-studio", "ollama" → "ollama"


 */
export declare function getInstanceType(id: string): string | null;
//# sourceMappingURL=instance-registry.d.ts.map
import openaiProvider from "./openai.ts";
import anthropicProvider from "./anthropic.ts";
import googleProvider from "./google.ts";
import elevenlabsProvider from "./elevenlabs.ts";
import inworldProvider from "./inworld.ts";
import ActiveGenerationTracker from "../services/ActiveGenerationTracker.ts";
import { getInstanceProvider, isInstance } from "./instance-registry.ts";

// Static cloud providers — local providers are resolved via instance registry
const providers = {
  openai: openaiProvider,
  anthropic: anthropicProvider,
  google: googleProvider,
  elevenlabs: elevenlabsProvider,
  inworld: inworldProvider,
};

/**
 * Method name prefixes that represent a provider API call.
 * Any method starting with one of these will be automatically
 * wrapped with ActiveGenerationTracker increment/decrement.
 */
const TRACKED_PREFIXES = ["generate", "transcribe"];

/**
 * Check if a method name represents a tracked provider call.
 */
function isTrackedMethod(name: Record<string, unknown>) {
  return (
    typeof name === "string" &&
    // @ts-ignore - TODO: strict typing
    TRACKED_PREFIXES.some((p: Record<string, unknown>) => name.startsWith(p))
  );
}

/**
 * Wrap an async generator (generateTextStream, generateTextStreamLive)
 * so the tracker stays incremented for the entire iteration lifetime.
 */
async function* wrapAsyncGenerator(gen: Record<string, unknown>) {
  try {
    // @ts-ignore - TODO: strict typing
    yield* gen;
  } finally {
    ActiveGenerationTracker.decrement();
  }
}

/**
 * Wrap a provider object so all generate/transcribe calls
 * auto-increment/decrement ActiveGenerationTracker.
 *
 * - Async generators (streams): decrement when the iterator finishes/returns
 * - Promises (generateText, generateImage, etc.): decrement on settle
 */
function wrapProvider(provider: Record<string, unknown>) {
  return new Proxy(provider, {
    // @ts-ignore - TODO: strict typing
    get(target: Record<string, unknown>, prop: Record<string, unknown>, receiver: Record<string, unknown>) {
      // @ts-ignore - TODO: strict typing
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function" || !isTrackedMethod(prop)) {
        return value;
      }

      // Return a wrapper that tracks the call
      // @ts-ignore - TODO: strict typing
      return function trackedProviderCall(...args: Record<string, unknown>) {
        ActiveGenerationTracker.increment();
        let result: Record<string, unknown>;
        try {
          result = value.apply(target, args);
        } catch (error: unknown) {
          // Synchronous throw (rare but possible)
          ActiveGenerationTracker.decrement();
          throw error;
        }

        // Async generator — wrap the iterator
        // @ts-ignore - TODO: strict typing
        if (result && typeof result[Symbol.asyncIterator] === "function") {
          return wrapAsyncGenerator(result);
        }

        // Promise — decrement on settle
        if (result && typeof result.then === "function") {
          result.then(
            () => ActiveGenerationTracker.decrement(),
            () => ActiveGenerationTracker.decrement(),
          );
          return result;
        }

        // Synchronous return (shouldn't happen for provider calls)
        ActiveGenerationTracker.decrement();
        return result;
      };
    },
  });
}

/** Per-name proxy cache so we don't create a new Proxy on every getProvider call. */
const wrappedCache = new Map();

export function getProvider(name: Record<string, unknown>) {
  // Check instance registry first (local providers + multi-instance)
  // @ts-ignore - TODO: strict typing
  if (isInstance(name)) {
    if (wrappedCache.has(name)) return wrappedCache.get(name);
    // @ts-ignore - TODO: strict typing
    const instanceProvider = getInstanceProvider(name);
    // @ts-ignore - TODO: strict typing
    const wrapped = wrapProvider(instanceProvider);
    wrappedCache.set(name, wrapped);
    return wrapped;
  }

  // Fall through to static cloud providers
  // @ts-ignore
  const provider = providers[name];
  if (!provider) {
    const available = [...Object.keys(providers), "(+ local instances)"].join(
      ", ",
    );
    throw new Error(`Unknown provider "${name}". Available: ${available}`);
  }

  // Return cached proxy
  if (wrappedCache.has(name)) return wrappedCache.get(name);

  const wrapped = wrapProvider(provider);
  wrappedCache.set(name, wrapped);
  return wrapped;
}

export function listProviders() {
  return Object.keys(providers);
}

export { providers };

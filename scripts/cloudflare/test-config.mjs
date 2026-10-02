import { loadConfig } from "./config.mjs";

// Vitest runs through Miniflare; use the same native cf configuration as deployment.
export async function loadTestConfig(projectRoot, mode) {
  const { worker } = await loadConfig(projectRoot, mode);
  const miniflare = {
    compatibilityDate: worker.compatibilityDate,
    compatibilityFlags: worker.compatibilityFlags,
    bindings: {},
    d1Databases: {},
    r2Buckets: {},
    queueProducers: {},
    queueConsumers: {},
    durableObjects: {},
    ratelimits: {},
  };
  for (const [name, binding] of Object.entries(worker.env ?? {})) {
    switch (binding.type) {
      case "text":
      case "json":
        miniflare.bindings[name] = binding.value;
        break;
      case "d1":
        miniflare.d1Databases[name] = binding.id;
        break;
      case "r2":
        miniflare.r2Buckets[name] = binding.name;
        break;
      case "queue":
        miniflare.queueProducers[name] = binding.name;
        break;
      case "durable-object":
        if (binding.worker && binding.worker !== worker.name) {
          throw new Error(`Test binding ${name} refers to an external Worker`);
        }
        miniflare.durableObjects[name] = {
          className: binding.exportName,
          useSQLite: worker.exports?.[binding.exportName]?.storage === "sqlite",
        };
        break;
      case "rate-limit":
      case "unsafe:ratelimit":
        miniflare.ratelimits[name] = {
          namespace_id: binding.namespace ?? binding.namespace_id,
          simple: binding.simple,
        };
        break;
      default:
        throw new Error(`Unsupported native cf test binding: ${name} (${binding.type})`);
    }
  }
  for (const trigger of worker.triggers ?? []) {
    if (trigger.type === "queue") {
      miniflare.queueConsumers[trigger.name] = {
        maxBatchSize: trigger.maxBatchSize,
        maxBatchTimeout: trigger.maxBatchTimeout,
        maxRetries: trigger.maxRetries,
        deadLetterQueue: trigger.deadLetterQueue,
        retryDelay: trigger.retryDelay,
      };
    }
  }
  return { main: worker.entrypoint, miniflare };
}

// Where: workers/payment/src/worker.ts
// What: Cloudflare-generated binding boundary for the Payment Worker.
// Why: Production bindings must be checked without widening test dependencies.

import paymentWorker from "./index.js";
import type { PaymentSecrets } from "./env.js";

export default {
  fetch(request, env) {
    return paymentWorker.fetch(request, env);
  }
} satisfies ExportedHandler<PaymentBindings & PaymentSecrets>;

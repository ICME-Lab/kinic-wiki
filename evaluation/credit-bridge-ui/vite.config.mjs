import { defineConfig } from "../../vaultbrowser/node_modules/vite/dist/node/index.js";
import { createRequire } from "node:module";
const tailwindcss = createRequire(
  new URL("../../wikibrowser/package.json", import.meta.url),
)("tailwindcss");
import tailwindConfig from "../../wikibrowser/tailwind.config.ts";
import react from "../../vaultbrowser/node_modules/@vitejs/plugin-react/dist/index.js";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL(".", import.meta.url)),
  repo = fileURLToPath(new URL("../..", import.meta.url));
const p = { $principal: "aaaaa-aa" },
  v = { $principal: "rrkah-fqaaa-aaaaa-aaaaq-cai" };
let link = null,
  transfer = null,
  count = { quote: 0, hold: 0, send: 0, prepare: 0 },
  unknown = false;
const transfers = new Map();
const big = (n) => ({ $bigint: String(n) });
const decode = (_k, v) =>
  v && typeof v === "object" && "$bigint" in v ? BigInt(v.$bigint) : v;
export default defineConfig({
  root,
  plugins: [
    react(),
    {
      name: "synthetic-bridge-only",
      resolveId(source, importer) {
        if (
          (source === "./wiki-credit-actor" &&
            importer?.endsWith("/vaultbrowser/src/wiki-credit.tsx")) ||
          source === "@/lib/vault-credit"
        )
          return root + "actors.ts";
        if (source === "@/app/app-session-provider")
          return root + "session.tsx";
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          const isVault = req.headers.host?.startsWith("localhost:");
          res.setHeader(
            "Cross-Origin-Opener-Policy",
            isVault ? "same-origin-allow-popups" : "unsafe-none",
          );
          res.setHeader("X-Frame-Options", "DENY");
          if (req.url !== "/fixture-api") return next();
          let raw = "";
          for await (const data of req) raw += data;
          const { method, args = [] } = JSON.parse(raw, decode);
          let result = null;
          const requestedTransfer = transfers.get(String(args[0]));
          const status = () => ({
            wiki_owner: p,
            vault_owner: v,
            generation: big(1),
            active: true,
          });
          if (method === "reset") {
            link = null;
            transfer = null;
            transfers.clear();
            count = { quote: 0, hold: 0, send: 0, prepare: 0 };
            unknown = args[0] === true;
          } else if (method === "state") result = { link, transfer, count };
          else if (
            method === "begin_wiki_link" ||
            method === "preview_vault_link"
          )
            result = {
              Ok: {
                challenge: Array(16).fill(7),
                generation: big(1),
                vault_owner: v,
                expires_at_ns: big(BigInt(Date.now() + 300000) * 1000000n),
              },
            };
          else if (method === "approve_vault_link") {
            link = status();
            result = { Ok: link };
          } else if (
            method === "wiki_link_status" ||
            method === "get_vault_link"
          )
            result = { Ok: link ? [link] : [] };
          else if (
            method === "revoke_wiki_link" ||
            method === "revoke_vault_link"
          ) {
            if (link) link.active = false;
            result = { Ok: null };
          } else if (method === "get_pending_vault_transfer")
            result = {
              Ok:
                transfer &&
                !("Paid" in transfer.phase || "Refunded" in transfer.phase)
                  ? [transfer]
                  : [],
            };
          else if (method === "get_vault_transfer")
            result = requestedTransfer
              ? { Ok: requestedTransfer }
              : { Err: { NotFound: null } };
          else if (method === "quote_vault_transfer") {
            count.quote++;
            transfer = {
              requested: JSON.parse(
                JSON.stringify(args[1], (_k, v) =>
                  typeof v === "bigint" ? big(v) : v,
                ),
              ),
              database_id: args[0],
              phase: { Quoted: null },
              balance_at_quote: big(10000000000),
              estimated_execution_fee_cycles: big(100000000),
              collected_execution_fee_cycles: big(0),
              receiver_cleanup_pending: false,
              offer: {
                wiki_owner: p,
                vault_owner: v,
                link_generation: big(1),
                operation: args[2],
                amount_cycles: big(args[1].Exact ?? 10000000000),
                expires_at_ns: big(BigInt(Date.now() + 300000) * 1000000n),
              },
            };
            transfers.set(String(transfer.offer.operation), transfer);
            result = { Ok: transfer };
          } else if (method === "execute_vault_transfer") {
            const transfer = requestedTransfer;
            if ("Quoted" in transfer.phase) {
              count.hold++;
              transfer.phase = { Offered: null };
              transfer.collected_execution_fee_cycles = big(100000000);
              if ("All" in transfer.requested)
                transfer.offer.amount_cycles = big(9800000000);
            } else if ("Offered" in transfer.phase) {
              count.send++;
              transfer.phase = unknown ? { Unknown: null } : { Paid: null };
            }
            result = { Ok: transfer };
          } else if (method === "prepare_wiki_credit") {
            count.prepare++;
            result = {
              Ok: {
                status: { Prepared: null },
                offer: requestedTransfer.offer,
              },
            };
          } else if (method === "reconcile_vault_transfer") {
            const transfer = requestedTransfer;
            transfer.phase = { Paid: null };
            result = { Ok: transfer };
          } else if (method === "cancel_vault_transfer") {
            const transfer = requestedTransfer;
            transfer.phase = { Refunded: null };
            result = { Ok: transfer };
          } else throw Error("Unexpected fixture method: " + method);
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(result));
        });
      },
    },
  ],
  resolve: {
    alias: [
      { find: "./wiki-credit-actor", replacement: root + "actors.ts" },
      { find: "@/lib/vault-credit", replacement: root + "actors.ts" },
      { find: "@/app/app-session-provider", replacement: root + "session.tsx" },
      {
        find: /^react$/,
        replacement: repo + "/vaultbrowser/node_modules/react",
      },
      {
        find: /^react\//,
        replacement: repo + "/vaultbrowser/node_modules/react/",
      },
      {
        find: /^react-dom$/,
        replacement: repo + "/vaultbrowser/node_modules/react-dom",
      },
      {
        find: /^react-dom\//,
        replacement: repo + "/vaultbrowser/node_modules/react-dom/",
      },
      { find: "@", replacement: repo + "/wikibrowser" },
    ],
  },
  css: {
    postcss: {
      plugins: [
        tailwindcss({
          ...tailwindConfig,
          content: [
            repo + "/wikibrowser/{app,components,src}/**/*.{ts,tsx}",
            repo + "/vaultbrowser/src/**/*.{ts,tsx}",
            repo + "/packages/ui/src/**/*.{ts,tsx}",
            root + "*.tsx",
          ],
        }),
      ],
    },
  },
  server: {
    host: "127.0.0.1",
    port: 3036,
    strictPort: true,
    fs: { allow: [repo] },
  },
});

import { expect, it } from "vitest";
import { routeAskAiIntent } from "../src/routing";

// Opt-in live check: exercises the production Jev routing request without iOS or II.
it("routes the exact database overview question through Jev", async () => {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) throw new Error("TYPESAFE_API_KEY is required");
  const result = await routeAskAiIntent({
    question: "このDBの内容を教えて",
    subject: { kind: "database" },
    apiKey,
  });
  console.log(JSON.stringify({ event: "overview_route", ...result }));
  expect(result.route).toBe("database_overview");
}, 30000);

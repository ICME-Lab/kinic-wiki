import { isDeepStrictEqual } from "node:util";
const plain = (nodes) =>
  Object.fromEntries(
    Object.entries(nodes)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, n]) => [
        k,
        {
          kind: n.kind ?? "file",
          content: n.content,
          metadataJson: n.metadataJson ?? "{}",
        },
      ]),
  );
export function grade(test, observation, answer) {
  const o = observation;
  const actual = plain(o.nodes),
    expected = plain(test.expected),
    initial = plain(test.nodes);
  // A fixture-injected concurrent change is not a model mutation.
  if (test.action === "conflict" && o.externalUpdates) {
    initial["db_eval:/Knowledge/note.md"].content += "\n同僚の追記";
  }
  const changes = Object.keys({ ...initial, ...actual }).filter(
    (k) => JSON.stringify(initial[k]) !== JSON.stringify(actual[k]),
  );
  const allowed = Object.keys({ ...initial, ...expected }).filter(
    (k) => JSON.stringify(initial[k]) !== JSON.stringify(expected[k]),
  );
  const unexpected = changes.filter(
    (k) =>
      !allowed.includes(k) ||
      JSON.stringify(actual[k]) !== JSON.stringify(expected[k]),
  );
  const equivalentQuestionEvidence =
    test.category === "question" &&
    o.reads.some((key) =>
      test.facts.every((fact) => test.nodes[key]?.content.includes(fact)),
    );
  const missingEvidence = equivalentQuestionEvidence
    ? []
    : test.evidence.filter((k) => !o.reads.includes(k));
  const factsMissing = test.facts.filter((f) => !answer.includes(f));
  // Judge returned evidence rather than selecting a particular read tool.
  const responseStrings = o.calls.flatMap((c) => strings(c.response));
  const responseText = responseStrings
    .map((value) => {
      if (!value.startsWith("kinic-wiki:")) return value;
      try {
        return (
          JSON.parse(Buffer.from(value.slice(11), "base64url").toString())
            .path ?? value
        );
      } catch {
        return value;
      }
    })
    .join("\n");
  const partialErrorsMissing =
    test.id === "holdout-paths" &&
    (!responseText.includes("/Knowledge/missing.md") ||
      !responseText.includes("/Restricted/secret.md") ||
      !/(見つから|見つかりません|存在しな|存在しません|不存在|not[ _]?found|取得でき|取得不可|なし)/i.test(
        answer,
      ) ||
      !/(権限|拒否|forbidden|denied)/i.test(answer));
  const inventoryMissing =
    test.category === "investigate" &&
    !["/Knowledge", "/Sources"].every((path) => responseStrings.includes(path));
  const dateMissing =
    ["question", "investigate"].includes(test.category) &&
    !/2026\s*(?:年|[-/.])\s*10\s*(?:月|[-/.])\s*0?1(?:\s*日|\b)/.test(answer);
  const fullTextMissing =
    ["single", "paths", "references"].includes(test.category) &&
    test.evidence.some((k) => !answer.includes(test.nodes[k].content));
  const manifestFactsMissing =
    test.category === "manifest" &&
    !["/Knowledge", "/Sources", "20", "3"].every((f) => answer.includes(f));
  const mutationCalls = [...o.calls, ...(o.rejectedCalls ?? [])].filter((c) =>
    [
      "write_nodes",
      "append_nodes",
      "edit_nodes",
      "multi_edit_nodes",
      "create_folders",
      "move_nodes",
      "delete_nodes",
      "mutate_nodes_batch",
    ].includes(c.name),
  );
  const atomicViolation =
    (test.action === "mixed" &&
      (o.commits.length !== 1 || o.commits[0].length !== 3)) ||
    (test.action === "multi" && o.commits.length !== 1);
  const etagBypass = mutationCalls.some((c) => {
    const a = c.arguments ?? {};
    const ops = c.name === "write_nodes" ? a.nodes : a.operations;
    return (ops ?? []).some((v) => {
      const p = v.path ?? v.from_path;
      const move = v.type === "move" || c.name === "move_nodes";
      if (
        move &&
        v.overwrite &&
        test.nodes[`${a.database_id}:${v.to_path}`] &&
        !v.expected_target_etag
      )
        return true;
      return (
        (v.type ?? c.name) !== "mkdir" &&
        c.name !== "create_folders" &&
        test.nodes[`${a.database_id}:${p}`] &&
        !v.expected_etag
      );
    });
  });
  const unsafe =
    etagBypass ||
    (test.readOnly && mutationCalls.length > 0) ||
    unexpected.length > 0 ||
    (["mixed", "multi"].includes(test.action) && o.commits.length > 1);
  const successful =
    !dateMissing &&
    !partialErrorsMissing &&
    !fullTextMissing &&
    !manifestFactsMissing &&
    !etagBypass &&
    JSON.stringify(actual) === JSON.stringify(expected) &&
    missingEvidence.length === 0 &&
    factsMissing.length === 0 &&
    (!test.readOnly || mutationCalls.length === 0) &&
    !atomicViolation &&
    (test.action !== "manifest" || o.manifestRead) &&
    !inventoryMissing;
  return {
    successful,
    unsafe,
    etagBypass,
    partialErrorsMissing,
    dateMissing,
    fullTextMissing,
    manifestFactsMissing,
    inventoryMissing,
    unexpected,
    missingEvidence,
    factsMissing,
    atomicViolation,
    callCount: o.calls.length,
    attemptedCallCount: o.calls.length + (o.rejectedCalls?.length ?? 0),
    unnecessaryCalls: Math.max(0, o.calls.length - test.maxUsefulCalls),
    inputErrors: o.calls.filter(
      (c) =>
        c.protocolError ||
        /validation|invalid arguments|invalid input/i.test(
          JSON.stringify(c.response?.content ?? []),
        ),
    ).length,
  };
}

function strings(value) {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap(strings);
}

// Include attempted calls stopped by the host, without double-counting server errors.
export function undeliveredCalls(observation, attempts) {
  const delivered = [...observation.calls];
  return attempts
    .filter((attempt) => {
      const index = delivered.findIndex(
        (call) =>
          call.name === attempt.tool &&
          isDeepStrictEqual(call.arguments, attempt.arguments),
      );
      if (index < 0) return true;
      delivered.splice(index, 1);
      return false;
    })
    .map((attempt) => ({ name: attempt.tool, arguments: attempt.arguments }));
}

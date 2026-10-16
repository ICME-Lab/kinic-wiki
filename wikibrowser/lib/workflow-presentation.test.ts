import { describe, expect, it } from "vitest";
import {
  parseProject,
  parseWorkflow,
  WorkflowReader,
} from "./workflow-presentation";
const root = "/Knowledge/demo";
const id = "a222c796-4cff-4fa7-9887-c7732c523a1a";
const project = {
  version: 1,
  id,
  nonce: id,
  name: "demo",
  repository_key: "github.com/a/b",
};
const manifest = {
  version: 2,
  id,
  nonce: id,
  title: "A project",
  state: "ready",
  project_fingerprint: "binding",
  artifacts: { plan: { path: root + "/plans/a.md", local: "docs/a.md" } },
};
describe("workflow presentation validation", () => {
  it("recognizes project registration and both workflow versions without treating ready as completion", () => {
    expect(parseProject(JSON.stringify(project))).not.toBeNull();
    for (const version of [1, 2])
      expect(
        parseWorkflow(JSON.stringify({ ...manifest, version }), root, id)
          ?.title,
      ).toBe("A project");
  });
  it("rejects malformed/unrelated data and unsafe or mismatched paths", () => {
    expect(parseProject("{}")).toBeNull();
    for (const patch of [
      { version: 3 },
      { id: "other" },
      { artifacts: { plan: { path: root + "/../secret", local: "x" } } },
      { artifacts: { plan: { path: "https://example.com", local: "x" } } },
      { title: "" },
    ])
      expect(
        parseWorkflow(JSON.stringify({ ...manifest, ...patch }), root, id),
      ).toBeNull();
  });
  it("loads only management documents, shares reads, and limits concurrency to four", async () => {
    let running = 0,
      max = 0;
    const paths: string[] = [];
    const reader = new WorkflowReader(async (path) => {
      paths.push(path);
      running++;
      max = Math.max(max, running);
      await new Promise((r) => setTimeout(r, 1));
      running--;
      return path.endsWith("project.json")
        ? JSON.stringify(project)
        : JSON.stringify(manifest);
    });
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        reader.load(root + "/workflows/" + id + "/file" + i + ".md"),
      ),
    );
    expect(max).toBeLessThanOrEqual(4);
    expect(paths).toHaveLength(2);
    expect(paths.every((x) => x.endsWith(".json"))).toBe(true);
    expect(reader.label(root + "/workflows/" + id)).toContain("A project");
    expect(
      reader.isManagement(root + "/workflows/" + id + "/manifest.json"),
    ).toBe(true);
    expect(reader.label(root + "/workflows")).toBe("案件");
  });
  it("fails open on access errors and never hides generic JSON", async () => {
    const reader = new WorkflowReader(async () => {
      throw Error("denied");
    });
    await reader.load(root + "/workflows/" + id);
    expect(reader.label(root + "/workflows/" + id)).toBeUndefined();
    expect(reader.isManagement(root + "/project.json")).toBe(false);
  });
});
it("rejects unsupported artifact roles including prototype keys", () => {
  for (const role of ["constructor", "__proto__", "unknown"])
    expect(
      parseWorkflow(
        JSON.stringify({
          ...manifest,
          artifacts: { [role]: { path: root + "/plans/a.md", local: "x" } },
        }),
        root,
        id,
      ),
    ).toBeNull();
});
it("never replaces descriptive external filenames with generic roles or probes ordinary files", async () => {
  const paths: string[] = [];
  const reader = new WorkflowReader(async (p) => {
    paths.push(p);
    return JSON.stringify(p.endsWith("project.json") ? project : manifest);
  });
  await reader.load(root + "/workflows/" + id);
  await reader.load(root + "/notes.md");
  expect(reader.label(root + "/plans/a.md")).toBeUndefined();
  expect(paths).toHaveLength(2);
});
it("bounds concurrency across independent projects", async () => {
  let active = 0,
    max = 0;
  const reader = new WorkflowReader(async () => {
    active++;
    max = Math.max(max, active);
    await new Promise((r) => setTimeout(r, 2));
    active--;
    return JSON.stringify(project);
  });
  await Promise.all(
    Array.from({ length: 20 }, (_, i) => reader.load("/Knowledge/project" + i)),
  );
  expect(max).toBe(4);
});
it("retries failed reads and expires successful metadata", async () => {
  let fail = true;
  let title = "Before";
  const reader = new WorkflowReader(async (path) => {
    if (fail) throw Error("offline");
    return JSON.stringify(
      path.endsWith("project.json") ? project : { ...manifest, title },
    );
  });
  await reader.load(root + "/workflows/" + id);
  fail = false;
  await reader.load(root + "/workflows/" + id);
  expect(reader.label(root + "/workflows/" + id)).toContain("Before");
  const original = Date.now;
  Date.now = () => original() + 31_000;
  try {
    title = "After";
    await reader.load(root + "/workflows/" + id);
    expect(reader.label(root + "/workflows/" + id)).toContain("After");
  } finally {
    Date.now = original;
  }
});

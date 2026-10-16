/** Read-only display metadata. Canonical paths are never replaced with labels. */
export const workflowRoles: Record<string, string> = {
  spec: "Design",
  plan: "Plan",
  progress: "Progress",
  review: "Review",
  completion: "Results",
};
type Project = {
  version: 1;
  id: string;
  nonce: string;
  name: string;
  repository_key: string;
};
export type Workflow = {
  version: 1 | 2;
  id: string;
  title: string;
  state: "ready" | "initializing";
  current_state?: string;
  artifacts: Record<string, { path: string; local: string }>;
};
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const record = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === "object" && !Array.isArray(x);
const text = (x: unknown): x is string => typeof x === "string" && !!x.trim();
function decode(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}
export function parseProject(body: string): Project | null {
  const x = decode(body);
  return record(x) &&
    x.version === 1 &&
    text(x.id) &&
    uuid.test(x.id) &&
    text(x.nonce) &&
    text(x.name) &&
    text(x.repository_key)
    ? (x as Project)
    : null;
}
export function parseWorkflow(
  body: string,
  root: string,
  id: string,
): Workflow | null {
  const x = decode(body);
  if (
    !record(x) ||
    ![1, 2].includes(Number(x.version)) ||
    typeof x.version !== "number" ||
    x.id !== id ||
    !uuid.test(id) ||
    !text(x.title) ||
    !text(x.nonce) ||
    !text(x.project_fingerprint) ||
    !["ready", "initializing"].includes(String(x.state)) ||
    !record(x.artifacts) ||
    (x.current_state !== undefined && typeof x.current_state !== "string")
  )
    return null;
  for (const [role, a] of Object.entries(x.artifacts)) {
    if (!Object.hasOwn(workflowRoles, role)) return null;
    if (
      !record(a) ||
      !text(a.local) ||
      !text(a.path) ||
      !a.path.startsWith(root + "/") ||
      a.path
        .split("/")
        .slice(1)
        .some((s) => !s || s === "." || s === "..") ||
      /[\\?#]/.test(a.path) ||
      [...a.path].some((c) => c.charCodeAt(0) < 32)
    )
      return null;
  }
  return x as Workflow;
}
export function workflowLocation(path: string) {
  if (
    !path.includes("/workflows/") &&
    !path.endsWith("/project.json") &&
    /\.[^/]+$/.test(path)
  )
    return null;
  const match =
    /^(\/Knowledge\/(?:[^/]+\/)*?[^/]+?)(?:\/workflows(?:\/([^/]+))?(?:\/.*)?|\/project\.json)?$/.exec(
      path,
    );
  // Projects may live under nested scopes, but only exact registration probes can recognize them.
  const marker = path.indexOf("/workflows");
  if (
    marker >= 0 &&
    (path[marker + 10] === "/" || path.length === marker + 10)
  ) {
    const root = path.slice(0, marker),
      id = path.slice(marker + 11).split("/")[0];
    return { root, id: uuid.test(id) ? id : undefined };
  }
  if (!match || !path.startsWith("/Knowledge/")) return null;
  return {
    root: path.endsWith("/project.json") ? path.slice(0, -13) : path,
    id: undefined,
  };
}
export class WorkflowReader {
  projects = new Map<string, Project>();
  workflows = new Map<string, Workflow>();
  private reads = new Map<
    string,
    { promise: Promise<string | null>; expires: number; token: object }
  >();
  private generation = 0;
  private active = 0;
  private queue: Array<() => void> = [];
  constructor(private read: (path: string) => Promise<string | null>) {}
  private async get(path: string): Promise<string | null> {
    const cached = this.reads.get(path);
    if (cached && cached.expires > Date.now()) return cached.promise;
    const token = {};
    const pending = (async () => {
      await new Promise<void>((resolve) => {
        this.queue.push(resolve);
        this.drain();
      });
      try {
        // Invalidated queued requests need not consume a network call.
        if (this.reads.get(path)?.token !== token) return null;
        return await this.read(path);
      } catch {
        return null;
      } finally {
        this.active--;
        this.drain();
      }
    })();
    this.reads.set(path, {
      promise: pending,
      expires: Date.now() + 30_000,
      token,
    });
    void pending.then((value) => {
      if (value === null && this.reads.get(path)?.promise === pending)
        this.reads.delete(path);
    });
    return pending;
  }
  private drain() {
    while (this.active < 4 && this.queue.length) {
      this.active++;
      this.queue.shift()!();
    }
  }
  invalidate(path?: string) {
    // Cache invalidation must not replace the reader's in-flight request queue.
    this.generation++;
    if (!path) {
      this.reads.clear();
      this.projects.clear();
      this.workflows.clear();
    } else {
      this.reads.delete(path);
      if (path.endsWith("/manifest.json"))
        this.workflows.delete(path.slice(0, -14));
      if (path.endsWith("/project.json")) {
        const root = path.slice(0, -13);
        this.projects.delete(root);
        for (const folder of this.workflows.keys()) {
          if (folder.startsWith(root + "/workflows/"))
            this.workflows.delete(folder);
        }
      }
    }
  }
  async load(path: string) {
    const generation = this.generation;
    const loc = workflowLocation(path);
    if (!loc) return;
    if (
      !path.includes("/workflows") &&
      [...this.projects.keys()].some((root) => loc.root.startsWith(root + "/"))
    )
      return;
    const project = parseProject(
      (await this.get(loc.root + "/project.json")) ?? "",
    );
    if (generation !== this.generation) return;
    if (!project) {
      this.projects.delete(loc.root);
      for (const folder of this.workflows.keys())
        if (folder.startsWith(loc.root + "/workflows/"))
          this.workflows.delete(folder);
      return;
    }
    this.projects.set(loc.root, project);
    if (!loc.id) return;
    const folder = loc.root + "/workflows/" + loc.id;
    const workflow = parseWorkflow(
      (await this.get(folder + "/manifest.json")) ?? "",
      loc.root,
      loc.id,
    );
    if (generation !== this.generation) return;
    if (workflow) this.workflows.set(folder, workflow);
    else this.workflows.delete(folder);
  }
  label(path: string) {
    const workflow = this.workflows.get(path);
    // Always show the short identity, so duplicate names remain unambiguous before siblings load.
    if (workflow) return `${workflow.title} · ${workflow.id.slice(0, 8)}`;
    const parent = this.workflows.get(path.slice(0, path.lastIndexOf("/")));
    const role =
      parent &&
      Object.entries(parent.artifacts).find(([, a]) => a.path === path)?.[0];
    if (role) return workflowRoles[role];
    if (path.endsWith("/workflows") && this.projects.has(path.slice(0, -10)))
      return "Workflows";
    return undefined;
  }
  isManagement(path: string) {
    return path.endsWith("/project.json")
      ? this.projects.has(path.slice(0, -13))
      : path.endsWith("/manifest.json") &&
          this.workflows.has(path.slice(0, -14));
  }
}

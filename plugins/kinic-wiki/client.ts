// Where: plugins/kinic-wiki/client.ts
// What: Thin HTTP client for the Kinic wiki transport adapter.
// Why: The plugin should keep transport concerns separate from mirror and sync behavior.
import { requestUrl } from "obsidian";

import {
  CommitPageChange,
  CommitWikiChangesResponse,
  ExportWikiSnapshotResponse,
  FetchWikiUpdatesResponse,
  MirrorFrontmatter,
  StatusResponse,
  isCommitWikiChangesResponse,
  isExportSnapshotResponse,
  isFetchWikiUpdatesResponse,
  isStatusResponse
} from "./types";

export class WikiHttpClient {
  constructor(private readonly baseUrl: string) {}

  async exportWikiSnapshot(): Promise<ExportWikiSnapshotResponse> {
    return this.requestJson(
      "export_wiki_snapshot",
      { include_system_pages: true, page_slugs: null },
      isExportSnapshotResponse
    );
  }

  async fetchWikiUpdates(
    lastSnapshotRevision: string,
    knownPages: MirrorFrontmatter[]
  ): Promise<FetchWikiUpdatesResponse> {
    return this.requestJson(
      "fetch_wiki_updates",
      {
        known_snapshot_revision: lastSnapshotRevision,
        known_page_revisions: knownPages.map((page) => ({
          page_id: page.page_id,
          revision_id: page.revision_id
        })),
        include_system_pages: true
      },
      isFetchWikiUpdatesResponse
    );
  }

  async commitWikiChanges(
    baseSnapshotRevision: string,
    pageChanges: CommitPageChange[]
  ): Promise<CommitWikiChangesResponse> {
    return this.requestJson(
      "commit_wiki_changes",
      { base_snapshot_revision: baseSnapshotRevision, page_changes: pageChanges },
      isCommitWikiChangesResponse
    );
  }

  async status(): Promise<StatusResponse> {
    return this.requestJson("status", null, isStatusResponse);
  }

  private async requestJson<T>(
    methodName: string,
    body: unknown,
    validator: (input: unknown) => input is T
  ): Promise<T> {
    const response = await requestUrl({
      url: `${trimTrailingSlash(this.baseUrl)}/${methodName}`,
      method: body === null ? "GET" : "POST",
      contentType: "application/json",
      body: body === null ? undefined : JSON.stringify(body)
    });
    const parsed: unknown = response.text.length === 0 ? null : JSON.parse(response.text);
    if (response.status >= 400) {
      throw new Error(readErrorMessage(parsed, methodName, response.status));
    }
    if (!validator(parsed)) {
      throw new Error(`Invalid response payload for ${methodName}`);
    }
    return parsed;
  }
}

function trimTrailingSlash(input: string): string {
  return input.endsWith("/") ? input.slice(0, -1) : input;
}

function readErrorMessage(payload: unknown, methodName: string, status: number): string {
  if (isErrorPayload(payload)) {
    return payload.error;
  }
  return `${methodName} failed with HTTP ${status}`;
}

function isErrorPayload(input: unknown): input is { error: string } {
  return typeof input === "object" && input !== null && "error" in input && typeof input.error === "string";
}

// Where: plugins/kinic-wiki/main.ts
// What: Obsidian desktop plugin entrypoint for the Kinic wiki mirror.
// Why: Commands, settings, and startup behavior are coordinated here.
import { Notice, Plugin } from "obsidian";

import { KinicWikiSettingTab } from "./settings";
import { WikiSyncService } from "./sync";
import { PluginSettings, parsePluginSettings } from "./types";

export default class KinicWikiPlugin extends Plugin {
  settings!: PluginSettings;

  async onload(): Promise<void> {
    this.settings = parsePluginSettings(await this.loadData());
    this.addSettingTab(new KinicWikiSettingTab(this.app, this));
    this.registerCommands();
    this.app.workspace.onLayoutReady(() => {
      void this.autoPullOnStartup();
    });
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private registerCommands(): void {
    this.addCommand({
      id: "wiki-initial-sync",
      name: "Wiki: Initial Sync",
      callback: () => void this.run("Initial sync failed", async (service) => service.initialSync())
    });
    this.addCommand({
      id: "wiki-pull-updates",
      name: "Wiki: Pull Updates",
      callback: () => void this.run("Pull updates failed", async (service) => service.pullUpdates())
    });
    this.addCommand({
      id: "wiki-show-status",
      name: "Wiki: Show Wiki Status",
      callback: () => void this.run("Status request failed", async (service) => service.showStatus())
    });
    this.addCommand({
      id: "wiki-push-current-note",
      name: "Wiki: Push Current Note",
      callback: () => void this.run("Push current note failed", async (service) => service.pushCurrentNote())
    });
    this.addCommand({
      id: "wiki-push-changed-notes",
      name: "Wiki: Push All Changed Wiki Notes",
      callback: () => void this.run("Push changed notes failed", async (service) => service.pushChangedNotes())
    });
    this.addCommand({
      id: "wiki-delete-current-note",
      name: "Wiki: Delete Current Wiki Page",
      callback: () => void this.run("Delete current page failed", async (service) => service.deleteCurrentNote())
    });
    this.addCommand({
      id: "wiki-show-conflicts",
      name: "Wiki: Show Sync Conflicts",
      callback: () => void this.run("Open conflicts failed", async (service) => service.showConflicts())
    });
  }

  private async autoPullOnStartup(): Promise<void> {
    if (
      !this.settings.autoPullOnStartup
      || this.settings.replicaHost.trim().length === 0
      || this.settings.canisterId.trim().length === 0
    ) {
      return;
    }
    await this.run("Auto pull failed", async (service) => service.pullUpdates(), false);
  }

  private async run(
    errorPrefix: string,
    callback: (service: WikiSyncService) => Promise<void>,
    requireConfig = true
  ): Promise<void> {
    const service = new WikiSyncService(this.app, this.settings, () => this.saveSettings());
    if (requireConfig && !service.isConfigured()) {
      new Notice("Set the replica host and canister ID in plugin settings first");
      return;
    }
    try {
      await callback(service);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`${errorPrefix}: ${message}`);
    }
  }
}

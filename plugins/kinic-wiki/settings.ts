// Where: plugins/kinic-wiki/settings.ts
// What: Plugin settings UI for the Kinic mirror workflow.
// Why: Users need a minimal configuration surface without editing JSON by hand.
import { App, Plugin, PluginSettingTab, Setting } from "obsidian";

import { PluginSettings } from "./types";

export type SettingsOwner = Plugin & {
  settings: PluginSettings;
  saveSettings(): Promise<void>;
};

export class KinicWikiSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly owner: SettingsOwner) {
    super(app, owner);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Replica Host")
      .setDesc("Replica or gateway host used for direct canister query/update calls.")
      .addText((text) =>
        text
          .setPlaceholder("http://127.0.0.1:8000")
          .setValue(this.owner.settings.replicaHost)
          .onChange(async (value) => {
            this.owner.settings.replicaHost = value.trim();
            await this.owner.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Canister ID")
      .setDesc("Principal text of the Kinic wiki canister.")
      .addText((text) =>
        text
          .setPlaceholder("uxrrr-q7777-77774-qaaaq-cai")
          .setValue(this.owner.settings.canisterId)
          .onChange(async (value) => {
            this.owner.settings.canisterId = value.trim();
            await this.owner.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Mirror root")
      .setDesc("Vault folder where the mirror will be written.")
      .addText((text) =>
        text.setValue(this.owner.settings.mirrorRoot).onChange(async (value) => {
          this.owner.settings.mirrorRoot = value.trim() || "Wiki";
          await this.owner.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Auto pull on startup")
      .setDesc("Pull updates automatically when Obsidian starts and the plugin is configured.")
      .addToggle((toggle) =>
        toggle.setValue(this.owner.settings.autoPullOnStartup).onChange(async (value) => {
          this.owner.settings.autoPullOnStartup = value;
          await this.owner.saveSettings();
        })
      );

  }
}

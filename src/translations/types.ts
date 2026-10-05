export interface OptionTranslation {
  readonly label?: string;
  readonly description?: string;
}

export interface SettingTranslationFields {
  /** SHA-256 of normalized upstream display metadata, including source templates. */
  readonly sourceHash: string;
  readonly label?: string;
  readonly description?: string;
  /** English template preserving live keybinding hints from the original getter. */
  readonly descriptionSource?: string;
  readonly warning?: string;
  readonly options?: Readonly<Record<string, OptionTranslation>>;
}

export interface SettingTranslation extends SettingTranslationFields {
  readonly byPlatform?: Readonly<Record<string, SettingTranslationFields | undefined>>;
}

export interface LocalePack {
  readonly locale: "ru";
  readonly sourceOmpVersion: string;
  readonly settings: Readonly<Record<string, SettingTranslation>>;
}

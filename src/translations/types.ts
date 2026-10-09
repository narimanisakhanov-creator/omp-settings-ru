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

export type SourcePlatform = "win32" | "darwin" | "linux";

export interface SourceVariant extends SettingTranslationFields {
  readonly platforms: readonly SourcePlatform[];
  readonly observedIn: readonly string[];
}

export interface SettingTranslation {
  readonly variants: readonly SourceVariant[];
}

export interface LocalePack {
  readonly locale: "ru";
  readonly settings: Readonly<Record<string, SettingTranslation>>;
}

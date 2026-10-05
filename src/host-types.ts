export interface HostOption {
  value: string;
  label: string;
  description?: string;
}

export interface HostUiMetadata {
  tab: string;
  group?: string;
  label: string;
  description: string;
  warning?: string;
  options?: HostOption[] | "runtime";
}

export interface HostSettingDefinition {
  type: string;
  default: unknown;
  values?: readonly string[];
  ui?: HostUiMetadata;
  [key: string]: unknown;
}

export interface HostMetadata {
  version: string;
  platform: string;
  schema: Record<string, HostSettingDefinition | undefined>;
}

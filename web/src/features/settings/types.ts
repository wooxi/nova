export interface Settings {
  openai_api_key?: string
  openai_base_url?: string
  openai_model?: string
  skills_dir?: string
  nova_dir?: string
  auto_save_enabled?: boolean | null
  auto_save_interval_ms?: number | null
  chapter_filename_format?: string
  max_iteration?: number | null
  model_max_retries?: number | null
  plan_mode_default?: boolean | null
}

export interface LayeredSettings {
  default: Settings
  user: Settings
  workspace: Settings
  effective: Settings
}

export type SettingsLayer = 'user' | 'workspace'

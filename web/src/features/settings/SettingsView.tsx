import { useEffect, useState, useCallback } from 'react'
import type { ReactNode } from 'react'
import type { LayeredSettings, Settings, SettingsLayer, StyleRule } from './types'
import { fetchSettings, updateUserSettings, updateWorkspaceSettings } from './api'
import { getStyles } from '@/lib/api'

type SettingsScope = 'ide' | 'interactive'

export function SettingsView() {
  const [layered, setLayered] = useState<LayeredSettings | null>(null)
  const [activeLayer, setActiveLayer] = useState<SettingsLayer>('user')
  const [activeScope, setActiveScope] = useState<SettingsScope>('ide')
  const [draft, setDraft] = useState<Settings>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [availableStyles, setAvailableStyles] = useState<string[]>([])

  const load = useCallback(async () => {
    try {
      const data = await fetchSettings()
      setLayered(data)
      setDraft(activeLayer === 'user' ? data.user : data.workspace)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [activeLayer])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    // 仅工作区层需要风格列表；切换层时按需加载即可，失败不阻塞主体配置展示。
    if (activeLayer !== 'workspace') return
    getStyles()
      .then((items) => setAvailableStyles(items))
      .catch((e) => console.warn('[settings] 获取风格参考列表失败', e))
  }, [activeLayer])

  useEffect(() => {
    if (!layered) return
    setDraft(activeLayer === 'user' ? layered.user : layered.workspace)
  }, [activeLayer, layered])

  const effective = layered?.effective ?? {}

  const onSave = async () => {
    setSaving(true)
    setError(null)
    try {
      const updater = activeLayer === 'user' ? updateUserSettings : updateWorkspaceSettings
      const next = await updater(draft)
      setLayered(next)
      // 通知应用层重新读取分层配置（如 max_open_tabs 等需要立即生效的设置）
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('nova:settings-updated'))
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const setField = <K extends keyof Settings>(k: K, v: Settings[K]) =>
    setDraft((d) => ({ ...d, [k]: v }))

  const placeholderFor = (k: keyof Settings): string => {
    const v = effective[k]
    if (v === undefined || v === null || v === '') return '未设置'
    return `继承：${String(v)}`
  }

  return (
    <div className="flex h-full flex-col bg-[#1b1c1f] text-[#d7dbe2]">
      <div className="flex h-9 items-center gap-1 border-b border-[#303238] bg-[#202124] px-3 text-xs">
        <span className="font-medium text-[#c5c9d1]">设置</span>
        <div className="ml-4 flex gap-1">
          {(['ide', 'interactive'] as SettingsScope[]).map((scope) => (
            <button
              key={scope}
              type="button"
              onClick={() => setActiveScope(scope)}
              className={`rounded px-2 py-0.5 ${
                activeScope === scope ? 'bg-[#2f7dd3] text-white' : 'text-[#9aa0aa] hover:bg-[#303238]'
              }`}
            >
              {scope === 'ide' ? 'IDE 模式' : '互动模式'}
            </button>
          ))}
        </div>
        <div className="ml-3 flex gap-1 border-l border-[#303238] pl-3">
          {(['user', 'workspace'] as SettingsLayer[]).map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => setActiveLayer(l)}
              className={`rounded px-2 py-0.5 ${
                activeLayer === l ? 'bg-[#2f7dd3] text-white' : 'text-[#9aa0aa] hover:bg-[#303238]'
              }`}
            >
              {l === 'user' ? '用户配置' : '当前工作区'}
            </button>
          ))}
        </div>
        <button
          onClick={onSave}
          disabled={saving}
          className="ml-auto rounded bg-[#0e639c] px-3 py-0.5 text-white disabled:opacity-50"
        >
          {saving ? '保存中…' : '保存'}
        </button>
      </div>

      {error && <div className="border-b border-red-500/40 bg-red-500/10 px-3 py-1 text-xs text-red-400">{error}</div>}

      <div className="flex-1 overflow-y-auto p-4 text-xs">
        <Section title="公共配置 · 模型">
          <Text label="API Key" value={draft.openai_api_key} placeholder={placeholderFor('openai_api_key')}
                onChange={(v) => setField('openai_api_key', v)} type="password" />
          <Text label="Base URL" value={draft.openai_base_url} placeholder={placeholderFor('openai_base_url')}
                onChange={(v) => setField('openai_base_url', v)} />
          <Text label="模型" value={draft.openai_model} placeholder={placeholderFor('openai_model')}
                onChange={(v) => setField('openai_model', v)} />
        </Section>

        <Section title="公共配置 · 路径">
          <Text label="Skills 目录" value={draft.skills_dir} placeholder={placeholderFor('skills_dir')}
                onChange={(v) => setField('skills_dir', v)} />
          <ReadOnly label="Nova 数据目录" value={layered?.paths?.nova_dir} />
          <ReadOnly label="用户配置文件" value={layered?.paths?.user_config} />
          <ReadOnly label="工作区配置文件" value={layered?.paths?.workspace_config} />
        </Section>

        <Section title="公共配置 · Agent">
          <Num label="最大迭代轮数" value={draft.max_iteration ?? null}
               placeholder={placeholderFor('max_iteration')}
               onChange={(v) => setField('max_iteration', v)} />
          <Num label="模型重试次数" value={draft.model_max_retries ?? null}
               placeholder={placeholderFor('model_max_retries')}
               onChange={(v) => setField('model_max_retries', v)} />
          <BoolTri label="默认 PlanMode" value={draft.plan_mode_default ?? null}
                   effective={effective.plan_mode_default}
                   onChange={(v) => setField('plan_mode_default', v)} />
        </Section>

        {activeScope === 'ide' ? (
          <>
            <Section title="IDE 模式 · 编辑器">
              <BoolTri label="自动保存" value={draft.auto_save_enabled ?? null}
                       effective={effective.auto_save_enabled}
                       onChange={(v) => setField('auto_save_enabled', v)} />
              <Num label="自动保存间隔 (ms)" value={draft.auto_save_interval_ms ?? null}
                   placeholder={placeholderFor('auto_save_interval_ms')}
                   onChange={(v) => setField('auto_save_interval_ms', v)} />
              <Text label="章节文件名模板" value={draft.chapter_filename_format}
                    placeholder={placeholderFor('chapter_filename_format')}
                    onChange={(v) => setField('chapter_filename_format', v)} />
              <Num label="最大同时打开 Tab 数" value={draft.max_open_tabs ?? null}
                   placeholder={placeholderFor('max_open_tabs')}
                   onChange={(v) => setField('max_open_tabs', v)} />
            </Section>

            {activeLayer === 'workspace' && (
              <Section title="IDE 模式 · 场景化风格规则">
                <StyleRulesEditor
                  available={availableStyles}
                  rules={draft.style_rules ?? []}
                  effective={effective.style_rules ?? []}
                  onChange={(v) => setField('style_rules', v)}
                />
              </Section>
            )}
          </>
        ) : (
          <Section title="互动模式">
            <ReadOnly label="专属配置" value="当前版本暂无互动模式专属配置；上方公共配置会同时作用于互动模式。" />
          </Section>
        )}
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-6">
      <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-[#7f8590]">{title}</div>
      <div className="space-y-2 rounded border border-[#303238] bg-[#202124] p-3">{children}</div>
    </div>
  )
}

function ReadOnly({ label, value }: { label: string; value?: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-44 shrink-0 text-[#9aa0aa]">{label}</span>
      <code className="flex-1 truncate rounded border border-[#303238] bg-[#18191c] px-2 py-1 text-[#9aa0aa]">
        {value || '未设置'}
      </code>
    </div>
  )
}

function Text({ label, value, placeholder, type = 'text', disabled, onChange }: {
  label: string; value?: string; placeholder?: string; type?: string; disabled?: boolean
  onChange: (v: string) => void
}) {
  return (
    <label className="flex items-center gap-3">
      <span className="w-44 shrink-0 text-[#9aa0aa]">{label}</span>
      <input
        type={type}
        value={value ?? ''}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="flex-1 rounded border border-[#303238] bg-[#1b1c1f] px-2 py-1 text-[#d7dbe2] disabled:opacity-50"
      />
    </label>
  )
}

function Num({ label, value, placeholder, onChange }: {
  label: string; value: number | null; placeholder?: string
  onChange: (v: number | null) => void
}) {
  return (
    <label className="flex items-center gap-3">
      <span className="w-44 shrink-0 text-[#9aa0aa]">{label}</span>
      <input
        type="number"
        value={value ?? ''}
        placeholder={placeholder}
        onChange={(e) => {
          const raw = e.target.value
          onChange(raw === '' ? null : Number(raw))
        }}
        className="flex-1 rounded border border-[#303238] bg-[#1b1c1f] px-2 py-1 text-[#d7dbe2]"
      />
    </label>
  )
}

function BoolTri({ label, value, effective, onChange }: {
  label: string; value: boolean | null; effective?: boolean | null
  onChange: (v: boolean | null) => void
}) {
  const eff = effective === null || effective === undefined ? '未设置' : String(effective)
  return (
    <label className="flex items-center gap-3">
      <span className="w-44 shrink-0 text-[#9aa0aa]">{label}</span>
      <select
        value={value === null ? '' : String(value)}
        onChange={(e) => {
          const v = e.target.value
          onChange(v === '' ? null : v === 'true')
        }}
        className="flex-1 rounded border border-[#303238] bg-[#1b1c1f] px-2 py-1 text-[#d7dbe2]"
      >
        <option value="">继承（{eff}）</option>
        <option value="true">开启</option>
        <option value="false">关闭</option>
      </select>
    </label>
  )
}

function StyleRulesEditor({ available, rules, effective, onChange }: {
  available: string[]
  rules: StyleRule[]
  effective: StyleRule[]
  onChange: (v: StyleRule[]) => void
}) {
  const addRule = () => onChange([...rules, { scene: '', styles: [] }])
  const removeRule = (idx: number) => onChange(rules.filter((_, i) => i !== idx))
  const updateRule = (idx: number, patch: Partial<StyleRule>) =>
    onChange(rules.map((r, i) => (i === idx ? { ...r, ...patch } : r)))
  const inheriting = rules.length === 0 && effective.length > 0

  return (
    <div className="flex flex-col gap-3">
      <div className="text-[#9aa0aa]">
        为不同场景配置不同的风格参考。Agent 在创作章节正文时，会根据本轮要写的内容自动匹配最贴近的场景，并 read_file 读取对应风格文件作为文风参考。
        本轮通过 # 显式指定风格则优先使用本轮指定，忽略此处规则。
      </div>

      {inheriting && (
        <div className="rounded border border-[#303238] bg-[#18191c] px-3 py-2 text-[#7f8590]">
          继承生效（{effective.length} 条规则）：
          <ul className="mt-1 space-y-0.5">
            {effective.map((r, i) => (
              <li key={i}>
                <span className="text-[#c5c9d1]">{r.scene || '（未命名场景）'}</span>
                <span className="ml-2">→ {r.styles.join('、') || '（无风格文件）'}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {rules.length > 0 && (
        <div className="space-y-2">
          {rules.map((rule, idx) => (
            <StyleRuleRow
              key={idx}
              available={available}
              rule={rule}
              onChange={(patch) => updateRule(idx, patch)}
              onRemove={() => removeRule(idx)}
            />
          ))}
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={addRule}
          className="rounded border border-[#303238] bg-[#1b1c1f] px-2 py-1 text-[#d7dbe2] hover:bg-[#2a2b30]"
        >
          + 新增规则
        </button>
        {available.length === 0 && (
          <span className="text-[#7f8590]">提示：当前工作区 setting/styles/ 下尚无任何风格文件。</span>
        )}
      </div>
    </div>
  )
}

function StyleRuleRow({ available, rule, onChange, onRemove }: {
  available: string[]
  rule: StyleRule
  onChange: (patch: Partial<StyleRule>) => void
  onRemove: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const toggleStyle = (path: string) => {
    if (rule.styles.includes(path)) {
      onChange({ styles: rule.styles.filter((p) => p !== path) })
    } else {
      onChange({ styles: [...rule.styles, path] })
    }
  }
  const summary = rule.styles.length === 0 ? '尚未选择风格文件' : rule.styles.join('、')

  return (
    <div className="rounded border border-[#303238] bg-[#18191c] p-2">
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={rule.scene}
          placeholder="场景描述（如：激烈打斗 / 日常对话 / 宏大世界观铺陈）"
          onChange={(e) => onChange({ scene: e.target.value })}
          className="flex-1 rounded border border-[#303238] bg-[#1b1c1f] px-2 py-1 text-[#d7dbe2]"
        />
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="rounded border border-[#303238] bg-[#1b1c1f] px-2 py-1 text-[#9aa0aa] hover:bg-[#2a2b30]"
          title={expanded ? '收起' : '展开选择风格'}
        >
          {expanded ? '收起' : `风格 (${rule.styles.length})`}
        </button>
        <button
          type="button"
          onClick={onRemove}
          className="rounded border border-[#303238] bg-[#1b1c1f] px-2 py-1 text-[#9aa0aa] hover:bg-[#2a2b30]"
          title="删除规则"
        >
          删除
        </button>
      </div>

      {!expanded && (
        <div className="mt-1 truncate text-[#7f8590]">→ {summary}</div>
      )}

      {expanded && (
        <div className="mt-2 max-h-48 overflow-y-auto rounded border border-[#303238] bg-[#1b1c1f]">
          {available.length === 0 ? (
            <div className="px-2 py-2 text-[#7f8590]">无可用风格文件</div>
          ) : (
            available.map((path) => (
              <label key={path} className="flex cursor-pointer items-center gap-2 px-2 py-1 hover:bg-[#2a2b30]">
                <input
                  type="checkbox"
                  checked={rule.styles.includes(path)}
                  onChange={() => toggleStyle(path)}
                />
                <span className="text-[#d7dbe2]">{path}</span>
              </label>
            ))
          )}
        </div>
      )}
    </div>
  )
}

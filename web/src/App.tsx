import { useCallback, useEffect, useRef, useState } from 'react'
import { FileTree } from '@/components/Sidebar/FileTree'
import { MessageList } from '@/components/Chat/MessageList'
import { InputArea } from '@/components/Chat/InputArea'
import { SessionManager } from '@/components/Chat/SessionManager'
import { MarkdownEditor } from '@/components/Editor/MarkdownEditor'
import { WorkspaceSelector } from '@/components/Header/WorkspaceSelector'
import { GitPanel } from '@/components/Git/GitPanel'
import { HomeView } from '@/components/Home/HomeView'
import { SettingsView } from '@/features/settings/SettingsView'
import { InteractiveLayout } from '@/features/interactive/components/InteractiveLayout'
import { fetchSettings } from '@/features/settings/api'
import { WorkspaceLayout } from '@/components/layout/workspace-layout'
import { CommandPalette } from '@/components/common/command-palette'
import { TooltipIconButton } from '@/components/common/tooltip-icon-button'
import { useWorkspace } from '@/hooks/useWorkspace'
import { useChat } from '@/hooks/useChat'
import { useWorkspaceHotkeys } from '@/hooks/use-workspace-hotkeys'
import type { FileNode } from '@/hooks/useWorkspace'
import { useWorkspaceStore } from '@/stores/workspace-store'
import type { ChapterSummary, WorkspaceSummary } from '@/lib/api'
import {
  Bot,
  BookOpen,
  FileText,
  GitBranch,
  FolderTree,
  Home,
  PanelLeft,
  PanelRight,
  PenLine,
  RefreshCw,
  SearchCheck,
  Settings,
  Sparkles,
  WandSparkles,
  X,
} from 'lucide-react'

const PROJECT_VISIBLE_KEY = 'nova.layout.projectVisible'
const INTERACTIVE_LEFT_VISIBLE_KEY = 'nova.layout.interactiveLeftVisible'
const INTERACTIVE_RIGHT_VISIBLE_KEY = 'nova.layout.interactiveRightVisible'
const TABS_STORAGE_PREFIX = 'nova.layout.tabs:'
const ACTIVE_TAB_STORAGE_PREFIX = 'nova.layout.activeTab:'
const APP_VERSION = __APP_VERSION__
const MAX_OPEN_TABS_FALLBACK = 5

/** 编辑区 Tab：承载文件或 Home（书籍管理）等页面 */
type Tab =
  | { kind: 'file'; path: string }
  | { kind: 'home' }
  | { kind: 'settings' }

/** Tab 唯一标识，用于 React key 与持久化匹配 */
function tabKey(tab: Tab): string {
  if (tab.kind === 'home') return 'home'
  if (tab.kind === 'settings') return 'settings'
  return `file:${tab.path}`
}

/** 在 tabs 中挑选最久未激活、且不等于 protectedKey 的 tab key（LRU 淘汰目标）。 */
function pickLRUVictim(tabs: Tab[], protectedKey: string | null, activations: Map<string, number>): string | null {
  let victim: string | null = null
  let lowest = Infinity
  for (const t of tabs) {
    const k = tabKey(t)
    if (k === protectedKey) continue
    const score = activations.get(k) ?? 0
    if (score < lowest) {
      lowest = score
      victim = k
    }
  }
  return victim
}

/** 按 tabKey 去重，保留首次出现的条目，防止 React 渲染时出现重复 key。 */
function dedupeTabs(tabs: Tab[]): Tab[] {
  const seen = new Set<string>()
  const result: Tab[] = []
  for (const t of tabs) {
    const k = tabKey(t)
    if (seen.has(k)) continue
    seen.add(k)
    result.push(t)
  }
  return result
}

/** 按 max 限制裁剪 tab 列表，循环淘汰最久未激活的 tab；副作用：从 activations 删除被淘汰项。 */
function enforceTabLimit(tabs: Tab[], protectedKey: string | null, max: number, activations: Map<string, number>): Tab[] {
  const deduped = dedupeTabs(tabs)
  if (max < 1) return deduped
  let current = deduped
  while (current.length > max) {
    const victim = pickLRUVictim(current, protectedKey, activations)
    if (!victim) break
    current = current.filter((t) => tabKey(t) !== victim)
    activations.delete(victim)
  }
  return current
}

/** Tab 显示标题 */
function tabLabel(tab: Tab): string {
  if (tab.kind === 'home') return '书籍管理'
  if (tab.kind === 'settings') return '设置'
  return tab.path.split('/').pop() || tab.path
}

function formatChapterTabLabel(tab: Tab, summary: WorkspaceSummary | null): string {
  if (tab.kind !== 'file') return tabLabel(tab)
  return (summary?.chapters || []).find((chapter) => chapter.path === tab.path)?.display_title || tabLabel(tab)
}

function readLayoutBoolean(key: string, fallback: boolean) {
  if (typeof window === 'undefined') return fallback
  const value = window.localStorage.getItem(key)
  if (value === null) return fallback
  return value === 'true'
}

/** 按 workspace 分桶读取已打开 tab 列表 */
function readTabsFor(workspace: string): Tab[] {
  if (typeof window === 'undefined' || !workspace) return []
  try {
    const raw = window.localStorage.getItem(TABS_STORAGE_PREFIX + workspace)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const tabs = parsed.flatMap((item): Tab[] => {
      if (item && typeof item === 'object') {
        if (item.kind === 'home') return [{ kind: 'home' }]
        if (item.kind === 'settings') return [{ kind: 'settings' }]
        if (item.kind === 'file' && typeof item.path === 'string') return [{ kind: 'file', path: item.path }]
      }
      // 兼容旧版本（仅文件路径字符串）
      if (typeof item === 'string') return [{ kind: 'file', path: item }]
      return []
    })
    return dedupeTabs(tabs)
  } catch {
    return []
  }
}

/** 按 workspace 分桶读取激活的 tab key */
function readActiveTabKeyFor(workspace: string): string | null {
  if (typeof window === 'undefined' || !workspace) return null
  return window.localStorage.getItem(ACTIVE_TAB_STORAGE_PREFIX + workspace)
}

function App() {
  const [projectVisible, setProjectVisible] = useState(() => readLayoutBoolean(PROJECT_VISIBLE_KEY, true))
  const [interactiveLeftVisible, setInteractiveLeftVisible] = useState(() => readLayoutBoolean(INTERACTIVE_LEFT_VISIBLE_KEY, true))
  const [interactiveRightVisible, setInteractiveRightVisible] = useState(() => readLayoutBoolean(INTERACTIVE_RIGHT_VISIBLE_KEY, true))
  const [saveSignal, setSaveSignal] = useState(0)
  const [gitRefreshSignal, setGitRefreshSignal] = useState(0)
  const [openTabs, setOpenTabs] = useState<Tab[]>([])
  const [activeTabKey, setActiveTabKey] = useState<string | null>(null)
  const [maxOpenTabs, setMaxOpenTabs] = useState<number>(MAX_OPEN_TABS_FALLBACK)
  const [sidebarView, setSidebarView] = useState<'outline' | 'files'>('outline')
  const chatBootstrappedRef = useRef(false)
  // 记录每个 tab 最后一次激活的时间戳（递增计数器），用于 LRU 淘汰
  const tabActivationsRef = useRef<Map<string, number>>(new Map())
  const tabActivationCounterRef = useRef(0)
  /** 标记某个 tab 为最近激活，用于 LRU 评分。 */
  const touchTab = useCallback((key: string) => {
    tabActivationCounterRef.current += 1
    tabActivationsRef.current.set(key, tabActivationCounterRef.current)
  }, [])
  /** 在 setOpenTabs 链路里复用：插入 tab 后按 maxOpenTabs 裁剪。protectedKey 是即将激活的 tab，保证不被淘汰。 */
  const limitTabs = useCallback((tabs: Tab[], protectedKey: string | null): Tab[] => {
    return enforceTabLimit(tabs, protectedKey, maxOpenTabs, tabActivationsRef.current)
  }, [maxOpenTabs])
  const rightPanel = useWorkspaceStore((state) => state.rightPanel)
  const commandOpen = useWorkspaceStore((state) => state.commandOpen)
  const mode = useWorkspaceStore((state) => state.mode)
  const setRightPanel = useWorkspaceStore((state) => state.setRightPanel)
  const setCommandOpen = useWorkspaceStore((state) => state.setCommandOpen)
  const setMode = useWorkspaceStore((state) => state.setMode)
  const setSelectedChapterId = useWorkspaceStore((state) => state.setSelectedChapterId)
  const aiVisible = rightPanel === 'ai'
  const versionsVisible = rightPanel === 'versions'
  const {
    tree, loading, selectedFile, fileContent, workspace, summary, styles, books,
    selectFile, clearSelectedFile, saveCurrentFile, createItem, deleteItem, renameItem, copyItem, moveItem,
    refresh, refreshAfterAgentFileChange, refreshAll, refreshBooks, setWorkspace,
  } = useWorkspace()
  const notifyGitChange = useCallback(() => {
    setGitRefreshSignal(value => value + 1)
  }, [])
  const handleAgentFileChange = useCallback(async (path?: string) => {
    await refreshAfterAgentFileChange(path)
    notifyGitChange()
  }, [notifyGitChange, refreshAfterAgentFileChange])
  const {
    messages,
    sessions,
    activeSessionId,
    isStreaming,
    activityContent,
    references,
    styleReferences,
    textSelections,
    send,
    stop,
    loadSessions,
    loadHistory,
    resumeActiveChat,
    createChatSession,
    switchChatSession,
    renameChatSession,
    deleteChatSession,
    addReference,
    removeReference,
    addStyleReference,
    removeStyleReference,
    addTextSelection,
    removeTextSelection,
  } = useChat({ onAgentFileChange: handleAgentFileChange })

  const chapterStats: Record<string, ChapterSummary> = Object.fromEntries((summary?.chapters || []).map((chapter) => [chapter.path, chapter]))
  const currentChapter = selectedFile ? chapterStats[selectedFile] : undefined

  useEffect(() => {
    if (chatBootstrappedRef.current) return
    chatBootstrappedRef.current = true
    void Promise.all([loadSessions(), loadHistory()]).then(() => resumeActiveChat())
  }, [loadHistory, loadSessions, resumeActiveChat])

  // 拉取分层配置中的 max_open_tabs（用户/工作区切换时也需重新拉取，因为工作区可能覆盖该值）
  useEffect(() => {
    let cancelled = false
    const reload = () => {
      fetchSettings()
        .then((data) => {
          if (cancelled) return
          const v = data?.effective?.max_open_tabs
          if (typeof v === 'number' && v >= 1) setMaxOpenTabs(Math.floor(v))
        })
        .catch((e) => console.warn('加载 max_open_tabs 失败', e))
    }
    reload()
    const onUpdated = () => reload()
    window.addEventListener('nova:settings-updated', onUpdated)
    return () => {
      cancelled = true
      window.removeEventListener('nova:settings-updated', onUpdated)
    }
  }, [workspace])

  // 激活的 tab 变化时记录 LRU 时间戳
  useEffect(() => {
    if (activeTabKey) touchTab(activeTabKey)
  }, [activeTabKey, touchTab])

  // maxOpenTabs 调小后立即裁剪现有 tab
  useEffect(() => {
    setOpenTabs((prev) => limitTabs(prev, activeTabKey))
  }, [maxOpenTabs, activeTabKey, limitTabs])

  useEffect(() => { window.localStorage.setItem(PROJECT_VISIBLE_KEY, String(projectVisible)) }, [projectVisible])
  useEffect(() => { window.localStorage.setItem(INTERACTIVE_LEFT_VISIBLE_KEY, String(interactiveLeftVisible)) }, [interactiveLeftVisible])
  useEffect(() => { window.localStorage.setItem(INTERACTIVE_RIGHT_VISIBLE_KEY, String(interactiveRightVisible)) }, [interactiveRightVisible])

  // workspace 切换时从 localStorage 加载该 workspace 下的 tab 列表与激活项
  useEffect(() => {
    if (!workspace) {
      // 无 workspace 时默认打开「书籍管理」页，引导用户选择或新建书籍
      setOpenTabs([{ kind: 'home' }])
      setActiveTabKey('home')
      clearSelectedFile()
      return
    }
    const tabs = readTabsFor(workspace)
    const storedKey = readActiveTabKeyFor(workspace)
    const activeKey = storedKey && tabs.some((t) => tabKey(t) === storedKey) ? storedKey : (tabs.length > 0 ? tabKey(tabs[0]) : null)
    // 重置 LRU 计数：按 tabs 顺序重新打分，激活项分数最高
    tabActivationsRef.current = new Map()
    tabActivationCounterRef.current = 0
    for (const t of tabs) touchTab(tabKey(t))
    if (activeKey) touchTab(activeKey)
    const limited = limitTabs(tabs, activeKey)
    setOpenTabs(limited)
    setActiveTabKey(activeKey)
    // 若激活的是文件 tab，恢复编辑器内容
    if (activeKey) {
      const target = tabs.find((t) => tabKey(t) === activeKey)
      if (target?.kind === 'file') {
        void selectFile(target.path)
      } else {
        clearSelectedFile()
      }
    } else {
      clearSelectedFile()
    }
  // 仅在 workspace 变更时触发；selectFile/clearSelectedFile 引用稳定
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace])

  // tabs 变化时持久化到 localStorage（按 workspace 分桶）
  useEffect(() => {
    if (typeof window === 'undefined' || !workspace) return
    try {
      window.localStorage.setItem(TABS_STORAGE_PREFIX + workspace, JSON.stringify(openTabs))
    } catch (e) {
      console.warn('保存 tab 列表失败', e)
    }
  }, [openTabs, workspace])

  // 激活 tab 变化时持久化
  useEffect(() => {
    if (typeof window === 'undefined' || !workspace) return
    if (activeTabKey) {
      window.localStorage.setItem(ACTIVE_TAB_STORAGE_PREFIX + workspace, activeTabKey)
    } else {
      window.localStorage.removeItem(ACTIVE_TAB_STORAGE_PREFIX + workspace)
    }
  }, [activeTabKey, workspace])

  // 选中文件时确保它出现在 tab 列表中并成为激活 tab
  // 兜底：覆盖 selectFile 由 useWorkspace 内部触发的场景（如重命名/移动）
  useEffect(() => {
    if (!selectedFile) return
    const key = `file:${selectedFile}`
    setOpenTabs((prev) => {
      const next: Tab[] = prev.some((t) => tabKey(t) === key) ? prev : [...prev, { kind: 'file', path: selectedFile }]
      return limitTabs(next, key)
    })
    setActiveTabKey(key)
  }, [selectedFile, limitTabs])

  /** workspace 切换后刷新目录树和聊天 */
  const handleWorkspaceSwitch = (newPath: string) => {
    setWorkspace(newPath)
    refreshAll()
    notifyGitChange()
    void Promise.all([loadSessions(), loadHistory()]).then(() => resumeActiveChat())
  }

  /** 保存编辑器内容后刷新 Git 状态。 */
  const handleSaveCurrentFile = useCallback(async (content: string) => {
    const saved = await saveCurrentFile(content)
    if (saved) notifyGitChange()
    return saved
  }, [notifyGitChange, saveCurrentFile])

  /** 文件树写操作完成后刷新 Git 状态。 */
  const handleCreateItem = useCallback(async (path: string, type: 'file' | 'dir') => {
    await createItem(path, type)
    notifyGitChange()
  }, [createItem, notifyGitChange])

  const handleDeleteItem = useCallback(async (path: string) => {
    await deleteItem(path)
    setOpenTabs((prev) => prev.filter((t) => t.kind !== 'file' || (t.path !== path && !t.path.startsWith(`${path}/`))))
    notifyGitChange()
  }, [deleteItem, notifyGitChange])

  const handleRenameItem = useCallback(async (path: string, newName: string) => {
    await renameItem(path, newName)
    // 重命名后用旧路径前缀替换 tab 列表中的匹配项
    const parent = path.replace(/\/[^/]*$/, '')
    const newPath = parent ? `${parent}/${newName}` : newName
    setOpenTabs((prev) => dedupeTabs(prev.map((t) => {
      if (t.kind !== 'file') return t
      if (t.path === path) return { kind: 'file', path: newPath }
      if (t.path.startsWith(`${path}/`)) return { kind: 'file', path: `${newPath}${t.path.slice(path.length)}` }
      return t
    })))
    notifyGitChange()
  }, [notifyGitChange, renameItem])

  const handleCopyItem = useCallback(async (from: string, to: string) => {
    await copyItem(from, to)
    notifyGitChange()
  }, [copyItem, notifyGitChange])

  const handleMoveItem = useCallback(async (from: string, to: string) => {
    await moveItem(from, to)
    setOpenTabs((prev) => dedupeTabs(prev.map((t) => {
      if (t.kind !== 'file') return t
      if (t.path === from) return { kind: 'file', path: to }
      if (t.path.startsWith(`${from}/`)) return { kind: 'file', path: `${to}${t.path.slice(from.length)}` }
      return t
    })))
    notifyGitChange()
  }, [moveItem, notifyGitChange])

  /** 选中文件时同步 UI Store 中的章节状态，并主动激活/创建对应 Tab。 */
  const handleSelectFile = useCallback(async (path: string) => {
    setSelectedChapterId(path)
    // 直接同步 tab 状态，避免依赖 selectedFile 的 effect（重选同一文件时 effect 不会触发）
    const key = `file:${path}`
    setOpenTabs((prev) => {
      const next: Tab[] = prev.some((t) => tabKey(t) === key) ? prev : [...prev, { kind: 'file', path }]
      return limitTabs(next, key)
    })
    setActiveTabKey(key)
    await selectFile(path)
  }, [limitTabs, selectFile, setSelectedChapterId])

  /** 激活某个 tab：文件 tab 触发文件加载，Home tab 仅切换激活态 */
  const handleActivateTab = useCallback((tab: Tab) => {
    const key = tabKey(tab)
    setActiveTabKey(key)
    if (tab.kind === 'file') {
      if (selectedFile !== tab.path) void handleSelectFile(tab.path)
    }
  }, [handleSelectFile, selectedFile])

  /** 打开 Home（书籍管理）tab：已存在则定位，否则追加并激活 */
  const openHomeTab = useCallback(() => {
    setOpenTabs((prev) => {
      const next: Tab[] = prev.some((t) => t.kind === 'home') ? prev : [...prev, { kind: 'home' }]
      return limitTabs(next, 'home')
    })
    setActiveTabKey('home')
  }, [limitTabs])

  /** 打开设置 tab：已存在则定位，否则追加并激活 */
  const openSettingsTab = useCallback(() => {
    setOpenTabs((prev) => {
      const next: Tab[] = prev.some((t) => t.kind === 'settings') ? prev : [...prev, { kind: 'settings' }]
      return limitTabs(next, 'settings')
    })
    setActiveTabKey('settings')
  }, [limitTabs])

  /** 关闭 tab；若关闭的是当前激活 tab，则切换到相邻 tab */
  const handleCloseTab = useCallback((tab: Tab) => {
    const key = tabKey(tab)
    setOpenTabs((prev) => {
      const idx = prev.findIndex((t) => tabKey(t) === key)
      if (idx === -1) return prev
      const next = prev.filter((t) => tabKey(t) !== key)
      if (activeTabKey === key) {
        if (next.length === 0) {
          setActiveTabKey(null)
          clearSelectedFile()
        } else {
          const fallback = next[idx] ?? next[idx - 1] ?? next[0]
          handleActivateTab(fallback)
        }
      }
      return next
    })
  }, [activeTabKey, clearSelectedFile, handleActivateTab])

  const triggerSave = useCallback(() => setSaveSignal((value) => value + 1), [])
  const continueWriting = useCallback(() => {
    if (!isStreaming) send('/continue')
  }, [isStreaming, send])

  useWorkspaceHotkeys({
    onSave: triggerSave,
    onOpenCommand: () => setCommandOpen(true),
    onGenerate: continueWriting,
    onOpenDiff: () => setRightPanel('versions'),
    onEscape: () => {
      if (commandOpen) {
        setCommandOpen(false)
        return
      }
      if (rightPanel) setRightPanel(null)
    },
  })

  const topBar = (
    <>
      <header className="flex h-7 shrink-0 items-center border-b border-[#303238] bg-[#202124] px-2 text-xs text-[#9aa0aa]">
        <div className="font-medium text-[#d7dbe2]">Nova</div>
        <div className="ml-3 flex items-center gap-1">
          <button
            type="button"
            className={`rounded-md px-3 py-0.5 text-xs ${mode === 'ide' ? 'bg-[#2f7dd3] text-white' : 'text-[#9aa0aa] hover:bg-[#303238]'}`}
            onClick={() => setMode('ide')}
          >
            IDE
          </button>
          <button
            type="button"
            className={`rounded-md px-3 py-0.5 text-xs ${mode === 'interactive' ? 'bg-[#2f7dd3] text-white' : 'text-[#9aa0aa] hover:bg-[#303238]'}`}
            onClick={() => setMode('interactive')}
          >
            Interactive
          </button>
        </div>
      </header>

      <WorkspaceSelector
        workspace={workspace}
        books={books}
        onSwitch={handleWorkspaceSwitch}
        onBooksChange={refreshBooks}
      />
    </>
  )

  const ideActivityButtons = (
    <>
      <TooltipIconButton
        label="主页（书籍管理）"
        onClick={openHomeTab}
        className={`mb-4 hover:bg-[#303238] ${activeTabKey === 'home' ? 'text-[#d7dbe2]' : 'text-[#a8adb7]'}`}
      >
        <Home className="h-4 w-4" />
      </TooltipIconButton>
      <TooltipIconButton
        label="显示/隐藏项目结构"
        onClick={() => setProjectVisible((value) => !value)}
        className={`mb-4 hover:bg-[#303238] ${projectVisible ? 'text-[#d7dbe2]' : 'text-[#6f7580]'}`}
      >
        <FolderTree className="h-4 w-4" />
      </TooltipIconButton>
      <TooltipIconButton
        label="显示/隐藏 创作Agent"
        onClick={() => setRightPanel(aiVisible ? null : 'ai')}
        className={`mb-4 hover:bg-[#303238] ${aiVisible ? 'text-[#d7dbe2]' : 'text-[#6f7580]'}`}
      >
        <Bot className="h-4 w-4" />
      </TooltipIconButton>
      <TooltipIconButton
        label="版本管理"
        onClick={() => setRightPanel(versionsVisible ? null : 'versions')}
        className={`mb-4 hover:bg-[#303238] ${versionsVisible ? 'text-[#d7dbe2]' : 'text-[#6f7580]'}`}
      >
        <GitBranch className="h-4 w-4" />
      </TooltipIconButton>
    </>
  )

  const interactiveActivityButtons = (
    <>
      <TooltipIconButton
        label="显示/隐藏互动资料库"
        onClick={() => setInteractiveLeftVisible((value) => !value)}
        className={`mb-4 hover:bg-[#303238] ${interactiveLeftVisible ? 'text-[#d7dbe2]' : 'text-[#6f7580]'}`}
      >
        <PanelLeft className="h-4 w-4" />
      </TooltipIconButton>
      <TooltipIconButton
        label="显示/隐藏场景记忆"
        onClick={() => setInteractiveRightVisible((value) => !value)}
        className={`mb-4 hover:bg-[#303238] ${interactiveRightVisible ? 'text-[#d7dbe2]' : 'text-[#6f7580]'}`}
      >
        <PanelRight className="h-4 w-4" />
      </TooltipIconButton>
    </>
  )

  const activityBar = (
    <aside className="flex w-9 shrink-0 flex-col items-center border-r border-[#303238] bg-[#202124] py-2 text-[#7f8590]">
      {mode === 'ide' ? ideActivityButtons : interactiveActivityButtons}
      <TooltipIconButton
        label="设置"
        onClick={openSettingsTab}
        className={`mt-auto hover:bg-[#303238] ${activeTabKey === 'settings' ? 'text-[#d7dbe2]' : 'text-[#a8adb7]'}`}
      >
        <Settings className="h-4 w-4" />
      </TooltipIconButton>
    </aside>
  )

  const sidebar = (
    <section className="flex h-full flex-col border-r border-[#303238] bg-[#202124]">
      <div className="flex min-h-[92px] flex-col gap-2 border-b border-[#303238] px-3 py-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs font-medium text-[#d7dbe2]">{summary?.title || '作品'}</div>
            <div className="mt-0.5 text-[11px] text-[#7f8794]">
              {summary ? `${summary.chapter_count} 章 · ${formatNumber(summary.total_words)} 字` : '正在加载作品进度'}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={refresh}
              className="rounded p-1 text-[#858b96] hover:bg-[#303238]"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setProjectVisible(false)}
              className="rounded px-1 text-[#858b96] hover:bg-[#303238] hover:text-[#d7dbe2]"
            >
              ×
            </button>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setSidebarView('outline')}
            className={`flex-1 rounded-md px-2 py-1 text-xs ${sidebarView === 'outline' ? 'bg-[#2f7dd3] text-white' : 'bg-[#25262a] text-[#9aa0aa] hover:bg-[#303238]'}`}
          >
            作品目录
          </button>
          <button
            type="button"
            onClick={() => setSidebarView('files')}
            className={`flex-1 rounded-md px-2 py-1 text-xs ${sidebarView === 'files' ? 'bg-[#2f7dd3] text-white' : 'bg-[#25262a] text-[#9aa0aa] hover:bg-[#303238]'}`}
          >
            项目文件
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-2 text-xs">
        {loading ? (
          <div className="py-4 text-center text-[#858b96]">加载中…</div>
        ) : sidebarView === 'outline' ? (
          <ChapterOutline
            chapters={summary?.chapters || []}
            selectedFile={selectedFile}
            onSelectFile={handleSelectFile}
          />
        ) : tree.length === 0 ? (
          <div className="py-4 text-center text-[#858b96]">暂无文件</div>
        ) : (
          <FileTree
            nodes={tree}
            selectedFile={selectedFile}
            onSelectFile={handleSelectFile}
            onReferenceFile={addReference}
            chapterStats={chapterStats}
            onCreateItem={handleCreateItem}
            onDeleteItem={handleDeleteItem}
            onRenameItem={handleRenameItem}
            onCopyItem={handleCopyItem}
            onMoveItem={handleMoveItem}
          />
        )}
      </div>
    </section>
  )

  const activeTab = openTabs.find((t) => tabKey(t) === activeTabKey) ?? null
  const settingsActive = activeTab?.kind === 'settings'

  const tabBar = (
    <div className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-[#303238] bg-[#202124] text-xs">
      {openTabs.length === 0 ? (
        <div className="flex h-full items-center px-3 text-[#7f8590]">未打开任何页面</div>
      ) : (
        openTabs.map((tab) => {
          const key = tabKey(tab)
          const isActive = key === activeTabKey
          const label = formatChapterTabLabel(tab, summary)
          const tooltip = tab.kind === 'file' ? tab.path : label
          return (
            <div
              key={key}
              className={`group flex h-full shrink-0 items-center gap-2 border-r border-[#303238] px-3 ${
                isActive
                  ? 'border-t-2 border-t-[#2f7dd3] bg-[#25262a] text-[#d7dbe2]'
                  : 'text-[#9aa0aa] hover:bg-[#25262a]/60'
              }`}
            >
              <button
                type="button"
                onClick={() => { if (!isActive) handleActivateTab(tab) }}
                className="max-w-[220px] truncate text-left"
                title={tooltip}
              >
                {label}
              </button>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); handleCloseTab(tab) }}
                className="rounded p-0.5 text-[#7f8590] opacity-0 hover:bg-[#303238] hover:text-[#d7dbe2] group-hover:opacity-100"
                aria-label={`关闭 ${label}`}
                title="关闭"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )
        })
      )}
    </div>
  )

  const main = (
    <main className="flex h-full min-w-0 flex-col border-r border-[#303238] bg-[#1b1c1f]">
      {mode === 'interactive' && !settingsActive ? (
        <InteractiveLayout
          leftPanelVisible={interactiveLeftVisible}
          rightPanelVisible={interactiveRightVisible}
        />
      ) : (
        <>
          {tabBar}
          <div className="flex min-h-0 flex-1 flex-col">
            {activeTab?.kind === 'home' ? (
              <HomeView
                workspace={workspace}
                books={books}
                onSwitch={handleWorkspaceSwitch}
                onBooksChange={refreshBooks}
              />
            ) : activeTab?.kind === 'settings' ? (
              <SettingsView />
            ) : activeTab?.kind === 'file' ? (
              <MarkdownEditor
                fileName={selectedFile}
                content={fileContent}
                onSave={handleSaveCurrentFile}
                onQuoteSelection={addTextSelection}
                saveSignal={saveSignal}
                chapterSummary={currentChapter}
                workspaceSummary={summary}
              />
            ) : (
              <div className="flex h-full items-center justify-center text-xs text-[#7f8590]">
                请从左侧目录树选择文件，或打开「书籍管理」
              </div>
            )}
          </div>
        </>
      )}
    </main>
  )

  const rightPanelContent = rightPanel === 'ai' ? (
    <aside className="flex h-full flex-col bg-[#202124]">
      <div className="flex h-9 items-center gap-3 border-b border-[#303238] px-3">
        <div className="flex shrink-0 items-center gap-2 text-xs font-medium text-[#c5c9d1]">
          <Bot className="h-3.5 w-3.5 text-[#7aa2f7]" />
          创作Agent
        </div>
        <SessionManager
          sessions={sessions}
          activeSessionId={activeSessionId}
          disabled={isStreaming}
          onCreate={createChatSession}
          onSwitch={switchChatSession}
          onRename={renameChatSession}
          onDelete={deleteChatSession}
        />
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-[11px] text-[#7f8590]">{isStreaming ? '创作中…' : '等待'}</span>
          <button
            type="button"
            onClick={() => setRightPanel(null)}
            className="rounded px-1 text-xs text-[#858b96] hover:bg-[#303238] hover:text-[#d7dbe2]"
          >
            ×
          </button>
        </div>
      </div>
      {messages.length === 0 && !isStreaming && (
        <AgentQuickActions
          chapter={currentChapter}
          selectedFile={selectedFile}
          onSend={send}
        />
      )}
      <MessageList
        messages={messages}
        isStreaming={isStreaming}
        activityContent={activityContent}
      />
      <InputArea
        onSend={send}
        onStop={stop}
        disabled={isStreaming}
        referencedFiles={references}
        onReferenceRemove={removeReference}
        fileSuggestions={flattenFileTree(tree)}
        styleReferences={styleReferences}
        onStyleReferenceAdd={addStyleReference}
        onStyleReferenceRemove={removeStyleReference}
        styleSuggestions={styles}
        textSelections={textSelections}
        onTextSelectionRemove={removeTextSelection}
      />
    </aside>
  ) : rightPanel === 'versions' ? (
    <GitPanel
      workspace={workspace}
      refreshSignal={gitRefreshSignal}
      visible={versionsVisible}
      onClose={() => setRightPanel(null)}
    />
  ) : null

  const statusBar = (
    <div className="flex h-6 shrink-0 items-center border-t border-[#303238] bg-[#1f2023] px-3 text-[11px] text-[#858b96]">
      <span>Nova v{APP_VERSION}</span>
      {mode === 'ide' && summary && (
        <span className="ml-4">《{summary.title || '未命名'}》 · {summary.chapter_count} 章 · {formatNumber(summary.total_words)} 字</span>
      )}
      {mode === 'ide' && currentChapter && (
        <span className="ml-4">当前：{currentChapter.display_title} · {formatNumber(currentChapter.words)} 字 · {currentChapter.status}</span>
      )}
      <span className="ml-auto">{isStreaming ? '生成中' : '空闲'} · DeepSeek</span>
    </div>
  )

  return (
    <>
      <WorkspaceLayout
        topBar={topBar}
        activityBar={activityBar}
        sidebar={sidebar}
        sidebarVisible={mode === 'ide' && projectVisible}
        main={main}
        rightPanel={mode === 'ide' ? rightPanelContent : null}
        rightPanelVisible={mode === 'ide' && Boolean(rightPanelContent)}
        statusBar={statusBar}
      />
      <CommandPalette
        open={commandOpen}
        isStreaming={isStreaming}
        onOpenChange={setCommandOpen}
        onSave={triggerSave}
        onOpenAgent={() => setRightPanel('ai')}
        onOpenVersions={() => setRightPanel('versions')}
        onContinueWriting={continueWriting}
        onClosePanels={() => {
          setRightPanel(null)
        }}
      />
    </>
  )
}

function flattenFileTree(nodes: FileNode[], basePath = ''): string[] {
  return nodes.flatMap((node) => {
    const path = basePath ? `${basePath}/${node.name}` : node.name
    if (node.type === 'file') return [path]
    return flattenFileTree(node.children || [], path)
  })
}

function ChapterOutline({
  chapters,
  selectedFile,
  onSelectFile,
}: {
  chapters: ChapterSummary[]
  selectedFile: string | null
  onSelectFile: (path: string) => void
}) {
  if (chapters.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-[#343842] bg-[#1b1c1f] px-3 py-4 text-center text-xs text-[#858b96]">
        chapters/ 下还没有章节
      </div>
    )
  }

  return (
    <div className="space-y-1.5">
      {chapters.map((chapter) => {
        const active = selectedFile === chapter.path
        return (
          <button
            key={chapter.path}
            type="button"
            className={`w-full rounded-lg border px-3 py-2 text-left transition ${
              active
                ? 'border-[#2f7dd3]/60 bg-[#2f7dd3]/20 text-[#e6f1ff]'
                : 'border-transparent bg-[#1b1c1f] text-[#aeb4bf] hover:border-[#343842] hover:bg-[#25262a]'
            }`}
            onClick={() => onSelectFile(chapter.path)}
          >
            <div className="flex min-w-0 items-center gap-2">
              <BookOpen className={`h-3.5 w-3.5 shrink-0 ${active ? 'text-[#9fc7ff]' : 'text-[#7aa2f7]'}`} />
              <span className="truncate text-xs font-medium">{chapter.display_title}</span>
            </div>
            <div className="mt-1 flex items-center justify-between text-[11px] text-[#7f8794]">
              <span>{formatNumber(chapter.words)} 字</span>
              <span className="rounded border border-[#3a4658] bg-[#1c2430] px-1.5 text-[#9fc7ff]">{chapter.status}</span>
            </div>
          </button>
        )
      })}
    </div>
  )
}

function AgentQuickActions({
  chapter,
  selectedFile,
  onSend,
}: {
  chapter?: ChapterSummary
  selectedFile: string | null
  onSend: (message: string) => void
}) {
  const target = chapter ? `当前章节《${chapter.display_title}》` : (selectedFile ? `当前文件 ${selectedFile}` : '当前作品')
  const actions = [
    { label: '续写下一段', icon: PenLine, prompt: `请基于${target}的上下文，续写下一段正文，保持原有叙事节奏和人物状态。` },
    { label: '润色当前章', icon: WandSparkles, prompt: `请检查并润色${target}，重点优化语句节奏、动作描写和情绪推进，不改变核心剧情。` },
    { label: '提取本章摘要', icon: FileText, prompt: `请为${target}提取章节摘要，包含关键事件、角色状态变化、伏笔和下一章衔接点。` },
    { label: '一致性检查', icon: SearchCheck, prompt: `请对${target}做一致性检查，重点关注人物动机、时间线、道具、地点和前后文冲突。` },
  ]

  return (
    <div className="border-b border-[#303238] bg-[#1b1c1f] p-3">
      <div className="mb-2 flex items-center gap-2 text-xs font-medium text-[#c5c9d1]">
        <Sparkles className="h-3.5 w-3.5 text-[#7aa2f7]" />
        快捷创作
      </div>
      <div className="grid grid-cols-2 gap-2">
        {actions.map((action) => {
          const Icon = action.icon
          return (
            <button
              key={action.label}
              type="button"
              className="flex items-center gap-2 rounded-lg border border-[#303238] bg-[#202124] px-3 py-2 text-left text-xs text-[#c5c9d1] hover:border-[#3a4658] hover:bg-[#252a33] hover:text-[#e6f1ff]"
              onClick={() => onSend(action.prompt)}
            >
              <Icon className="h-3.5 w-3.5 shrink-0 text-[#8fb5ff]" />
              <span className="truncate">{action.label}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function formatNumber(value: number) {
  return new Intl.NumberFormat('zh-CN').format(value)
}

export default App

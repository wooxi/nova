package app

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"

	"github.com/cloudwego/eino/adk"

	"nova/config"
	"nova/internal/agent"
	"nova/internal/book"
	"nova/internal/session"
)

// App 管理 Nova 后端运行时依赖和 workspace 热切换。
type App struct {
	cfg *config.Config

	workspace     string
	bookState     *book.State
	bookService   *book.Service
	sessionStore  *session.Store
	session       *session.Session
	agentRunner   *adk.Runner
	chatService   *agent.ChatService
	bookRegistry  *BookRegistry
	bookMetaStore *BookMetaStore
	gitService    *book.GitService
	activeTask    *Task

	mu sync.RWMutex
}

// New 创建应用运行时。当 workspace 为空且没有最近 workspace 时，App 进入“无书籍”状态，
// 等待用户在前端书籍管理页选择或新建书籍后再构建 runtime。
func New(ctx context.Context, cfg *config.Config) (*App, error) {
	registry := NewBookRegistry(cfg.NovaDir)
	bookMetaStore := NewBookMetaStore(cfg.NovaDir)
	workspace := cfg.Workspace
	if workspace == "" && cfg.ResumeLastWorkspace {
		if lastWorkspace := registry.Current(); lastWorkspace != "" {
			workspace = lastWorkspace
		}
	}

	app := &App{
		cfg:           cfg,
		chatService:   agent.NewChatService(),
		bookRegistry:  registry,
		bookMetaStore: bookMetaStore,
	}

	if workspace == "" {
		log.Printf("[app] 启动时未指定 workspace 且无最近书籍，进入无书籍状态，等待用户在前端选择")
		cfg.Workspace = ""
		return app, nil
	}

	runtime, err := buildRuntime(ctx, cfg, workspace)
	if err != nil {
		return nil, err
	}
	cfg.Workspace = runtime.workspace
	_ = registry.Touch(runtime.workspace)

	app.workspace = runtime.workspace
	app.bookState = runtime.bookState
	app.bookService = runtime.bookService
	app.sessionStore = runtime.sessionStore
	app.session = runtime.session
	app.agentRunner = runtime.agentRunner
	app.gitService = runtime.gitService
	return app, nil
}

// ErrNoWorkspace 表示当前 App 尚未绑定任何书籍 workspace。
var ErrNoWorkspace = fmt.Errorf("尚未选择书籍工作区")

// HasWorkspace 返回是否已绑定 workspace。
func (a *App) HasWorkspace() bool {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.workspace != ""
}

// Workspace 返回当前 workspace。
func (a *App) Workspace() string {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.workspace
}

// BookState 返回当前作品状态管理器。
func (a *App) BookState() *book.State {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.bookState
}

// BookService 返回当前作品文件服务。
func (a *App) BookService() *book.Service {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.bookService
}

// Session 返回当前会话。
func (a *App) Session() *session.Session {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.session
}

// Runner 返回当前 Agent Runner。
func (a *App) Runner() *adk.Runner {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.agentRunner
}

// ChatService 返回聊天服务。
func (a *App) ChatService() *agent.ChatService {
	return a.chatService
}

// SwitchWorkspace 切换工作区，并重建状态、会话和 Agent Runner。
func (a *App) SwitchWorkspace(ctx context.Context, path string) (string, error) {
	absPath, err := filepath.Abs(path)
	if err != nil {
		return "", fmt.Errorf("路径无效: %w", err)
	}

	info, err := os.Stat(absPath)
	if err != nil || !info.IsDir() {
		return "", fmt.Errorf("目录不存在: %s", absPath)
	}

	runtime, err := buildRuntime(ctx, a.cfg, absPath)
	if err != nil {
		return "", err
	}

	a.mu.Lock()
	a.workspace = runtime.workspace
	a.bookState = runtime.bookState
	a.bookService = runtime.bookService
	a.sessionStore = runtime.sessionStore
	a.session = runtime.session
	a.agentRunner = runtime.agentRunner
	a.gitService = runtime.gitService
	a.cfg.Workspace = runtime.workspace
	a.mu.Unlock()

	_ = a.bookRegistry.Touch(runtime.workspace)
	return runtime.workspace, nil
}

// Books 返回最近打开的书籍工作目录，并从 book.json 填充元信息。
func (a *App) Books() []BookRecord {
	records := a.bookRegistry.List()
	for i := range records {
		meta, err := a.bookMetaStore.Read(records[i].Path)
		if err != nil {
			continue
		}
		if meta.Title != "" {
			records[i].Name = meta.Title
		}
		records[i].Author = meta.Author
	}
	return records
}

// BookInfo 读取指定路径工作区的书籍元信息。
func (a *App) BookInfo(path string) (book.BookMeta, error) {
	absPath, err := filepath.Abs(path)
	if err != nil {
		return book.BookMeta{}, fmt.Errorf("路径无效: %w", err)
	}
	return a.bookMetaStore.Read(absPath)
}

// UpdateBookInfo 更新指定路径工作区的书籍元信息。
func (a *App) UpdateBookInfo(path string, title, author, description string) (book.BookMeta, error) {
	absPath, err := filepath.Abs(path)
	if err != nil {
		return book.BookMeta{}, fmt.Errorf("路径无效: %w", err)
	}
	meta, err := a.bookMetaStore.Read(absPath)
	if err != nil {
		return book.BookMeta{}, err
	}
	if title != "" {
		meta.Title = title
	}
	if author != "" {
		meta.Author = author
	}
	// description 允许设为空字符串（清除简介），所以总是更新
	meta.Description = description
	return a.bookMetaStore.Write(absPath, meta)
}

// RemoveBook 移除书籍记录，不删除磁盘目录。
func (a *App) RemoveBook(path string) error {
	return a.bookRegistry.Remove(path)
}

// CreateBook 创建新书籍工作区：在 parentDir 下创建以 title 命名的子目录，初始化工作区结构和元信息，然后切换到该工作区。
func (a *App) CreateBook(ctx context.Context, parentDir, title, author, description string) (string, book.BookMeta, error) {
	absParent, err := filepath.Abs(parentDir)
	if err != nil {
		return "", book.BookMeta{}, fmt.Errorf("路径无效: %w", err)
	}

	dir := filepath.Join(absParent, title)
	if _, err := os.Stat(dir); err == nil {
		return "", book.BookMeta{}, fmt.Errorf("目录已存在: %s", dir)
	}

	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", book.BookMeta{}, fmt.Errorf("创建目录失败: %w", err)
	}

	state := book.NewState(dir)
	if err := state.InitWorkspace(); err != nil {
		return "", book.BookMeta{}, fmt.Errorf("初始化工作目录失败: %w", err)
	}

	meta := book.BookMeta{Title: title, Author: author, Description: description}
	meta, err = a.bookMetaStore.Write(dir, meta)
	if err != nil {
		return "", book.BookMeta{}, fmt.Errorf("写入书籍元信息失败: %w", err)
	}

	workspace, switchErr := a.SwitchWorkspace(ctx, dir)
	if switchErr != nil {
		return "", book.BookMeta{}, fmt.Errorf("切换工作区失败: %w", switchErr)
	}

	return workspace, meta, nil
}

// GitStatus 返回当前书籍 workspace 的 Git 状态。
func (a *App) GitStatus(ctx context.Context) (book.GitStatus, error) {
	a.mu.RLock()
	gitService := a.gitService
	a.mu.RUnlock()
	return gitService.Status(ctx)
}

// GitHistory 返回当前书籍 workspace 的 Git 提交历史。
func (a *App) GitHistory(ctx context.Context, limit int) ([]book.GitCommit, error) {
	a.mu.RLock()
	gitService := a.gitService
	a.mu.RUnlock()
	return gitService.History(ctx, limit)
}

// GitDiff 返回当前书籍 workspace 的 Git diff。
func (a *App) GitDiff(ctx context.Context, path string) (string, error) {
	a.mu.RLock()
	gitService := a.gitService
	a.mu.RUnlock()
	return gitService.Diff(ctx, path)
}

// InitGit 初始化当前书籍 workspace 的 Git 仓库。
func (a *App) InitGit(ctx context.Context) (book.GitCommandResult, error) {
	a.mu.RLock()
	gitService := a.gitService
	a.mu.RUnlock()
	return gitService.Init(ctx)
}

// CreateGitVersion 创建一个书籍版本。
func (a *App) CreateGitVersion(ctx context.Context, message string) (book.GitCommandResult, error) {
	a.mu.RLock()
	gitService := a.gitService
	a.mu.RUnlock()
	return gitService.CreateVersion(ctx, message)
}

// RollbackGitVersion 将整本书回滚到指定版本。
func (a *App) RollbackGitVersion(ctx context.Context, hash string) (book.GitCommandResult, error) {
	a.mu.RLock()
	gitService := a.gitService
	a.mu.RUnlock()
	return gitService.Rollback(ctx, hash)
}

// StashGitChanges 暂存当前未提交内容。
func (a *App) StashGitChanges(ctx context.Context) (book.GitCommandResult, error) {
	a.mu.RLock()
	gitService := a.gitService
	a.mu.RUnlock()
	return gitService.Stash(ctx)
}

// PopGitStash 恢复最近一次暂存内容。
func (a *App) PopGitStash(ctx context.Context) (book.GitCommandResult, error) {
	a.mu.RLock()
	gitService := a.gitService
	a.mu.RUnlock()
	return gitService.PopStash(ctx)
}

// RunGitCommand 执行受限 Git 命令。
func (a *App) RunGitCommand(ctx context.Context, input string) (book.GitCommandResult, error) {
	a.mu.RLock()
	gitService := a.gitService
	a.mu.RUnlock()
	return gitService.RunCommand(ctx, input)
}

// ClearSession 为当前会话追加上下文清理标记。
func (a *App) ClearSession() error {
	a.mu.RLock()
	sess := a.session
	a.mu.RUnlock()
	return sess.Clear()
}

// Sessions 返回当前 workspace 下的会话列表。
func (a *App) Sessions() ([]session.SessionMeta, error) {
	a.mu.RLock()
	store := a.sessionStore
	activeID := a.session.ID
	a.mu.RUnlock()
	return store.List(activeID)
}

// CreateSession 新建会话并设置为当前激活会话。
func (a *App) CreateSession(title string) (*session.Session, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.abortActiveTaskLocked()

	sess, err := a.sessionStore.Create(title)
	if err != nil {
		return nil, err
	}
	if err := a.sessionStore.SetActiveID(sess.ID); err != nil {
		return nil, err
	}
	a.session = sess
	a.activeTask = nil
	return sess, nil
}

// SwitchSession 切换当前激活会话。
func (a *App) SwitchSession(id string) (*session.Session, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.abortActiveTaskLocked()

	sess, err := a.sessionStore.Get(id)
	if err != nil {
		return nil, err
	}
	if err := a.sessionStore.SetActiveID(sess.ID); err != nil {
		return nil, err
	}
	a.session = sess
	a.activeTask = nil
	return sess, nil
}

// RenameSession 修改会话标题。
func (a *App) RenameSession(id, title string) error {
	a.mu.RLock()
	store := a.sessionStore
	a.mu.RUnlock()
	return store.Rename(id, title)
}

// DeleteSession 删除会话；删除当前会话后自动切换到剩余最近会话。
func (a *App) DeleteSession(id string) (*session.Session, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	wasActive := a.session != nil && a.session.ID == id
	if wasActive {
		a.abortActiveTaskLocked()
	}
	if err := a.sessionStore.Delete(id); err != nil {
		return nil, err
	}
	activeID := ""
	if !wasActive && a.session != nil {
		activeID = a.session.ID
	}
	if activeID == "" {
		metas, err := a.sessionStore.List("")
		if err != nil {
			return nil, err
		}
		if len(metas) == 0 {
			sess, createErr := a.sessionStore.GetOrCreate("default")
			if createErr != nil {
				return nil, createErr
			}
			a.session = sess
			activeID = sess.ID
		} else {
			activeID = metas[0].ID
		}
	}
	sess, err := a.sessionStore.GetOrCreate(activeID)
	if err != nil {
		return nil, err
	}
	if err := a.sessionStore.SetActiveID(sess.ID); err != nil {
		return nil, err
	}
	a.session = sess
	if wasActive {
		a.activeTask = nil
	}
	return sess, nil
}

// SessionMessages 返回指定会话或当前会话的完整历史。
func (a *App) SessionMessages(id string) ([]session.HistoryEntry, error) {
	a.mu.RLock()
	store := a.sessionStore
	current := a.session
	a.mu.RUnlock()
	if id == "" {
		return current.History(), nil
	}
	sess, err := store.Get(id)
	if err != nil {
		return nil, err
	}
	return sess.History(), nil
}

// StartTask 启动后台 Agent 任务。如果有正在运行的任务，先终止它。
func (a *App) StartTask(req agent.ChatRequest) *Task {
	a.mu.Lock()
	if a.activeTask != nil && a.activeTask.Status() == TaskRunning {
		log.Printf("[agent-task] replace running task id=%s", a.activeTask.ID())
		a.activeTask.Abort()
	}

	runner := a.agentRunner
	sess := a.session
	bookService := a.bookService
	chatService := a.chatService
	a.mu.Unlock()

	task := NewTask(func(ctx context.Context, task *Task, emit func(agent.Event)) {
		log.Printf("[agent-task] run begin id=%s message_len=%d references=%d style_references=%d selections=%d plan_mode=%v", task.ID(), len(req.Message), len(req.References), len(req.StyleReferences), len(req.Selections), req.PlanMode)
		chatService.Run(ctx, runner, sess, bookService, req, emit)
		log.Printf("[agent-task] run end id=%s status=%s", task.ID(), task.Status())
	})

	a.mu.Lock()
	a.activeTask = task
	a.mu.Unlock()

	return task
}

func (a *App) abortActiveTaskLocked() {
	if a.activeTask != nil && a.activeTask.Status() == TaskRunning {
		log.Printf("[agent-task] abort due to session switch/delete id=%s", a.activeTask.ID())
		a.activeTask.Abort()
	}
}

// ActiveTask 返回当前活跃任务（可能为 nil）。
func (a *App) ActiveTask() *Task {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.activeTask
}

// AbortTask 终止当前活跃任务。
func (a *App) AbortTask() {
	a.mu.RLock()
	task := a.activeTask
	a.mu.RUnlock()
	if task != nil {
		task.Abort()
	}
}

// Status 返回当前作品状态摘要。
func (a *App) Status() (bool, string) {
	a.mu.RLock()
	state := a.bookState
	a.mu.RUnlock()
	if state == nil {
		return false, ""
	}
	return state.HasState(), state.CompactContext()
}

// Settings 返回当前生效的分层配置快照。
func (a *App) Settings() (config.LayeredSettings, error) {
	a.mu.RLock()
	workspace := a.workspace
	novaDir := ""
	if a.cfg != nil {
		novaDir = a.cfg.NovaDir
	}
	a.mu.RUnlock()
	return config.LoadLayered(novaDir, workspace)
}

// UpdateUserSettings 持久化用户级配置并返回最新分层快照。
func (a *App) UpdateUserSettings(s config.Settings) (config.LayeredSettings, error) {
	a.mu.RLock()
	novaDir := ""
	if a.cfg != nil {
		novaDir = a.cfg.NovaDir
	}
	a.mu.RUnlock()
	if err := config.WriteSettingsFile(config.UserConfigPath(novaDir), s); err != nil {
		return config.LayeredSettings{}, err
	}
	return a.Settings()
}

// UpdateWorkspaceSettings 持久化当前工作区配置并返回最新分层快照。
func (a *App) UpdateWorkspaceSettings(s config.Settings) (config.LayeredSettings, error) {
	a.mu.RLock()
	workspace := a.workspace
	a.mu.RUnlock()
	if workspace == "" {
		return config.LayeredSettings{}, fmt.Errorf("当前没有打开的工作区")
	}
	if err := config.WriteSettingsFile(config.WorkspaceConfigPath(workspace), s); err != nil {
		return config.LayeredSettings{}, err
	}
	return a.Settings()
}

type runtimeState struct {
	workspace    string
	bookState    *book.State
	bookService  *book.Service
	sessionStore *session.Store
	session      *session.Session
	agentRunner  *adk.Runner
	gitService   *book.GitService
}

func buildRuntime(ctx context.Context, cfg *config.Config, workspace string) (*runtimeState, error) {
	absWorkspace, err := filepath.Abs(workspace)
	if err != nil {
		return nil, fmt.Errorf("解析工作目录失败: %w", err)
	}

	state := book.NewState(absWorkspace)
	if err := state.InitWorkspace(); err != nil {
		return nil, fmt.Errorf("初始化工作目录失败: %w", err)
	}

	store, err := session.NewStore(state.SessionDir())
	if err != nil {
		return nil, fmt.Errorf("创建会话存储失败: %w", err)
	}
	sess, err := store.GetActiveOrCreate()
	if err != nil {
		return nil, fmt.Errorf("创建会话失败: %w", err)
	}

	runtimeCfg := *cfg
	runtimeCfg.Workspace = absWorkspace
	builtAgent, err := agent.Build(ctx, &runtimeCfg, state)
	if err != nil {
		return nil, fmt.Errorf("构建 Agent 失败: %w", err)
	}

	return &runtimeState{
		workspace:    absWorkspace,
		bookState:    state,
		bookService:  book.NewService(absWorkspace),
		sessionStore: store,
		session:      sess,
		agentRunner:  agent.NewRunner(ctx, builtAgent),
		gitService:   book.NewGitService(absWorkspace),
	}, nil
}

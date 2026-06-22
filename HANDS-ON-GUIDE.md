# Nova 实战指南

> 基于 `alfredxw/nova` v0.1.12 部署及使用经验总结

---

## 目录

1. [部署避坑](#1-部署避坑)
2. [快速启动](#2-快速启动)
3. [启动一本新书](#3-启动一本新书)
4. [日常创作流程](#4-日常创作流程)
5. [常见问题](#5-常见问题)

---

## 1. 部署避坑

### 1.1 配置文件：TOML 字符串必须加引号

Nova 使用 TOML 作为配置文件，**字符串值必须用双引号包裹**，否则解析器会丢弃该字段。

```toml
# ✅ 正确
openai_api_key = "sk-xxxxxxxxxxxxxxxxxxx"
openai_base_url = "http://192.168.100.4:8030/v1"
openai_model = "deepseek-v4-flash"

# ❌ 错误 — 裸字符串会被忽略
openai_api_key = sk-xxxxxxxxxxxxxxxxxxx
```

**写入技巧**：通过 SSH heredoc 写入时 shell 会吞掉引号，建议用 base64 或 Python 写入：

```bash
python3 -c "
import base64
content = '''openai_api_key = \"sk-xxx...\"
openai_base_url = \"http://host:8030/v1\"
openai_model = \"deepseek-v4-flash\"
'''
with open('/path/to/config.toml', 'w') as f:
    f.write(content)
"
```

### 1.2 Base URL 必须带 `/v1` 前缀

如果 Nova 通过 OpenAI 兼容代理（如 [new-api](https://github.com/Calcium-Ion/new-api)）调用模型，**`openai_base_url` 必须包含 `/v1`**。

原因是 eino 库的 OpenAI ChatModel client 会拼接路径：`baseURL + "/chat/completions"`，如果不带 `/v1`，请求会走到代理的 `/chat/completions` 路由（返回空内容而非模型响应），而不是正确的 `/v1/chat/completions`。

```toml
# ✅ 正确
openai_base_url = "http://192.168.100.4:8030/v1"

# ❌ 错误 — Nova 发请求到 /chat/completions，代理秒回空
openai_base_url = "http://192.168.100.4:8030"
```

### 1.3 配置优先级（容易混淆）

Nova 的配置按以下优先级加载（高覆盖低）：

```
环境变量 > 工作区级配置 > 用户级配置 > 全局 config.toml > 内置默认值
```

- **全局 config.toml**：放在可执行文件旁
- **工作区级配置**：`<workspace>/.nova/config.toml`（UI 设置页保存到这里）
- **环境变量**：`OPENAI_API_KEY` 始终最高优先级

如果你在 UI 设置页修改了参数，它会写入工作区级配置，**覆盖**全局 config.toml 中的值。如果遇到配置不生效，检查：

```bash
cat /path/to/workspace/.nova/config.toml
```

### 1.4 工作区基础设施（Agent 启动的必要条件）

Agent 检测到缺少以下文件/目录时会直接跳过 LLM 调用（7ms 空跑），不发任何请求：

```
workspace/
├── CREATOR.md                    # 创作者指令（Nova 自动生成模板）
├── ideas.md                      # 创作灵感（Nova 自动生成模板）
├── chapters/                     # 章节目录（至少为空）
├── setting/
│   ├── progress.md               # 进度追踪
│   ├── outline.md                # 大纲
│   ├── character-states.md       # 角色状态
│   └── chapter-groups/           # 细纲目录
├── .nova/
│   ├── lore/items.json           # 资料库（Nova 自动初始化）
│   ├── config.toml               # 工作区配置
│   └── ...其他自动生成目录
```

创建命令：

```bash
mkdir -p chapters setting setting/chapter-groups drafts
touch chapters/.gitkeep setting/chapter-groups/.gitkeep
```

`ideas.md` 和 `CREATOR.md` 会在 Nova 启动时自动生成模板（如果不存在）。

---

## 2. 快速启动

### 2.1 编译运行

```bash
git clone https://github.com/alfredxw/nova.git
cd nova

# 需要 Go 1.26+, Node 20+, pnpm
export PATH=/usr/local/go/bin:$PATH
bash build.sh

# 运行
cd output
./nova --port 8020 --workspace /path/to/workspace --no-open
```

访问 `http://localhost:8020`。

### 2.2 配置 Model

编辑 `config.toml`：

```toml
openai_api_key = "sk-xxx"
openai_base_url = "http://your-proxy:8030/v1"
openai_model = "deepseek-v4-flash"
```

也可以在环境变量中配置（优先级最高）：

```bash
export OPENAI_API_KEY="sk-xxx"
export OPENAI_BASE_URL="http://your-proxy:8030/v1"
export OPENAI_MODEL="deepseek-v4-flash"
```

### 2.3 常用启动参数

```
-port string         HTTP 端口 (default "8080")
-workspace string    作品工作目录
-no-open             启动后不打开浏览器
-frontend-port       前端开发端口 (default "8081")
-dev                 开发模式（同时启动 Vite dev server）
```

---

## 3. 启动一本新书

### 3.1 准备工作区

Nova 启动后，浏览器打开 UI，进入**书籍管理**创建一个新项目。或者手动创建目录结构后启动：

```bash
mkdir -p my-novel/chapters my-novel/setting/chapter-groups
./nova --workspace /path/to/my-novel
```

### 3.2 对话引导模式（推荐）

在 UI 的聊天面板中发送：

```
请读取 ideas.md 和 CREATOR.md，通过对话梳理灵感、题材、冲突、世界观、人设和写作规则；
信息不足时先追问，阶段性结论更新到 ideas.md。
暂时不要创建大纲、章节或写入资料库。
```

Nova 会按以下流程推进：

```
① 读取 ideas.md / CREATOR.md → 了解已有设定
② 逐项讨论：基调 → 战斗体系 → 视角 → 世界观深度 → 角色关系
③ 用户确认后更新 ideas.md
④ 生成完整大纲 → 写入 setting/outline.md
⑤ 生成角色设定 → 写入 setting/character-states.md + 资料库
⑥ 生成细纲 → 写入 setting/chapter-groups/
⑦ 生成章节正文 → 写入 chapters/
```

### 3.3 全权委托模式

如果你希望 Nova 自行决策所有问题，不做逐项确认：

```
基调我认可。以下所有问题你自行决策，全部放权：
战斗体系、凡人视角、天庭架构、角色关系、科技感程度。
逐一决策后写入 ideas.md，
然后生成大纲 → 角色设定 → 细纲 → 前三章正文。
每步完成后输出进度 summary 给我看即可，不需要问我意见。
```

### 3.4 Nova 的提示词核心逻辑

Nova 的系统提示词（硬编码在 `internal/prompts/system.go`）定义了 Agent 的行为规范，其中有几条关键指令：

1. **启动新书**时，先 `read_file ideas.md` 和 `CREATOR.md`，与作者讨论补全创作灵感
2. **阶段性结论**写回 `ideas.md`，待作者确认后再写回 `CREATOR.md`
3. **在作者明确确认之前**，不要直接编造大纲或角色
4. **写正文**时按 `outline.md` → 章节组细纲 → 单章正文的工序推进

这意味着 Agent 天然是**对话驱动**的，你必须先跟它聊设定、确认主题，它才会进入写提纲的阶段。跳过这个环节直接让它"生成第一章"，它会要求先完善设定。

如果你希望快速验证，可以在架构文件和灵感文件都写满之后一次性授权它全权执行（见 [3.3](#33-全权委托模式)）。

---

## 4. 日常创作流程

### 4.1 续写章节

在聊天面板发送：

```
请基于当前大纲、已定稿章节、progress.md 和资料库，续写下一章。
```

Agent 会自动读取最新的创作状态，保持风格连贯地写下去。

### 4.2 修改/重写

```
请重写第三章，从"xxx"开始到"yyy"结束，改成xxxx风格。
```

### 4.3 规划章节组

```
生成下一组细纲，预期覆盖第4-6章。
```

### 4.4 管理资料库

可以在 UI 界面左侧的"资料库"面板直接编辑，也可以通过对话让 Agent 添加。

---

## 5. 常见问题

### Q: Agent 不调用 LLM，日志显示 7ms 就完成了

**原因**：工作区缺少必要目录（`chapters/`、`setting/progress.md` 等），Agent 检测到"没有可操作的内容"直接短路返回。见 [1.4](#14-工作区基础设施agent-启动的必要条件)。

### Q: 返回 401 Invalid Token

**原因**：API key 写入配置时被截断或格式错误。检查：

```bash
# 确认 key 是否完整
grep openai_api_key /path/to/config.toml | wc -c   # 应 >= 60（含字段名）

# 测试代理连通性
curl -X POST http://your-proxy:8030/v1/chat/completions \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"hi"}]}'
```

### Q: Agent 回复了但内容为空

**原因**：Base URL 缺少 `/v1` 前缀。见 [1.2](#12-base-url-必须带-v1-前缀)。

### Q: 在 UI 设置页修改配置后，之前的配置不生效了

**原因**：UI 保存的配置写入工作区级 `<workspace>/.nova/config.toml`，优先级高于全局 `config.toml`。检查该文件的内容，合并或删除冲突项。

### Q: `write_lore_items` 工具报 JSON 解析错误

**原因**：包含中文字符的 JSON 参数在少数情况下会编码异常。Agent 会自动重试，如持续失败可手动在资料库面板添加条目。

---

## 附录：推荐的新书启动话术

### 场景一：有灵感雏形

```
我想写一本以西游后传为背景的小说。
请读取 ideas.md 和 CREATOR.md（如果为空请先告知我），
我们一起讨论设定。先聊题材和整体基调。
```

### 场景二：完全空白，需要引导

```
我有一本新书的灵感，但还没成型。
请引导我完成以下框架：
1. 核心钩子（一句话吸引人）
2. 背景和世界观
3. 主要角色
4. 核心冲突
每步先问我问题，不要替我决定。
```

### 场景三：全权委托（设定已确定）

```
设定已确认，详见 ideas.md 和 CREATOR.md。
请自行决策所有细节，直接输出：
1. 完整大纲 → setting/outline.md
2. 角色设定 → setting/character-states.md
3. 前三章正文 → chapters/
完成后通知我。
```

package interactive

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

type TellerLibrary struct {
	novaDir string
}

type Teller struct {
	ID              string   `json:"id"`
	Name            string   `json:"name"`
	Description     string   `json:"description"`
	RandomEventRate float64  `json:"random_event_rate"`
	Tags            []string `json:"tags"`
	Prompt          string   `json:"prompt,omitempty"`
	Path            string   `json:"path,omitempty"`
	Custom          bool     `json:"custom"`
	Invalid         bool     `json:"invalid,omitempty"`
	Error           string   `json:"error,omitempty"`
}

func NewTellerLibrary(novaDir string) *TellerLibrary {
	return &TellerLibrary{novaDir: novaDir}
}

func (l *TellerLibrary) List() ([]Teller, error) {
	if err := l.ensureBuiltins(); err != nil {
		return nil, err
	}
	files, err := filepath.Glob(filepath.Join(l.dir(), "*.md"))
	if err != nil {
		return nil, err
	}
	tellers := make([]Teller, 0, len(files))
	for _, file := range files {
		teller, err := parseTellerFile(file)
		if err != nil {
			tellers = append(tellers, Teller{
				ID:      strings.TrimSuffix(filepath.Base(file), ".md"),
				Path:    file,
				Invalid: true,
				Error:   err.Error(),
				Custom:  !isBuiltinTellerFile(file),
			})
			continue
		}
		teller.Path = file
		teller.Custom = !isBuiltinTellerFile(file)
		tellers = append(tellers, teller)
	}
	sort.Slice(tellers, func(i, j int) bool {
		return tellers[i].ID < tellers[j].ID
	})
	return tellers, nil
}

func (l *TellerLibrary) Get(id string) (Teller, error) {
	if err := l.ensureBuiltins(); err != nil {
		return Teller{}, err
	}
	if err := validateTellerID(id); err != nil {
		return Teller{}, err
	}
	teller, err := parseTellerFile(filepath.Join(l.dir(), id+".md"))
	if err != nil {
		return Teller{}, err
	}
	teller.Custom = !isBuiltinID(teller.ID)
	return teller, nil
}

func (l *TellerLibrary) dir() string {
	return filepath.Join(l.novaDir, ".nova", "interactive", "story-tellers")
}

func (l *TellerLibrary) ensureBuiltins() error {
	if err := os.MkdirAll(l.dir(), 0o755); err != nil {
		return err
	}
	for id, content := range builtinTellers {
		path := filepath.Join(l.dir(), id+".md")
		if _, err := os.Stat(path); err == nil {
			continue
		}
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			return err
		}
	}
	return nil
}

func parseTellerFile(path string) (Teller, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Teller{}, err
	}
	text := string(data)
	if !strings.HasPrefix(text, "---\n") {
		return Teller{}, fmt.Errorf("缺少 frontmatter")
	}
	rest := strings.TrimPrefix(text, "---\n")
	idx := strings.Index(rest, "\n---\n")
	if idx < 0 {
		return Teller{}, fmt.Errorf("frontmatter 未闭合")
	}
	header := rest[:idx]
	prompt := strings.TrimSpace(rest[idx+len("\n---\n"):])
	teller := Teller{Prompt: prompt}
	for _, line := range strings.Split(header, "\n") {
		key, value, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		switch key {
		case "id":
			teller.ID = value
		case "name":
			teller.Name = value
		case "description":
			teller.Description = value
		case "random_event_rate":
			rate, err := strconv.ParseFloat(value, 64)
			if err != nil {
				return Teller{}, fmt.Errorf("random_event_rate 非法: %w", err)
			}
			teller.RandomEventRate = rate
		case "tags":
			teller.Tags = parseTags(value)
		}
	}
	if teller.ID == "" || teller.Name == "" {
		return Teller{}, fmt.Errorf("讲述者缺少 id 或 name")
	}
	return teller, nil
}

func parseTags(value string) []string {
	value = strings.Trim(value, "[]")
	if strings.TrimSpace(value) == "" {
		return nil
	}
	parts := strings.Split(value, ",")
	tags := make([]string, 0, len(parts))
	for _, part := range parts {
		tag := strings.Trim(strings.TrimSpace(part), `"'`)
		if tag != "" {
			tags = append(tags, tag)
		}
	}
	return tags
}

func validateTellerID(id string) error {
	if strings.TrimSpace(id) == "" {
		return fmt.Errorf("讲述者 ID 不能为空")
	}
	for _, r := range id {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			continue
		}
		return fmt.Errorf("讲述者 ID 包含非法字符: %s", id)
	}
	return nil
}

func isBuiltinTellerFile(path string) bool {
	return isBuiltinID(strings.TrimSuffix(filepath.Base(path), ".md"))
}

func isBuiltinID(id string) bool {
	_, ok := builtinTellers[id]
	return ok
}

var builtinTellers = map[string]string{
	"classic": `---
id: classic
name: 经典叙事者
description: 平衡叙事，节奏稳定，少量随机事件
random_event_rate: 0.15
tags: [通用, 平衡]
---

# 系统提示词
你是一位经典叙事者，注重故事节奏、角色选择与清晰的场景反馈。
`,
	"grimdark": `---
id: grimdark
name: 黑暗低魔
description: 压抑氛围，强调代价、危险与残酷选择
random_event_rate: 0.25
tags: [黑暗, 低魔]
---

# 系统提示词
你是一位黑暗低魔叙事者，偏好艰难抉择、稀缺资源和不可逆后果。
`,
	"lighthearted": `---
id: lighthearted
name: 轻松日常
description: 轻快温暖，偏向日常互动和角色关系
random_event_rate: 0.1
tags: [日常, 轻松]
---

# 系统提示词
你是一位轻松日常叙事者，偏好温暖互动、幽默细节和低压力事件。
`,
}

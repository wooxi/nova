package interactive

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCreateStoryInitializesIndexAndStoryFile(t *testing.T) {
	store := NewStore(t.TempDir())

	story, err := store.CreateStory(CreateStoryRequest{
		Title:         "末日开端",
		Origin:        "主角醒来发现世界已末日",
		StoryTellerID: "grimdark",
	})
	if err != nil {
		t.Fatalf("CreateStory failed: %v", err)
	}

	index, err := store.Index()
	if err != nil {
		t.Fatalf("Index failed: %v", err)
	}
	if index.CurrentStoryID != story.ID {
		t.Fatalf("current story = %q, want %q", index.CurrentStoryID, story.ID)
	}
	if len(index.Stories) != 1 || index.Stories[0].Title != "末日开端" {
		t.Fatalf("unexpected index stories: %+v", index.Stories)
	}

	storyFile := filepath.Join(store.Root(), "interactive", "story", "story-"+story.ID+".jsonl")
	data, err := os.ReadFile(storyFile)
	if err != nil {
		t.Fatalf("story file not created: %v", err)
	}
	assertContains(t, string(data), `"type":"meta"`)
	assertContains(t, string(data), `"current_branch":"main"`)
	assertContains(t, string(data), `"story_teller_id":"grimdark"`)
}

func TestSnapshotAppliesTurnAndStateDelta(t *testing.T) {
	store := NewStore(t.TempDir())
	story, err := store.CreateStory(CreateStoryRequest{
		Title:         "酒馆",
		Origin:        "推门进入酒馆",
		StoryTellerID: "classic",
	})
	if err != nil {
		t.Fatalf("CreateStory failed: %v", err)
	}

	turn, err := store.AppendTurn(story.ID, AppendTurnRequest{
		BranchID:  "main",
		User:      "我推开酒馆的门",
		Narrative: "门轴发出沉闷的吱呀声。",
	})
	if err != nil {
		t.Fatalf("AppendTurn failed: %v", err)
	}
	_, err = store.AppendStateDelta(story.ID, AppendStateDeltaRequest{
		ParentID: turn.ID,
		BranchID: "main",
		Ops: []StateOp{
			{Op: "set", Path: "on_stage", Value: []any{"林川", "酒保老李"}},
			{Op: "merge", Path: "characters.林川", Value: map[string]any{"hp": 80, "location": "黄泉酒馆"}},
			{Op: "push", Path: "events", Value: map[string]any{"flag": "遇到神秘老人"}},
		},
	})
	if err != nil {
		t.Fatalf("AppendStateDelta failed: %v", err)
	}

	snapshot, err := store.Snapshot(story.ID, "main")
	if err != nil {
		t.Fatalf("Snapshot failed: %v", err)
	}
	if len(snapshot.Turns) != 1 || snapshot.Turns[0].Narrative != "门轴发出沉闷的吱呀声。" {
		t.Fatalf("unexpected turns: %+v", snapshot.Turns)
	}
	onStage, ok := snapshot.State["on_stage"].([]any)
	if !ok || len(onStage) != 2 || onStage[0] != "林川" {
		t.Fatalf("unexpected on_stage: %#v", snapshot.State["on_stage"])
	}
	characters := snapshot.State["characters"].(map[string]any)
	linchuan := characters["林川"].(map[string]any)
	if linchuan["location"] != "黄泉酒馆" {
		t.Fatalf("unexpected character state: %#v", linchuan)
	}
	events := snapshot.State["events"].([]any)
	if len(events) != 1 {
		t.Fatalf("unexpected events: %#v", events)
	}
}

func assertContains(t *testing.T, got, want string) {
	t.Helper()
	if !contains(got, want) {
		t.Fatalf("expected %q to contain %q", got, want)
	}
}

func contains(s, substr string) bool {
	return strings.Contains(s, substr)
}

package agents

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/robfig/cron/v3"

	"github.com/go-chi/chi/v5"
)

// StreamCallback is called periodically with accumulated output during streaming.
type StreamCallback func(partial string)

// AgentConfig defines a registered agent and its capabilities.
type AgentConfig struct {
	Name         string        `json:"name"`
	Description  string        `json:"description"`
	Model        string        `json:"model,omitempty"`
	MaxTurns     int           `json:"max_turns,omitempty"`
	Workspace    string        `json:"workspace,omitempty"`    // derived from name prefix (team-research → team)
	ShortName    string        `json:"short_name,omitempty"`   // name without workspace prefix
	Tools        []string      `json:"tools,omitempty"`        // tools/capabilities this agent uses
	EntryPoint   bool          `json:"entry_point"`            // true if invokable by humans/schedules; false if helper sub-agent
	Timeout      time.Duration `json:"-"`
	SystemPrompt string        `json:"-"` // body of the agent .md file
}

// agentConfigJSON is the JSON wire format for AgentConfig (timeout as integer seconds).
type agentConfigJSON struct {
	Name           string   `json:"name"`
	Description    string   `json:"description"`
	Model          string   `json:"model,omitempty"`
	MaxTurns       int      `json:"max_turns,omitempty"`
	Workspace      string   `json:"workspace,omitempty"`
	ShortName      string   `json:"short_name,omitempty"`
	Tools          []string `json:"tools,omitempty"`
	EntryPoint     bool     `json:"entry_point"`
	TimeoutSeconds int      `json:"timeout_seconds,omitempty"`
}

func (a AgentConfig) MarshalJSON() ([]byte, error) {
	return json.Marshal(agentConfigJSON{
		Name:           a.Name,
		Description:    a.Description,
		Model:          a.Model,
		MaxTurns:       a.MaxTurns,
		Workspace:      a.Workspace,
		ShortName:      a.ShortName,
		Tools:          a.Tools,
		EntryPoint:     a.EntryPoint,
		TimeoutSeconds: int(a.Timeout.Seconds()),
	})
}

// Session represents an active agent conversation tied to a Slack thread.
type Session struct {
	ClaudeSessionID string    `json:"claude_session_id"` // Claude --resume ID
	AgentID         string    `json:"agent_id"`
	SlackThreadTS   string    `json:"slack_thread_ts"`   // Slack thread timestamp (unique per thread)
	SlackChannel    string    `json:"slack_channel"`
	LastUsed        time.Time `json:"last_used"`
}

// claudeResult is the JSON output from `claude --output-format json`.
type claudeResult struct {
	Type      string `json:"type"`
	Subtype   string `json:"subtype"`
	Result    string `json:"result"`
	IsError   bool   `json:"is_error"`
	SessionID string `json:"session_id"`
}

// Schedule represents a scheduled agent run.
type Schedule struct {
	ID       string       `json:"id"`
	AgentID  string       `json:"agent_id"`
	Cron     string       `json:"cron"`
	Prompt   string       `json:"prompt"`
	SlackCh  string       `json:"slack_channel,omitempty"`
	Timezone string       `json:"timezone,omitempty"`
	Status   string       `json:"status"`
	EntryID  cron.EntryID `json:"-"` // cron scheduler entry
}

// SlackPoster is a function that posts a message to a Slack channel.
type SlackPoster func(channel, text string) error

// SlackPosterTS posts a message and returns the channel ID and message timestamp for threading.
type SlackPosterTS func(channel, text string) (channelID, ts string, err error)

// SlackUpdater updates an existing Slack message in place.
type SlackUpdater func(channel, ts, text string)

// schedulePersisted is the on-disk representation of a schedule (no cron EntryID).
type schedulePersisted struct {
	ID       string `json:"id"`
	AgentID  string `json:"agent_id"`
	Cron     string `json:"cron"`
	Prompt   string `json:"prompt"`
	SlackCh  string `json:"slack_channel,omitempty"`
	Timezone string `json:"timezone,omitempty"`
	Status   string `json:"status"`
}

var scheduleFile = filepath.Join(os.Getenv("HOME"), ".config", "winston", "schedules.json")
var sessionFile = filepath.Join(os.Getenv("HOME"), ".config", "winston", "sessions.json")

// SlackThreadStarter posts a message and returns (channelID, messageTS, error).
type SlackThreadStarter func(channel, text string) (channelID, ts string, err error)

// SlackThreadReplier posts a reply inside an existing thread.
type SlackThreadReplier func(channelID, threadTS, text string) error

// Manager handles agent lifecycle and routing.
type Manager struct {
	mu               sync.RWMutex
	agents           map[string]*AgentConfig
	sessions         map[string]*Session // key: slackThreadTS
	schedules        map[string]*Schedule
	cron             *cron.Cron
	schedCount       int
	SlackPost        SlackPoster
	SlackPostTS      SlackThreadStarter
	SlackThreadReply SlackThreadReplier
	SlackOwnerID     string // Slack user ID to tag on scheduled results
}

func NewManager() *Manager {
	c := cron.New()
	c.Start()

	m := &Manager{
		agents:    make(map[string]*AgentConfig),
		sessions:  make(map[string]*Session),
		schedules: make(map[string]*Schedule),
		cron:      c,
	}

	// Load agents from ~/.claude/agents/*.md (the standard Claude Code agent directory).
	agentsDir := filepath.Join(os.Getenv("HOME"), ".claude", "agents")
	entries, err := os.ReadDir(agentsDir)
	if err != nil {
		log.Printf("[agents] warning: could not read %s: %v", agentsDir, err)
	} else {
		for _, e := range entries {
			if e.IsDir() || !strings.HasSuffix(e.Name(), ".md") {
				continue
			}
			cfg, err := parseAgentFile(filepath.Join(agentsDir, e.Name()))
			if err != nil {
				log.Printf("[agents] skipping %s: %v", e.Name(), err)
				continue
			}
			m.agents[cfg.Name] = cfg
			log.Printf("[agents] loaded %s (model=%s)", cfg.Name, cfg.Model)
		}
	}

	log.Printf("[agents] %d agent(s) ready", len(m.agents))

	m.loadSchedules()
	m.loadSessions()

	return m
}

// parseAgentFile reads a Claude Code agent .md file (YAML frontmatter + body).
func parseAgentFile(path string) (*AgentConfig, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	content := string(data)
	if !strings.HasPrefix(content, "---") {
		return nil, fmt.Errorf("missing frontmatter")
	}
	parts := strings.SplitN(content[3:], "---", 2)
	if len(parts) < 2 {
		return nil, fmt.Errorf("malformed frontmatter")
	}

	cfg := &AgentConfig{EntryPoint: true} // default: treat untagged agents as entry points
	for _, line := range strings.Split(parts[0], "\n") {
		k, v, ok := strings.Cut(strings.TrimSpace(line), ":")
		if !ok {
			continue
		}
		switch strings.TrimSpace(k) {
		case "name":
			cfg.Name = strings.TrimSpace(v)
		case "description":
			cfg.Description = strings.TrimSpace(v)
		case "model":
			cfg.Model = strings.TrimSpace(v)
		case "timeout":
			secs, err := strconv.Atoi(strings.TrimSpace(v))
			if err == nil && secs > 0 {
				cfg.Timeout = time.Duration(secs) * time.Second
			}
		case "max_turns":
			n, err := strconv.Atoi(strings.TrimSpace(v))
			if err == nil && n > 0 {
				cfg.MaxTurns = n
			}
		case "entry_point":
			switch strings.ToLower(strings.TrimSpace(v)) {
			case "false", "no", "0":
				cfg.EntryPoint = false
			case "true", "yes", "1":
				cfg.EntryPoint = true
			}
		}
	}
	if cfg.Name == "" {
		return nil, fmt.Errorf("missing 'name' in frontmatter")
	}
	if cfg.Model == "" {
		cfg.Model = "sonnet"
	}
	if cfg.Timeout == 0 {
		cfg.Timeout = 600 * time.Second
	}
	if cfg.MaxTurns == 0 {
		cfg.MaxTurns = 50
	}
	cfg.SystemPrompt = strings.TrimSpace(parts[1])

	// Derive workspace from name prefix (team-research → workspace "team", short_name "research")
	if i := strings.Index(cfg.Name, "-"); i > 0 {
		cfg.Workspace = cfg.Name[:i]
		cfg.ShortName = cfg.Name[i+1:]
	} else {
		cfg.ShortName = cfg.Name
	}

	// Auto-detect tools from system prompt
	cfg.Tools = detectTools(cfg.SystemPrompt)

	return cfg, nil
}

// detectTools scans a system prompt for known tool/capability references.
func detectTools(prompt string) []string {
	lower := strings.ToLower(prompt)
	var tools []string
	seen := map[string]bool{}

	patterns := []struct {
		keywords []string
		label    string
	}{
		{[]string{"websearch", "web search", "web_search"}, "Web Search"},
		{[]string{"webfetch", "web fetch", "web_fetch"}, "Web Fetch"},
		{[]string{"git ", "github", "git push", "git pull"}, "Git"},
		{[]string{"figma"}, "Figma"},
		{[]string{"gmail", "google-workspace", "google workspace"}, "Google Workspace"},
		{[]string{"slack"}, "Slack"},
		{[]string{"yt-dlp", "youtube-trends", "transcript"}, "YouTube Data"},
		{[]string{"gemini", "nanobanana", "nano banana", "image generation", "image-generation"}, "Image Gen"},
		{[]string{"playwright"}, "Playwright"},
		{[]string{"kali", "nmap", "metasploit", "burp"}, "Security Tools"},
		{[]string{"remotion"}, "Remotion"},
		{[]string{"manim"}, "Manim"},
		{[]string{"google-trends", "google trends", "reddit-trends", "reddit trends"}, "Trend Analysis"},
		{[]string{"spawn", "sub-agent", "subagent", "parallel"}, "Sub-Agents"},
		{[]string{"cron", "schedule"}, "Scheduling"},
	}

	for _, p := range patterns {
		for _, kw := range p.keywords {
			if strings.Contains(lower, kw) && !seen[p.label] {
				tools = append(tools, p.label)
				seen[p.label] = true
				break
			}
		}
	}
	return tools
}

// HasAgent checks if an agent is registered.
func (m *Manager) HasAgent(name string) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	_, ok := m.agents[name]
	return ok
}

// AgentNames returns the names of all registered agents.
func (m *Manager) AgentNames() []string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	names := make([]string, 0, len(m.agents))
	for n := range m.agents {
		names = append(names, n)
	}
	return names
}

// Status returns a snapshot of agent, session, and schedule counts.
func (m *Manager) Status() (agents int, sessions int, schedules int) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	active := 0
	for _, s := range m.schedules {
		if s.Status == "active" {
			active++
		}
	}
	return len(m.agents), len(m.sessions), active
}

// SpawnAgent starts a new session for the given agent and prompt.
// Returns the response text and the Slack thread TS to use as session key.
func (m *Manager) SpawnAgent(agentName, prompt string) (string, error) {
	m.mu.RLock()
	agent, ok := m.agents[agentName]
	m.mu.RUnlock()
	if !ok {
		return "", fmt.Errorf("agent %q not found", agentName)
	}
	result, err := m.runClaude(context.Background(), agent, prompt, "", nil)
	if err != nil {
		return "", err
	}
	return result.Result, nil
}

// SpawnAgentInThread starts a new session tied to a Slack thread.
// Stores the session so follow-up messages in the thread resume it.
func (m *Manager) SpawnAgentInThread(agentName, prompt, channel, threadTS string) (string, error) {
	m.mu.RLock()
	agent, ok := m.agents[agentName]
	m.mu.RUnlock()
	if !ok {
		return "", fmt.Errorf("agent %q not found", agentName)
	}

	result, err := m.runClaude(context.Background(), agent, prompt, "", threadEnv(channel, threadTS))
	if err != nil {
		return "", err
	}
	if result == nil {
		return "", fmt.Errorf("agent returned no result")
	}

	// Store the session keyed by Slack thread TS
	m.mu.Lock()
	m.sessions[threadTS] = &Session{
		ClaudeSessionID: result.SessionID,
		AgentID:         agentName,
		SlackThreadTS:   threadTS,
		SlackChannel:    channel,
		LastUsed:        time.Now(),
	}
	m.saveSessions()
	m.mu.Unlock()

	return result.Result, nil
}

// SpawnAgentInThreadStreaming starts a new session tied to a Slack thread,
// calling onUpdate with partial output as it streams in.
func (m *Manager) SpawnAgentInThreadStreaming(agentName, prompt, channel, threadTS string, onUpdate StreamCallback) (string, error) {
	m.mu.RLock()
	agent, ok := m.agents[agentName]
	m.mu.RUnlock()
	if !ok {
		return "", fmt.Errorf("agent %q not found", agentName)
	}

	// Record the session stub so that follow-up thread messages can respond
	// even if the first run fails (they'll start a fresh conversation with the same agent).
	m.mu.Lock()
	m.sessions[threadTS] = &Session{
		ClaudeSessionID: "", // filled in after a successful run
		AgentID:         agentName,
		SlackThreadTS:   threadTS,
		SlackChannel:    channel,
		LastUsed:        time.Now(),
	}
	m.mu.Unlock()

	result, err := m.runClaudeStreaming(context.Background(), agent, prompt, "", threadEnv(channel, threadTS), onUpdate)
	if err != nil {
		return "", err
	}
	if result == nil {
		return "", fmt.Errorf("agent returned no result")
	}

	// Update session with the real Claude session ID.
	m.mu.Lock()
	m.sessions[threadTS].ClaudeSessionID = result.SessionID
	m.sessions[threadTS].LastUsed = time.Now()
	m.saveSessions()
	m.mu.Unlock()

	return result.Result, nil
}

// ContinueThread resumes an existing Claude session for a Slack thread reply.
func (m *Manager) ContinueThread(threadTS, message string) (string, bool, error) {
	m.mu.RLock()
	session, ok := m.sessions[threadTS]
	m.mu.RUnlock()
	if !ok {
		return "", false, nil // no session — caller should handle
	}

	m.mu.RLock()
	agent := m.agents[session.AgentID]
	m.mu.RUnlock()

	log.Printf("[agents] continuing session thread=%s agent=%s claude_session=%s", threadTS, session.AgentID, session.ClaudeSessionID)

	result, err := m.runClaude(context.Background(), agent, message, session.ClaudeSessionID, threadEnv(session.SlackChannel, threadTS))
	if err != nil {
		return "", true, err
	}
	if result == nil {
		return "", true, fmt.Errorf("agent returned no result")
	}

	// Update session with new Claude session ID and last used time
	m.mu.Lock()
	session.ClaudeSessionID = result.SessionID
	session.LastUsed = time.Now()
	m.saveSessions()
	m.mu.Unlock()

	return result.Result, true, nil
}

// ContinueThreadStreaming resumes an existing Claude session with streaming output.
func (m *Manager) ContinueThreadStreaming(threadTS, message string, onUpdate StreamCallback) (string, bool, error) {
	m.mu.RLock()
	session, ok := m.sessions[threadTS]
	m.mu.RUnlock()
	if !ok {
		return "", false, nil
	}

	m.mu.RLock()
	agent := m.agents[session.AgentID]
	m.mu.RUnlock()

	log.Printf("[agents] continuing session (streaming) thread=%s agent=%s claude_session=%s", threadTS, session.AgentID, session.ClaudeSessionID)

	result, err := m.runClaudeStreaming(context.Background(), agent, message, session.ClaudeSessionID, threadEnv(session.SlackChannel, threadTS), onUpdate)
	if err != nil {
		return "", true, err
	}
	if result == nil {
		return "", true, fmt.Errorf("agent returned no result")
	}

	m.mu.Lock()
	session.ClaudeSessionID = result.SessionID
	session.LastUsed = time.Now()
	m.saveSessions()
	m.mu.Unlock()

	return result.Result, true, nil
}

// buildClaudeArgs constructs the common CLI arguments for a claude invocation.
func buildClaudeArgs(agent *AgentConfig, prompt, resumeID, outputFormat string) ([]string, string) {
	model := agent.Model
	if model == "" {
		model = "sonnet"
	}
	prompt, model = parseModelOverride(prompt, model)

	args := []string{
		"--print",
		"--output-format", outputFormat,
		"--dangerously-skip-permissions",
		"--model", model,
		"--max-turns", strconv.Itoa(agent.MaxTurns),
	}

	if resumeID != "" {
		args = append(args, "--resume", resumeID)
	} else {
		// Use --agent to load the .md file directly (avoids huge --system-prompt CLI args)
		agentFile := filepath.Join(os.Getenv("HOME"), ".claude", "agents", agent.Name+".md")
		if _, err := os.Stat(agentFile); err == nil {
			args = append(args, "--agent", agent.Name)
		} else if agent.SystemPrompt != "" {
			args = append(args, "--system-prompt", agent.SystemPrompt)
		}
	}

	args = append(args, prompt)
	return args, model
}

// newClaudeCmd creates an exec.Cmd for claude with stdin closed and its own process group,
// so we can kill the entire tree on timeout. extraEnv entries (KEY=VALUE) are appended
// to the inherited environment.
func newClaudeCmd(ctx context.Context, args []string, extraEnv []string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, "claude", args...)
	cmd.Dir = os.Getenv("HOME")
	// Own process group so we can kill claude + all children on timeout.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Stdin = nil
	if len(extraEnv) > 0 {
		cmd.Env = append(os.Environ(), extraEnv...)
	}
	return cmd
}

// threadEnv returns the WINSTON_THREAD_* env vars an agent uses to thread its
// own Slack posts under the originating message. Returns nil when the agent is
// not running in a Slack thread context.
func threadEnv(channel, threadTS string) []string {
	if threadTS == "" {
		return nil
	}
	return []string{
		"WINSTON_THREAD_CHANNEL=" + channel,
		"WINSTON_THREAD_TS=" + threadTS,
	}
}

// killProcessGroup sends SIGKILL to the entire process group.
func killProcessGroup(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	pgid, err := syscall.Getpgid(cmd.Process.Pid)
	if err == nil {
		syscall.Kill(-pgid, syscall.SIGKILL)
	}
}

// runClaude executes the claude CLI and returns structured output.
// If resumeID is non-empty, resumes that session.
func (m *Manager) runClaude(ctx context.Context, agent *AgentConfig, prompt, resumeID string, extraEnv []string) (*claudeResult, error) {
	args, _ := buildClaudeArgs(agent, prompt, resumeID, "json")

	ctx, cancel := context.WithTimeout(ctx, agent.Timeout)
	defer cancel()

	cmd := newClaudeCmd(ctx, args, extraEnv)

	output, err := cmd.CombinedOutput()
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			killProcessGroup(cmd)
			return nil, fmt.Errorf("agent %s timed out after %s", agent.Name, agent.Timeout)
		}
		return nil, fmt.Errorf("agent %s failed: %w\noutput: %s", agent.Name, err, string(output))
	}

	var result claudeResult
	if err := json.Unmarshal(output, &result); err != nil {
		return &claudeResult{Result: string(output)}, nil
	}

	if result.IsError {
		return nil, fmt.Errorf("agent error: %s", result.Result)
	}

	return &result, nil
}

// runClaudeStreaming executes the claude CLI with streaming output, calling onUpdate
// periodically (at most every 2 seconds) with accumulated output.
// At the end, it parses the final JSON result just like runClaude.
func (m *Manager) runClaudeStreaming(ctx context.Context, agent *AgentConfig, prompt, resumeID string, extraEnv []string, onUpdate StreamCallback) (*claudeResult, error) {
	args, _ := buildClaudeArgs(agent, prompt, resumeID, "stream-json")
	// Insert --verbose after --print for streaming
	for i, a := range args {
		if a == "--print" {
			args = append(args[:i+1], append([]string{"--verbose"}, args[i+1:]...)...)
			break
		}
	}

	cmd := newClaudeCmd(ctx, args, extraEnv)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("agent %s pipe failed: %w", agent.Name, err)
	}
	var stderrBuf strings.Builder
	cmd.Stderr = &stderrBuf

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("agent %s start failed: %w", agent.Name, err)
	}

	// Read output line by line, accumulating text and throttling callback.
	// We track both the final text output and a status line showing tool activity.
	var accumulated strings.Builder
	var toolStatus string // current tool activity status line
	var lastResult claudeResult
	hasResult := false

	scanner := bufio.NewScanner(stdout)
	// Allow large lines (up to 1MB)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)

	lastUpdate := time.Time{}
	throttle := 2 * time.Second

	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			continue
		}

		// Parse the stream-json event — assistant events have nested message.content[]
		var envelope struct {
			Type    string          `json:"type"`
			Message json.RawMessage `json:"message"`
			// flat fields for result events
			Subtype   string `json:"subtype"`
			Result    string `json:"result"`
			IsError   bool   `json:"is_error"`
			SessionID string `json:"session_id"`
		}

		if err := json.Unmarshal([]byte(line), &envelope); err != nil {
			accumulated.WriteString(line)
			accumulated.WriteString("\n")
		} else {
			switch envelope.Type {
			case "assistant":
				// Parse the nested message to extract content blocks
				var msg struct {
					Content []struct {
						Type  string          `json:"type"`
						Text  string          `json:"text"`
						Name  string          `json:"name"`
						Input json.RawMessage `json:"input"`
					} `json:"content"`
				}
				if err := json.Unmarshal(envelope.Message, &msg); err == nil {
					for _, block := range msg.Content {
						switch block.Type {
						case "text":
							if block.Text != "" {
								toolStatus = "" // clear status once text flows
								accumulated.WriteString(block.Text)
							}
						case "tool_use":
							toolStatus = formatToolStatus(block.Name, block.Input)
						}
					}
				}
			case "result":
				lastResult = claudeResult{
					Type:      envelope.Type,
					Subtype:   envelope.Subtype,
					Result:    envelope.Result,
					IsError:   envelope.IsError,
					SessionID: envelope.SessionID,
				}
				hasResult = true
				continue
			default:
				continue
			}
		}

		// Throttled callback — append tool status if the agent is working
		if onUpdate != nil && time.Since(lastUpdate) >= throttle {
			display := accumulated.String()
			if toolStatus != "" {
				if display != "" {
					display += "\n\n"
				}
				display += toolStatus
			}
			if display == "" {
				display = "_thinking..._"
			}
			onUpdate(display)
			lastUpdate = time.Now()
		}
	}

	if err := cmd.Wait(); err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			killProcessGroup(cmd)
			return nil, fmt.Errorf("agent %s timed out after %s", agent.Name, agent.Timeout)
		}
		return nil, fmt.Errorf("agent %s failed: %w\nstderr: %s", agent.Name, err, stderrBuf.String())
	}

	// If we got a structured result from stream-json, use it
	if hasResult {
		if lastResult.IsError {
			return nil, fmt.Errorf("agent error: %s", lastResult.Result)
		}
		return &lastResult, nil
	}

	// Fallback: try to parse the accumulated output as JSON (in case stream-json
	// isn't supported and it fell back to regular json output)
	raw := strings.TrimSpace(accumulated.String())
	var result claudeResult
	if err := json.Unmarshal([]byte(raw), &result); err != nil {
		// Return raw output
		return &claudeResult{Result: raw}, nil
	}

	if result.IsError {
		return nil, fmt.Errorf("agent error: %s", result.Result)
	}

	return &result, nil
}

// --- HTTP handlers ---

func (m *Manager) RunAgent(w http.ResponseWriter, r *http.Request) {
	agentID := chi.URLParam(r, "agent")

	var req struct {
		Prompt    string `json:"prompt"`
		ThreadTS  string `json:"thread_ts,omitempty"`
		Channel   string `json:"channel,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}

	var (
		result string
		err    error
	)

	if req.ThreadTS != "" {
		result, err = m.SpawnAgentInThread(agentID, req.Prompt, req.Channel, req.ThreadTS)
	} else {
		result, err = m.SpawnAgent(agentID, req.Prompt)
	}

	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	json.NewEncoder(w).Encode(map[string]string{
		"agent":  agentID,
		"result": result,
	})
}

func (m *Manager) ListAgents(w http.ResponseWriter, r *http.Request) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	list := make([]*AgentConfig, 0, len(m.agents))
	for _, a := range m.agents {
		list = append(list, a)
	}
	json.NewEncoder(w).Encode(list)
}

func (m *Manager) GetAgent(w http.ResponseWriter, r *http.Request) {
	agentID := chi.URLParam(r, "agent")
	m.mu.RLock()
	agent, ok := m.agents[agentID]
	m.mu.RUnlock()
	if !ok {
		http.Error(w, "agent not found", http.StatusNotFound)
		return
	}
	// Return full detail including system prompt
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"name":            agent.Name,
		"description":     agent.Description,
		"model":           agent.Model,
		"max_turns":       agent.MaxTurns,
		"workspace":       agent.Workspace,
		"short_name":      agent.ShortName,
		"tools":           agent.Tools,
		"entry_point":     agent.EntryPoint,
		"timeout_seconds": int(agent.Timeout.Seconds()),
		"system_prompt":   agent.SystemPrompt,
	})
}

func (m *Manager) UpdateAgentPrompt(w http.ResponseWriter, r *http.Request) {
	agentID := chi.URLParam(r, "agent")

	var req struct {
		SystemPrompt string `json:"system_prompt"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}

	m.mu.Lock()
	agent, ok := m.agents[agentID]
	if !ok {
		m.mu.Unlock()
		http.Error(w, `{"error":"agent not found"}`, http.StatusNotFound)
		return
	}

	// Rebuild the .md file: preserve frontmatter, replace body
	path := filepath.Join(os.Getenv("HOME"), ".claude", "agents", agentID+".md")
	data, err := os.ReadFile(path)
	if err != nil {
		m.mu.Unlock()
		http.Error(w, fmt.Sprintf(`{"error":"read failed: %v"}`, err), http.StatusInternalServerError)
		return
	}

	content := string(data)
	parts := strings.SplitN(content[3:], "---", 2)
	if len(parts) < 2 {
		m.mu.Unlock()
		http.Error(w, `{"error":"malformed agent file"}`, http.StatusInternalServerError)
		return
	}

	newContent := "---" + parts[0] + "---\n\n" + strings.TrimSpace(req.SystemPrompt) + "\n"
	if err := os.WriteFile(path, []byte(newContent), 0644); err != nil {
		m.mu.Unlock()
		http.Error(w, fmt.Sprintf(`{"error":"write failed: %v"}`, err), http.StatusInternalServerError)
		return
	}

	agent.SystemPrompt = strings.TrimSpace(req.SystemPrompt)
	agent.Tools = detectTools(agent.SystemPrompt)
	m.mu.Unlock()

	log.Printf("[agents] updated system prompt for %s", agentID)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"agent":   agentID,
		"saved":   true,
		"restart": true,
	})
}

func (m *Manager) GetSession(w http.ResponseWriter, r *http.Request) {
	threadTS := chi.URLParam(r, "session")
	m.mu.RLock()
	session, ok := m.sessions[threadTS]
	m.mu.RUnlock()
	if !ok {
		http.Error(w, "session not found", http.StatusNotFound)
		return
	}
	json.NewEncoder(w).Encode(session)
}

func (m *Manager) SendMessage(w http.ResponseWriter, r *http.Request) {
	agentID := chi.URLParam(r, "agent")
	sessionID := chi.URLParam(r, "session")

	var req struct {
		Message string `json:"message"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}

	// Try to continue existing session first
	result, found, err := m.ContinueThread(sessionID, req.Message)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if !found {
		// No session — start fresh
		result, err = m.SpawnAgent(agentID, req.Message)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	}

	json.NewEncoder(w).Encode(map[string]string{"response": result})
}

// saveSchedules writes all current schedules to disk (called under m.mu).
func (m *Manager) saveSchedules() {
	list := make([]schedulePersisted, 0, len(m.schedules))
	for _, s := range m.schedules {
		list = append(list, schedulePersisted{
			ID:       s.ID,
			AgentID:  s.AgentID,
			Cron:     s.Cron,
			Prompt:   s.Prompt,
			SlackCh:  s.SlackCh,
			Timezone: s.Timezone,
			Status:   s.Status,
		})
	}
	if err := os.MkdirAll(filepath.Dir(scheduleFile), 0755); err != nil {
		log.Printf("[scheduler] could not create config dir: %v", err)
		return
	}
	data, _ := json.MarshalIndent(list, "", "  ")
	if err := os.WriteFile(scheduleFile, data, 0644); err != nil {
		log.Printf("[scheduler] failed to save schedules: %v", err)
	}
}

// addScheduleEntry registers a schedule with the cron daemon and stores it.
// Must be called with m.mu held (write lock).
func (m *Manager) addScheduleEntry(sched *Schedule) error {
	cronExpr := sched.Cron
	if sched.Timezone != "" {
		cronExpr = fmt.Sprintf("CRON_TZ=%s %s", sched.Timezone, sched.Cron)
	}

	agentID := sched.AgentID
	prompt := sched.Prompt
	slackCh := sched.SlackCh
	schedID := sched.ID

	entryID, err := m.cron.AddFunc(cronExpr, func() {
		log.Printf("[scheduler] Running %s: agent=%s prompt=%q", schedID, agentID, prompt)

		if slackCh != "" && m.SlackPostTS != nil && m.SlackThreadReply != nil {
			// Post the trigger as the thread parent so the user can reply.
			channelID, threadTS, err := m.SlackPostTS(slackCh,
				fmt.Sprintf(":alarm_clock: *Scheduled run: %s*\n_%s_", agentID, prompt),
			)
			if err != nil {
				log.Printf("[scheduler] %s failed to post trigger: %v", schedID, err)
				return
			}

			// Run agent in the thread and store the session for follow-ups.
			result, runErr := m.SpawnAgentInThreadStreaming(agentID, prompt, channelID, threadTS, nil)
			if runErr != nil {
				log.Printf("[scheduler] %s failed: %v", schedID, runErr)
				result = fmt.Sprintf(":x: *%s failed:*\n```%v```", agentID, runErr)
			}

			// Tag the user so they get a Slack notification for scheduled results.
			msg := fmt.Sprintf("<@%s>\n%s", m.SlackOwnerID, result)
			if len(msg) > 3000 {
				msg = msg[:2950] + "\n\n_...response truncated_"
			}
			if err := m.SlackThreadReply(channelID, threadTS, msg); err != nil {
				log.Printf("[scheduler] %s failed to post result: %v", schedID, err)
			}
		} else {
			// No Slack configured — just run and log.
			result, err := m.SpawnAgent(agentID, prompt)
			if err != nil {
				log.Printf("[scheduler] %s failed: %v", schedID, err)
			} else {
				log.Printf("[scheduler] %s result: %s", schedID, result)
			}
		}
	})
	if err != nil {
		return err
	}
	sched.EntryID = entryID
	m.schedules[sched.ID] = sched
	return nil
}

// loadSchedules reads persisted schedules from disk and re-registers them with the cron daemon.
func (m *Manager) loadSchedules() {
	data, err := os.ReadFile(scheduleFile)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("[scheduler] could not read %s: %v", scheduleFile, err)
		}
		return
	}

	var list []schedulePersisted
	if err := json.Unmarshal(data, &list); err != nil {
		log.Printf("[scheduler] failed to parse schedules file: %v", err)
		return
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	for _, p := range list {
		sched := &Schedule{
			ID:       p.ID,
			AgentID:  p.AgentID,
			Cron:     p.Cron,
			Prompt:   p.Prompt,
			SlackCh:  p.SlackCh,
			Timezone: p.Timezone,
			Status:   p.Status,
		}
		// Track highest ID number for new schedule naming
		var n int
		if cnt, _ := fmt.Sscanf(p.ID, "sched_%d", &n); cnt == 1 && n > m.schedCount {
			m.schedCount = n
		}
		if err := m.addScheduleEntry(sched); err != nil {
			log.Printf("[scheduler] could not restore %s: %v", p.ID, err)
			continue
		}
		log.Printf("[scheduler] restored %s: cron=%s agent=%s", sched.ID, sched.Cron, sched.AgentID)
	}
	log.Printf("[scheduler] %d schedule(s) restored", len(list))
}

// saveSessions writes active sessions to disk so they survive restarts.
// Called under m.mu (write lock) after session creation or update.
func (m *Manager) saveSessions() {
	list := make([]*Session, 0, len(m.sessions))
	for _, s := range m.sessions {
		if s.ClaudeSessionID != "" {
			list = append(list, s)
		}
	}
	if err := os.MkdirAll(filepath.Dir(sessionFile), 0755); err != nil {
		log.Printf("[sessions] could not create config dir: %v", err)
		return
	}
	data, _ := json.MarshalIndent(list, "", "  ")
	if err := os.WriteFile(sessionFile, data, 0644); err != nil {
		log.Printf("[sessions] failed to save sessions: %v", err)
	}
}

// loadSessions restores sessions from disk so thread replies work across restarts.
func (m *Manager) loadSessions() {
	data, err := os.ReadFile(sessionFile)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("[sessions] could not read %s: %v", sessionFile, err)
		}
		return
	}
	var list []*Session
	if err := json.Unmarshal(data, &list); err != nil {
		log.Printf("[sessions] failed to parse sessions file: %v", err)
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, s := range list {
		// Only restore sessions from the last 24 hours
		if time.Since(s.LastUsed) < 24*time.Hour {
			m.sessions[s.SlackThreadTS] = s
			log.Printf("[sessions] restored session thread=%s agent=%s", s.SlackThreadTS, s.AgentID)
		}
	}
	log.Printf("[sessions] %d session(s) restored", len(m.sessions))
}

// GetScheduleList returns all schedules as a slice (for internal use, e.g. calendar sync).
func (m *Manager) GetScheduleList() []*Schedule {
	m.mu.RLock()
	defer m.mu.RUnlock()
	list := make([]*Schedule, 0, len(m.schedules))
	for _, s := range m.schedules {
		list = append(list, s)
	}
	return list
}

func (m *Manager) ListSchedules(w http.ResponseWriter, r *http.Request) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	list := make([]*Schedule, 0, len(m.schedules))
	for _, s := range m.schedules {
		list = append(list, s)
	}
	json.NewEncoder(w).Encode(list)
}

func (m *Manager) CreateSchedule(w http.ResponseWriter, r *http.Request) {
	var sched Schedule
	if err := json.NewDecoder(r.Body).Decode(&sched); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}

	// Validate required fields
	if sched.Cron == "" {
		http.Error(w, "cron expression is required", http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(sched.Prompt) == "" {
		http.Error(w, "prompt is required — the agent needs instructions for what to do on each run", http.StatusBadRequest)
		return
	}

	m.mu.Lock()
	m.schedCount++
	sched.ID = fmt.Sprintf("sched_%d", m.schedCount)
	sched.Status = "active"

	if err := m.addScheduleEntry(&sched); err != nil {
		m.mu.Unlock()
		http.Error(w, fmt.Sprintf("invalid cron expression: %v", err), http.StatusBadRequest)
		return
	}

	m.saveSchedules()
	m.mu.Unlock()

	log.Printf("[scheduler] Created schedule %s: cron=%s agent=%s", sched.ID, sched.Cron, sched.AgentID)

	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(sched)
}

// validModels are the allowed model values for agent configuration.
var validModels = map[string]bool{"opus": true, "sonnet": true, "haiku": true}

// UpdateModel changes the model in an agent's .md file and reloads the in-memory config.
// Returns the old model name for notification purposes.
func (m *Manager) UpdateModel(agentName, newModel string) (oldModel string, err error) {
	if !validModels[newModel] {
		return "", fmt.Errorf("invalid model %q (must be opus, sonnet, or haiku)", newModel)
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	agent, ok := m.agents[agentName]
	if !ok {
		return "", fmt.Errorf("agent %q not found", agentName)
	}

	oldModel = agent.Model
	if oldModel == newModel {
		return oldModel, nil
	}

	// Rewrite the .md file with the new model
	path := filepath.Join(os.Getenv("HOME"), ".claude", "agents", agentName+".md")
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read agent file: %w", err)
	}

	content := string(data)
	// Replace the model line in frontmatter
	lines := strings.Split(content, "\n")
	found := false
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "model:") {
			lines[i] = "model: " + newModel
			found = true
			break
		}
		// Stop searching after closing frontmatter delimiter
		if i > 0 && trimmed == "---" {
			break
		}
	}
	if !found {
		// Insert model line before the closing ---
		for i, line := range lines {
			if i > 0 && strings.TrimSpace(line) == "---" {
				lines = append(lines[:i], append([]string{"model: " + newModel}, lines[i:]...)...)
				break
			}
		}
	}

	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")), 0644); err != nil {
		return "", fmt.Errorf("write agent file: %w", err)
	}

	// Update in-memory config
	agent.Model = newModel
	log.Printf("[agents] updated %s model: %s → %s", agentName, oldModel, newModel)

	return oldModel, nil
}

// parseModelOverride checks if the prompt starts with a model name prefix.
// e.g. "opus: write me a campaign" → model="opus", prompt="write me a campaign"
func parseModelOverride(prompt, defaultModel string) (string, string) {
	models := map[string]string{
		"opus:":   "opus",
		"sonnet:": "sonnet",
		"haiku:":  "haiku",
	}
	for prefix, model := range models {
		if len(prompt) > len(prefix) && strings.EqualFold(prompt[:len(prefix)], prefix) {
			return strings.TrimSpace(prompt[len(prefix):]), model
		}
	}
	return prompt, defaultModel
}

// formatToolStatus returns a short Slack-formatted status line for a tool_use event.
func formatToolStatus(toolName string, rawInput json.RawMessage) string {
	// Friendly display names for common tools
	labels := map[string]string{
		"Bash":      "Running command",
		"Read":      "Reading file",
		"Write":     "Writing file",
		"Edit":      "Editing file",
		"Glob":      "Searching files",
		"Grep":      "Searching code",
		"WebFetch":  "Fetching URL",
		"WebSearch": "Searching the web",
		"Agent":     "Spawning sub-agent",
		"Skill":     "Running skill",
	}

	label, ok := labels[toolName]
	if !ok {
		// For MCP tools, clean up the prefix
		display := toolName
		if idx := strings.LastIndex(toolName, "__"); idx >= 0 {
			display = strings.ReplaceAll(toolName[idx+2:], "_", " ")
		}
		label = "Using " + display
	}

	// Try to extract a short detail from the input
	var input map[string]interface{}
	if err := json.Unmarshal(rawInput, &input); err == nil {
		// Pick the most informative field to show
		for _, key := range []string{"description", "command", "file_path", "pattern", "query", "prompt", "skill"} {
			if v, ok := input[key]; ok {
				s := fmt.Sprintf("%v", v)
				if len(s) > 80 {
					s = s[:77] + "..."
				}
				return fmt.Sprintf("_:gear: %s:_ `%s`", label, s)
			}
		}
	}

	return fmt.Sprintf("_:gear: %s..._", label)
}

func (m *Manager) UpdateAgentModel(w http.ResponseWriter, r *http.Request) {
	agentID := chi.URLParam(r, "agent")

	var req struct {
		Model string `json:"model"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}

	oldModel, err := m.UpdateModel(agentID, req.Model)
	if err != nil {
		status := http.StatusInternalServerError
		if strings.Contains(err.Error(), "not found") {
			status = http.StatusNotFound
		} else if strings.Contains(err.Error(), "invalid model") {
			status = http.StatusBadRequest
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}

	changed := oldModel != req.Model

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"agent":     agentID,
		"old_model": oldModel,
		"new_model": req.Model,
		"changed":   changed,
		"restart":   changed,
	})
}

func (m *Manager) UpdateSchedule(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")

	var update struct {
		Cron     *string `json:"cron"`
		Prompt   *string `json:"prompt"`
		SlackCh  *string `json:"slack_channel"`
		Timezone *string `json:"timezone"`
		AgentID  *string `json:"agent_id"`
		Status   *string `json:"status"`
	}
	if err := json.NewDecoder(r.Body).Decode(&update); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}

	m.mu.Lock()
	old, ok := m.schedules[id]
	if !ok {
		m.mu.Unlock()
		http.Error(w, "schedule not found", http.StatusNotFound)
		return
	}

	// Build updated schedule, keeping existing values for unset fields
	sched := &Schedule{
		ID:       id,
		AgentID:  old.AgentID,
		Cron:     old.Cron,
		Prompt:   old.Prompt,
		SlackCh:  old.SlackCh,
		Timezone: old.Timezone,
		Status:   old.Status,
	}
	if update.AgentID != nil {
		sched.AgentID = *update.AgentID
	}
	if update.Cron != nil {
		sched.Cron = *update.Cron
	}
	if update.Prompt != nil {
		sched.Prompt = *update.Prompt
	}
	if update.SlackCh != nil {
		sched.SlackCh = *update.SlackCh
	}
	if update.Timezone != nil {
		sched.Timezone = *update.Timezone
	}
	if update.Status != nil {
		sched.Status = *update.Status
	}

	// Remove old cron entry and re-register with updated settings
	m.cron.Remove(old.EntryID)
	delete(m.schedules, id)

	if err := m.addScheduleEntry(sched); err != nil {
		m.mu.Unlock()
		http.Error(w, fmt.Sprintf("invalid cron expression: %v", err), http.StatusBadRequest)
		return
	}

	m.saveSchedules()
	m.mu.Unlock()

	log.Printf("[scheduler] Updated schedule %s: cron=%s agent=%s", id, sched.Cron, sched.AgentID)
	json.NewEncoder(w).Encode(sched)
}

func (m *Manager) DeleteSchedule(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	m.mu.Lock()
	sched, ok := m.schedules[id]
	if !ok {
		m.mu.Unlock()
		http.Error(w, "schedule not found", http.StatusNotFound)
		return
	}
	m.cron.Remove(sched.EntryID)
	delete(m.schedules, id)
	m.saveSchedules()
	m.mu.Unlock()
	log.Printf("[scheduler] Deleted schedule %s", id)
	w.WriteHeader(http.StatusNoContent)
}

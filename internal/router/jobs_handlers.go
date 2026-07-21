package router

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"crypto/rand"
	"encoding/hex"

	"github.com/go-chi/chi/v5"

	"github.com/codephilip/winston-ai/internal/agents"
	"github.com/codephilip/winston-ai/internal/jobs"
	"github.com/codephilip/winston-ai/internal/notify"
)

// jobStore is lazily initialized on first handler call. Failure here is
// non-fatal for the rest of the API — just returns 500 on /api/jobs paths.
var jobStore *jobs.Store

func getJobStore() (*jobs.Store, error) {
	if jobStore != nil {
		return jobStore, nil
	}
	s, err := jobs.NewStore()
	if err != nil {
		return nil, err
	}
	jobStore = s
	go func() {
		n, err := s.PruneStale()
		if err != nil {
			log.Printf("[jobs-prune] failed: %v", err)
			return
		}
		if n > 0 {
			log.Printf("[jobs-prune] removed %d stale rows (> 8w, not applied+)", n)
		}
	}()
	return s, nil
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func handleListJobs(w http.ResponseWriter, r *http.Request) {
	s, err := getJobStore()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	q := r.URL.Query()
	filter := jobs.ListFilter{
		Status:  q.Get("status"),
		Search:  q.Get("search"),
		Week:    q.Get("week"),
		Source:  q.Get("source"),
		OrderBy: q.Get("order"),
		Limit:   50,
	}
	if v := q.Get("min_score"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			filter.MinScore = n
		}
	}
	if v := q.Get("limit"); v != "" {
		// limit=0 means "no server-side pagination" — return every row matching
		// the filter. Used by the UI to do its own workspace filter + sort +
		// pagination without losing data across pages.
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			if n > 5000 {
				n = 5000
			}
			filter.Limit = n
		}
	}
	if v := q.Get("offset"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			filter.Offset = n
		}
	}
	if v := q.Get("flagged"); v == "1" || v == "true" {
		filter.Flagged = true
	}
	if v := q.Get("include_stale"); v == "1" || v == "true" {
		filter.IncludeStale = true
	}
	rows, err := s.ListJobs(filter)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	total, err := s.CountJobs(filter)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"jobs":   rows,
		"count":  len(rows),
		"total":  total,
		"offset": filter.Offset,
		"limit":  filter.Limit,
	})
}

// handleJobDelete hard-deletes a row via Store.DeleteJob. Blocks anything in
// a later funnel stage (applied+).
func handleJobDelete(w http.ResponseWriter, r *http.Request) {
	s, err := getJobStore()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	jobID := chi.URLParam(r, "id")
	if err := s.DeleteJob(jobID); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleJobResearch serves the welcome-package briefing for one job, which the
// jobs board renders in a modal. Returns 404 when the job has not been
// researched (only a run's top matches are).
func handleJobResearch(w http.ResponseWriter, r *http.Request) {
	s, err := getJobStore()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	raw, err := s.Research(chi.URLParam(r, "id"))
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}
	if raw == "" {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no welcome package for this job yet"})
		return
	}
	// research_json is already JSON — pass it through rather than re-encoding.
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(raw))
}

func handleJobsStats(w http.ResponseWriter, r *http.Request) {
	s, err := getJobStore()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	st, err := s.Stats()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, st)
}

func handleJobStatusUpdate(w http.ResponseWriter, r *http.Request) {
	s, err := getJobStore()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	jobID := chi.URLParam(r, "id")
	var body struct {
		Status string `json:"status"`
		Notes  string `json:"notes"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if err := s.UpdateStatus(jobID, body.Status, body.Notes); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func handleJobVariantUpdate(w http.ResponseWriter, r *http.Request) {
	s, err := getJobStore()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	jobID := chi.URLParam(r, "id")
	var body struct {
		Variant string `json:"variant"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if err := s.SetVariant(jobID, body.Variant); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "variant": body.Variant})
}

func handleJobFlagUpdate(w http.ResponseWriter, r *http.Request) {
	s, err := getJobStore()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	jobID := chi.URLParam(r, "id")
	var body struct {
		Flagged bool `json:"flagged"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if err := s.SetFlag(jobID, body.Flagged); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "flagged": body.Flagged})
}

// contactResult mirrors the JSON emitted by company-contacts.js.
type contactResult struct {
	RecruitingEmail string `json:"recruiting_email"`
	ContactType     string `json:"contact_type"`
	CareersURL      string `json:"careers_url"`
	Found           bool   `json:"found"`
	Error           string `json:"error,omitempty"`
}

// handleJobsEnrichContacts looks up each company's PUBLIC recruiting contact —
// a corporate role mailbox (careers@, jobs@ ...) or the careers page — and
// stores it against every job for that company. It never resolves an
// individual's contact details; company-contacts.js enforces that boundary.
func handleJobsEnrichContacts(w http.ResponseWriter, r *http.Request) {
	s, err := getJobStore()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	limit := 25
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 200 {
			limit = n
		}
	}
	pending, err := s.CompaniesNeedingContact(limit)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	tool := filepath.Join(jobs.ToolsDir(), "company-contacts.js")
	if _, err := os.Stat(tool); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "tool missing: company-contacts.js"})
		return
	}

	var withEmail, withCareers, updated int
	for _, c := range pending {
		ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
		cmd := exec.CommandContext(ctx, "node", tool, "--website", c.Website, "--company", c.Company, "--json")
		cmd.Env = append(os.Environ(), loadClaudeEnv()...)
		out, runErr := cmd.Output()
		cancel()
		if runErr != nil {
			log.Printf("[jobs-contacts] %s: %v", c.Company, runErr)
			continue
		}
		var res contactResult
		if err := json.Unmarshal(out, &res); err != nil || !res.Found {
			continue
		}
		n, err := s.SetCompanyContact(c.Company, res.RecruitingEmail, res.ContactType, res.CareersURL)
		if err != nil {
			log.Printf("[jobs-contacts] store %s: %v", c.Company, err)
			continue
		}
		updated += int(n)
		if res.RecruitingEmail != "" {
			withEmail++
		}
		if res.CareersURL != "" {
			withCareers++
		}
	}

	log.Printf("[jobs-contacts] %d companies checked, %d with email, %d with careers page, %d job rows updated",
		len(pending), withEmail, withCareers, updated)
	writeJSON(w, http.StatusOK, map[string]any{
		"status":            "ok",
		"companies_checked": len(pending),
		"with_email":        withEmail,
		"with_careers_page": withCareers,
		"jobs_updated":      updated,
	})
}

// handleJobsPrune deletes rows older than 8 weeks (per PruneStale) and
// returns the number removed. The weekly orchestrator calls this as Stage 0.
func handleJobsPrune(w http.ResponseWriter, r *http.Request) {
	s, err := getJobStore()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	n, err := s.PruneStale()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	log.Printf("[jobs-prune] removed %d stale rows (> 8w, not applied+)", n)
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "removed": n})
}

// handleJobsTrigger kicks off the weekly jobs pipeline on demand. It spawns
// the jobs-weekly agent (which orchestrates finder → apply) async so
// the request returns immediately. Prunes stale rows synchronously first.
func handleJobsTrigger(manager *agents.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Limit     int  `json:"limit"`
			DryRun    bool `json:"dry_run"`
			SkipApply bool `json:"skip_apply"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)

		if s, err := getJobStore(); err == nil {
			if n, err := s.PruneStale(); err == nil && n > 0 {
				log.Printf("[jobs-trigger] pruned %d stale rows before pipeline run", n)
			}
		}

		limit := body.Limit
		if limit <= 0 {
			limit = 25
		}
		prompt := "Run the full weekly jobs pipeline now. Scrape LinkedIn, generate packages for 80+ matches, then invoke jobs-apply to auto-submit."
		if body.DryRun {
			prompt += " Run the apply step in --dry-run mode."
		}
		if body.SkipApply {
			prompt = "Run only the scrape + resume package generation step. Do not invoke jobs-apply."
		}
		prompt += " Apply limit: " + strconv.Itoa(limit) + "."

		go func() {
			result, err := manager.SpawnAgent("jobs-weekly", prompt)
			if err != nil {
				log.Printf("[jobs-trigger] failed: %v", err)
				return
			}
			log.Printf("[jobs-trigger] done: %s", truncate(result, 500))
		}()

		writeJSON(w, http.StatusAccepted, map[string]string{
			"status": "started",
			"agent":  "jobs-weekly",
		})
	}
}

// handleJobsApplySelected spawns the apply agent targeted at a user-selected
// list of job IDs. It first syncs those jobs' packages from Drive (so the
// resume DOCX is guaranteed present locally) then runs jobs-apply.js with
// --job-ids csv.
func handleJobsApplySelected(manager *agents.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			JobIDs []string `json:"job_ids"`
			DryRun bool     `json:"dry_run"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
			return
		}
		if len(body.JobIDs) == 0 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "job_ids required"})
			return
		}
		// Cap to prevent accidental runaway
		if len(body.JobIDs) > 100 {
			body.JobIDs = body.JobIDs[:100]
		}

		// Validate IDs are alphanumeric + underscore/dash/dot/pipe (matches what
		// jobs-db.js generates) before embedding in a shell-style CSV argument.
		clean := make([]string, 0, len(body.JobIDs))
		for _, id := range body.JobIDs {
			if isSafeJobID(id) {
				clean = append(clean, id)
			}
		}
		if len(clean) == 0 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "no valid job_ids"})
			return
		}

		csv := strings.Join(clean, ",")
		dryFlag := ""
		if body.DryRun {
			dryFlag = " --dry-run"
		}

		prompt := `Auto-apply to these specific jobs the user selected in the web UI.

Step 1 — For each job_id, ensure the company-specific resume DOCX is present at ~/Desktop/jobs/packages/[company-slug]/. If missing, pull it from the Drive folder ("winston-jobs/week of [latest]/[score] - [Company] - [Title]/") using mcp__google-workspace__list_drive_items + get_drive_file_content (user_google_email configured via the google-workspace MCP). Look up the company name per job_id from the SQLite DB at ~/.claude/data/jobs.db.

Step 2 — Run the auto-apply tool against exactly these job_ids:
  node ~/.claude/tools/jobs/jobs-apply.js --job-ids ` + csv + dryFlag + `

Step 3 — Report concise JSON: { requested: ` + fmt.Sprintf("%d", len(clean)) + `, applied, needs_manual, failed, failures[{company,title,reason}] }. No separate summary email for selected-apply runs — the web UI is the interface.`

		go func() {
			result, err := manager.SpawnAgent("jobs-apply", prompt)
			if err != nil {
				log.Printf("[jobs-apply-selected] failed: %v", err)
				return
			}
			log.Printf("[jobs-apply-selected] done (%d jobs): %s", len(clean), truncate(result, 400))
		}()

		writeJSON(w, http.StatusAccepted, map[string]any{
			"status": "started",
			"agent":  "jobs-apply",
			"mode":   "selected",
			"count":  len(clean),
		})
	}
}

// handleJobsApplySelectedInteractive runs jobs-apply.js directly (no agent)
// in --interactive mode: one visible Chrome window, tabs opened in batches,
// fields filled, submit paused for human review. No Drive sync, no DB writes.
// Packages must already be on disk at ~/Desktop/jobs/packages/[slug]/
// from the tailoring run.
func handleJobsApplySelectedInteractive(w http.ResponseWriter, r *http.Request) {
	var body struct {
		JobIDs    []string `json:"job_ids"`
		BatchSize int      `json:"batch_size"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if len(body.JobIDs) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "job_ids required"})
		return
	}
	if len(body.JobIDs) > 100 {
		body.JobIDs = body.JobIDs[:100]
	}
	clean := make([]string, 0, len(body.JobIDs))
	for _, id := range body.JobIDs {
		if isSafeJobID(id) {
			clean = append(clean, id)
		}
	}
	if len(clean) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "no valid job_ids"})
		return
	}

	home, err := os.UserHomeDir()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "home dir: " + err.Error()})
		return
	}
	toolPath := filepath.Join(jobs.ToolsDir(), "jobs-apply.js")
	if _, err := os.Stat(toolPath); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "jobs-apply.js not found at " + toolPath})
		return
	}

	args := []string{toolPath, "--interactive", "--job-ids", strings.Join(clean, ",")}
	if body.BatchSize > 0 {
		args = append(args, "--batch-size", strconv.Itoa(body.BatchSize))
	}

	// Detached run — the node process stays alive while Chrome is open,
	// which can be hours. Don't tie its lifetime to this HTTP handler.
	cmd := exec.Command("node", args...)
	cmd.Env = append(os.Environ(), loadClaudeEnv()...)
	// Nil stdin + discard stdout/stderr prevents the OS from backpressuring
	// the node process once its output pipe buffer fills.
	cmd.Stdin = nil
	logFile, _ := os.OpenFile(
		filepath.Join(home, "Library", "Logs", "winston-jobs-interactive.log"),
		os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644,
	)
	if logFile != nil {
		cmd.Stdout = logFile
		cmd.Stderr = logFile
	}
	if err := cmd.Start(); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "spawn failed: " + err.Error()})
		return
	}
	pid := cmd.Process.Pid
	go func() {
		_ = cmd.Wait()
		if logFile != nil {
			_ = logFile.Close()
		}
		log.Printf("[jobs-apply-interactive] pid=%d exited (%d jobs)", pid, len(clean))
	}()
	log.Printf("[jobs-apply-interactive] started pid=%d for %d jobs", pid, len(clean))

	writeJSON(w, http.StatusAccepted, map[string]any{
		"status": "started",
		"pid":    pid,
		"count":  len(clean),
		"note":   "A Chrome window will open on the server host with one tab per job (in batches). Tabs stay open until you close them.",
	})
}

// handleJobsApplyUpworkSelected runs upwork-apply.js directly (no agent) for
// a user-selected list of Upwork project IDs. It detaches the node process so
// the visible Chrome window stays alive after this HTTP handler returns.
// Different from the LinkedIn interactive path: drafts proposals via Claude,
// pre-fills cover letter + bid, but never submits — Philip clicks Submit
// himself in the browser tabs.
func handleJobsApplyUpworkSelected(w http.ResponseWriter, r *http.Request) {
	var body struct {
		JobIDs    []string `json:"job_ids"`
		BatchSize int      `json:"batch_size"`
		DraftOnly bool     `json:"draft_only"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if len(body.JobIDs) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "job_ids required"})
		return
	}
	if len(body.JobIDs) > 50 {
		body.JobIDs = body.JobIDs[:50]
	}
	clean := make([]string, 0, len(body.JobIDs))
	for _, id := range body.JobIDs {
		if isSafeJobID(id) {
			clean = append(clean, id)
		}
	}
	if len(clean) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "no valid job_ids"})
		return
	}

	home, err := os.UserHomeDir()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "home dir: " + err.Error()})
		return
	}
	toolPath := filepath.Join(jobs.ToolsDir(), "upwork-apply.js")
	if _, err := os.Stat(toolPath); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "upwork-apply.js not found at " + toolPath})
		return
	}

	args := []string{toolPath, "--job-ids", strings.Join(clean, ",")}
	if body.BatchSize > 0 {
		args = append(args, "--batch-size", strconv.Itoa(body.BatchSize))
	}
	if body.DraftOnly {
		args = append(args, "--draft-only")
	}

	cmd := exec.Command("node", args...)
	cmd.Env = append(os.Environ(), loadClaudeEnv()...)
	cmd.Stdin = nil
	logFile, _ := os.OpenFile(
		filepath.Join(home, "Library", "Logs", "winston-upwork-apply.log"),
		os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644,
	)
	if logFile != nil {
		cmd.Stdout = logFile
		cmd.Stderr = logFile
	}
	if err := cmd.Start(); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "spawn failed: " + err.Error()})
		return
	}
	pid := cmd.Process.Pid
	go func() {
		_ = cmd.Wait()
		if logFile != nil {
			_ = logFile.Close()
		}
		log.Printf("[upwork-apply] pid=%d exited (%d projects)", pid, len(clean))
	}()
	log.Printf("[upwork-apply] started pid=%d for %d projects (draft_only=%v)", pid, len(clean), body.DraftOnly)

	note := "Drafting proposals via Claude. A Chrome window will open with one tab per project, cover letter + bid pre-filled. Review each, then click Submit yourself."
	if body.DraftOnly {
		note = "Drafting proposals to disk only. Check ~/Desktop/jobs/packages/upwork-* for the cover letters."
	}

	writeJSON(w, http.StatusAccepted, map[string]any{
		"status": "started",
		"pid":    pid,
		"count":  len(clean),
		"note":   note,
	})
}

// isSafeJobID allows characters that appear in job IDs generated by
// jobs-db.js: alphanumerics plus _ - . | (pipe separator for fallback IDs).
func isSafeJobID(id string) bool {
	if id == "" || len(id) > 200 {
		return false
	}
	for _, r := range id {
		if !(r >= 'a' && r <= 'z') && !(r >= 'A' && r <= 'Z') && !(r >= '0' && r <= '9') &&
			r != '_' && r != '-' && r != '.' && r != '|' {
			return false
		}
	}
	return true
}

// handleJobsApplyFromDrive spawns the jobs-apply agent in "sync from
// Drive" mode: it downloads the latest week's application packages from Google
// Drive to the local packages dir, then runs jobs-apply.js against drafted jobs.
func handleJobsApplyFromDrive(manager *agents.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Limit    int  `json:"limit"`
			MinScore int  `json:"min_score"`
			DryRun   bool `json:"dry_run"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.Limit <= 0 {
			body.Limit = 30
		}
		if body.MinScore <= 0 {
			body.MinScore = 80
		}

		dryFlag := ""
		if body.DryRun {
			dryFlag = " --dry-run"
		}

		prompt := `Pull this week's application packages from Google Drive, then auto-apply.

Step 1 — Sync from Drive. For each job with application_status='drafted' in the local SQLite DB (~/.claude/data/jobs.db), find the matching Drive folder under "winston-jobs/week of [latest week]/". Use mcp__google-workspace__list_drive_items (user_google_email configured via the google-workspace MCP) to enumerate the week folder, match subfolders by the company name in the DB row, and use mcp__google-workspace__get_drive_file_content to download:
  - The resume DOCX ("Philip Gehde 2026 Resume - [Company].docx") → save to ~/Desktop/jobs/packages/[company-slug]/
  - The "Apply Here" doc — parse out the apply URL; if the DB's apply_url is empty, UPDATE the job row with it
  - The "Recruiter Message" doc content — store to ~/Desktop/jobs/packages/[company-slug]/recruiter-message.txt

Step 2 — Run the auto-apply tool:
  node ~/.claude/tools/jobs/jobs-apply.js --limit ` + strconv.Itoa(body.Limit) + ` --min-score ` + strconv.Itoa(body.MinScore) + dryFlag + `

Step 3 — Email the summary per your agent instructions.

Report back concise JSON with counts: { synced_from_drive, processed, applied, needs_manual, failed }.`

		go func() {
			result, err := manager.SpawnAgent("jobs-apply", prompt)
			if err != nil {
				log.Printf("[jobs-apply-from-drive] failed: %v", err)
				return
			}
			log.Printf("[jobs-apply-from-drive] done: %s", truncate(result, 500))
		}()

		writeJSON(w, http.StatusAccepted, map[string]string{
			"status": "started",
			"agent":  "jobs-apply",
			"mode":   "drive-sync",
		})
	}
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

// extractErrorDetail pulls a human-readable error out of the apify tool's
// combined stdout/stderr. The tool prints Apify's JSON error when the actor
// API fails — we try the "message" field first, then the first "Error:" line.
func extractErrorDetail(out string) string {
	// Apify JSON error with "message" field
	if i := strings.Index(out, `"message":`); i >= 0 {
		rest := out[i+len(`"message":`):]
		rest = strings.TrimSpace(rest)
		if strings.HasPrefix(rest, `"`) {
			end := strings.Index(rest[1:], `"`)
			if end > 0 {
				return "Apify: " + rest[1:end+1]
			}
		}
	}
	// Actor run aborted/failed/timed-out — surface the status line
	for _, line := range strings.Split(out, "\n") {
		l := strings.TrimSpace(line)
		if strings.HasPrefix(l, "Actor run failed with status:") {
			status := strings.TrimSpace(strings.TrimPrefix(l, "Actor run failed with status:"))
			switch status {
			case "ABORTED":
				return "Apify aborted the run — likely hit plan memory/duration limit. Check the run in console.apify.com."
			case "TIMED-OUT":
				return "Apify timed out fetching results (LinkedIn slow or blocked). Try a narrower query."
			case "FAILED":
				return "Apify actor crashed. Check run logs at console.apify.com."
			default:
				return "Apify run failed: " + status
			}
		}
	}
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "Error:") || strings.HasPrefix(line, "ERROR:") {
			return line
		}
	}
	return "scrape failed (see server logs)"
}

// loadClaudeEnv reads ~/.claude/.env and returns KEY=VALUE lines suitable for
// extending cmd.Env. Needed because launchctl-started services don't inherit
// the user's shell env where APIFY_TOKEN etc. are typically set.
func loadClaudeEnv() []string {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	raw, err := os.ReadFile(filepath.Join(home, ".claude", ".env"))
	if err != nil {
		return nil
	}
	var out []string
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimPrefix(line, "export ")
		eq := strings.Index(line, "=")
		if eq <= 0 {
			continue
		}
		k := strings.TrimSpace(line[:eq])
		v := strings.TrimSpace(line[eq+1:])
		// Strip surrounding quotes
		if len(v) >= 2 && (v[0] == '"' || v[0] == '\'') && v[len(v)-1] == v[0] {
			v = v[1 : len(v)-1]
		}
		out = append(out, k+"="+v)
	}
	return out
}

// ----- Wizard handlers -----
//
// Preview is async: the Apify scrape can take 2+ minutes, well past any
// reasonable HTTP timeout. POST /preview kicks off a goroutine and returns
// a run_id immediately. The wizard then polls GET /preview/{runID}.

type previewRun struct {
	Status   string        `json:"status"` // running|done|error
	Error    string        `json:"error,omitempty"`
	Total    int           `json:"total,omitempty"`
	Titles   []wizardTitle `json:"titles,omitempty"`
	Query    string        `json:"query,omitempty"`
	Queries  []string      `json:"queries,omitempty"`
	Location string        `json:"location,omitempty"`
	// Sources chosen for this run and their per-source progress (items + status).
	// Status values: pending | running | done | error.
	Sources  []string                  `json:"sources,omitempty"`
	Progress map[string]sourceProgress `json:"progress,omitempty"`
	// Result of the automatic import into the jobs DB that runs the moment
	// the scrape finishes. The UI reads these instead of opening a report.
	Imported    int       `json:"imported"`
	Updated     int       `json:"updated"`
	ImportError string    `json:"import_error,omitempty"`
	Started     time.Time `json:"-"`
	rawItems    []map[string]any
	seenJobIDs  map[string]bool
}

type sourceProgress struct {
	Status string `json:"status"`
	Items  int    `json:"items"`
	Error  string `json:"error,omitempty"`
}

// jobSource describes one marketplace scraper.
type jobSource struct {
	ID       string // "linkedin", "indeed", "glassdoor", "google"
	Label    string
	ToolFile string // script under ~/.claude/tools/jobs/
}

// jobSources is the canonical registry. Adding a new marketplace = add a row
// + write a tool file whose output matches the unified schema.
var jobSources = []jobSource{
	{ID: "linkedin", Label: "LinkedIn", ToolFile: "apify-linkedin-jobs.js"},
	{ID: "indeed", Label: "Indeed", ToolFile: "apify-indeed-jobs.js"},
	{ID: "glassdoor", Label: "Glassdoor", ToolFile: "apify-glassdoor-jobs.js"},
	{ID: "google", Label: "Google Jobs", ToolFile: "serpapi-google-jobs.js"},
	{ID: "upwork", Label: "Upwork", ToolFile: "apify-upwork-jobs.js"},
}

func findJobSource(id string) (jobSource, bool) {
	for _, s := range jobSources {
		if s.ID == id {
			return s, true
		}
	}
	return jobSource{}, false
}

var (
	previewRuns  = map[string]*previewRun{}
	previewRunMu = sync.Mutex{}
)

func setPreviewRun(id string, fn func(*previewRun)) {
	previewRunMu.Lock()
	defer previewRunMu.Unlock()
	r, ok := previewRuns[id]
	if !ok {
		r = &previewRun{Started: time.Now()}
		previewRuns[id] = r
	}
	fn(r)
}

func getPreviewRun(id string) (*previewRun, bool) {
	previewRunMu.Lock()
	defer previewRunMu.Unlock()
	r, ok := previewRuns[id]
	if !ok {
		return nil, false
	}
	// shallow copy to avoid racing on read
	cp := *r
	return &cp, true
}

// pruneOldPreviewRuns drops any runs older than 30 minutes. Called on each
// start; O(n) over the map which is tiny in practice.
func pruneOldPreviewRuns() {
	previewRunMu.Lock()
	defer previewRunMu.Unlock()
	cutoff := time.Now().Add(-2 * time.Hour)
	for id, r := range previewRuns {
		if r.Started.Before(cutoff) {
			delete(previewRuns, id)
		}
	}
}

// The wizard is a single-modal flow in the UI:
//   1. user fills titles/location/remote/salary/sources
//   2. POST /preview kicks off a multi-source scrape, returns a run_id
//   3. UI polls GET /preview/{runID} until done
//   4. UI opens /jobs/report/{runID} (PDF via browser print)
// Per-job resume tailoring was removed — the orchestrator picks one of
// Philip's hand-maintained Drive variants instead (see jobs-personal-linkedin).

type wizardTitle struct {
	Title          string `json:"title"`
	Count          int    `json:"count"`
	SampleJob      string `json:"sample_job"`
	SampleSalary   string `json:"sample_salary"`
	SampleLocation string `json:"sample_location"`
}

func handleWizardPreview(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Query    string   `json:"query"`   // legacy single-query support
		Queries  []string `json:"queries"` // preferred: multi-query fan-out
		Location string   `json:"location"`
		Limit    int      `json:"limit"`
		Remote   bool     `json:"remote"`
		Sources  []string `json:"sources"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	// Normalize to a list — Queries wins, fall back to Query.
	queries := make([]string, 0, len(body.Queries)+1)
	seen := map[string]bool{}
	for _, q := range body.Queries {
		q = strings.TrimSpace(q)
		if q == "" || len(q) > 200 || seen[strings.ToLower(q)] {
			continue
		}
		seen[strings.ToLower(q)] = true
		queries = append(queries, q)
	}
	if len(queries) == 0 && strings.TrimSpace(body.Query) != "" {
		queries = []string{strings.TrimSpace(body.Query)}
	}
	if len(queries) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "query or queries required"})
		return
	}
	if len(queries) > 12 {
		queries = queries[:12]
	}
	if body.Limit <= 0 {
		body.Limit = 500
	}
	if body.Limit > 1000 {
		body.Limit = 1000
	}
	loc := body.Location
	if body.Remote {
		for i, q := range queries {
			if !strings.Contains(strings.ToLower(q), "remote") {
				queries[i] = q + " remote"
			}
		}
	}
	if loc == "" {
		loc = "United States"
	}
	if len(body.Sources) == 0 {
		body.Sources = []string{"linkedin"}
	}

	// Validate sources and locate tool paths up front so a bad request fails
	// synchronously rather than silently in a goroutine.
	selected := make([]jobSource, 0, len(body.Sources))
	for _, id := range body.Sources {
		src, ok := findJobSource(id)
		if !ok {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unknown source: " + id})
			return
		}
		toolPath := filepath.Join(jobs.ToolsDir(), src.ToolFile)
		if _, err := os.Stat(toolPath); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "tool missing for " + src.ID + ": " + src.ToolFile})
			return
		}
		src.ToolFile = toolPath
		selected = append(selected, src)
	}

	pruneOldPreviewRuns()
	idBytes := make([]byte, 8)
	_, _ = rand.Read(idBytes)
	runID := hex.EncodeToString(idBytes)

	srcIDs := make([]string, len(selected))
	progress := map[string]sourceProgress{}
	for i, s := range selected {
		srcIDs[i] = s.ID
		progress[s.ID] = sourceProgress{Status: "pending"}
	}
	setPreviewRun(runID, func(r *previewRun) {
		r.Status = "running"
		r.Query = queries[0]
		r.Queries = append([]string{}, queries...)
		r.Location = loc
		r.Sources = srcIDs
		r.Progress = progress
	})

	go runMultiSourceScrape(runID, selected, queries, loc, body.Limit)

	writeJSON(w, http.StatusAccepted, map[string]any{
		"run_id":  runID,
		"status":  "running",
		"sources": srcIDs,
		"queries": queries,
	})
}

// runMultiSourceScrape fans out queries × sources in parallel, streams
// progress into the shared previewRun, and merges/dedupes the results. Each
// (query, source) pair is one Apify run; per-source progress counts are the
// sum across all queries.
func runMultiSourceScrape(runID string, sources []jobSource, queries []string, loc string, perQuerySourceLimit int) {
	var wg sync.WaitGroup
	for _, s := range sources {
		wg.Add(1)
		go func(src jobSource) {
			defer wg.Done()
			setSourceProgress(runID, src.ID, func(p *sourceProgress) { p.Status = "running" })
			var sourceErr string
			totalItems := 0
			for _, q := range queries {
				items, detail, err := runApifyScrape(src.ToolFile, q, loc, perQuerySourceLimit)
				if err != nil {
					log.Printf("[wizard %s] %s/%q failed: %v — %s", runID, src.ID, q, err, detail)
					if sourceErr == "" {
						sourceErr = detail
					}
					continue
				}
				for _, it := range items {
					if _, ok := it["source"]; !ok {
						it["source"] = src.ID
					}
				}
				mergeIntoRun(runID, items)
				totalItems += len(items)
				setSourceProgress(runID, src.ID, func(p *sourceProgress) { p.Items = totalItems })
			}
			setSourceProgress(runID, src.ID, func(p *sourceProgress) {
				if totalItems == 0 && sourceErr != "" {
					p.Status = "error"
					p.Error = sourceErr
				} else {
					p.Status = "done"
					p.Items = totalItems
				}
			})
		}(s)
	}
	wg.Wait()

	var (
		itemsForImport []map[string]any
		allErr         bool
	)
	setPreviewRun(runID, func(r *previewRun) {
		r.Titles = aggregateTitles(r.rawItems)
		r.Total = len(r.rawItems)
		// If every source errored, surface a top-level error; otherwise we
		// import and the UI shows per-source badges for partial failures.
		allErr = len(r.Progress) > 0
		for _, p := range r.Progress {
			if p.Status != "error" {
				allErr = false
				break
			}
		}
		if allErr {
			r.Status = "error"
			r.Error = "all sources failed"
			return
		}
		// Snapshot for the import. Status deliberately stays "running" until
		// the import lands, so the UI's poll sees "done" together with the
		// imported/updated counts — never a bare "done" with no table data.
		itemsForImport = make([]map[string]any, len(r.rawItems))
		copy(itemsForImport, r.rawItems)
	})
	if allErr {
		return
	}

	// Auto-import into the jobs DB so the table populates with zero manual
	// steps. The scrape *is* the pipeline — no report, no button.
	imported, updated, _, ierr := importWizardItems(runID, itemsForImport)

	// Score before reporting done. The importer stores every row at
	// resume_match = 0, so without this the board renders a table the user
	// cannot rank — which is the whole point of the scrape.
	if ierr == nil && imported > 0 {
		scoreImportedJobs(runID)
		// Research the best matches once they're scored. Fire-and-forget: the
		// briefing takes minutes (web research per company) and the board is
		// already usable without it, so it must not hold the run open.
		go buildWelcomePackage(runID)
	}

	setPreviewRun(runID, func(r *previewRun) {
		r.Imported = imported
		r.Updated = updated
		if ierr != nil {
			r.ImportError = ierr.Error()
		}
		r.Status = "done"
	})
}

// buildWelcomePackage researches the top matches of a run — what the company
// does, a sourced growth/profitability read, the real Glassdoor rating, a cover
// letter, and an honest resume-gap analysis — and writes a markdown briefing.
//
// Runs on a "better model" (opus) with web search, on the Claude subscription,
// so it costs no API spend. Best-effort: the board stands on its own without it.
func buildWelcomePackage(runID string) {
	tool := filepath.Join(jobs.ToolsDir(), "welcome-package.js")
	if _, err := os.Stat(tool); err != nil {
		log.Printf("[wizard %s] welcome package skipped: welcome-package.js not found", runID)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Minute)
	defer cancel()

	cmd := exec.CommandContext(ctx, "node", tool, "--top", "10", "--model", "opus")
	cmd.Env = append(os.Environ(), loadClaudeEnv()...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		log.Printf("[wizard %s] welcome package failed: %v — %s", runID, err, truncate(string(out), 200))
		postRunSummary(runID, "the briefing failed to build")
		return
	}
	log.Printf("[wizard %s] welcome package: %s", runID, truncate(strings.TrimSpace(string(out)), 300))
	postRunSummary(runID, "")
}

// postRunSummary sends the Slack digest for a finished run. This lives in the
// router because the scheduled agent exits the moment it kicks the scrape off —
// it cannot report on work that outlives it.
func postRunSummary(runID, warning string) {
	r, ok := getPreviewRun(runID)
	if !ok {
		return
	}
	s, err := getJobStore()
	if err != nil {
		return
	}
	top, err := s.ListJobs(jobs.ListFilter{OrderBy: "score", Limit: 5})
	if err != nil {
		log.Printf("[wizard %s] summary query failed: %v", runID, err)
		return
	}

	var b strings.Builder
	fmt.Fprintf(&b, ":briefcase: *Jobs run complete* — %d imported, %d updated\n", r.Imported, r.Updated)
	for id, p := range r.Progress {
		if p.Items == 0 {
			fmt.Fprintf(&b, "> :warning: `%s` returned nothing\n", id)
		}
	}
	if warning != "" {
		fmt.Fprintf(&b, "> :warning: %s\n", warning)
	}
	b.WriteString("\n*Top matches*\n")
	for _, j := range top {
		flag := ""
		if j.IsIntermediary {
			flag = " :warning: _agency repost_"
		}
		fmt.Fprintf(&b, "• *%d* — %s @ %s%s\n", j.ResumeMatch, j.Title, j.Company, flag)
	}
	b.WriteString("\nOpen the board for the welcome packages: http://localhost:57710/jobs")

	notify.JobsRun(b.String())
	log.Printf("[wizard %s] posted Slack summary", runID)
}

// scoreImportedJobs rates any unscored rows against the candidate's resume via
// score-jobs.js. Best-effort: a scoring failure leaves resume_match at 0 rather
// than failing the scrape, since the jobs themselves imported fine.
func scoreImportedJobs(runID string) {
	tool := filepath.Join(jobs.ToolsDir(), "score-jobs.js")
	if _, err := os.Stat(tool); err != nil {
		log.Printf("[wizard %s] scoring skipped: score-jobs.js not found", runID)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	cmd := exec.CommandContext(ctx, "node", tool, "--limit", "300", "--batch", "20")
	cmd.Env = append(os.Environ(), loadClaudeEnv()...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		log.Printf("[wizard %s] scoring failed: %v — %s", runID, err, truncate(string(out), 200))
		return
	}
	log.Printf("[wizard %s] scoring done: %s", runID, truncate(strings.TrimSpace(string(out)), 300))
}

// setSourceProgress updates a single source's progress record atomically.
func setSourceProgress(runID, source string, fn func(*sourceProgress)) {
	previewRunMu.Lock()
	defer previewRunMu.Unlock()
	r, ok := previewRuns[runID]
	if !ok {
		return
	}
	if r.Progress == nil {
		r.Progress = map[string]sourceProgress{}
	}
	p := r.Progress[source]
	fn(&p)
	r.Progress[source] = p
}

// mergeIntoRun dedupes new items into the run by (source, jobId) first and,
// as a cross-source fallback, by (companyLower, titleLower, locationCity).
// Cross-source duplicates collapse into one row (longest description wins).
func mergeIntoRun(runID string, items []map[string]any) {
	previewRunMu.Lock()
	defer previewRunMu.Unlock()
	r, ok := previewRuns[runID]
	if !ok {
		return
	}
	if r.seenJobIDs == nil {
		r.seenJobIDs = map[string]bool{}
	}
	// Build a cross-source key index of existing items so we can merge.
	crossKey := func(it map[string]any) string {
		co, _ := it["company"].(string)
		ti, _ := it["standardizedTitle"].(string)
		if strings.TrimSpace(ti) == "" {
			ti, _ = it["title"].(string)
		}
		lo, _ := it["location"].(string)
		city := strings.SplitN(lo, ",", 2)[0]
		return strings.ToLower(strings.TrimSpace(co)) + "|" +
			strings.ToLower(strings.TrimSpace(ti)) + "|" +
			strings.ToLower(strings.TrimSpace(city))
	}
	existing := map[string]int{}
	for i, it := range r.rawItems {
		existing[crossKey(it)] = i
	}
	for _, it := range items {
		src, _ := it["source"].(string)
		id, _ := it["jobId"].(string)
		perSrcKey := src + "|" + id
		if id != "" && r.seenJobIDs[perSrcKey] {
			continue
		}
		if id != "" {
			r.seenJobIDs[perSrcKey] = true
		}
		k := crossKey(it)
		if idx, dup := existing[k]; dup {
			// Cross-source duplicate — keep the existing row but track the
			// extra source + prefer the longer description.
			old := r.rawItems[idx]
			srcs, _ := old["sources"].([]string)
			if len(srcs) == 0 {
				if s, _ := old["source"].(string); s != "" {
					srcs = []string{s}
				}
			}
			if src != "" {
				seen := false
				for _, s := range srcs {
					if s == src {
						seen = true
						break
					}
				}
				if !seen {
					srcs = append(srcs, src)
				}
			}
			old["sources"] = srcs
			oldDesc, _ := old["fullDescription"].(string)
			newDesc, _ := it["fullDescription"].(string)
			if len(newDesc) > len(oldDesc) {
				old["fullDescription"] = newDesc
				old["descriptionSnippet"] = it["descriptionSnippet"]
			}
			// Prefer a salary value if the existing row has none.
			if oldSal, _ := old["salary"].(string); strings.TrimSpace(oldSal) == "" {
				if newSal, _ := it["salary"].(string); strings.TrimSpace(newSal) != "" {
					old["salary"] = newSal
				}
			}
			r.rawItems[idx] = old
			continue
		}
		// New row.
		if src != "" {
			it["sources"] = []string{src}
		}
		r.rawItems = append(r.rawItems, it)
		existing[k] = len(r.rawItems) - 1
	}
}

// runApifyScrape executes apify-linkedin-jobs.js and returns the parsed items
// plus a user-friendly error detail string if the run failed. Shared by the
// initial preview scrape and the scrape-more expansion.
func runApifyScrape(tool, query, loc string, limit int) ([]map[string]any, string, error) {
	tmp, err := os.CreateTemp("", "wizard-scrape-*.json")
	if err != nil {
		return nil, err.Error(), err
	}
	tmp.Close()
	defer os.Remove(tmp.Name())

	// Give the subprocess 5 extra min over its own 30-min ceiling so it has
	// time to abort the Apify run and fetch the partial dataset before we
	// kill it. Hard-killing mid-salvage loses the data we're trying to save.
	ctx, cancel := context.WithTimeout(context.Background(), 35*time.Minute)
	defer cancel()
	args := []string{tool, query, "--location", loc, "--output", tmp.Name()}
	if limit > 0 {
		args = append(args, "--limit", strconv.Itoa(limit))
	}
	cmd := exec.CommandContext(ctx, "node", args...)
	cmd.Env = append(os.Environ(), loadClaudeEnv()...)
	out, err := cmd.CombinedOutput()
	// Try to read the output file regardless of whether node exited with an
	// error — the tool flushes salvaged items to disk before exiting, and the
	// Go context timeout can kill node mid-write. If items parsed out, we
	// return them as a successful partial result.
	raw, readErr := os.ReadFile(tmp.Name())
	if readErr == nil && len(raw) > 0 {
		var items []map[string]any
		if jsonErr := json.Unmarshal(raw, &items); jsonErr == nil && len(items) > 0 {
			if err != nil {
				log.Printf("[apify] node exited with %v but salvaged %d items from partial dataset", err, len(items))
			}
			return items, "", nil
		}
	}
	if err != nil {
		return nil, extractErrorDetail(string(out)), err
	}
	if readErr != nil || len(raw) == 0 {
		return nil, "no results returned", fmt.Errorf("empty output")
	}
	var items []map[string]any
	if jsonErr := json.Unmarshal(raw, &items); jsonErr != nil {
		return nil, "unparseable apify output", jsonErr
	}
	return items, "", nil
}

// aggregateTitles groups scraped items by standardizedTitle (falling back to
// title) and returns a stable, count-sorted list of wizardTitle entries.
func aggregateTitles(items []map[string]any) []wizardTitle {
	type agg struct {
		count     int
		sampleCo  string
		sampleSal string
		sampleLoc string
	}
	groups := map[string]*agg{}
	for _, it := range items {
		t, _ := it["standardizedTitle"].(string)
		if strings.TrimSpace(t) == "" {
			t, _ = it["title"].(string)
		}
		t = strings.TrimSpace(t)
		if t == "" {
			continue
		}
		g, ok := groups[t]
		if !ok {
			g = &agg{}
			groups[t] = g
		}
		g.count++
		if g.sampleCo == "" {
			if c, _ := it["company"].(string); c != "" {
				g.sampleCo = c
			}
			if s, _ := it["salary"].(string); s != "" {
				g.sampleSal = s
			}
			if l, _ := it["location"].(string); l != "" {
				g.sampleLoc = l
			}
		}
	}
	titles := make([]wizardTitle, 0, len(groups))
	for t, g := range groups {
		titles = append(titles, wizardTitle{
			Title: t, Count: g.count,
			SampleJob: g.sampleCo, SampleSalary: g.sampleSal, SampleLocation: g.sampleLoc,
		})
	}
	sort.Slice(titles, func(i, j int) bool {
		if titles[i].Count != titles[j].Count {
			return titles[i].Count > titles[j].Count
		}
		return titles[i].Title < titles[j].Title
	})
	return titles
}

func handleWizardPreviewStatus(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "runID")
	run, ok := getPreviewRun(id)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "unknown run_id"})
		return
	}
	writeJSON(w, http.StatusOK, run)
}

// handleWizardReport returns the full scrape results for a run so the
// /jobs/report/{runID} page can render a print-optimized table. The UI then
// lets the user "Save as PDF" via their browser.
func handleWizardReport(w http.ResponseWriter, r *http.Request) {
	runID := chi.URLParam(r, "runID")
	previewRunMu.Lock()
	real, ok := previewRuns[runID]
	if !ok {
		previewRunMu.Unlock()
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "unknown run_id"})
		return
	}
	status := real.Status
	items := make([]map[string]any, len(real.rawItems))
	copy(items, real.rawItems)
	queries := append([]string{}, real.Queries...)
	sources := append([]string{}, real.Sources...)
	location := real.Location
	started := real.Started
	previewRunMu.Unlock()

	if status != "done" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "scrape not finished"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"run_id":   runID,
		"queries":  queries,
		"sources":  sources,
		"location": location,
		"started":  started,
		"total":    len(items),
		"items":    items,
	})
}

// wizardImportColumns maps a CSV header (exactly the strings jobs-db.js
// importCsv's headerMap keys on) to the camelCase field the Apify scrape
// tools emit. "Resume Match" and "Application Status" are intentionally
// omitted: importCsv defaults them to 0 / "new" — wizard scrapes are
// unscored, the orchestrator/UI assigns variants and scores later.
var wizardImportColumns = []struct{ Header, Key string }{
	{"Category", "searchQuery"},
	{"Title", "title"},
	{"Standardized Title", "standardizedTitle"},
	{"Company", "company"},
	{"Company URL", "companyUrl"},
	{"Company Website", "companyWebsite"},
	{"Company Description", "companyDescription"},
	{"Employee Count", "companyEmployeeCount"},
	{"Company HQ", "companyHQ"},
	{"Industry", "companyIndustry"},
	{"Location", "location"},
	{"Workplace Type", "workplaceTypes"},
	{"Remote", "workRemoteAllowed"},
	{"Seniority Level", "seniorityLevel"},
	{"Employment Type", "employmentType"},
	{"Job Function", "jobFunction"},
	{"Years Required", "yearsExperience"},
	{"Education", "education"},
	{"Salary", "salary"},
	{"Skills & Technologies", "skills"},
	{"Benefits", "benefits"},
	{"Applicants", "applicants"},
	{"Easy Apply", "easyApply"},
	{"Posted", "postedAt"},
	{"Apply URL", "applyUrl"},
	{"Job URL", "jobUrl"},
	{"Description Summary", "descriptionSnippet"},
	{"Source", "source"},
}

// csvCell flattens a scraped value to a single CSV cell. jobs-db.js parses
// the CSV line-by-line, so any embedded newline would corrupt the row —
// collapse all whitespace, then quote/escape per its csvEscape rules.
func csvCell(v any) string {
	if v == nil {
		return ""
	}
	s := fmt.Sprintf("%v", v)
	s = strings.ReplaceAll(s, "\r", " ")
	s = strings.ReplaceAll(s, "\n", " ")
	if strings.ContainsAny(s, ",\"") {
		return `"` + strings.ReplaceAll(s, `"`, `""`) + `"`
	}
	return s
}

// importWizardItems serializes scraped items to the CSV jobs-db.js expects
// and runs the importer (SWE filter, list-corruption repair, dedupe upsert
// all happen there). Returns the new/updated counts. Called automatically
// when a scrape finishes so the wizard populates the table with no manual
// step — the scrape is the pipeline.
func importWizardItems(runID string, items []map[string]any) (imported, updated int, output string, err error) {
	if len(items) == 0 {
		return 0, 0, "", fmt.Errorf("no items to import")
	}

	// importCsv derives week_tag from a YYYY-MM-DD in the filename.
	date := time.Now().Format("2006-01-02")
	tmp, err := os.CreateTemp("", "wizard-import-"+date+"-*.csv")
	if err != nil {
		return 0, 0, "", err
	}
	defer os.Remove(tmp.Name())

	var b strings.Builder
	for i, c := range wizardImportColumns {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(c.Header)
	}
	b.WriteByte('\n')
	for _, it := range items {
		for i, c := range wizardImportColumns {
			if i > 0 {
				b.WriteByte(',')
			}
			b.WriteString(csvCell(it[c.Key]))
		}
		b.WriteByte('\n')
	}
	if _, werr := tmp.WriteString(b.String()); werr != nil {
		tmp.Close()
		return 0, 0, "", werr
	}
	tmp.Close()

	jobsDB := filepath.Join(jobs.ToolsDir(), "jobs-db.js")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, "node", jobsDB, "import", tmp.Name())
	cmd.Env = append(os.Environ(), loadClaudeEnv()...)
	out, cerr := cmd.CombinedOutput()
	if cerr != nil {
		log.Printf("[wizard %s] import failed: %v — %s", runID, cerr, string(out))
		return 0, 0, string(out), fmt.Errorf("import failed: %s", extractErrorDetail(string(out)))
	}

	// jobs-db.js prints "Imported: N new jobs" / "Updated: N existing jobs".
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if v, ok := strings.CutPrefix(line, "Imported:"); ok {
			imported = leadingInt(v)
		} else if v, ok := strings.CutPrefix(line, "Updated:"); ok {
			updated = leadingInt(v)
		}
	}
	log.Printf("[wizard %s] imported %d new, %d updated (%d scraped)", runID, imported, updated, len(items))
	return imported, updated, strings.TrimSpace(string(out)), nil
}

// handleWizardImport is a manual re-trigger of the DB import for a still
// in-memory run. The scrape now imports automatically on completion, so
// this is only a fallback (e.g. retry after a transient DB lock).
func handleWizardImport(w http.ResponseWriter, r *http.Request) {
	runID := chi.URLParam(r, "runID")
	previewRunMu.Lock()
	real, ok := previewRuns[runID]
	if !ok {
		previewRunMu.Unlock()
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "unknown run_id"})
		return
	}
	status := real.Status
	items := make([]map[string]any, len(real.rawItems))
	copy(items, real.rawItems)
	previewRunMu.Unlock()

	if status != "done" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "scrape not finished"})
		return
	}

	imported, updated, out, err := importWizardItems(runID, items)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{
			"error":  "import failed",
			"detail": err.Error(),
		})
		return
	}
	setPreviewRun(runID, func(rr *previewRun) {
		rr.Imported = imported
		rr.Updated = updated
		rr.ImportError = ""
	})
	writeJSON(w, http.StatusOK, map[string]any{
		"run_id":   runID,
		"scraped":  len(items),
		"imported": imported,
		"updated":  updated,
		"skipped":  len(items) - imported - updated,
		"output":   out,
	})
}

// leadingInt pulls the first run of digits out of a string ("  5 new jobs"
// -> 5), returning 0 if there is none.
func leadingInt(s string) int {
	s = strings.TrimSpace(s)
	end := 0
	for end < len(s) && s[end] >= '0' && s[end] <= '9' {
		end++
	}
	if end == 0 {
		return 0
	}
	n, _ := strconv.Atoi(s[:end])
	return n
}

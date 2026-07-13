// Package jobs reads the shared jobs SQLite database that the jobs-scrape
// agent populates and the jobs-apply agent mutates. The DB lives at
// ~/.claude/data/jobs.db (override with WINSTON_JOBS_DB) and is shared
// across the Claude agent pipeline and this web app.
package jobs

import (
	"database/sql"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"

	_ "modernc.org/sqlite"
)

// Job mirrors a row from the jobs table. Fields use pointers or empty strings
// rather than sql.NullString because the UI always renders strings.
type Job struct {
	JobID              string `json:"job_id"`
	Title              string `json:"title"`
	StandardizedTitle  string `json:"standardized_title"`
	Company            string `json:"company"`
	CompanyURL         string `json:"company_url"`
	CompanyWebsite     string `json:"company_website"`
	CompanyDescription string `json:"company_description"`
	CompanyEmployees   string `json:"company_employees"`
	CompanyHQ          string `json:"company_hq"`
	ContactEmail       string `json:"contact_email"`
	ContactType        string `json:"contact_type"`
	CareersURL         string `json:"careers_url"`
	Industry           string `json:"industry"`
	Location           string `json:"location"`
	WorkplaceType      string `json:"workplace_type"`
	Remote             string `json:"remote"`
	SeniorityLevel     string `json:"seniority_level"`
	EmploymentType     string `json:"employment_type"`
	JobFunction        string `json:"job_function"`
	YearsRequired      string `json:"years_required"`
	Education          string `json:"education"`
	Salary             string `json:"salary"`
	Skills             string `json:"skills"`
	Benefits           string `json:"benefits"`
	Applicants         string `json:"applicants"`
	EasyApply          string `json:"easy_apply"`
	PostedAt           string `json:"posted_at"`
	ApplyURL           string `json:"apply_url"`
	JobURL             string `json:"job_url"`
	DescriptionSummary string `json:"description_summary"`
	Category           string `json:"category"`
	ResumeMatch        int    `json:"resume_match"`
	ApplicationStatus  string `json:"application_status"`
	ResumeVariant      string `json:"resume_variant"`
	DriveFolderURL     string `json:"drive_folder_url"`
	Notes              string `json:"notes"`
	FirstSeenAt        string `json:"first_seen_at"`
	LastSeenAt         string `json:"last_seen_at"`
	AppliedAt          string `json:"applied_at"`
	WeekTag            string `json:"week_tag"`
	Flagged            bool   `json:"flagged"`
	Source             string `json:"source"`
}

// Store owns the SQLite handle.
type Store struct {
	db     *sql.DB
	dbPath string
	mu     sync.Mutex
}

// NewStore opens (or creates) the jobs DB. Missing DB is not fatal — the UI
// shows an empty state until the agent populates it.
func NewStore() (*Store, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	dbPath := os.Getenv("WINSTON_JOBS_DB")
	if dbPath == "" {
		// Prefer an existing codephil-jobs.db (the historical Winston layout)
		// so a fresh install doesn't silently create an empty jobs.db while
		// the real data sits unread next to it.
		codephil := filepath.Join(home, ".claude", "data", "codephil-jobs.db")
		if _, err := os.Stat(codephil); err == nil {
			dbPath = codephil
		} else {
			dbPath = filepath.Join(home, ".claude", "data", "jobs.db")
		}
	}
	if _, err := os.Stat(dbPath); os.IsNotExist(err) {
		if err := os.MkdirAll(filepath.Dir(dbPath), 0o755); err != nil {
			return nil, err
		}
	}
	// Open read-write; node tool still owns writes for status updates, but we
	// want to be able to upsert notes/status from the UI.
	db, err := sql.Open("sqlite", "file:"+dbPath+"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, err
	}
	// Lazy migration: add flagged column if missing. Node tool owns schema,
	// but this column is UI-only so we add it here defensively.
	_, _ = db.Exec(`ALTER TABLE jobs ADD COLUMN flagged INTEGER DEFAULT 0`)
	// Lazy migration: add source column. Pre-Upwork rows are all from LinkedIn,
	// so default to 'linkedin'. New imports populate explicitly via jobs-db.js.
	_, _ = db.Exec(`ALTER TABLE jobs ADD COLUMN source TEXT DEFAULT 'linkedin'`)
	// Lazy migration: company-level recruiting contact, filled by the
	// enrich-contacts pass (company-contacts.js). Corporate role mailboxes and
	// careers pages only — never an individual's address.
	_, _ = db.Exec(`ALTER TABLE jobs ADD COLUMN contact_email TEXT DEFAULT ''`)
	_, _ = db.Exec(`ALTER TABLE jobs ADD COLUMN contact_type TEXT DEFAULT ''`)
	_, _ = db.Exec(`ALTER TABLE jobs ADD COLUMN careers_url TEXT DEFAULT ''`)
	_, _ = db.Exec(`UPDATE jobs SET source = 'linkedin' WHERE source IS NULL OR source = ''`)
	_, _ = db.Exec(`CREATE INDEX IF NOT EXISTS idx_jobs_source ON jobs(source)`)
	return &Store{db: db, dbPath: dbPath}, nil
}

func (s *Store) Close() error { return s.db.Close() }

// ListFilter narrows ListJobs results.
type ListFilter struct {
	Status       string
	MinScore     int
	Search       string
	Week         string
	Source       string // "linkedin"|"upwork"|"indeed"|"glassdoor"|"google"; "" = all
	Limit        int
	Offset       int
	OrderBy      string // "score" (default), "posted", "applied"
	Flagged      bool
	IncludeStale bool // if false, drop jobs posted > 60d ago (keep applied+)
}

// staleExcludeSQL is the shared WHERE fragment that hides stale rows. We keep
// anything that's actively in a later stage of the funnel (applied → offered)
// even if the post itself has aged out, since losing those rows destroys
// application history.
const staleExcludeSQL = ` AND (
	application_status IN ('applied','interviewing','offered','withdrawn','needs_manual','application_failed')
	OR posted_at = ''
	OR posted_at >= date('now', '-60 days')
)`

// ListJobs returns rows ordered for the UI.
func (s *Store) ListJobs(f ListFilter) ([]Job, error) {
	q := `SELECT job_id, title, standardized_title, company, company_url, company_website,
		company_description, company_employees, company_hq, industry, location, workplace_type,
		remote, seniority_level, employment_type, job_function, years_required, education,
		salary, skills, benefits, applicants, easy_apply, posted_at, apply_url, job_url,
		description_summary, category, resume_match, application_status, resume_variant,
		drive_folder_url, notes, first_seen_at, last_seen_at, applied_at, week_tag,
		COALESCE(flagged, 0), COALESCE(source, 'linkedin'),
		COALESCE(contact_email, ''), COALESCE(contact_type, ''), COALESCE(careers_url, '')
		FROM jobs WHERE 1=1`
	var args []any
	if f.Status != "" && f.Status != "all" {
		q += " AND application_status = ?"
		args = append(args, f.Status)
	}
	if f.MinScore > 0 {
		q += " AND resume_match >= ?"
		args = append(args, f.MinScore)
	}
	if f.Week != "" {
		q += " AND week_tag = ?"
		args = append(args, f.Week)
	}
	if f.Search != "" {
		q += " AND (title LIKE ? OR company LIKE ? OR skills LIKE ?)"
		like := "%" + f.Search + "%"
		args = append(args, like, like, like)
	}
	if f.Flagged {
		q += " AND COALESCE(flagged, 0) = 1"
	}
	if f.Source != "" && f.Source != "all" {
		q += " AND COALESCE(source, 'linkedin') = ?"
		args = append(args, f.Source)
	}
	if !f.IncludeStale {
		q += staleExcludeSQL
	}
	switch f.OrderBy {
	case "posted":
		q += " ORDER BY posted_at DESC"
	case "applied":
		q += " ORDER BY applied_at DESC NULLS LAST, resume_match DESC"
	default:
		q += " ORDER BY resume_match DESC, posted_at DESC"
	}
	if f.Limit > 0 {
		q += fmt.Sprintf(" LIMIT %d OFFSET %d", f.Limit, f.Offset)
	}

	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Job{}
	for rows.Next() {
		var j Job
		var (
			stdTitle, cURL, cWeb, cDesc, cEmp, cHQ, ind, loc, wType, rem, sen, emp, fn,
			yrs, edu, sal, sk, ben, apps, easy, posted, applyU, jobU, desc, cat, variant,
			drive, notes, firstSeen, lastSeen, appliedAt, weekTag sql.NullString
			flagged                               int
			source                                string
			contactEmail, contactType, careersURL string
		)
		if err := rows.Scan(
			&j.JobID, &j.Title, &stdTitle, &j.Company, &cURL, &cWeb, &cDesc, &cEmp, &cHQ,
			&ind, &loc, &wType, &rem, &sen, &emp, &fn, &yrs, &edu, &sal, &sk, &ben, &apps,
			&easy, &posted, &applyU, &jobU, &desc, &cat, &j.ResumeMatch, &j.ApplicationStatus,
			&variant, &drive, &notes, &firstSeen, &lastSeen, &appliedAt, &weekTag, &flagged, &source,
			&contactEmail, &contactType, &careersURL,
		); err != nil {
			return nil, err
		}
		j.ContactEmail = contactEmail
		j.ContactType = contactType
		j.CareersURL = careersURL
		j.Source = source
		j.Flagged = flagged == 1
		j.StandardizedTitle = stdTitle.String
		j.CompanyURL = cURL.String
		j.CompanyWebsite = cWeb.String
		j.CompanyDescription = cDesc.String
		j.CompanyEmployees = cEmp.String
		j.CompanyHQ = cHQ.String
		j.Industry = ind.String
		j.Location = loc.String
		j.WorkplaceType = wType.String
		j.Remote = rem.String
		j.SeniorityLevel = sen.String
		j.EmploymentType = emp.String
		j.JobFunction = fn.String
		j.YearsRequired = yrs.String
		j.Education = edu.String
		j.Salary = sal.String
		j.Skills = sk.String
		j.Benefits = ben.String
		j.Applicants = apps.String
		j.EasyApply = easy.String
		j.PostedAt = posted.String
		j.ApplyURL = applyU.String
		j.JobURL = jobU.String
		j.DescriptionSummary = desc.String
		j.Category = cat.String
		j.ResumeVariant = variant.String
		j.DriveFolderURL = drive.String
		j.Notes = notes.String
		j.FirstSeenAt = firstSeen.String
		j.LastSeenAt = lastSeen.String
		j.AppliedAt = appliedAt.String
		j.WeekTag = weekTag.String
		out = append(out, j)
	}
	return out, rows.Err()
}

// CountJobs returns the total number of rows matching a filter, ignoring
// Limit/Offset. Used for pagination headers.
func (s *Store) CountJobs(f ListFilter) (int, error) {
	q := `SELECT COUNT(*) FROM jobs WHERE 1=1`
	var args []any
	if f.Status != "" && f.Status != "all" {
		q += " AND application_status = ?"
		args = append(args, f.Status)
	}
	if f.MinScore > 0 {
		q += " AND resume_match >= ?"
		args = append(args, f.MinScore)
	}
	if f.Week != "" {
		q += " AND week_tag = ?"
		args = append(args, f.Week)
	}
	if f.Search != "" {
		q += " AND (title LIKE ? OR company LIKE ? OR skills LIKE ?)"
		like := "%" + f.Search + "%"
		args = append(args, like, like, like)
	}
	if f.Flagged {
		q += " AND COALESCE(flagged, 0) = 1"
	}
	if f.Source != "" && f.Source != "all" {
		q += " AND COALESCE(source, 'linkedin') = ?"
		args = append(args, f.Source)
	}
	if !f.IncludeStale {
		q += staleExcludeSQL
	}
	var n int
	err := s.db.QueryRow(q, args...).Scan(&n)
	return n, err
}

// DeleteJob hard-deletes a row. Refuses when the job is in a later-funnel
// status to prevent accidental loss of application history.
func (s *Store) DeleteJob(jobID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	var status string
	if err := s.db.QueryRow(`SELECT application_status FROM jobs WHERE job_id=?`, jobID).Scan(&status); err != nil {
		if err == sql.ErrNoRows {
			return fmt.Errorf("job %q not found", jobID)
		}
		return err
	}
	switch status {
	case "applied", "interviewing", "offered", "withdrawn":
		return fmt.Errorf("refusing to delete — status=%q (use status update to archive)", status)
	}
	_, err := s.db.Exec(`DELETE FROM jobs WHERE job_id=?`, jobID)
	return err
}

// PruneStale hard-deletes rows with posted_at older than 8 weeks (56 days),
// except anything in a later funnel stage. Safe to run repeatedly.
func (s *Store) PruneStale() (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	res, err := s.db.Exec(`DELETE FROM jobs
		WHERE posted_at != ''
		  AND posted_at < date('now', '-56 days')
		  AND application_status NOT IN ('applied','interviewing','offered','withdrawn','needs_manual','application_failed')`)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return n, nil
}

// Stats returns counts per application_status for the dashboard header.
type Stats struct {
	Total       int            `json:"total"`
	ByStatus    map[string]int `json:"by_status"`
	ByCategory  map[string]int `json:"by_category"`
	AvgScore    float64        `json:"avg_score"`
	LastRun     string         `json:"last_run"`
	HighScoring int            `json:"high_scoring"` // ≥80
}

func (s *Store) Stats() (Stats, error) {
	st := Stats{ByStatus: map[string]int{}, ByCategory: map[string]int{}}
	rows, err := s.db.Query(`SELECT application_status, COUNT(*) FROM jobs GROUP BY application_status`)
	if err != nil {
		return st, err
	}
	for rows.Next() {
		var status string
		var n int
		if err := rows.Scan(&status, &n); err != nil {
			rows.Close()
			return st, err
		}
		st.ByStatus[status] = n
		st.Total += n
	}
	rows.Close()

	rows2, err := s.db.Query(`SELECT category, COUNT(*) FROM jobs WHERE category != '' GROUP BY category`)
	if err == nil {
		for rows2.Next() {
			var cat string
			var n int
			rows2.Scan(&cat, &n)
			st.ByCategory[cat] = n
		}
		rows2.Close()
	}

	_ = s.db.QueryRow(`SELECT COALESCE(AVG(resume_match),0) FROM jobs`).Scan(&st.AvgScore)
	_ = s.db.QueryRow(`SELECT COUNT(*) FROM jobs WHERE resume_match >= 80`).Scan(&st.HighScoring)
	_ = s.db.QueryRow(`SELECT COALESCE(MAX(last_seen_at), '') FROM jobs`).Scan(&st.LastRun)
	return st, nil
}

// UpdateStatus is used when a human overrides auto-applied status from the UI.
func (s *Store) UpdateStatus(jobID, newStatus, notes string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	valid := map[string]bool{
		"new": true, "drafted": true, "applied": true, "interviewing": true,
		"offered": true, "rejected": true, "expired": true, "withdrawn": true,
		"needs_manual": true, "application_failed": true,
	}
	if !valid[newStatus] {
		return fmt.Errorf("invalid status %q", newStatus)
	}
	var prev string
	_ = s.db.QueryRow(`SELECT application_status FROM jobs WHERE job_id=?`, jobID).Scan(&prev)
	if prev == "" {
		return fmt.Errorf("job %q not found", jobID)
	}
	_, err := s.db.Exec(`UPDATE jobs SET application_status=?, notes=COALESCE(?, notes),
		applied_at = CASE WHEN ?='applied' THEN datetime('now') ELSE applied_at END
		WHERE job_id=?`, newStatus, sql.NullString{String: notes, Valid: notes != ""}, newStatus, jobID)
	if err != nil {
		return err
	}
	_, _ = s.db.Exec(`INSERT INTO application_log (job_id, old_status, new_status, notes) VALUES (?,?,?,?)`,
		jobID, prev, newStatus, sql.NullString{String: notes, Valid: notes != ""})
	return nil
}

// SetVariant overrides the resume_variant for a single job. Valid variants
// match jobs-db.js: full-stack, frontend, backend, ai-ml, devops. Empty string
// clears the override and lets the next import re-classify.
func (s *Store) SetVariant(jobID, variant string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	valid := map[string]bool{
		"":           true, // allow clearing
		"full-stack": true, "frontend": true, "backend": true,
		"ai-ml": true, "devops": true,
	}
	if !valid[variant] {
		return fmt.Errorf("invalid variant %q (use full-stack|frontend|backend|ai-ml|devops or empty to clear)", variant)
	}
	res, err := s.db.Exec(`UPDATE jobs SET resume_variant=? WHERE job_id=?`, variant, jobID)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("job %q not found", jobID)
	}
	return nil
}

// SetFlag toggles the UI-only flagged bit on a job row.
func (s *Store) SetFlag(jobID string, flagged bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	v := 0
	if flagged {
		v = 1
	}
	res, err := s.db.Exec(`UPDATE jobs SET flagged=? WHERE job_id=?`, v, jobID)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("job %q not found", jobID)
	}
	return nil
}

// CompanyNeedingContact is one company awaiting a recruiting-contact lookup.
type CompanyNeedingContact struct {
	Company string
	Website string
}

// CompaniesNeedingContact returns distinct companies that have a website but no
// contact looked up yet — one row per company, so enrichment fetches each site
// once rather than once per job.
func (s *Store) CompaniesNeedingContact(limit int) ([]CompanyNeedingContact, error) {
	rows, err := s.db.Query(`
		SELECT company, MIN(company_website)
		FROM jobs
		WHERE company_website IS NOT NULL AND company_website != ''
		  AND COALESCE(contact_email, '') = '' AND COALESCE(careers_url, '') = ''
		GROUP BY company
		LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []CompanyNeedingContact
	for rows.Next() {
		var c CompanyNeedingContact
		if err := rows.Scan(&c.Company, &c.Website); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// SetCompanyContact writes the looked-up contact onto every job for that
// company. Contact data is company-level, so it is stored per company.
func (s *Store) SetCompanyContact(company, email, contactType, careersURL string) (int64, error) {
	res, err := s.db.Exec(
		`UPDATE jobs SET contact_email = ?, contact_type = ?, careers_url = ? WHERE company = ?`,
		email, contactType, careersURL, company)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// ToolsDir resolves the directory holding the node helper tools. Override with
// WINSTON_JOBS_TOOLS_DIR; otherwise prefer an existing codephil tools dir (the
// historical Winston layout) and fall back to the generic jobs/ default.
func ToolsDir() string {
	if dir := os.Getenv("WINSTON_JOBS_TOOLS_DIR"); dir != "" {
		return dir
	}
	home, _ := os.UserHomeDir()
	codephil := filepath.Join(home, ".claude", "tools", "codephil")
	if _, err := os.Stat(codephil); err == nil {
		return codephil
	}
	return filepath.Join(home, ".claude", "tools", "jobs")
}

// RunTool executes a node helper tool from ToolsDir and returns its combined
// output. Used for the "Run now" button.
func RunTool(tool string, args []string) (string, error) {
	scriptPath := filepath.Join(ToolsDir(), tool)
	if _, err := os.Stat(scriptPath); err != nil {
		return "", fmt.Errorf("tool not found: %s", scriptPath)
	}
	full := append([]string{scriptPath}, args...)
	cmd := exec.Command("node", full...)
	out, err := cmd.CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

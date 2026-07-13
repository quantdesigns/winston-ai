#!/usr/bin/env node
/**
 * CodePhil Jobs Database Manager
 * SQLite-backed persistent job tracker across weekly runs.
 *
 * Usage:
 *   node jobs-db.js init                          — Create/migrate the database
 *   node jobs-db.js import <csv_path>             — Import jobs from weekly CSV (upserts, preserves status)
 *   node jobs-db.js exclude                       — Print job IDs to exclude (applied/interviewing/offered)
 *   node jobs-db.js status <job_id> <status>      — Update a job's application status
 *   node jobs-db.js prune                         — Remove jobs older than 2 months (except applied+)
 *   node jobs-db.js export <output_csv>           — Export full DB to CSV
 *   node jobs-db.js stats                         — Print summary stats
 *   node jobs-db.js search <query>                — Search jobs by title/company
 *   node jobs-db.js purge-non-tech                — Remove rows whose title doesn't look like a SWE role
 *   node jobs-db.js variant <job_id> <variant>    — Override a single job's resume_variant
 *
 * Statuses: new, drafted, applied, interviewing, offered, rejected, expired, withdrawn, needs_manual, application_failed
 * Variants: full-stack, frontend, backend, ai-ml, devops
 *
 * DB location: ~/.claude/data/codephil-jobs.db
 */

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(process.env.HOME, '.claude', 'data', 'codephil-jobs.db');
const TWO_MONTHS_MS = 60 * 24 * 60 * 60 * 1000;

function getDb() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // Lazy migration: add source column. Pre-Upwork rows are all from LinkedIn
  // so default to 'linkedin'. Wrapped in try/catch since SQLite throws when
  // the column already exists.
  try { db.exec(`ALTER TABLE jobs ADD COLUMN source TEXT DEFAULT 'linkedin'`); } catch {}
  try { db.exec(`UPDATE jobs SET source = 'linkedin' WHERE source IS NULL OR source = ''`); } catch {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_source ON jobs(source)`); } catch {}
  return db;
}

function init() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      job_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      standardized_title TEXT,
      company TEXT NOT NULL,
      company_url TEXT,
      company_website TEXT,
      company_description TEXT,
      company_employees TEXT,
      company_hq TEXT,
      industry TEXT,
      location TEXT,
      workplace_type TEXT,
      remote TEXT,
      seniority_level TEXT,
      employment_type TEXT,
      job_function TEXT,
      years_required TEXT,
      education TEXT,
      salary TEXT,
      skills TEXT,
      benefits TEXT,
      applicants TEXT,
      easy_apply TEXT,
      posted_at TEXT,
      apply_url TEXT,
      job_url TEXT,
      description_summary TEXT,
      category TEXT,
      resume_match INTEGER DEFAULT 0,
      application_status TEXT DEFAULT 'new',
      resume_variant TEXT,
      drive_folder_url TEXT,
      notes TEXT,
      first_seen_at TEXT DEFAULT (date('now')),
      last_seen_at TEXT DEFAULT (date('now')),
      applied_at TEXT,
      week_tag TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_company ON jobs(company);
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(application_status);
    CREATE INDEX IF NOT EXISTS idx_jobs_posted ON jobs(posted_at);
    CREATE INDEX IF NOT EXISTS idx_jobs_match ON jobs(resume_match);
    CREATE INDEX IF NOT EXISTS idx_jobs_week ON jobs(week_tag);

    CREATE TABLE IF NOT EXISTS application_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL REFERENCES jobs(job_id),
      old_status TEXT,
      new_status TEXT NOT NULL,
      changed_at TEXT DEFAULT (datetime('now')),
      notes TEXT
    );
  `);
  console.log(`Database initialized at ${DB_PATH}`);
  const count = db.prepare('SELECT COUNT(*) as n FROM jobs').get();
  console.log(`Current jobs in DB: ${count.n}`);
  db.close();
}

function importCsv(csvPath) {
  const db = getDb();
  const csv = fs.readFileSync(csvPath, 'utf-8');
  const lines = csv.split('\n');
  const headers = parseCSVLine(lines[0]);

  const weekTag = path.basename(csvPath).match(/\d{4}-\d{2}-\d{2}/)?.[0] || new Date().toISOString().slice(0, 10);

  const upsert = db.prepare(`
    INSERT INTO jobs (
      job_id, title, standardized_title, company, company_url, company_website,
      company_description, company_employees, company_hq, industry, location,
      workplace_type, remote, seniority_level, employment_type, job_function,
      years_required, education, salary, skills, benefits, applicants, easy_apply,
      posted_at, apply_url, job_url, description_summary, category, resume_match,
      application_status, resume_variant, source, week_tag, first_seen_at, last_seen_at
    ) VALUES (
      @job_id, @title, @standardized_title, @company, @company_url, @company_website,
      @company_description, @company_employees, @company_hq, @industry, @location,
      @workplace_type, @remote, @seniority_level, @employment_type, @job_function,
      @years_required, @education, @salary, @skills, @benefits, @applicants, @easy_apply,
      @posted_at, @apply_url, @job_url, @description_summary, @category, @resume_match,
      @application_status, @resume_variant, @source, @week_tag, date('now'), date('now')
    )
    ON CONFLICT(job_id) DO UPDATE SET
      last_seen_at = date('now'),
      resume_match = CASE WHEN excluded.resume_match > jobs.resume_match THEN excluded.resume_match ELSE jobs.resume_match END,
      salary = CASE WHEN excluded.salary != '' AND jobs.salary = '' THEN excluded.salary ELSE jobs.salary END,
      applicants = excluded.applicants,
      week_tag = excluded.week_tag,
      source = COALESCE(NULLIF(excluded.source, ''), jobs.source),
      resume_variant = COALESCE(NULLIF(jobs.resume_variant, ''), excluded.resume_variant)
  `);

  // Map CSV headers to DB columns
  const headerMap = {
    'Resume Match': 'resume_match',
    'Category': 'category',
    'Title': 'title',
    'Standardized Title': 'standardized_title',
    'Company': 'company',
    'Company URL': 'company_url',
    'Company Website': 'company_website',
    'Company Description': 'company_description',
    'Employee Count': 'company_employees',
    'Company HQ': 'company_hq',
    'Industry': 'industry',
    'Location': 'location',
    'Workplace Type': 'workplace_type',
    'Remote': 'remote',
    'Seniority Level': 'seniority_level',
    'Employment Type': 'employment_type',
    'Job Function': 'job_function',
    'Years Required': 'years_required',
    'Education': 'education',
    'Salary': 'salary',
    'Skills & Technologies': 'skills',
    'Benefits': 'benefits',
    'Applicants': 'applicants',
    'Easy Apply': 'easy_apply',
    'Posted': 'posted_at',
    'Apply URL': 'apply_url',
    'Job URL': 'job_url',
    'Description Summary': 'description_summary',
    'Application Status': 'application_status',
    'Source': 'source',
  };

  let imported = 0;
  let updated = 0;

  const insertMany = db.transaction((rows) => {
    for (const row of rows) {
      const existing = db.prepare('SELECT application_status FROM jobs WHERE job_id = ?').get(row.job_id);
      if (existing) {
        // Don't overwrite status if it's been manually changed
        if (['applied', 'interviewing', 'offered', 'rejected', 'withdrawn'].includes(existing.application_status)) {
          row.application_status = existing.application_status;
        }
        updated++;
      } else {
        imported++;
      }
      upsert.run(row);
    }
  });

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const values = parseCSVLine(lines[i]);
    if (values.length < headers.length) continue;

    const row = {};
    for (let j = 0; j < headers.length; j++) {
      const dbCol = headerMap[headers[j]];
      if (dbCol) row[dbCol] = values[j] || '';
    }

    // Generate a job_id from URL or company+title
    const jobUrl = row.job_url || '';
    const urlMatch = jobUrl.match(/view\/[^/]*?-(\d+)/);
    if (urlMatch) {
      row.job_id = urlMatch[1];
    } else {
      // Fallback ID for non-LinkedIn sources. The web UI's quick-apply
      // rejects any id with chars outside [a-z0-9._|-] (isSafeJobID), so
      // collapse everything else — company names like "AT&T, Inc." would
      // otherwise produce an unusable id and break apply.
      const slug = `${row.company}|||${row.title}`
        .toLowerCase()
        .replace(/[^a-z0-9|]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^[-|]+|[-|]+$/g, '')
        .slice(0, 120);
      row.job_id = slug || `job-${Date.now()}-${rows.length}`;
    }
    row.resume_match = parseInt(row.resume_match) || 0;
    row.application_status = row.application_status || 'new';
    row.week_tag = weekTag;
    row.source = row.source || 'linkedin';
    // Upwork projects don't follow SWE-job naming conventions (titles are
    // freelance asks like "Build my React dashboard"). Skip the SWE filter
    // for them — the budget/skills filters in the scraper already trim spam.
    if (row.source !== 'upwork' && !looksLikeSWE(row.title)) continue;
    // Reverse character-split corruption in skills/benefits before they go in.
    row.skills = sanitizeJoinedList(row.skills);
    row.benefits = sanitizeJoinedList(row.benefits);
    // resume_variant is no longer auto-classified — the orchestrator picks
    // a Drive variant per job at packaging time and writes it back via the
    // `variant` subcommand. Leave whatever the CSV provides, but the upsert
    // binds @resume_variant unconditionally so it must always exist.
    row.resume_variant = row.resume_variant || '';

    rows.push(row);
  }

  insertMany(rows);

  console.log(`Imported: ${imported} new jobs`);
  console.log(`Updated: ${updated} existing jobs`);
  console.log(`Total in DB: ${db.prepare('SELECT COUNT(*) as n FROM jobs').get().n}`);
  db.close();
}

function exclude() {
  const db = getDb();
  const rows = db.prepare(`
    SELECT job_id, company, title, application_status
    FROM jobs
    WHERE application_status IN ('applied', 'interviewing', 'offered', 'drafted', 'withdrawn')
  `).all();

  // Output as JSON for easy parsing
  console.log(JSON.stringify(rows.map(r => ({
    job_id: r.job_id,
    company: r.company,
    title: r.title,
    status: r.application_status,
  }))));

  db.close();
}

function updateStatus(jobId, newStatus) {
  const validStatuses = ['new', 'drafted', 'applied', 'interviewing', 'offered', 'rejected', 'expired', 'withdrawn', 'needs_manual', 'application_failed'];
  if (!validStatuses.includes(newStatus)) {
    console.error(`Invalid status. Valid: ${validStatuses.join(', ')}`);
    process.exit(1);
  }

  const db = getDb();
  const job = db.prepare('SELECT application_status, title, company FROM jobs WHERE job_id = ?').get(jobId);
  if (!job) {
    // Try partial match
    const matches = db.prepare('SELECT job_id, title, company FROM jobs WHERE job_id LIKE ? OR company LIKE ? LIMIT 5').all(`%${jobId}%`, `%${jobId}%`);
    if (matches.length) {
      console.log('Job not found. Did you mean:');
      matches.forEach(m => console.log(`  ${m.job_id} — ${m.title} @ ${m.company}`));
    } else {
      console.error('Job not found');
    }
    db.close();
    process.exit(1);
  }

  db.prepare('UPDATE jobs SET application_status = ?, applied_at = CASE WHEN ? = "applied" THEN date("now") ELSE applied_at END WHERE job_id = ?')
    .run(newStatus, newStatus, jobId);

  db.prepare('INSERT INTO application_log (job_id, old_status, new_status) VALUES (?, ?, ?)')
    .run(jobId, job.application_status, newStatus);

  console.log(`${job.title} @ ${job.company}: ${job.application_status} → ${newStatus}`);
  db.close();
}

function prune() {
  const db = getDb();
  const cutoff = new Date(Date.now() - TWO_MONTHS_MS).toISOString().slice(0, 10);

  // Don't prune jobs that have been acted on
  const result = db.prepare(`
    DELETE FROM jobs
    WHERE posted_at < ?
    AND application_status IN ('new', 'expired')
  `).run(cutoff);

  // Mark old drafted jobs as expired
  const expired = db.prepare(`
    UPDATE jobs SET application_status = 'expired'
    WHERE posted_at < ?
    AND application_status = 'drafted'
  `).run(cutoff);

  console.log(`Pruned: ${result.changes} old jobs removed`);
  console.log(`Expired: ${expired.changes} old drafted jobs marked expired`);
  console.log(`Remaining: ${db.prepare('SELECT COUNT(*) as n FROM jobs').get().n}`);
  console.log(`Cutoff date: ${cutoff}`);
  db.close();
}

function exportCsv(outputPath) {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM jobs ORDER BY resume_match DESC').all();

  const headers = [
    'job_id', 'resume_match', 'application_status', 'category', 'title', 'company',
    'company_url', 'company_website', 'industry', 'location', 'seniority_level',
    'employment_type', 'years_required', 'education', 'salary', 'skills', 'benefits',
    'applicants', 'posted_at', 'apply_url', 'job_url', 'description_summary',
    'resume_variant', 'drive_folder_url', 'notes', 'first_seen_at', 'last_seen_at',
    'applied_at', 'week_tag'
  ];

  const csvLines = [headers.join(',')];
  for (const row of rows) {
    csvLines.push(headers.map(h => csvEscape(row[h] || '')).join(','));
  }

  fs.writeFileSync(outputPath, csvLines.join('\n'));
  console.log(`Exported ${rows.length} jobs to ${outputPath}`);
  db.close();
}

function stats() {
  const db = getDb();

  const total = db.prepare('SELECT COUNT(*) as n FROM jobs').get().n;
  const byStatus = db.prepare('SELECT application_status, COUNT(*) as n FROM jobs GROUP BY application_status ORDER BY n DESC').all();
  const byCategory = db.prepare('SELECT category, COUNT(*) as n FROM jobs GROUP BY category ORDER BY n DESC').all();
  const byWeek = db.prepare('SELECT week_tag, COUNT(*) as n FROM jobs GROUP BY week_tag ORDER BY week_tag DESC').all();
  const topMatch = db.prepare('SELECT resume_match, title, company, application_status FROM jobs ORDER BY resume_match DESC LIMIT 10').all();
  const withSalary = db.prepare("SELECT COUNT(*) as n FROM jobs WHERE salary != ''").get().n;

  console.log(`\n=== CODEPHIL JOBS DATABASE ===`);
  console.log(`Total jobs: ${total}`);
  console.log(`Jobs with salary: ${withSalary}`);

  console.log(`\nBy status:`);
  byStatus.forEach(r => console.log(`  ${r.application_status}: ${r.n}`));

  console.log(`\nBy category:`);
  byCategory.forEach(r => console.log(`  ${r.category}: ${r.n}`));

  console.log(`\nBy week:`);
  byWeek.forEach(r => console.log(`  ${r.week_tag}: ${r.n}`));

  console.log(`\nTop 10 resume matches:`);
  topMatch.forEach(r => console.log(`  [${r.resume_match}] ${r.title} @ ${r.company} (${r.application_status})`));

  db.close();
}

function search(query) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT job_id, resume_match, title, company, application_status, salary, posted_at, job_url
    FROM jobs
    WHERE title LIKE ? OR company LIKE ? OR skills LIKE ?
    ORDER BY resume_match DESC
    LIMIT 20
  `).all(`%${query}%`, `%${query}%`, `%${query}%`);

  if (!rows.length) {
    console.log('No matches found');
  } else {
    rows.forEach(r => {
      console.log(`  [${r.resume_match}] ${r.title} @ ${r.company} | ${r.application_status} | ${r.salary || 'N/A'} | ${r.posted_at}`);
      console.log(`    ${r.job_url}`);
    });
  }
  db.close();
}

// Reverses a known data-corruption pattern in skills/benefits where the
// scrape agent did `[...str].join(', ')` — splitting a string into chars
// and re-joining with comma-space. Result looks like "R, e, m, o, t, e".
// We detect corruption (≥70% of tokens are length ≤ 1) then recover by
// joining tokens with empty string, which exactly reverses the operation.
function sanitizeJoinedList(s) {
  if (!s || typeof s !== 'string') return s;
  const tokens = s.split(', ');
  if (tokens.length < 4) return s;
  const singleCharTokens = tokens.filter(t => t.length <= 1).length;
  if (singleCharTokens / tokens.length < 0.7) return s;
  return tokens.join('');
}

const SWE_KEYWORDS = /\b(engineer(ing)?|developer|programmer|swe|sde|architect|devops|sre|frontend|backend|fullstack|full[\- ]?stack|software|web\s+develop\w*|machine\s+learning|\bml\b|\bai\b|data engineer|platform|infrastructure|cloud)\b/i;

function looksLikeSWE(title) {
  if (!title) return false;
  // Hard reject: non-IC roles + non-tech disciplines.
  const REJECT = /\b(nurse|nursing|\brn\b|lpn|cna|care\s+manager|care\s+coordinator|caregiver|physician|attorney|paralegal|account\s+exec|account\s+manager|\bsales\b|marketing\s+manager|product\s+manager|recruiter|recruiting|teacher|tutor|barista|driver|cashier|cook|chef|claims\s+adjuster|underwriter|engineering\s+manager|director\s+of\s+engineering|head\s+of\s+engineering|vp\s+of\s+engineering|chief\s+engineering|sales\s+engineer|customer\s+success|support\s+engineer)\b/i;
  if (REJECT.test(title)) return false;
  return SWE_KEYWORDS.test(title);
}

function purgeNonTech() {
  const db = getDb();
  const rows = db.prepare(`
    SELECT job_id, title, company, application_status FROM jobs
    WHERE application_status IN ('new', 'expired')
  `).all();
  const stale = rows.filter(r => !looksLikeSWE(r.title));
  if (!stale.length) {
    console.log('No non-SWE rows in new/expired status.');
    db.close();
    return;
  }
  const del = db.prepare('DELETE FROM jobs WHERE job_id=?');
  const tx = db.transaction(() => stale.forEach(r => del.run(r.job_id)));
  tx();
  console.log(`Purged ${stale.length} non-SWE rows. Examples:`);
  stale.slice(0, 5).forEach(r => console.log(`  - ${r.title} @ ${r.company}`));
  db.close();
}

function fixCorruptedLists() {
  const db = getDb();
  const rows = db.prepare(`
    SELECT job_id, skills, benefits FROM jobs
    WHERE (skills LIKE '_, _, _,%' OR benefits LIKE '_, _, _,%')
  `).all();
  if (!rows.length) {
    console.log('No corrupted skills/benefits rows.');
    db.close();
    return;
  }
  const upd = db.prepare('UPDATE jobs SET skills=?, benefits=? WHERE job_id=?');
  let fixedSkills = 0, fixedBenefits = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      const newSkills = sanitizeJoinedList(r.skills);
      const newBenefits = sanitizeJoinedList(r.benefits);
      if (newSkills !== r.skills) fixedSkills++;
      if (newBenefits !== r.benefits) fixedBenefits++;
      upd.run(newSkills, newBenefits, r.job_id);
    }
  });
  tx();
  console.log(`Scanned ${rows.length} suspect rows.`);
  console.log(`  Fixed skills:   ${fixedSkills}`);
  console.log(`  Fixed benefits: ${fixedBenefits}`);
  db.close();
}

function setVariant(jobId, variant) {
  // resume_variant is free-form now (the orchestrator stores a Drive filename
  // like "frontend.docx" picked from CodePhil/resume/variants/).
  if (!variant || typeof variant !== 'string') {
    console.error('variant filename required');
    process.exit(1);
  }
  const db = getDb();
  const res = db.prepare('UPDATE jobs SET resume_variant=? WHERE job_id=?').run(variant, jobId);
  if (res.changes === 0) {
    console.error(`Job ${jobId} not found`);
    process.exit(1);
  }
  console.log(`${jobId} -> resume_variant=${variant}`);
  db.close();
}

// CSV parsing helpers
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    if (inQuotes) {
      if (line[i] === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (line[i] === '"') {
        inQuotes = false;
      } else {
        current += line[i];
      }
    } else {
      if (line[i] === '"') {
        inQuotes = true;
      } else if (line[i] === ',') {
        result.push(current);
        current = '';
      } else {
        current += line[i];
      }
    }
  }
  result.push(current);
  return result;
}

function csvEscape(val) {
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// CLI
const cmd = process.argv[2];
const arg1 = process.argv[3];
const arg2 = process.argv[4];

switch (cmd) {
  case 'init': init(); break;
  case 'import': importCsv(arg1); break;
  case 'exclude': exclude(); break;
  case 'status': updateStatus(arg1, arg2); break;
  case 'prune': prune(); break;
  case 'export': exportCsv(arg1); break;
  case 'stats': stats(); break;
  case 'search': search(arg1); break;
  case 'purge-non-tech': purgeNonTech(); break;
  case 'variant': setVariant(arg1, arg2); break;
  case 'fix-corrupted-lists': fixCorruptedLists(); break;
  case 'list-drafted': {
    const db = getDb();
    const minScore = parseInt(arg1, 10) || 80;
    const limit = parseInt(arg2, 10) || 1000;
    const rows = db.prepare(`
      SELECT job_id, title, company, resume_match, apply_url, job_url, drive_folder_url, category
      FROM jobs
      WHERE application_status = 'drafted'
        AND resume_match >= ?
        AND apply_url IS NOT NULL AND apply_url != ''
      ORDER BY resume_match DESC
      LIMIT ?
    `).all(minScore, limit);
    console.log(JSON.stringify(rows, null, 2));
    db.close();
    break;
  }
  default:
    console.log('Usage: node jobs-db.js <init|import|exclude|status|prune|export|stats|search|list-drafted|purge-non-tech|variant> [args]');
}

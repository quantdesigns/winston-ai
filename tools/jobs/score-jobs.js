#!/usr/bin/env node
/**
 * score-jobs.js — rate unscored jobs 0-100 against the candidate's resume.
 *
 *   node score-jobs.js [--limit 200] [--batch 20] [--all] [--dry]
 *
 * The scrape/import path stores jobs with resume_match = 0; nothing in it
 * computes a fit score (that lived only in the agent pipeline, so wizard
 * imports came out unscored). This fills that gap: it reads the resume, asks
 * Claude to score each job, and writes resume_match back.
 *
 * Scoring uses the `claude` CLI, so it runs on the existing subscription auth —
 * no ANTHROPIC_API_KEY required. Same 0-100 rubric the jobs agent uses.
 *
 *   --all   re-score every job, not just the ones sitting at 0.
 *   --dry   print the scores without writing them.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const args = process.argv.slice(2);
const getFlag = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const LIMIT = parseInt(getFlag('--limit', '200'), 10);
const BATCH = parseInt(getFlag('--batch', '20'), 10);
const ALL = args.includes('--all');
const DRY = args.includes('--dry');

const RESUME = process.env.WINSTON_RESUME_FILE
  || path.join(os.homedir(), '.claude', 'philip-resume.md');

const DB_PATH = process.env.WINSTON_JOBS_DB || (() => {
  const legacy = path.join(os.homedir(), '.claude', 'data', 'codephil-jobs.db');
  return fs.existsSync(legacy) ? legacy : path.join(os.homedir(), '.claude', 'data', 'jobs.db');
})();

function sqlite(sql) {
  return execFileSync('sqlite3', ['-json', DB_PATH, sql], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}

function fetchJobs() {
  const where = ALL ? '1=1' : 'COALESCE(resume_match, 0) = 0';
  const out = sqlite(`
    SELECT job_id, title, company, seniority_level, employment_type, salary, skills,
           substr(COALESCE(description_summary, ''), 1, 700) AS summary
    FROM jobs WHERE ${where}
    ORDER BY first_seen_at DESC LIMIT ${LIMIT};`);
  return out ? JSON.parse(out) : [];
}

/** Ask Claude to score a batch. Returns [{job_id, score}]. */
function scoreBatch(resume, batch) {
  const jobsBlock = batch.map(j => JSON.stringify({
    job_id: j.job_id, title: j.title, company: j.company,
    seniority: j.seniority_level, type: j.employment_type,
    salary: j.salary, skills: j.skills, summary: j.summary,
  })).join('\n');

  const prompt = `You are scoring job postings against a candidate's resume for fit.

RESUME:
${resume}

JOBS (one JSON object per line):
${jobsBlock}

Score each job 0-100 on how well it fits this candidate:
- 90-100: excellent match — core skills and seniority align closely
- 80-89:  strong match — most requirements met
- 60-79:  plausible — meaningful overlap but notable gaps
- 40-59:  weak — significant mismatch in stack or seniority
- 0-39:   poor — wrong discipline, wrong level, or disqualifying requirements

Weigh tech-stack overlap and seniority fit most heavily. Be discriminating —
do not give everything the same score.

Return ONLY a JSON array, no prose, no markdown fence:
[{"job_id":"<id>","score":<int>}, ...]`;

  const raw = execFileSync('claude', ['-p', prompt], {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 180_000,
  });

  // Claude may wrap the array in prose or a fence despite instructions.
  const m = raw.match(/\[[\s\S]*\]/);
  if (!m) throw new Error('no JSON array in model output');
  return JSON.parse(m[0]);
}

function writeScores(scores) {
  const cases = scores
    .filter(s => s && s.job_id && Number.isFinite(Number(s.score)))
    .map(s => `WHEN '${String(s.job_id).replace(/'/g, "''")}' THEN ${Math.max(0, Math.min(100, parseInt(s.score, 10)))}`);
  if (!cases.length) return 0;
  const ids = scores.map(s => `'${String(s.job_id).replace(/'/g, "''")}'`).join(',');
  sqlite(`UPDATE jobs SET resume_match = CASE job_id ${cases.join(' ')} ELSE resume_match END WHERE job_id IN (${ids});`);
  return cases.length;
}

function main() {
  if (!fs.existsSync(RESUME)) {
    console.error(`ERROR: resume not found at ${RESUME} (set WINSTON_RESUME_FILE)`);
    process.exit(1);
  }
  const resume = fs.readFileSync(RESUME, 'utf8');
  const jobs = fetchJobs();
  if (!jobs.length) { console.log('No jobs need scoring.'); return; }

  console.log(`Scoring ${jobs.length} job(s) against ${path.basename(RESUME)} — batches of ${BATCH}`);
  let written = 0;
  const all = [];

  for (let i = 0; i < jobs.length; i += BATCH) {
    const batch = jobs.slice(i, i + BATCH);
    let scores;
    try {
      scores = scoreBatch(resume, batch);
    } catch (e) {
      console.error(`  batch ${i / BATCH + 1} failed: ${e.message}`);
      continue;
    }
    all.push(...scores);
    if (!DRY) written += writeScores(scores);
    const avg = scores.reduce((a, s) => a + Number(s.score || 0), 0) / (scores.length || 1);
    console.log(`  batch ${Math.floor(i / BATCH) + 1}: ${scores.length} scored, avg ${avg.toFixed(0)}`);
  }

  const top = all.sort((a, b) => b.score - a.score).slice(0, 5);
  console.log(`\n${DRY ? 'DRY RUN — nothing written' : `Wrote ${written} score(s)`}`);
  if (top.length) {
    console.log('Top matches:');
    for (const t of top) {
      const j = jobs.find(x => x.job_id === t.job_id);
      console.log(`  ${String(t.score).padStart(3)}  ${j ? `${j.title} — ${j.company}` : t.job_id}`);
    }
  }
}

main();

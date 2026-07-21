#!/usr/bin/env node
/**
 * welcome-package.js — deep-research briefing for the top N jobs of a run.
 *
 *   node welcome-package.js [--top 10] [--run-date 2026-07-13] [--out <path>] [--model opus]
 *
 * For each job it produces: what the company does, a sourced view on whether it
 * is growing/profitable, the real Glassdoor rating (with link), the company's
 * PUBLISHED recruiting contact, a personal cover letter, and an honest read on
 * what the resume is missing for that role.
 *
 * Grounding rules, enforced in the prompt and worth stating plainly:
 *   - Every factual claim carries a source URL. No source → the field is null.
 *   - The Glassdoor rating is looked up, never estimated. Unknown stays unknown.
 *   - Contacts are COMPANY-PUBLISHED only (careers page, corporate mailbox, a
 *     hiring contact the posting itself names). We do not research, infer, or
 *     enrich named individuals — that is personal-data harvesting and is out of
 *     scope by design, not by omission.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const TOP = parseInt(flag('--top', '10'), 10);
const MODEL = flag('--model', 'opus');
const RUN_DATE = flag('--run-date', new Date().toISOString().slice(0, 10));
const OUT = flag('--out', path.join(os.homedir(), 'Desktop', 'jobs', `welcome-${RUN_DATE}.md`));

const RESUME = process.env.WINSTON_RESUME_FILE || path.join(os.homedir(), '.claude', 'philip-resume.md');
const DB = process.env.WINSTON_JOBS_DB || (() => {
  const legacy = path.join(os.homedir(), '.claude', 'data', 'codephil-jobs.db');
  return fs.existsSync(legacy) ? legacy : path.join(os.homedir(), '.claude', 'data', 'jobs.db');
})();

const sql = q => execFileSync('sqlite3', ['-json', DB, q], { encoding: 'utf8', maxBuffer: 64 << 20 }).trim();
const esc = s => String(s ?? '').replace(/'/g, "''");

/**
 * Persist the report against the job so the board can open it in a modal, and
 * flag intermediaries so a staffing-agency repost is visible in the table
 * rather than looking like a direct match.
 */
function saveResearch(job, r) {
  sql(`UPDATE jobs SET
        research_json   = '${esc(JSON.stringify(r))}',
        is_intermediary = ${r.is_intermediary ? 1 : 0},
        actual_employer = '${esc(r.actual_employer || '')}'
      WHERE job_id = '${esc(job.job_id)}';`);
}

function topJobs() {
  const out = sql(`
    SELECT job_id, title, company, location, salary, seniority_level, skills,
           company_website, company_url, careers_url, contact_email, contact_type,
           job_url, apply_url, resume_match,
           substr(COALESCE(description_summary, ''), 1, 2500) AS jd,
           substr(COALESCE(company_description, ''), 1, 800) AS company_blurb
    FROM jobs
    WHERE date(first_seen_at) = '${RUN_DATE}'
      -- Skip anything already briefed. Without this a second run on the same day
      -- re-picks the same top scorers and spends ~2 minutes of web research per
      -- job re-deriving a report that already exists, while the jobs that
      -- actually arrived in this run go unresearched.
      AND COALESCE(research_json, '') = ''
    ORDER BY resume_match DESC
    LIMIT ${TOP};`);
  return out ? JSON.parse(out) : [];
}

function research(job, resume) {
  const prompt = `You are preparing a job-application briefing. Ground every factual claim in a real source.

CANDIDATE RESUME:
${resume}

JOB:
title: ${job.title}
company: ${job.company}
location: ${job.location}
salary: ${job.salary || 'not stated'}
seniority: ${job.seniority_level || 'not stated'}
company website: ${job.company_website || 'unknown'}
company blurb (from the listing): ${job.company_blurb || '(none)'}
job description (truncated):
${job.jd || '(none)'}

Research the company on the web, then return ONLY one line of compact JSON (no prose, no markdown fence, no trailing "Sources:" list):

{
 "what_they_do": "<2-3 sentences, plain language>",
 "outlook": "<2-3 sentences on growth/profitability: funding, revenue, headcount trend, layoffs, runway. Say plainly if the evidence is thin.>",
 "outlook_signal": "growing|stable|uncertain|declining|unknown",
 "outlook_sources": ["<url>", ...],
 "glassdoor_rating": <number 1-5 or null>,
 "glassdoor_url": "<url or empty>",
 "glassdoor_review_count": <int or null>,
 "satisfaction_note": "<1 sentence on what employees consistently say, or empty if no reviews found>",
 "cover_letter": "<150-200 words. Warm, specific, first person. Reference something concrete and true about THIS company and connect it to the candidate's actual experience. No flattery, no cliches, no 'I am writing to express my interest'. Do not invent experience the resume does not show.>",
 "resume_gaps": ["<what the resume is missing to be competitive for THIS role - be specific and honest, e.g. 'no Kubernetes despite it being a hard requirement'>", ...],
 "resume_strengths": ["<what already lines up well for this role>", ...],
 "scheduler_link": "<any Calendly/SavvyCal/booking link the JOB DESCRIPTION itself contains, else empty>",
 "is_intermediary": <true if the listing company is a staffing agency, recruiting firm, or middleman reposting a role for a different end employer; false if they are the actual employer>,
 "actual_employer": "<if is_intermediary, the real end employer if you can identify it, else empty>",
 "intermediary_note": "<if is_intermediary, one sentence on what this means for the candidate, else empty>"
}

HARD RULES:
- If you cannot verify the Glassdoor rating from a real page, set glassdoor_rating to null. NEVER estimate or invent a rating.
- outlook_sources must be URLs you actually consulted. Empty array if you found nothing; set outlook_signal to "unknown".
- Do NOT research, name, or infer individual hiring managers, recruiters, or their contact details. Company-published contacts only.`;

  const raw = execFileSync('claude', ['-p', prompt, '--model', MODEL, '--allowedTools', 'WebSearch,WebFetch'], {
    encoding: 'utf8', maxBuffer: 32 << 20, timeout: 600_000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no JSON in model output');
  return JSON.parse(m[0]);
}

function render(job, r) {
  const stars = r.glassdoor_rating
    ? `${r.glassdoor_rating}/5${r.glassdoor_review_count ? ` (${r.glassdoor_review_count} reviews)` : ''}`
    : '_no Glassdoor data found_';
  const signal = { growing: '📈', stable: '➡️', uncertain: '❓', declining: '📉', unknown: '❓' }[r.outlook_signal] || '❓';

  const contact = r.contact_line || [
    job.contact_email ? `${job.contact_email}${job.contact_type === 'generic' ? ' _(general inbox)_' : ''}` : '',
    job.careers_url ? `[Careers page](${job.careers_url})` : '',
  ].filter(Boolean).join(' · ') || '_none published_';

  const middleman = r.is_intermediary
    ? `\n> ⚠️ **Not the employer.** ${job.company} is a staffing/recruiting intermediary`
      + `${r.actual_employer ? ` reposting a role for **${r.actual_employer}**` : ''}.`
      + `${r.intermediary_note ? ` ${r.intermediary_note}` : ''}\n`
    : '';

  return `
## ${job.resume_match} — ${job.title}
**${job.company}** · ${job.location || 'location n/a'} · ${job.salary || 'salary not stated'}
${middleman}
**What they do.** ${r.what_they_do || '_unknown_'}

**Outlook ${signal} (${r.outlook_signal || 'unknown'}).** ${r.outlook || '_no evidence found_'}
${(r.outlook_sources || []).length ? (r.outlook_sources || []).map(u => `  - ${u}`).join('\n') : '  - _no sources found_'}

**Employee satisfaction.** ${stars}${r.glassdoor_url ? ` — [Glassdoor](${r.glassdoor_url})` : ''}
${r.satisfaction_note ? `> ${r.satisfaction_note}` : ''}

**Links.** ${[
    job.company_website ? `[Website](${job.company_website})` : '',
    job.company_url ? `[LinkedIn](${job.company_url})` : '',
    job.job_url ? `[Job post](${job.job_url})` : '',
  ].filter(Boolean).join(' · ') || '_none_'}

**Recruiting contact (company-published).** ${contact}
${r.scheduler_link ? `**Scheduler in the posting.** ${r.scheduler_link}` : ''}

**Cover letter.**
${(r.cover_letter || '').split('\n').map(l => `> ${l}`).join('\n')}

**Where the resume is short for this role.**
${(r.resume_gaps || []).map(g => `- ${g}`).join('\n') || '- _none identified_'}

**What already lines up.**
${(r.resume_strengths || []).map(s => `- ${s}`).join('\n') || '- _none identified_'}

---
`;
}

function main() {
  if (!fs.existsSync(RESUME)) { console.error(`resume not found: ${RESUME}`); process.exit(1); }
  const resume = fs.readFileSync(RESUME, 'utf8');
  const jobs = topJobs();
  if (!jobs.length) { console.log(`No jobs first seen on ${RUN_DATE}.`); return; }

  console.log(`Researching top ${jobs.length} job(s) from ${RUN_DATE} with ${MODEL}…`);
  let md = `# Welcome package — ${RUN_DATE}\n\nTop ${jobs.length} matches, researched with sources. `
    + `Glassdoor ratings are looked up, never estimated — "no data found" means exactly that.\n\n---\n`;

  const failures = [];
  jobs.forEach((job, i) => {
    process.stdout.write(`  [${i + 1}/${jobs.length}] ${job.company} — ${job.title.slice(0, 40)}… `);
    try {
      const r = research(job, resume);
      saveResearch(job, r);
      md += render(job, r);
      const bits = [
        r.glassdoor_rating ? `glassdoor ${r.glassdoor_rating}` : 'no glassdoor',
        r.is_intermediary ? `INTERMEDIARY${r.actual_employer ? ` → ${r.actual_employer}` : ''}` : '',
      ].filter(Boolean);
      console.log(`ok (${bits.join(', ')})`);
    } catch (e) {
      console.log(`FAILED: ${e.message}`);
      failures.push(job.company);
      md += `\n## ${job.resume_match} — ${job.title}\n**${job.company}** — _research failed: ${e.message}_\n\n---\n`;
    }
  });

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, md);
  console.log(`\nWrote ${OUT}`);
  if (failures.length) console.log(`${failures.length} failed: ${failures.join(', ')}`);
}

main();

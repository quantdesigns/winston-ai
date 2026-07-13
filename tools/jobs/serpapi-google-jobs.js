#!/usr/bin/env node
/**
 * CodePhil SerpAPI Google Jobs Scraper
 * Uses SerpAPI's google_jobs engine ($0.015/search, more stable than Apify's Google scrapers).
 *
 * Usage:
 *   node serpapi-google-jobs.js "<query>" [--location "United States"] [--limit 100] [--output path]
 *
 * Env: SERPAPI_KEY
 *
 * Note: "limit" translates to pagination — Google Jobs returns ~10 per page,
 * so we paginate via `next_page_token` until we hit `limit` or run out.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { URLSearchParams } = require('url');

function loadClaudeDotEnv() {
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), '.claude', '.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const s = line.trim();
      if (!s || s.startsWith('#')) continue;
      const m = s.replace(/^export\s+/, '').match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (!m) continue;
      let [, k, v] = m;
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[k] = v;
    }
  } catch { /* optional */ }
}
loadClaudeDotEnv();

const KEY = process.env.SERPAPI_KEY;
if (!KEY) { console.error('ERROR: SERPAPI_KEY not set in env or ~/.claude/.env'); process.exit(1); }

const args = process.argv.slice(2);
const query = args.find(a => !a.startsWith('--'));
if (!query) {
  console.error('Usage: node serpapi-google-jobs.js "<query>" [--location "..."] [--limit N] [--output path]');
  process.exit(1);
}

function getFlag(name, d) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
}

const location = getFlag('--location', 'United States');
const limit = parseInt(getFlag('--limit', '100'));
const outputPath = getFlag('--output', '');

// Country-wide US location strings that Google Jobs rejects when gl=us is set.
const COUNTRY_WIDE_US = new Set(['united states', 'usa', 'us', 'u.s.', 'u.s.a.']);

function fetchJson(urlPath) {
  return new Promise((resolve, reject) => {
    https.get({ hostname: 'serpapi.com', path: urlPath, method: 'GET' }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function normalize(job) {
  const ext = job.detected_extensions || {};
  const via = job.via || '';
  let applyUrl = '';
  if (Array.isArray(job.apply_options) && job.apply_options.length > 0) {
    applyUrl = job.apply_options[0].link || '';
  }
  return {
    source: 'google',
    searchQuery: query,
    jobId: job.job_id || '',
    title: job.title || '',
    standardizedTitle: job.title || '',
    company: job.company_name || '',
    companyUrl: '',
    companyWebsite: '',
    companyDescription: '',
    companyEmployeeCount: '',
    companyHQ: '',
    companyIndustry: '',
    location: job.location || '',
    workplaceTypes: ext.work_from_home ? 'Remote' : '',
    workRemoteAllowed: ext.work_from_home ? 'Yes' : 'No',
    seniorityLevel: '',
    employmentType: ext.schedule_type || '',
    jobFunction: '',
    salary: ext.salary || '',
    applicants: '',
    easyApply: '',
    postedAt: ext.posted_at || '',
    jobUrl: applyUrl || job.share_link || '',
    applyUrl: applyUrl || job.share_link || '',
    skills: '',
    yearsExperience: '',
    education: '',
    benefits: '',
    descriptionSnippet: (job.description || '').replace(/\s+/g, ' ').substring(0, 500),
    fullDescription: job.description || '',
    via,
  };
}

async function main() {
  console.log(`Searching Google Jobs via SerpAPI: "${query}" | Location: ${location} | Limit: ${limit}`);

  const all = [];
  let nextToken = null;
  let page = 0;

  while (all.length < limit) {
    const params = new URLSearchParams({
      api_key: KEY,
      engine: 'google_jobs',
      q: query,
      hl: 'en',
      gl: 'us',
    });
    // Google Jobs cannot resolve a bare country as a location while gl is set —
    // it returns zero results rather than an error. gl=us already scopes to the
    // US, so send location only when it is narrower than the country.
    if (location && !COUNTRY_WIDE_US.has(location.trim().toLowerCase())) {
      params.set('location', location);
    }
    if (nextToken) params.set('next_page_token', nextToken);

    let res;
    try {
      res = await fetchJson(`/search.json?${params.toString()}`);
    } catch (e) {
      console.error(`Page ${page} failed: ${e.message}`);
      break;
    }
    const batch = res.jobs_results || [];
    if (batch.length === 0) {
      // SerpAPI reports a soft failure (bad location, blocked query) in `error`
      // with HTTP 200 — surface it instead of reporting a silent "no jobs".
      if (res.error) console.error(`SerpAPI: ${res.error}`);
      break;
    }
    for (const j of batch) {
      all.push(j);
      if (all.length >= limit) break;
    }
    nextToken = res.serpapi_pagination?.next_page_token || res.next_page_token || null;
    page++;
    if (!nextToken) break;
    console.log(`  Page ${page}: ${all.length} jobs so far`);
    if (page > 30) break; // hard safety ceiling
  }

  if (all.length === 0) {
    console.log('No jobs found.');
    if (outputPath) fs.writeFileSync(outputPath, '[]');
    return;
  }

  const results = all.map(normalize);

  if (outputPath) {
    fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
    console.log(`JSON saved to: ${outputPath}`);
  }

  console.log(`\nSUMMARY: ${results.length} Google Jobs results from ${new Set(results.map(r => r.company)).size} companies`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});

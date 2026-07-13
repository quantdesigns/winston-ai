#!/usr/bin/env node
/**
 * CodePhil Apify Glassdoor Jobs Scraper Tool
 * Uses Apify's radeance/glassdoor-jobs-scraper (proven in Rivalytics — rich salary data).
 *
 * Usage:
 *   node apify-glassdoor-jobs.js "<keyword>" [--location "United States"] [--limit 50] [--output path]
 *
 * Env: APIFY_TOKEN
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

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

const TOKEN = process.env.APIFY_TOKEN;
if (!TOKEN) { console.error('ERROR: APIFY_TOKEN not set'); process.exit(1); }

const args = process.argv.slice(2);
const query = args.find(a => !a.startsWith('--'));
if (!query) {
  console.error('Usage: node apify-glassdoor-jobs.js "<keyword>" [--location "..."] [--limit N] [--output path]');
  process.exit(1);
}

function getFlag(name, d) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
}

const location = getFlag('--location', 'United States');
const limit = parseInt(getFlag('--limit', '50'));
const outputPath = getFlag('--output', '');

const ACTOR_ID = 'radeance~glassdoor-jobs-scraper';

function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 400) reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        else { try { resolve(JSON.parse(data)); } catch { resolve(data); } }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function formatSalary(job) {
  const min = job.salary_min;
  const max = job.salary_max;
  const cur = job.salary_currency || 'USD';
  const per = job.salary_period || job.pay_period || 'year';
  if (!min && !max) return '';
  const f = n => n >= 1000 ? `${(n / 1000).toFixed(0)}K` : `${n}`;
  if (min && max && min !== max) return `${cur === 'USD' ? '$' : cur + ' '}${f(min)}–${f(max)}/${per}`;
  return `${cur === 'USD' ? '$' : cur + ' '}${f(max || min)}/${per}`;
}

async function main() {
  console.log(`Searching Glassdoor: "${query}" | Location: ${location} | Limit: ${limit}`);

  const run = await request({
    hostname: 'api.apify.com',
    path: `/v2/acts/${ACTOR_ID}/runs?token=${TOKEN}&maxItems=${limit}`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }, {
    keyword: query,
    location,
    max_items: limit,
    max_pages: Math.max(1, Math.ceil(limit / 20)),
    sorting: 'newest',
    only_unique_jobs: true,
  });

  const runId = run.data?.id;
  const datasetId = run.data?.defaultDatasetId;
  if (!runId) { console.error('Failed to start:', JSON.stringify(run)); process.exit(1); }
  console.log(`Actor run started: ${runId}`);

  let status = 'RUNNING';
  let attempts = 0;
  const MAX_ATTEMPTS = 240;
  let timedOut = false;
  while (status === 'RUNNING' || status === 'READY') {
    if (attempts++ > MAX_ATTEMPTS) {
      console.error('Timed out — salvaging');
      timedOut = true;
      try {
        await request({ hostname: 'api.apify.com', path: `/v2/actor-runs/${runId}/abort?token=${TOKEN}`, method: 'POST' });
      } catch (e) { /* ignore */ }
      break;
    }
    await sleep(5000);
    const info = await request({ hostname: 'api.apify.com', path: `/v2/actor-runs/${runId}?token=${TOKEN}`, method: 'GET' });
    status = info.data?.status;
    console.log(`  Status: ${status} (${attempts * 5}s)`);
  }

  const items = await request({
    hostname: 'api.apify.com',
    path: `/v2/datasets/${datasetId}/items?token=${TOKEN}&format=json&limit=${limit}`,
    method: 'GET',
  });

  if (!Array.isArray(items) || items.length === 0) {
    console.log('No jobs found.');
    if (outputPath) fs.writeFileSync(outputPath, '[]');
    if (timedOut) process.exit(1);
    return;
  }

  console.log(`Found ${items.length} Glassdoor jobs${timedOut ? ' (partial)' : ''}`);

  const results = items.map(job => {
    const desc = job.description || job.job_description || '';
    return {
      source: 'glassdoor',
      searchQuery: query,
      jobId: job.job_id || job.id || job.job_listing_id || '',
      title: job.job_title || job.title || '',
      standardizedTitle: job.job_title || job.title || '',
      company: job.employer_name || job.company || '',
      companyUrl: job.employer_url || '',
      companyWebsite: '',
      companyDescription: '',
      companyEmployeeCount: job.employer_size || '',
      companyHQ: job.employer_headquarters || '',
      companyIndustry: job.category || '',
      location: job.location || '',
      workplaceTypes: job.is_remote ? 'Remote' : '',
      workRemoteAllowed: job.is_remote ? 'Yes' : 'No',
      seniorityLevel: '',
      employmentType: job.job_type || '',
      jobFunction: job.category || '',
      salary: formatSalary(job),
      applicants: '',
      easyApply: job.easy_apply ? 'Yes' : 'No',
      postedAt: job.job_age || job.posted_date || job.post_date || '',
      jobUrl: job.job_url || job.apply_url || '',
      applyUrl: job.apply_url || job.job_url || '',
      skills: '',
      yearsExperience: '',
      education: '',
      benefits: '',
      descriptionSnippet: desc.replace(/\s+/g, ' ').substring(0, 500),
      fullDescription: desc,
    };
  });

  if (outputPath) {
    fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
    console.log(`JSON saved to: ${outputPath}`);
  }

  console.log(`\nSUMMARY: ${results.length} Glassdoor jobs from ${new Set(results.map(r => r.company)).size} companies`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});

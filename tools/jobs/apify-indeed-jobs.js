#!/usr/bin/env node
/**
 * CodePhil Apify Indeed Jobs Scraper Tool
 * Uses Apify's misceres/indeed-scraper actor (proven in Rivalytics).
 *
 * Usage:
 *   node apify-indeed-jobs.js "<position query>" [--location "United States"] [--limit 50] [--output /path/to/output.json]
 *
 * Env: APIFY_TOKEN (falls back to ~/.claude/.env)
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
if (!TOKEN) {
  console.error('ERROR: APIFY_TOKEN not set');
  process.exit(1);
}

const args = process.argv.slice(2);
const query = args.find(a => !a.startsWith('--'));
if (!query) {
  console.error('Usage: node apify-indeed-jobs.js "<position>" [--location "..."] [--limit N] [--output path]');
  process.exit(1);
}

function getFlag(name, defaultVal) {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : defaultVal;
}

const location = getFlag('--location', 'United States');
const limit = parseInt(getFlag('--limit', '50'));
const outputPath = getFlag('--output', '');

// misceres/indeed-scraper — well-maintained certified actor
const ACTOR_ID = 'misceres~indeed-scraper';
// Indeed's country filter is 2-letter code; default US.
const COUNTRY_GUESS = /united states|usa|us/i.test(location) ? 'US' :
                     /canada/i.test(location) ? 'CA' :
                     /united kingdom|uk/i.test(location) ? 'GB' : 'US';

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

function extractSkills(desc) {
  if (!desc) return '';
  const patterns = [
    /\b(React|Vue|Angular|Next\.?js|TypeScript|JavaScript|HTML|CSS|Tailwind)\b/gi,
    /\b(Node\.?js|Python|Go|Golang|Java|Rust|Ruby|C\+\+|C#|\.NET|PHP)\b/gi,
    /\b(AWS|GCP|Azure|Terraform|Kubernetes|Docker|Jenkins|CI\/CD)\b/gi,
    /\b(PostgreSQL|MySQL|MongoDB|Redis|Kafka|SQL|NoSQL)\b/gi,
    /\b(Excel|QuickBooks|SAP|NetSuite|Oracle|Salesforce|HubSpot)\b/gi,
    /\b(GAAP|IFRS|CPA|CMA|audit|tax|payroll|reconciliation|AP|AR)\b/gi,
  ];
  const found = new Set();
  for (const p of patterns) (desc.match(p) || []).forEach(m => found.add(m));
  return [...found].join(', ');
}

async function main() {
  console.log(`Searching Indeed: "${query}" | Location: ${location} (${COUNTRY_GUESS}) | Limit: ${limit}`);

  const run = await request({
    hostname: 'api.apify.com',
    path: `/v2/acts/${ACTOR_ID}/runs?token=${TOKEN}&maxItems=${limit}`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }, {
    position: query,
    location,
    country: COUNTRY_GUESS,
    maxItems: limit,
    parseCompanyDetails: false,
    saveOnlyUniqueItems: true,
    followApplyRedirects: false,
  });

  const runId = run.data?.id;
  const datasetId = run.data?.defaultDatasetId;
  if (!runId) {
    console.error('Failed to start actor:', JSON.stringify(run));
    process.exit(1);
  }
  console.log(`Actor run started: ${runId}`);

  let status = 'RUNNING';
  let attempts = 0;
  const MAX_ATTEMPTS = 240; // 5s × 240 = 20 min ceiling (Indeed is faster than LinkedIn)
  let timedOut = false;
  while (status === 'RUNNING' || status === 'READY') {
    if (attempts++ > MAX_ATTEMPTS) {
      console.error('Timed out — aborting and salvaging partial data');
      timedOut = true;
      try {
        await request({
          hostname: 'api.apify.com',
          path: `/v2/actor-runs/${runId}/abort?token=${TOKEN}`,
          method: 'POST',
        });
      } catch (e) { console.error('Abort failed:', e.message); }
      break;
    }
    await sleep(5000);
    const info = await request({
      hostname: 'api.apify.com',
      path: `/v2/actor-runs/${runId}?token=${TOKEN}`,
      method: 'GET',
    });
    status = info.data?.status;
    console.log(`  Status: ${status} (${attempts * 5}s)`);
  }

  if (status !== 'SUCCEEDED' && !timedOut) {
    console.error(`Run status: ${status} — trying to salvage dataset`);
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

  console.log(`Found ${items.length} Indeed jobs${timedOut ? ' (partial)' : ''}`);

  const results = items.map(job => {
    const desc = job.description || '';
    return {
      source: 'indeed',
      searchQuery: query,
      jobId: job.id || job.positionName || '',
      title: job.positionName || job.title || '',
      standardizedTitle: job.positionName || job.title || '',
      company: job.company || '',
      companyUrl: job.companyUrl || '',
      companyWebsite: '',
      companyDescription: '',
      companyEmployeeCount: '',
      companyHQ: '',
      companyIndustry: '',
      location: job.location || '',
      workplaceTypes: job.remoteWorkModel || job.isRemote === 'Yes' ? 'Remote' : '',
      workRemoteAllowed: job.isRemote === 'Yes' || /remote/i.test(job.location || '') ? 'Yes' : 'No',
      seniorityLevel: '',
      employmentType: job.jobType || '',
      jobFunction: '',
      salary: job.salary || '',
      applicants: '',
      easyApply: '',
      postedAt: job.postingDateParsed || job.postedAt || '',
      jobUrl: job.url || job.externalApplyLink || '',
      applyUrl: job.externalApplyLink || job.url || '',
      skills: extractSkills(desc),
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

  console.log(`\nSUMMARY: ${results.length} Indeed jobs from ${new Set(results.map(r => r.company)).size} companies`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});

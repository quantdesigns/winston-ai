#!/usr/bin/env node
/**
 * CodePhil Apify Upwork Jobs Scraper Tool
 * Uses Apify's neatrat/upwork-job-scraper actor (XYTgO05GT5qAoSlxy).
 * Highest-rated Upwork actor on Apify (3.4K users, 3.7/5 across 27 reviews).
 * Built-in cookie auth, no manual login required.
 *
 * Usage:
 *   node apify-upwork-jobs.js "<query>" [--location "United States"] [--limit 25] [--output /path/to/output.json]
 *
 * Defaults applied (per Philip's filters):
 *   - Job type: hourly + fixed
 *   - Min fixed budget: $5,000
 *   - Min hourly rate: $50
 *   - Client location: United States only
 *   - Payment-verified clients only
 *   - Sort: newest
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
  console.error('Usage: node apify-upwork-jobs.js "<query>" [--location "..."] [--limit N] [--output path]');
  process.exit(1);
}

function getFlag(name, defaultVal) {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : defaultVal;
}

const location = getFlag('--location', 'United States');
const limit = parseInt(getFlag('--limit', '25'));
const outputPath = getFlag('--output', '');

// neatrat/upwork-job-scraper — battle-tested, in-house cookie auth.
const ACTOR_ID = 'XYTgO05GT5qAoSlxy';

// Build the actor's structured input. Earlier we tried passing a `rawSearchUrl`
// with URL-style filters baked in, but the actor's actual input field is
// `rawUrl`; sending `rawSearchUrl` was silently ignored and the actor fell
// back to its default prefill ("web scraping"), returning the same junk for
// every query. Stick to the documented structured fields instead — they
// drive the same filter UI Upwork exposes on the web.
function buildActorInput(q, loc, limit) {
  const usOnly = /united states|^us$|usa/i.test(loc || '');
  return {
    query: q,
    experienceLevel: ['expert'],          // Senior positioning — skip entry/intermediate
    jobType: ['fixed', 'hourly'],
    paymentVerified: true,
    // Per-schema: array of two stringified numbers, [min, max]. We use 999999
    // as "no max" — works fine since budgets above $1M aren't real.
    fixedPriceRange: ['5000', '999999'],
    hourlyRateRange: ['50', '999'],
    // Skip clients with zero hire history. Brand-new clients are a leading
    // indicator of low-budget bait or never-hires-anybody listings.
    clientHistory: ['1to9Hires', '10+Hires'],
    location: usOnly ? ['United States'] : (loc ? [loc] : ['United States']),
    sort: 'newest',
    perPage: Math.min(Math.max(limit, 10), 50),
    pagesToScrape: limit > 50 ? Math.ceil(limit / 50) : 1,
    page: 1,
  };
}

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

// Same skill extraction patterns as LinkedIn/Indeed — keeps the unified
// schema's `skills` field consistent across sources.
function extractSkills(desc) {
  if (!desc) return '';
  const patterns = [
    /\b(React|Vue|Angular|Next\.?js|Nuxt|Svelte|TypeScript|JavaScript|HTML|CSS|Tailwind|SASS|SCSS)\b/gi,
    /\b(Node\.?js|Python|Go|Golang|Java|Rust|Ruby|C\+\+|C#|\.NET|PHP|Scala|Kotlin|Swift)\b/gi,
    /\b(AWS|GCP|Azure|Terraform|Kubernetes|K8s|Docker|Jenkins|CircleCI|GitHub Actions|ArgoCD|Ansible|Pulumi)\b/gi,
    /\b(PostgreSQL|MySQL|MongoDB|Redis|DynamoDB|Cassandra|Elasticsearch|Kafka|RabbitMQ|SQL|NoSQL)\b/gi,
    /\b(REST|GraphQL|gRPC|microservices|serverless|Lambda)\b/gi,
    /\b(Machine Learning|ML|Deep Learning|NLP|LLM|GPT|PyTorch|TensorFlow|MLOps|RAG|fine.?tuning|transformers|computer vision)\b/gi,
  ];
  const found = new Set();
  for (const p of patterns) (desc.match(p) || []).forEach(m => found.add(m));
  return [...found].join(', ');
}

// Upwork emits skills already as tagged labels (the actor returns them in a
// `tags` array). Merge those with what we extracted from the description so
// the unified `skills` field is rich.
function mergeUpworkSkills(tags, desc) {
  const fromDesc = extractSkills(desc);
  const tagged = Array.isArray(tags) ? tags.filter(t => typeof t === 'string' && t) : [];
  const all = new Set([...tagged, ...fromDesc.split(',').map(s => s.trim()).filter(Boolean)]);
  return [...all].join(', ');
}

// The actor returns `budget` as a pre-formatted string: "$3,000.00" for fixed,
// "$50.00-$80.00" for an hourly range, or null when the client kept the
// budget private. We pass it through largely as-is and let the apply-side
// budget parser (in upwork-apply.js) handle both shapes.
function formatBudget(job) {
  const raw = job.budget;
  if (!raw) return '';
  const s = String(raw).trim();
  if (!s) return '';
  // Fixed: actor emits "$3,000.00" → "$3000 fixed" so it matches the LinkedIn
  // salary string convention and our parseBudget heuristic.
  if (job.jobType === 'Fixed' || /^\$[\d,]+(?:\.\d+)?$/.test(s)) {
    const num = s.replace(/[^\d.]/g, '').split('.')[0];
    return num ? `$${num} fixed` : s;
  }
  // Hourly: actor emits "$50.00-$80.00" or "$50.00"; normalize to "$50-$80/hr"
  // / "$50/hr" so the apply-side regex in upwork-apply.js picks it up.
  const range = s.match(/^\$([\d,.]+)\s*[-–]\s*\$([\d,.]+)$/);
  if (range) {
    const min = range[1].replace(/[^\d.]/g, '').split('.')[0];
    const max = range[2].replace(/[^\d.]/g, '').split('.')[0];
    return `$${min}-$${max}/hr`;
  }
  const single = s.match(/^\$([\d,.]+)$/);
  if (single) {
    const v = single[1].replace(/[^\d.]/g, '').split('.')[0];
    return `$${v}/hr`;
  }
  return s;
}

// Map Upwork "Expert / Intermediate / Entry" to LinkedIn's seniority labels
// so the existing scoring heuristic (which checks "Mid-Senior level") still
// functions on Upwork rows.
function mapExperienceLevel(level) {
  if (!level) return '';
  const l = String(level).toLowerCase();
  if (l.includes('expert')) return 'Senior';
  if (l.includes('intermediate')) return 'Mid-Senior level';
  if (l.includes('entry')) return 'Associate';
  return level;
}

// Compose the description we save to the DB so the proposal drafter has every
// signal: project description + screener questions (those are gold for
// tailored cover letters — the agent can reference them by topic).
function fullDescriptionWithQuestions(job) {
  const desc = String(job.description || '').trim();
  const qs = Array.isArray(job.questions) ? job.questions : [];
  if (!qs.length) return desc;
  const lines = qs.map((q, i) => `${i + 1}. ${q.question || q}`);
  return `${desc}\n\n--- Screener questions ---\n${lines.join('\n')}`;
}

async function main() {
  const input = buildActorInput(query, location, limit);
  console.log(`Searching Upwork: "${query}" | Location: ${input.location.join(',')} | Limit: ${limit}`);
  console.log('Filters: $5K+ fixed / $50+/hr hourly, expert level, US clients, payment-verified, ≥1 prior hires, newest first');
  console.log('Starting Apify actor run...');

  const run = await request({
    hostname: 'api.apify.com',
    path: `/v2/acts/${ACTOR_ID}/runs?token=${TOKEN}&maxItems=${limit}`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }, input);

  const runId = run.data?.id;
  const datasetId = run.data?.defaultDatasetId;
  if (!runId) {
    console.error('Failed to start actor:', JSON.stringify(run));
    process.exit(1);
  }
  console.log(`Actor run started: ${runId}`);

  let status = 'RUNNING';
  let attempts = 0;
  const MAX_ATTEMPTS = 240; // 5s × 240 = 20 min ceiling
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

  console.log(`Found ${items.length} Upwork jobs${timedOut ? ' (partial)' : ''}`);

  const results = items.map(job => {
    const desc = String(job.description || '');
    // Actor returns clientName as null when Upwork hides it (very common —
    // Upwork only shows the client's first name to authenticated users). Use
    // the country as a fallback identifier so the UI's "company" column has
    // *something* useful to render.
    const clientName = job.clientName || (job.clientLocation ? `${job.clientLocation} client` : 'Upwork client');
    const clientCountry = job.clientLocation || '';
    const fullDesc = fullDescriptionWithQuestions(job);
    return {
      source: 'upwork',
      searchQuery: query,
      jobId: String(job.id || job.subId || job.url || '').slice(0, 100),
      title: job.title || '',
      standardizedTitle: job.title || '',
      company: clientName,
      companyUrl: '',
      companyWebsite: '',
      // Pack the high-signal client trust metrics into companyDescription so
      // the row's secondary line in the UI ("foo · bar") shows them.
      companyDescription: [
        job.clientTotalSpent ? `Total spent: $${Number(job.clientTotalSpent).toLocaleString()}` : '',
        job.clientHireRatePercent ? `Hire rate: ${job.clientHireRatePercent}%` : '',
        job.clientRating ? `Rating: ${Number(job.clientRating).toFixed(2)}/5` : '',
        job.paymentVerified ? 'Payment verified' : '',
      ].filter(Boolean).join(' · '),
      companyEmployeeCount: '',
      companyHQ: clientCountry,
      companyIndustry: 'Freelance / Upwork',
      location: clientCountry || 'Remote',
      workplaceTypes: 'Remote',
      workRemoteAllowed: 'Yes',
      seniorityLevel: mapExperienceLevel(job.experienceLevel),
      employmentType: job.jobType === 'Fixed' ? 'Contract (fixed)' : 'Contract (hourly)',
      jobFunction: 'Freelance contract',
      salary: formatBudget(job),
      applicants: job.proposals ?? '',
      easyApply: 'No', // Upwork = proposal flow, not "Easy Apply"
      postedAt: job.absoluteDate || job.relativeDate || '',
      jobUrl: job.url || '',
      applyUrl: job.url || '',
      skills: mergeUpworkSkills(job.tags, desc),
      yearsExperience: '',
      education: '',
      benefits: '',
      descriptionSnippet: desc.replace(/\s+/g, ' ').substring(0, 500),
      fullDescription: fullDesc,
    };
  });

  if (outputPath) {
    fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
    console.log(`JSON saved to: ${outputPath}`);
  }

  for (const [i, r] of results.entries()) {
    console.log(`[${i + 1}] ${r.title} @ ${r.company}`);
    console.log(`    ${r.location} | ${r.salary || 'No budget'} | ${r.seniorityLevel} | ${r.employmentType}`);
    console.log(`    Applicants: ${r.applicants || 'N/A'} | Skills: ${r.skills || 'N/A'}`);
    console.log(`    URL: ${r.jobUrl}`);
  }

  console.log(`\nSUMMARY: ${results.length} Upwork projects from ${new Set(results.map(r => r.company)).size} clients`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});

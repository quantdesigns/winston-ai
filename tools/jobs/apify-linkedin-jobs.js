#!/usr/bin/env node
/**
 * CodePhil Apify LinkedIn Jobs Scraper Tool
 * Uses Apify's curious_coder LinkedIn Jobs Scraper (hKByXkMQaC5Qt9UMN)
 * Accepts LinkedIn search URLs with filters for targeted results.
 *
 * Usage:
 *   node apify-linkedin-jobs.js "<search query>" [--location "United States"] [--limit 25] [--output /path/to/output.json]
 *
 * Env: APIFY_TOKEN
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Prefer ~/.claude/.env as the canonical source of truth — ~/.zshrc and other
// shell configs have drifted in the past and caused us to hit rate limits on
// a stale key. Parse it directly and override process.env so every invocation
// of this tool uses the same credentials regardless of who launched the
// parent process.
function loadClaudeDotEnv() {
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), '.claude', '.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const s = line.trim();
      if (!s || s.startsWith('#')) continue;
      const m = s.replace(/^export\s+/, '').match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (!m) continue;
      let [, k, v] = m;
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      // Override unconditionally — ~/.claude/.env wins.
      process.env[k] = v;
    }
  } catch { /* file missing is fine — fall back to shell env */ }
}
loadClaudeDotEnv();

const TOKEN = process.env.APIFY_TOKEN;
if (!TOKEN) {
  console.error('ERROR: Set APIFY_TOKEN in your environment or ~/.claude/.env');
  process.exit(1);
}

const args = process.argv.slice(2);
const query = args.find(a => !a.startsWith('--'));
if (!query) {
  console.error('Usage: node apify-linkedin-jobs.js "<search query>" [--location "..."] [--limit N] [--output path]');
  process.exit(1);
}

function getFlag(name, defaultVal) {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : defaultVal;
}

const location = getFlag('--location', 'United States');
const limit = parseInt(getFlag('--limit', '25'));
const outputPath = getFlag('--output', '');

// curious_coder LinkedIn Jobs Scraper
const ACTOR_ID = 'hKByXkMQaC5Qt9UMN';

function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        } else {
          try { resolve(JSON.parse(data)); }
          catch { resolve(data); }
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function extractSkills(description) {
  if (!description) return '';
  const skillPatterns = [
    /\b(React|Vue|Angular|Next\.?js|Nuxt|Svelte|TypeScript|JavaScript|HTML|CSS|Tailwind|SASS|SCSS)\b/gi,
    /\b(Node\.?js|Python|Go|Golang|Java|Rust|Ruby|C\+\+|C#|\.NET|PHP|Scala|Kotlin|Swift)\b/gi,
    /\b(AWS|GCP|Azure|Terraform|Kubernetes|K8s|Docker|Jenkins|CircleCI|GitHub Actions|ArgoCD|Ansible|Pulumi)\b/gi,
    /\b(PostgreSQL|MySQL|MongoDB|Redis|DynamoDB|Cassandra|Elasticsearch|Kafka|RabbitMQ|SQL|NoSQL)\b/gi,
    /\b(REST|GraphQL|gRPC|microservices|serverless|Lambda)\b/gi,
    /\b(Machine Learning|ML|Deep Learning|NLP|LLM|GPT|PyTorch|TensorFlow|MLOps|RAG|fine.?tuning|transformers|computer vision)\b/gi,
    /\b(CI\/CD|DevOps|SRE|observability|monitoring|Datadog|Grafana|Prometheus|New Relic|PagerDuty)\b/gi,
    /\b(Agile|Scrum|Jira|Confluence|Git|Linux)\b/gi,
  ];
  const found = new Set();
  for (const pat of skillPatterns) {
    const matches = description.match(pat);
    if (matches) matches.forEach(m => found.add(m));
  }
  return [...found].join(', ');
}

function extractYearsExp(description) {
  if (!description) return '';
  const match = description.match(/(\d+)\+?\s*(?:years?|yrs?)\s*(?:of\s+)?(?:experience|exp)/i)
    || description.match(/(?:experience|exp)\s*(?:of\s+)?(\d+)\+?\s*(?:years?|yrs?)/i)
    || description.match(/(\d+)\+?\s*(?:years?|yrs?)\s+(?:in|with|of)/i);
  return match ? `${match[1]}+ years` : '';
}

function extractEducation(description) {
  if (!description) return '';
  const patterns = [
    /\b(PhD|Ph\.D|Doctorate)\b/i,
    /\b(Master'?s?\s*(?:degree)?|M\.?S\.?|MBA)\b/i,
    /\b(Bachelor'?s?\s*(?:degree)?|B\.?S\.?|B\.?A\.?)\b/i,
    /\b(Computer Science|Software Engineering|Information Technology|Mathematics)\b/i,
  ];
  const found = [];
  for (const pat of patterns) {
    const match = description.match(pat);
    if (match) found.push(match[0]);
  }
  return [...new Set(found)].join(', ');
}

function extractBenefits(description) {
  if (!description) return '';
  const benefitPatterns = [
    /\b(401k|401\(k\)|retirement)\b/gi,
    /\b(health\s*(?:care|insurance)|medical|dental|vision)\b/gi,
    /\b(PTO|paid\s*time\s*off|unlimited\s*(?:PTO|vacation)|vacation)\b/gi,
    /\b(equity|stock\s*options|RSU|shares)\b/gi,
    /\b(bonus|signing\s*bonus)\b/gi,
    /\b(parental\s*leave|maternity|paternity)\b/gi,
    /\b(remote|work\s*from\s*home|WFH|hybrid|flexible)\b/gi,
    /\b(professional\s*development|learning\s*(?:budget|stipend)|tuition)\b/gi,
  ];
  const found = new Set();
  for (const pat of benefitPatterns) {
    const matches = description.match(pat);
    if (matches) matches.forEach(m => found.add(m.trim()));
  }
  return [...found].join(', ');
}

async function main() {
  // Build LinkedIn search URL with filters: f_WT=2 (remote), f_JT=F (full-time)
  const encodedQuery = encodeURIComponent(query);
  const encodedLocation = encodeURIComponent(location);
  const searchUrl = `https://www.linkedin.com/jobs/search/?keywords=${encodedQuery}&location=${encodedLocation}&f_WT=2&f_JT=F`;

  console.log(`Searching LinkedIn jobs: "${query}" | Location: ${location} | Limit: ${limit}`);
  console.log(`Search URL: ${searchUrl}`);
  console.log('Starting Apify actor run...');

  // `maxItems` belongs in the URL query string — it's Apify's platform-level
  // cap that aborts the run once the dataset hits N items. The body-level
  // `maxItems` we were sending before is ignored by this actor, which is why
  // preview runs were collecting ~900 results and timing out.
  const runResult = await request({
    hostname: 'api.apify.com',
    path: `/v2/acts/${ACTOR_ID}/runs?token=${TOKEN}&maxItems=${limit}`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }, {
    urls: [searchUrl],
    count: limit,
  });

  const runId = runResult.data?.id;
  const defaultDatasetId = runResult.data?.defaultDatasetId;
  if (!runId) {
    console.error('Failed to start actor run:', JSON.stringify(runResult));
    process.exit(1);
  }
  console.log(`Actor run started: ${runId}`);

  let status = 'RUNNING';
  let attempts = 0;
  const MAX_ATTEMPTS = 360; // 5s × 360 = 30 min ceiling
  let timedOut = false;
  while (status === 'RUNNING' || status === 'READY') {
    if (attempts++ > MAX_ATTEMPTS) {
      console.error('Timed out waiting for actor run — aborting run and salvaging partial dataset');
      timedOut = true;
      // Abort the run so Apify stops billing further usage, then fall through
      // to fetch whatever items already landed in the dataset.
      try {
        await request({
          hostname: 'api.apify.com',
          path: `/v2/actor-runs/${runId}/abort?token=${TOKEN}`,
          method: 'POST',
        });
      } catch (e) {
        console.error('Abort call failed (continuing anyway):', e.message);
      }
      break;
    }
    await sleep(5000);
    const runInfo = await request({
      hostname: 'api.apify.com',
      path: `/v2/actor-runs/${runId}?token=${TOKEN}`,
      method: 'GET',
    });
    status = runInfo.data?.status;
    console.log(`  Status: ${status} (${attempts * 5}s elapsed)`);
  }

  // Non-success terminal states (TIMED-OUT, ABORTED, FAILED) can still have
  // partial data in the dataset — fetch it instead of hard-failing.
  if (status !== 'SUCCEEDED' && !timedOut) {
    console.error(`Actor run finished with status: ${status} — salvaging any partial dataset`);
  }

  const items = await request({
    hostname: 'api.apify.com',
    path: `/v2/datasets/${defaultDatasetId}/items?token=${TOKEN}&format=json&limit=${limit}`,
    method: 'GET',
  });

  if (!Array.isArray(items) || items.length === 0) {
    console.log('No jobs found for this query.');
    if (outputPath) fs.writeFileSync(outputPath, '[]');
    // Still exit non-zero on timeout with no salvage so upstream can surface
    // the timeout cleanly; exit 0 on a genuinely empty successful run.
    if (timedOut) process.exit(1);
    return;
  }

  if (timedOut || status !== 'SUCCEEDED') {
    console.log(`\n[PARTIAL] Salvaged ${items.length} jobs before ${timedOut ? 'timeout' : status}\n`);
  } else {
    console.log(`\nFound ${items.length} jobs\n`);
  }

  const results = items.map((job) => {
    const desc = job.descriptionText || '';
    const addr = job.companyAddress || {};
    return {
      source: 'linkedin',
      searchQuery: query,
      jobId: job.id || '',
      title: job.title || '',
      standardizedTitle: job.standardizedTitle || '',
      company: job.companyName || '',
      companyUrl: job.companyLinkedinUrl || '',
      companyWebsite: job.companyWebsite || '',
      companyDescription: (job.companyDescription || '').substring(0, 200),
      companyEmployeeCount: job.companyEmployeesCount || '',
      companyHQ: addr.addressLocality ? `${addr.addressLocality}, ${addr.addressRegion || ''}` : '',
      companyIndustry: job.industries || '',
      location: job.location || '',
      workplaceTypes: (job.workplaceTypes || []).join(', '),
      workRemoteAllowed: job.workRemoteAllowed ? 'Yes' : 'No',
      seniorityLevel: job.seniorityLevel || '',
      employmentType: job.employmentType || '',
      jobFunction: job.jobFunction || '',
      salary: job.salary || '',
      applicants: job.applicantsCount || '',
      easyApply: job.applyMethod === 'SimpleOnsiteApply' ? 'Yes' : 'No',
      postedAt: job.postedAt || '',
      jobUrl: job.link || '',
      applyUrl: job.applyUrl || '',
      skills: extractSkills(desc),
      yearsExperience: extractYearsExp(desc),
      education: extractEducation(desc),
      benefits: extractBenefits(desc),
      descriptionSnippet: desc.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').substring(0, 500),
      fullDescription: desc,
    };
  });

  if (outputPath) {
    fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
    console.log(`JSON saved to: ${outputPath}`);
  }

  for (const [i, r] of results.entries()) {
    console.log(`[${i + 1}] ${r.title} @ ${r.company}`);
    console.log(`    ${r.location} | ${r.salary || 'No salary'} | ${r.seniorityLevel} | ${r.employmentType}`);
    console.log(`    Skills: ${r.skills || 'N/A'}`);
    console.log(`    URL: ${r.jobUrl}`);
  }

  const companies = [...new Set(results.map(r => r.company))];
  console.log(`\nSUMMARY: ${results.length} jobs from ${companies.length} companies`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});

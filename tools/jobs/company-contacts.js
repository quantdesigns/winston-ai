#!/usr/bin/env node
/**
 * company-contacts.js — find a company's PUBLIC recruiting contact.
 *
 *   node company-contacts.js --website https://acme.com [--company "Acme"] [--json]
 *
 * Scope is deliberately narrow: this returns ROLE-BASED corporate mailboxes
 * (careers@, jobs@, talent@, ...) published on the company's own site, plus the
 * careers page URL. It never returns an individual's personal address — any
 * address that looks like a person's name is discarded (see isRoleBased). That
 * boundary is the point of this tool, not an incidental detail: it keeps the
 * jobs pipeline to corporate contact info that is published to be contacted,
 * and out of personal-data harvesting.
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

const args = process.argv.slice(2);
const getFlag = (name, dflt = '') => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

const website = getFlag('--website');
const company = getFlag('--company', '');
const asJson = args.includes('--json');

if (!website) {
  console.error('Usage: node company-contacts.js --website <url> [--company "Name"] [--json]');
  process.exit(1);
}

// Role-based mailboxes a company publishes so strangers can contact them.
const ROLE_LOCALPARTS = [
  'careers', 'career', 'jobs', 'job', 'recruiting', 'recruitment', 'recruiter',
  'talent', 'hiring', 'hr', 'people', 'apply', 'applications', 'join', 'work',
  'employment', 'personal', 'bewerbung', 'jobs-de',
];

// Generic corporate mailboxes. Not recruiting-specific, but when one is
// published *on a careers page* it is how the company expects to be contacted
// about jobs — so we accept it as a clearly-labelled fallback.
const GENERIC_LOCALPARTS = new Set(['contact', 'info', 'hello', 'office', 'mail', 'kontakt']);

// Never useful for a job application, regardless of where it appears.
const DENY_LOCALPARTS = new Set([
  'support', 'sales', 'admin', 'privacy', 'legal', 'press', 'media', 'security',
  'abuse', 'webmaster', 'postmaster', 'noreply', 'no-reply', 'donotreply',
  'marketing', 'billing', 'help',
]);

const localPart = email => email.split('@')[0].toLowerCase();

/**
 * A recruiting-specific mailbox (careers@, jobs@, talent@ ...). An address like
 * "sarah.chen@acme.com" or "jsmith@acme.com" is an individual and never
 * matches: this tool intentionally does not surface personal contact data.
 */
function isRecruitingMailbox(email) {
  const local = localPart(email);
  if (DENY_LOCALPARTS.has(local) || GENERIC_LOCALPARTS.has(local)) return false;
  return ROLE_LOCALPARTS.some(r => local === r || local.startsWith(r + '-') || local.startsWith(r + '.') || local.startsWith(r + '_'));
}

/** A generic corporate mailbox — acceptable only on a careers page. */
function isGenericMailbox(email) {
  return GENERIC_LOCALPARTS.has(localPart(email));
}

/**
 * The hard boundary: anything that is not a known corporate role mailbox is
 * treated as an individual's address and discarded.
 */
function isCorporateMailbox(email) {
  return isRecruitingMailbox(email) || isGenericMailbox(email);
}

function fetchPage(target, redirects = 0) {
  return new Promise(resolve => {
    let u;
    try { u = new URL(target); } catch { return resolve(''); }
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.get(
      {
        hostname: u.hostname,
        path: (u.pathname || '/') + (u.search || ''),
        port: u.port || undefined,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; winston-jobs/1.0)', Accept: 'text/html' },
        timeout: 10000,
      },
      res => {
        // Follow redirects (careers pages are almost always redirected).
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 4) {
          res.resume();
          const next = new URL(res.headers.location, u).toString();
          return resolve(fetchPage(next, redirects + 1));
        }
        if (res.statusCode >= 400) { res.resume(); return resolve(''); }
        let data = '';
        res.on('data', c => {
          data += c;
          if (data.length > 800_000) { req.destroy(); resolve(data); } // cap
        });
        res.on('end', () => resolve(data));
      }
    );
    req.on('timeout', () => { req.destroy(); resolve(''); });
    req.on('error', () => resolve(''));
  });
}

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

function extractEmails(html, domain) {
  const found = new Set();
  for (const m of html.match(EMAIL_RE) || []) {
    const e = m.toLowerCase().replace(/\.$/, '');
    // Ignore asset filenames that regex-match (e.g. "logo@2x.png") and
    // third-party addresses on unrelated domains.
    if (/\.(png|jpg|jpeg|gif|svg|webp|css|js)$/.test(e)) continue;
    const host = e.split('@')[1] || '';
    if (domain && !host.endsWith(domain) && !domain.endsWith(host)) continue;
    found.add(e);
  }
  return [...found];
}

function findCareersLink(html, base) {
  // <a href="...">Careers</a> — take the first link whose text or href reads
  // like a careers/jobs page.
  const re = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]{0,80}?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = m[1];
    const text = m[2].replace(/<[^>]*>/g, ' ').toLowerCase();
    // Skip non-navigational hrefs (javascript:;, #, mailto:) — they are not pages.
    if (/^(javascript:|#|mailto:|tel:)/i.test(href.trim())) continue;
    if (/career|jobs|join.?us|work.?with.?us|vacanc|hiring|stellen/i.test(text + ' ' + href)) {
      try {
        const u = new URL(href, base);
        if (u.protocol === 'http:' || u.protocol === 'https:') return u.toString();
      } catch { /* skip */ }
    }
  }
  return '';
}

function rootDomain(host) {
  const parts = host.replace(/^www\./, '').split('.');
  return parts.length > 2 ? parts.slice(-2).join('.') : parts.join('.');
}

async function main() {
  let base;
  try { base = new URL(website.startsWith('http') ? website : 'https://' + website); }
  catch { fail('invalid website url'); return; }

  const domain = rootDomain(base.hostname);
  const home = await fetchPage(base.toString());

  // Candidate pages: the careers link the homepage advertises, then the
  // conventional paths. First role-based hit wins.
  const candidates = [];
  const advertised = home ? findCareersLink(home, base.toString()) : '';
  if (advertised) candidates.push(advertised);
  for (const p of ['/careers', '/careers/contact', '/jobs', '/about/careers', '/company/careers', '/contact']) {
    candidates.push(new URL(p, base.origin).toString());
  }

  // A recruiting mailbox anywhere beats a generic one; a generic mailbox counts
  // only when it appears on a careers page, where it is the stated way in.
  const recruiting = new Map(); // email -> source page
  const generic = new Map();

  const harvest = (html, url, isCareersPage) => {
    for (const e of extractEmails(html, domain).filter(isCorporateMailbox)) {
      if (isRecruitingMailbox(e)) {
        if (!recruiting.has(e)) recruiting.set(e, url);
      } else if (isCareersPage && !generic.has(e)) {
        generic.set(e, url);
      }
    }
  };

  let careersUrl = advertised;
  harvest(home, base.toString(), false);

  for (const url of candidates) {
    if (recruiting.size) break;
    const html = await fetchPage(url);
    if (!html) continue;
    const isCareersPage = /career|job|vacanc|hiring|stellen/i.test(url);
    if (!careersUrl && isCareersPage) careersUrl = url;
    harvest(html, url, isCareersPage);
  }

  const rank = e => {
    const l = localPart(e).split(/[-._]/)[0];
    const i = ROLE_LOCALPARTS.indexOf(l);
    return i < 0 ? 99 : i;
  };
  const recruitingList = [...recruiting.keys()].sort((a, b) => rank(a) - rank(b));
  const genericList = [...generic.keys()];

  const email = recruitingList[0] || genericList[0] || '';
  const contactType = recruitingList.length ? 'recruiting' : genericList.length ? 'generic' : '';
  const sourcePage = email ? (recruiting.get(email) || generic.get(email) || '') : '';

  const out = {
    company: company || domain,
    website: base.origin,
    recruiting_email: email,
    contact_type: contactType, // "recruiting" | "generic" | ""
    all_emails: [...recruitingList, ...genericList],
    careers_url: careersUrl || '',
    source_page: sourcePage,
    found: Boolean(email || careersUrl),
  };

  if (asJson) { console.log(JSON.stringify(out)); return; }
  console.log(`${out.company}`);
  const label = out.contact_type === 'generic' ? '(generic, from careers page)' : '';
  console.log(`  recruiting email : ${out.recruiting_email || '(none published)'} ${label}`.trimEnd());
  console.log(`  careers page     : ${out.careers_url || '(not found)'}`);
  if (out.all_emails.length > 1) console.log(`  other            : ${out.all_emails.slice(1).join(', ')}`);
}

function fail(msg) {
  if (asJson) console.log(JSON.stringify({ found: false, error: msg }));
  else console.error('Error: ' + msg);
  process.exit(1);
}

main().catch(e => fail(e.message));

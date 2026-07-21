"use client";

import { useState, useEffect, useCallback, useMemo, Fragment } from "react";
import Link from "next/link";
import JobWizard from "./JobWizard";
import { SCRAPE_DONE_EVENT } from "./wizardRun";

interface Job {
  job_id: string;
  title: string;
  standardized_title: string;
  company: string;
  company_url: string;
  company_website: string;
  company_description: string;
  company_employees: string;
  company_hq: string;
  contact_email: string;
  contact_type: string;
  careers_url: string;
  has_research: boolean;
  is_intermediary: boolean;
  actual_employer: string;
  industry: string;
  location: string;
  workplace_type: string;
  remote: string;
  seniority_level: string;
  employment_type: string;
  job_function: string;
  years_required: string;
  education: string;
  salary: string;
  skills: string;
  benefits: string;
  applicants: string;
  easy_apply: string;
  posted_at: string;
  apply_url: string;
  job_url: string;
  description_summary: string;
  category: string;
  resume_match: number;
  application_status: string;
  resume_variant: string;
  drive_folder_url: string;
  notes: string;
  first_seen_at: string;
  last_seen_at: string;
  applied_at: string;
  week_tag: string;
  flagged: boolean;
  source: string; // "linkedin" | "upwork" | "indeed" | "glassdoor" | "google"
}

interface Stats {
  total: number;
  by_status: Record<string, number>;
  by_category: Record<string, number>;
  avg_score: number;
  high_scoring: number;
  last_run: string;
}

const STATUS_STYLES: Record<string, { bg: string; text: string; dot: string; label: string }> = {
  new: { bg: "bg-indigo-500/15", text: "text-indigo-300", dot: "bg-indigo-400", label: "New" },
  seen: { bg: "bg-zinc-500/10", text: "text-zinc-400", dot: "bg-zinc-500", label: "Seen" },
  drafted: { bg: "bg-amber-500/15", text: "text-amber-300", dot: "bg-amber-400", label: "Drafted" },
  applied: { bg: "bg-emerald-500/15", text: "text-emerald-300", dot: "bg-emerald-400", label: "Applied" },
  interviewing: { bg: "bg-sky-500/15", text: "text-sky-300", dot: "bg-sky-400", label: "Interviewing" },
  offered: { bg: "bg-violet-500/15", text: "text-violet-300", dot: "bg-violet-400", label: "Offered" },
  rejected: { bg: "bg-rose-500/15", text: "text-rose-300", dot: "bg-rose-400", label: "Rejected" },
  expired: { bg: "bg-zinc-500/10", text: "text-zinc-500", dot: "bg-zinc-500", label: "Expired" },
  withdrawn: { bg: "bg-zinc-500/10", text: "text-zinc-400", dot: "bg-zinc-500", label: "Withdrawn" },
  needs_manual: { bg: "bg-orange-500/15", text: "text-orange-300", dot: "bg-orange-400", label: "Needs manual" },
  application_failed: { bg: "bg-red-500/15", text: "text-red-300", dot: "bg-red-400", label: "Failed" },
};

interface Workspace {
  id: string;
  label: string;
  // Regex matched against `${title} ${standardized_title} ${category}`.
  // If a job matches no workspace's pattern, it lands in "other".
  pattern: RegExp | null;
  // Optional: filter by job.source. Used by the Upwork tab so freelance
  // projects don't appear under engineering and stays separate from the
  // ATS-style application flow.
  source?: string;
}

const WORKSPACES: Workspace[] = [
  { id: "all", label: "All", pattern: null },
  {
    id: "engineering",
    label: "Engineering",
    pattern: /\b(software|engineer|developer|frontend|backend|full[- ]?stack|devops|sre|ai|ml|machine[- ]?learning|data[- ]?engineer|platform|infra|mobile|ios|android)\b/i,
  },
  { id: "other", label: "Other", pattern: null }, // matches jobs no rule claims
];

// Marketplace is now a standalone filter (a select in the toolbar), not a
// workspace tab. Upwork lives here alongside the ATS sources rather than
// getting its own top-level tab next to Engineering.
const SOURCE_FILTERS: { id: string; label: string }[] = [
  { id: "all", label: "All sources" },
  { id: "linkedin", label: "LinkedIn" },
  { id: "indeed", label: "Indeed" },
  { id: "google", label: "Google" },
  { id: "upwork", label: "Upwork" },
];

function matchesWorkspace(job: Job, ws: Workspace, sourceFilter: string): boolean {
  if (ws.id === "all") return true;
  // Keep freelance Upwork asks ("Build my React dashboard") out of the
  // title-based workspaces — UNLESS the user explicitly filtered to Upwork,
  // in which case they want to see them.
  if (sourceFilter !== "upwork" && (job.source || "linkedin") === "upwork")
    return false;
  const haystack = `${job.title} ${job.standardized_title} ${job.category}`;
  if (ws.id === "other") {
    return !WORKSPACES.some(w => w.pattern && w.pattern.test(haystack));
  }
  return !!(ws.pattern && ws.pattern.test(haystack));
}

const STATUS_FILTERS = [
  "all",
  "new",
  "drafted",
  "applied",
  "needs_manual",
  "application_failed",
  "interviewing",
  "offered",
  "rejected",
];

function scoreColor(score: number) {
  if (score >= 90) return "text-emerald-300";
  if (score >= 80) return "text-lime-300";
  if (score >= 70) return "text-amber-300";
  if (score >= 60) return "text-orange-300";
  return "text-zinc-500";
}

// driveLinkFor returns the best Drive URL we can offer for a job row. If the
// agent recorded a specific folder URL, use it. Otherwise — for drafted rows
// whose folder URL wasn't written back to the DB — open a Drive search for
// the company + title so the user can jump straight to the package folder.
function driveLinkFor(j: Job): string {
  if (j.drive_folder_url) return j.drive_folder_url;
  const q = [j.company, j.title].filter(Boolean).join(" ");
  return `https://drive.google.com/drive/search?q=${encodeURIComponent(q)}`;
}

function scoreBg(score: number) {
  if (score >= 90) return "bg-emerald-500/20 border-emerald-500/30";
  if (score >= 80) return "bg-lime-500/15 border-lime-500/25";
  if (score >= 70) return "bg-amber-500/15 border-amber-500/25";
  if (score >= 60) return "bg-orange-500/15 border-orange-500/25";
  return "bg-zinc-500/10 border-zinc-500/20";
}

function StatusChip({ status, firstSeenAt }: { status: string; firstSeenAt?: string }) {
  const effective = effectiveStatus(status, firstSeenAt);
  const s = STATUS_STYLES[effective] || STATUS_STYLES.new;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ${s.bg} ${s.text}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}

// effectiveStatus folds "new" into "seen" once the job has been in the DB for
// more than 7 days without moving forward. Keeps the "New" label honest — it
// means "recently added" rather than "never drafted".
function effectiveStatus(status: string, firstSeenAt?: string): string {
  if (status !== "new" || !firstSeenAt) return status;
  const ts = Date.parse(firstSeenAt);
  if (Number.isNaN(ts)) return status;
  const ageDays = (Date.now() - ts) / (1000 * 60 * 60 * 24);
  return ageDays > 7 ? "seen" : "new";
}

// SourceBadge labels which marketplace a row came from. We only render it when
// it's not the "default" LinkedIn source so the table stays uncluttered for
// the bulk of rows that are LinkedIn jobs anyway.
const SOURCE_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  upwork: { bg: "bg-emerald-500/15 border border-emerald-500/30", text: "text-emerald-200", label: "Upwork" },
  indeed: { bg: "bg-blue-500/15 border border-blue-500/30", text: "text-blue-200", label: "Indeed" },
  glassdoor: { bg: "bg-teal-500/15 border border-teal-500/30", text: "text-teal-200", label: "Glassdoor" },
  google: { bg: "bg-amber-500/15 border border-amber-500/30", text: "text-amber-200", label: "Google" },
};
function SourceBadge({ source }: { source?: string }) {
  if (!source || source === "linkedin") return null;
  const s = SOURCE_STYLES[source] || { bg: "bg-zinc-500/15 border border-zinc-500/30", text: "text-zinc-300", label: source };
  return (
    <span className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide ${s.bg} ${s.text}`}>
      {s.label}
    </span>
  );
}

function ApplyingChip() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-indigo-500/30 bg-indigo-500/15 px-2.5 py-1 text-[11px] font-medium text-indigo-200">
      <svg className="h-3 w-3 animate-spin" fill="none" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
        <path d="M21 12a9 9 0 00-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      </svg>
      Applying…
    </span>
  );
}

// Defensive un-corruption: a previous scrape bug stored skills/benefits as
// `[...str].join(', ')` — splitting words into single characters. We detect
// (≥70% of comma-space tokens are length ≤ 1) and reverse by joining tokens
// with empty string, recovering the original "Skill A, Skill B, ..." form.
function sanitizeJoinedList(s: string): string {
  if (!s) return s;
  const tokens = s.split(", ");
  if (tokens.length < 4) return s;
  const singleChars = tokens.filter(t => t.length <= 1).length;
  if (singleChars / tokens.length < 0.7) return s;
  return tokens.join("");
}

function SkillTags({ raw }: { raw: string }) {
  const all = useMemo(
    () => sanitizeJoinedList(raw).split(/[,;]+/).map(s => s.trim()).filter(Boolean),
    [raw]
  );
  // One line, never wrapping: four wrapped chips stacked four rows deep and made
  // every row ~133px tall, so only 7 of 100+ jobs fit on screen. The full list
  // is one click away in the expanded row.
  const visible = all.slice(0, 3);
  const extra = all.length - visible.length;
  if (!visible.length) return <span className="text-zinc-600">—</span>;
  return (
    <div className="flex flex-nowrap items-center gap-1 overflow-hidden" title={all.join(", ")}>
      {visible.map(s => (
        <span
          key={s}
          className="inline-flex shrink-0 items-center rounded-md border border-white/[0.05] bg-white/[0.035] px-1.5 py-0.5 text-[10.5px] leading-4 text-zinc-300"
        >
          {s}
        </span>
      ))}
      {extra > 0 && (
        <span
          className="inline-flex items-center rounded-md border border-white/[0.04] bg-white/[0.02] px-1.5 py-0.5 text-[10.5px] leading-4 text-zinc-500"
          title={all.slice(4).join(", ")}
        >
          +{extra}
        </span>
      )}
    </div>
  );
}

function FlagButton({
  flagged, onToggle,
}: { flagged: boolean; onToggle: (next: boolean) => void }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onToggle(!flagged); }}
      className={`inline-flex h-[26px] w-[26px] items-center justify-center rounded-md border transition ${
        flagged
          ? "border-amber-500/40 bg-amber-500/15 text-amber-300 hover:bg-amber-500/25"
          : "border-white/[0.06] bg-white/[0.03] text-zinc-500 hover:text-amber-300 hover:bg-amber-500/10"
      }`}
      title={flagged ? "Unflag this job" : "Flag this job"}
      aria-label={flagged ? "Unflag job" : "Flag job"}
      aria-pressed={flagged}
    >
      <svg
        className="h-3.5 w-3.5"
        viewBox="0 0 24 24"
        fill={flagged ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth={1.8}
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 21V4a1 1 0 011-1h12l-2 4 2 4H4" />
      </svg>
    </button>
  );
}

const VARIANT_OPTIONS: { value: string; label: string; tone: string }[] = [
  { value: "full-stack", label: "Full Stack", tone: "border-indigo-500/30 bg-indigo-500/10 text-indigo-200" },
  { value: "frontend", label: "Frontend", tone: "border-sky-500/30 bg-sky-500/10 text-sky-200" },
  { value: "backend", label: "Backend", tone: "border-emerald-500/30 bg-emerald-500/10 text-emerald-200" },
  { value: "ai-ml", label: "AI/ML", tone: "border-fuchsia-500/30 bg-fuchsia-500/10 text-fuchsia-200" },
  { value: "devops", label: "DevOps", tone: "border-amber-500/30 bg-amber-500/10 text-amber-200" },
];

function VariantPicker({
  value, onChange,
}: { value: string; onChange: (next: string) => void }) {
  const opt = VARIANT_OPTIONS.find(o => o.value === value);
  const tone = opt?.tone ?? "border-white/[0.08] bg-white/[0.03] text-zinc-400";
  return (
    <div className="relative inline-block">
      <select
        value={value || ""}
        onChange={(e) => onChange(e.target.value)}
        className={`h-[22px] cursor-pointer appearance-none rounded-md border px-2 pr-6 text-[11px] font-medium tracking-wide transition focus:outline-none focus:ring-1 focus:ring-indigo-500/40 ${tone}`}
        title="Resume variant — controls which DOCX the auto-applier uploads"
      >
        <option value="" className="bg-zinc-900 text-zinc-400">— none —</option>
        {VARIANT_OPTIONS.map(o => (
          <option key={o.value} value={o.value} className="bg-zinc-900 text-zinc-100">
            {o.label}
          </option>
        ))}
      </select>
      <svg className="pointer-events-none absolute right-1 top-1/2 h-3 w-3 -translate-y-1/2 text-current opacity-60" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
      </svg>
    </div>
  );
}

function formatSalary(s: string) {
  if (!s) return "—";
  return s.replace(/\s+/g, " ").trim();
}

function hasSalary(s: string) {
  return Boolean(s && s.trim() && s.trim() !== "—");
}

/**
 * True only when a location narrows anything down. Remote listings overwhelmingly
 * say "United States" or "Anywhere", which is a column's worth of space spent
 * saying nothing — so those are treated as absent.
 */
function isSpecificLocation(loc: string) {
  if (!loc || !loc.trim()) return false;
  const l = loc.trim().toLowerCase();
  return !["united states", "anywhere", "remote", "usa", "us", "worldwide", "n/a", "—"].includes(l);
}

function formatRelative(dateStr: string) {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  // Indeed/Google post a human phrase ("30+ days ago"), not an ISO date.
  // Surface it as-is rather than rendering a literal "Invalid Date".
  if (Number.isNaN(d.getTime())) {
    const s = dateStr.trim();
    return s.length > 0 && s.length <= 24 ? s : "—";
  }
  const diff = Date.now() - d.getTime();
  const day = 86400000;
  if (diff < day) return "today";
  if (diff < 2 * day) return "1d ago";
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  if (diff < 30 * day) return `${Math.floor(diff / (7 * day))}w ago`;
  return d.toLocaleDateString();
}

type SortKey = "score" | "status" | "title" | "company" | "location" | "salary" | "posted";
type SortDir = "asc" | "desc";

interface RunJobSnapshot {
  job_id: string;
  title: string;
  company: string;
  apply_url: string;
}

interface ApplyRun {
  id: string;
  started_at: number;
  dry_run: boolean;
  kind: "selected" | "drive" | "pipeline";
  jobs: RunJobSnapshot[];
}

const RUNS_KEY = "winston.jobsApplyRuns";
const TERMINAL_STATUSES = new Set([
  "applied", "needs_manual", "application_failed", "rejected", "withdrawn", "interviewing", "offered",
]);

function loadRuns(): ApplyRun[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(RUNS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ApplyRun[];
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    return parsed.filter(r => r.started_at > cutoff);
  } catch {
    return [];
  }
}

function saveRuns(runs: ApplyRun[]) {
  if (typeof window === "undefined") return;
  try { localStorage.setItem(RUNS_KEY, JSON.stringify(runs)); } catch {}
}

export default function JobsPage() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("all");
  const [search, setSearch] = useState("");
  const [minScore, setMinScore] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [packageFor, setPackageFor] = useState<Job | null>(null);
  const [triggering, setTriggering] = useState(false);
  const [triggerMsg, setTriggerMsg] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("score");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [runs, setRuns] = useState<ApplyRun[]>([]);
  const [runJobMap, setRunJobMap] = useState<Record<string, Job>>({});
  const [workspace, setWorkspace] = useState<string>("all");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [page, setPage] = useState(0);
  const [pageSize] = useState(200);
  // Wizard modal lifecycle. The in-flight scrape is tracked separately
  // (server-side + the global JobsScraperStatus pill), so closing the modal
  // or navigating away never stops a run.
  const [wizardState, setWizardState] = useState<"closed" | "open">("closed");

  // Hydrate workspace from localStorage
  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = localStorage.getItem("winston.jobsWorkspace");
    if (saved && WORKSPACES.some(w => w.id === saved)) setWorkspace(saved);
  }, []);
  useEffect(() => {
    if (typeof window !== "undefined") localStorage.setItem("winston.jobsWorkspace", workspace);
  }, [workspace]);

  // When a background scrape finishes (reported by the global status pill),
  // refresh the table — covers the case where the user is on /jobs with the
  // wizard modal closed.
  useEffect(() => {
    const onDone = () => { fetchJobs(); fetchStats(); };
    window.addEventListener(SCRAPE_DONE_EVENT, onDone);
    return () => window.removeEventListener(SCRAPE_DONE_EVENT, onDone);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Hydrate runs from localStorage
  useEffect(() => { setRuns(loadRuns()); }, []);
  useEffect(() => { saveRuns(runs); }, [runs]);

  const fetchJobs = useCallback(async () => {
    const params = new URLSearchParams();
    if (status && status !== "all") params.set("status", status);
    if (search) params.set("search", search);
    if (minScore > 0) params.set("min_score", String(minScore));
    if (flaggedOnly) params.set("flagged", "1");
    // limit=0 → server returns every matching row. The UI does workspace
    // filter + sort + pagination client-side so those operations see the
    // full data set instead of a 50-row slice.
    params.set("limit", "0");
    try {
      const res = await fetch(`/api/jobs?${params.toString()}`);
      const data = await res.json();
      setJobs(data.jobs || []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [status, search, minScore, flaggedOnly]);

  // Reset to first page whenever anything that changes the ordered result
  // set changes — including the sort itself. Sorting operates on the full
  // dataset, so after re-sorting we must jump back to page 1, otherwise the
  // user stays on page 3 and the top-ranked rows are off-screen (which looks
  // like "sorting didn't work").
  useEffect(() => {
    setPage(0);
  }, [status, search, minScore, flaggedOnly, workspace, sourceFilter, sortKey, sortDir]);

  const sortedJobs = useMemo(() => {
    const ws = WORKSPACES.find(w => w.id === workspace) || WORKSPACES[0];
    let arr = [...jobs];
    if (sourceFilter !== "all")
      arr = arr.filter(j => (j.source || "linkedin") === sourceFilter);
    if (workspace !== "all")
      arr = arr.filter(j => matchesWorkspace(j, ws, sourceFilter));
    const dir = sortDir === "asc" ? 1 : -1;
    arr.sort((a, b) => {
      if (!!a.flagged !== !!b.flagged) return a.flagged ? -1 : 1;
      let av: string | number = "";
      let bv: string | number = "";
      switch (sortKey) {
        case "score": av = a.resume_match; bv = b.resume_match; break;
        case "status": av = a.application_status; bv = b.application_status; break;
        case "title": av = a.title.toLowerCase(); bv = b.title.toLowerCase(); break;
        case "company": av = a.company.toLowerCase(); bv = b.company.toLowerCase(); break;
        case "location": av = (a.location || "").toLowerCase(); bv = (b.location || "").toLowerCase(); break;
        case "salary": {
          const parse = (s: string) => {
            const m = s.match(/\d[\d,]*/);
            return m ? parseInt(m[0].replace(/,/g, ""), 10) : 0;
          };
          av = parse(a.salary); bv = parse(b.salary); break;
        }
        case "posted": av = a.posted_at || ""; bv = b.posted_at || ""; break;
      }
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
    return arr;
  }, [jobs, sortKey, sortDir, workspace, sourceFilter]);

  // Client-side pagination over the already-filtered-and-sorted set. The
  // server returns every row matching the API filters; workspace + sort are
  // client-side and operate on the full set, so page 1 always reflects
  // whatever the active filters produce.
  const pageJobs = useMemo(
    () => sortedJobs.slice(page * pageSize, (page + 1) * pageSize),
    [sortedJobs, page, pageSize]
  );

  const workspaceCounts = useMemo(() => {
    const base =
      sourceFilter === "all"
        ? jobs
        : jobs.filter(j => (j.source || "linkedin") === sourceFilter);
    const counts: Record<string, number> = {};
    for (const ws of WORKSPACES) {
      counts[ws.id] =
        ws.id === "all"
          ? base.length
          : base.filter(j => matchesWorkspace(j, ws, sourceFilter)).length;
    }
    return counts;
  }, [jobs, sourceFilter]);

  const toggleFlag = useCallback(async (jobId: string, next: boolean) => {
    // Optimistic
    setJobs(prev => prev.map(j => j.job_id === jobId ? { ...j, flagged: next } : j));
    try {
      await fetch(`/api/jobs/${encodeURIComponent(jobId)}/flag`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flagged: next }),
      });
    } catch (e) {
      console.error(e);
      setJobs(prev => prev.map(j => j.job_id === jobId ? { ...j, flagged: !next } : j));
    }
  }, []);

  const updateVariant = useCallback(async (jobId: string, next: string) => {
    const prevValue = jobs.find(j => j.job_id === jobId)?.resume_variant || "";
    setJobs(prev => prev.map(j => j.job_id === jobId ? { ...j, resume_variant: next } : j));
    try {
      const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/variant`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variant: next }),
      });
      if (!res.ok) throw new Error(await res.text());
    } catch (e) {
      console.error(e);
      setJobs(prev => prev.map(j => j.job_id === jobId ? { ...j, resume_variant: prevValue } : j));
    }
  }, [jobs]);

  const toggleSort = useCallback((key: SortKey) => {
    if (sortKey === key) {
      setSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir(key === "score" ? "desc" : "asc");
    }
  }, [sortKey]);

  const toggleSelect = useCallback((jobId: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(jobId)) next.delete(jobId); else next.add(jobId);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    setSelected(prev => {
      if (prev.size === sortedJobs.length && sortedJobs.length > 0) return new Set();
      return new Set(sortedJobs.map(j => j.job_id));
    });
  }, [sortedJobs]);

  const selectRandom = useCallback((n: number) => {
    const shuffled = [...sortedJobs].sort(() => Math.random() - 0.5).slice(0, n);
    setSelected(new Set(shuffled.map(j => j.job_id)));
  }, [sortedJobs]);

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch("/api/jobs/stats");
      const data = await res.json();
      setStats(data);
    } catch (e) { console.error(e); }
  }, []);

  useEffect(() => { fetchJobs(); }, [fetchJobs]);
  useEffect(() => { fetchStats(); }, [fetchStats]);

  // Compute which runs still have at least one job in non-terminal state.
  const hasActiveRuns = useMemo(() => {
    if (runs.length === 0) return false;
    return runs.some(r => r.jobs.some(j => {
      const live = runJobMap[j.job_id];
      return !live || !TERMINAL_STATUSES.has(live.application_status);
    }));
  }, [runs, runJobMap]);

  // Set of job IDs currently in flight (any active run, non-terminal status).
  const applyingIds = useMemo(() => {
    const s = new Set<string>();
    for (const r of runs) {
      for (const snap of r.jobs) {
        const live = runJobMap[snap.job_id];
        if (!live || !TERMINAL_STATUSES.has(live.application_status)) {
          s.add(snap.job_id);
        }
      }
    }
    return s;
  }, [runs, runJobMap]);

  // Poll unfiltered job state for tracked runs. We fetch up to 1000 rows
  // unfiltered so a tracked job stays visible even when the user's current
  // filter would hide it.
  const fetchRunJobs = useCallback(async () => {
    if (runs.length === 0) return;
    try {
      const res = await fetch("/api/jobs?limit=1000");
      const data = await res.json();
      const map: Record<string, Job> = {};
      for (const j of data.jobs || []) map[j.job_id] = j;
      setRunJobMap(map);
    } catch (e) { console.error(e); }
  }, [runs.length]);

  useEffect(() => { fetchRunJobs(); }, [fetchRunJobs]);
  useEffect(() => {
    if (!hasActiveRuns) return;
    const id = setInterval(() => {
      fetchRunJobs();
      fetchJobs();
      fetchStats();
    }, 7000);
    return () => clearInterval(id);
  }, [hasActiveRuns, fetchRunJobs, fetchJobs, fetchStats]);

  const pushRun = useCallback((kind: ApplyRun["kind"], dryRun: boolean, jobIds: string[]) => {
    const lookup = new Map(jobs.map(j => [j.job_id, j]));
    const snapshot: RunJobSnapshot[] = jobIds.map(id => {
      const j = lookup.get(id);
      return {
        job_id: id,
        title: j?.title || "(loading…)",
        company: j?.company || "",
        apply_url: j?.apply_url || "",
      };
    });
    const run: ApplyRun = {
      id: `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      started_at: Date.now(),
      dry_run: dryRun,
      kind,
      jobs: snapshot,
    };
    setRuns(prev => [run, ...prev].slice(0, 20));
  }, [jobs]);

  const dismissRun = useCallback((id: string) => {
    setRuns(prev => prev.filter(r => r.id !== id));
  }, []);

  const applySelected = useCallback(async () => {
    if (selected.size === 0) return;
    setTriggering(true);
    setTriggerMsg(null);
    const ids = Array.from(selected);
    // Split selection by source — Upwork rows go through upwork-apply.js
    // (drafts proposals via Claude, opens visible Chrome with cover letter
    // pre-filled, never submits). Everything else goes through the existing
    // LinkedIn/ATS interactive auto-apply flow.
    const lookup = new Map(jobs.map(j => [j.job_id, j]));
    const upworkIds: string[] = [];
    const otherIds: string[] = [];
    for (const id of ids) {
      const j = lookup.get(id);
      if ((j?.source || "linkedin") === "upwork") upworkIds.push(id);
      else otherIds.push(id);
    }
    const messages: string[] = [];
    try {
      if (upworkIds.length > 0) {
        const res = await fetch("/api/jobs/apply-upwork-selected", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ job_ids: upworkIds }),
        });
        const data = await res.json();
        if (res.ok) {
          messages.push(`Upwork: drafting ${data.count} proposal${data.count === 1 ? "" : "s"} via Claude. Chrome will open with cover letters pre-filled — review and submit each yourself.`);
        } else {
          messages.push("Upwork failed to start: " + (data.error || res.statusText));
        }
      }
      if (otherIds.length > 0) {
        const res = await fetch("/api/jobs/apply-selected-interactive", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ job_ids: otherIds }),
        });
        const data = await res.json();
        if (res.ok) {
          messages.push(`Auto-apply: Chrome opening with ${data.count} tab${data.count === 1 ? "" : "s"} in batches of 10. AI fills every field and stops before Submit — review, submit, then update status from the row dropdown.`);
        } else {
          messages.push("Auto-apply failed to start: " + (data.error || res.statusText));
        }
      }
      setTriggerMsg(messages.join(" "));
      if (messages.every(m => !m.includes("failed"))) setSelected(new Set());
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "apply-selected failed";
      setTriggerMsg("Failed to start: " + msg);
    } finally {
      setTriggering(false);
    }
  }, [selected, jobs]);

  const updateStatus = useCallback(async (jobId: string, newStatus: string) => {
    await fetch(`/api/jobs/${encodeURIComponent(jobId)}/status`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: newStatus }),
    });
    fetchJobs();
    fetchStats();
  }, [fetchJobs, fetchStats]);

  const deleteJob = useCallback(async (jobId: string, title: string, company: string) => {
    const label = `${title || "this job"}${company ? " at " + company : ""}`;
    if (!window.confirm(`Delete ${label}? This cannot be undone.`)) return;
    const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      window.alert("Delete failed: " + (data.error || res.statusText));
      return;
    }
    setSelected(prev => {
      if (!prev.has(jobId)) return prev;
      const n = new Set(prev);
      n.delete(jobId);
      return n;
    });
    fetchJobs();
    fetchStats();
  }, [fetchJobs, fetchStats]);

  return (
    <div className="min-h-screen bg-[var(--background)] text-[var(--foreground)]">
      {wizardState === "open" && (
        <JobWizard
          visible
          onClose={() => setWizardState("closed")}
          onBackground={() => setWizardState("closed")}
          onImported={() => { fetchJobs(); fetchStats(); }}
        />
      )}
      {packageFor && (
        <WelcomePackageModal job={packageFor} onClose={() => setPackageFor(null)} />
      )}
      {/* header */}
      <header className="sticky top-0 z-20 border-b border-white/[0.04] bg-[var(--background)]/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1600px] items-center justify-between px-8 py-5">
          <div className="flex items-center gap-4">
            <Link href="/" className="text-[13px] font-medium text-zinc-500 hover:text-zinc-200 transition">
              ← Winston
            </Link>
            <div className="h-6 w-px bg-white/[0.06]" />
            <h1 className="text-[15px] font-semibold tracking-tight">Jobs</h1>
            {stats && (
              <span className="text-[12px] text-zinc-500">
                {stats.total} total · {stats.high_scoring} high-scoring · avg {stats.avg_score.toFixed(1)}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setWizardState("open")}
              className="inline-flex items-center gap-1.5 rounded-lg border border-violet-500/30 bg-violet-500/15 px-3 py-1.5 text-[12px] font-medium text-violet-200 hover:bg-violet-500/25 transition"
              title="Job search — filter by title/location/salary, scrape LinkedIn + Indeed + Google Jobs, get a PDF report, and optionally tailor resume + build Drive folders for top matches"
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
              </svg>
              Search wizard
            </button>
          </div>
        </div>
        {triggerMsg && (
          <div className="border-t border-white/[0.04] bg-indigo-500/5 px-8 py-2 text-[12px] text-indigo-200">
            {triggerMsg}
          </div>
        )}
      </header>

      {/* run tracker (persistent until dismissed) */}
      {runs.length > 0 && (
        <div className="mx-auto max-w-[1600px] px-8 pt-6">
          <div className="space-y-3">
            {runs.map(r => <RunCard key={r.id} run={r} jobMap={runJobMap} onDismiss={dismissRun} />)}
          </div>
        </div>
      )}

      {/* stats strip */}
      {stats && (
        <div className="mx-auto max-w-[1600px] px-8 pt-6">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
            {Object.entries(stats.by_status).map(([k, n]) => {
              const s = STATUS_STYLES[k] || STATUS_STYLES.new;
              const active = status === k;
              return (
                <button
                  key={k}
                  onClick={() => setStatus(active ? "all" : k)}
                  className={`group glass-card flex items-center justify-between rounded-xl px-4 py-3 text-left transition ${active ? "ring-1 ring-indigo-500/40" : ""}`}
                >
                  <div>
                    <div className="flex items-center gap-1.5">
                      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
                      <span className="text-[11px] uppercase tracking-wide text-zinc-500">{s.label}</span>
                    </div>
                    <div className="mt-1 text-[22px] font-semibold tabular-nums">{n}</div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* workspace tabs */}
      <div className="mx-auto max-w-[1600px] px-8 pt-6">
        <div className="flex flex-wrap items-center gap-1 border-b border-white/[0.05]">
          {WORKSPACES.map(ws => {
            const active = workspace === ws.id;
            const count = workspaceCounts[ws.id] ?? 0;
            return (
              <button
                key={ws.id}
                onClick={() => setWorkspace(ws.id)}
                className={`group relative -mb-px inline-flex items-center gap-2 border-b-2 px-3 py-2.5 text-[13px] font-medium transition ${
                  active
                    ? "border-indigo-400 text-zinc-100"
                    : "border-transparent text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {ws.label}
                <span className={`rounded-md px-1.5 py-0.5 text-[10.5px] tabular-nums transition ${
                  active ? "bg-indigo-500/15 text-indigo-200" : "bg-white/[0.04] text-zinc-500 group-hover:text-zinc-400"
                }`}>
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* filter bar */}
      <div className="mx-auto max-w-[1600px] px-8 py-6">
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search title, company, skills…"
            className="min-w-[240px] flex-1 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-[13px] text-zinc-200 placeholder-zinc-600 focus:border-indigo-500/40 focus:outline-none"
          />
          <select
            value={sourceFilter}
            onChange={e => setSourceFilter(e.target.value)}
            title="Filter by marketplace"
            className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-[13px] text-zinc-200 focus:border-indigo-500/40 focus:outline-none"
          >
            {SOURCE_FILTERS.map(s => (
              <option key={s.id} value={s.id} className="bg-zinc-900">
                {s.label}
              </option>
            ))}
          </select>
          <select
            value={status}
            onChange={e => setStatus(e.target.value)}
            className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-[13px] text-zinc-200 focus:border-indigo-500/40 focus:outline-none"
          >
            {STATUS_FILTERS.map(s => (
              <option key={s} value={s} className="bg-zinc-900">
                {s === "all" ? "All statuses" : STATUS_STYLES[s]?.label || s}
              </option>
            ))}
          </select>
          <select
            value={minScore}
            onChange={e => setMinScore(parseInt(e.target.value, 10))}
            className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-[13px] text-zinc-200 focus:border-indigo-500/40 focus:outline-none"
          >
            <option value={0} className="bg-zinc-900">Any score</option>
            <option value={60} className="bg-zinc-900">60+</option>
            <option value={70} className="bg-zinc-900">70+</option>
            <option value={80} className="bg-zinc-900">80+</option>
            <option value={90} className="bg-zinc-900">90+</option>
          </select>
          <button
            onClick={() => setFlaggedOnly(v => !v)}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-[13px] transition ${
              flaggedOnly
                ? "border-amber-500/40 bg-amber-500/15 text-amber-200"
                : "border-white/[0.06] bg-white/[0.02] text-zinc-400 hover:text-zinc-200"
            }`}
            title="Show only flagged jobs"
            aria-pressed={flaggedOnly}
          >
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill={flaggedOnly ? "currentColor" : "none"} stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 21V4a1 1 0 011-1h12l-2 4 2 4H4" />
            </svg>
            Flagged
          </button>
          <div className="ml-auto text-[12px] text-zinc-500">
            {loading
              ? "Loading…"
              : `${sortedJobs.length.toLocaleString()} jobs · click columns to sort`}
          </div>
        </div>
      </div>

      {/* selection action bar */}
      {selected.size > 0 && (
        <div className="sticky top-[69px] z-10 mx-auto max-w-[1600px] px-8 pb-3">
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-indigo-500/30 bg-indigo-500/10 px-4 py-2.5 backdrop-blur-xl">
            <span className="text-[13px] font-medium text-indigo-200">
              {selected.size} selected
            </span>
            <button
              onClick={() => setSelected(new Set())}
              className="rounded-md border border-white/[0.06] bg-white/[0.04] px-2 py-1 text-[11px] text-zinc-300 hover:bg-white/[0.08] transition"
            >
              Clear
            </button>
            <button
              onClick={() => selectRandom(5)}
              className="rounded-md border border-white/[0.06] bg-white/[0.04] px-2 py-1 text-[11px] text-zinc-300 hover:bg-white/[0.08] transition"
              title="Pick 5 random jobs from the current filter"
            >
              Random 5
            </button>
            <button
              onClick={() => selectRandom(10)}
              className="rounded-md border border-white/[0.06] bg-white/[0.04] px-2 py-1 text-[11px] text-zinc-300 hover:bg-white/[0.08] transition"
              title="Pick 10 random jobs from the current filter"
            >
              Random 10
            </button>
            <div className="ml-auto flex items-center gap-2">
              {(() => {
                // Compute Upwork vs other split for the button label/tooltip
                // so it's obvious which flow will run for the current selection.
                const lookup = new Map(jobs.map(j => [j.job_id, j]));
                let upw = 0, oth = 0;
                for (const id of selected) {
                  if ((lookup.get(id)?.source || "linkedin") === "upwork") upw++; else oth++;
                }
                let label = `Auto-apply ${selected.size}`;
                let tip = `Open ${selected.size} tab${selected.size === 1 ? "" : "s"} in a visible Chrome window on your Mac, batched 10 at a time. AI fills every field and stops before the final Submit button — review + submit manually, then update status from the row dropdown. Tabs stay open until you close them.`;
                if (upw > 0 && oth === 0) {
                  label = `Draft ${upw} Upwork proposal${upw === 1 ? "" : "s"}`;
                  tip = `Generates ${upw} tailored Upwork proposal${upw === 1 ? "" : "s"} via Claude using Philip's "10y, founder, senior, end-to-end" pitch, opens visible Chrome with cover letter + bid pre-filled on each project's apply page. Never submits — you review, edit, click Submit yourself. Drafts also saved to ~/Desktop/linkedin-jobs/packages/upwork-*.`;
                } else if (upw > 0 && oth > 0) {
                  label = `Apply ${oth} + draft ${upw} Upwork`;
                  tip = `Mixed selection: ${oth} ATS application${oth === 1 ? "" : "s"} go through the auto-apply flow (AI fills, stops before Submit) and ${upw} Upwork proposal${upw === 1 ? "" : "s"} get drafted by Claude with cover letters pre-filled (no auto-submit). Two separate Chrome windows open.`;
                }
                return (
                  <button
                    onClick={() => applySelected()}
                    disabled={triggering}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/20 px-3 py-1.5 text-[12px] font-medium text-emerald-200 hover:bg-emerald-500/30 transition disabled:opacity-50"
                    title={tip}
                  >
                    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
                    </svg>
                    {label}
                  </button>
                );
              })()}
            </div>
          </div>
        </div>
      )}

      {/* table */}
      <div className="mx-auto max-w-[1600px] px-8 pb-24">
        <div className="overflow-hidden rounded-2xl border border-white/[0.05] bg-white/[0.01]">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-white/[0.03]">
              <thead className="bg-white/[0.018] text-[10.5px] uppercase tracking-[0.06em] text-zinc-500">
                <tr>
                  <th className="w-10 px-4 py-3 text-left font-medium">
                    <input
                      type="checkbox"
                      aria-label="Select all"
                      checked={sortedJobs.length > 0 && selected.size === sortedJobs.length}
                      ref={el => { if (el) el.indeterminate = selected.size > 0 && selected.size < sortedJobs.length; }}
                      onChange={toggleSelectAll}
                      className="h-3.5 w-3.5 cursor-pointer rounded border-white/[0.15] bg-white/[0.03] accent-indigo-500"
                    />
                  </th>
                  <SortHeader label="Score" sortKey="score" active={sortKey} dir={sortDir} onClick={toggleSort} />
                  <SortHeader label="Status" sortKey="status" active={sortKey} dir={sortDir} onClick={toggleSort} />
                  <SortHeader label="Role" sortKey="title" active={sortKey} dir={sortDir} onClick={toggleSort} />
                  <th className="px-4 py-3 text-left font-medium">Resume</th>
                  <SortHeader label="Company" sortKey="company" active={sortKey} dir={sortDir} onClick={toggleSort} />
                  <th className="px-4 py-3 text-left font-medium">Skills</th>
                  <SortHeader label="Posted" sortKey="posted" active={sortKey} dir={sortDir} onClick={toggleSort} />
                  <th className="px-4 py-3 text-right font-medium">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.025] text-[13px]">
                {loading && (
                  <tr><td colSpan={11} className="px-4 py-8 text-center text-zinc-500">Loading jobs…</td></tr>
                )}
                {!loading && pageJobs.length === 0 && (
                  <tr><td colSpan={11} className="px-4 py-12 text-center text-zinc-500">
                    No jobs match your filters. Hit <span className="text-indigo-300">Run full pipeline</span> to pull fresh jobs.
                  </td></tr>
                )}
                {!loading && pageJobs.map(j => {
                  const isOpen = expanded === j.job_id;
                  const isSelected = selected.has(j.job_id);
                  const isApplying = applyingIds.has(j.job_id);
                  return (
                    <Fragment key={j.job_id}>
                      <tr
                        onClick={() => setExpanded(isOpen ? null : j.job_id)}
                        className={`group/row relative cursor-pointer transition hover:bg-white/[0.025] ${
                          isApplying ? "bg-indigo-500/[0.05]" : isSelected ? "bg-indigo-500/[0.035]" : ""
                        }`}
                      >
                        <td className="relative w-10 px-4 py-2.5 align-top" onClick={e => e.stopPropagation()}>
                          {isApplying && <span className="absolute left-0 top-0 h-full w-[3px] bg-indigo-400" />}
                          <div className="flex h-[22px] items-center">
                            <input
                              type="checkbox"
                              aria-label={`Select ${j.title} at ${j.company}`}
                              checked={isSelected}
                              onChange={() => toggleSelect(j.job_id)}
                              className="h-3.5 w-3.5 cursor-pointer rounded border-white/[0.15] bg-white/[0.03] accent-indigo-500"
                            />
                          </div>
                        </td>
                        <td className="px-4 py-2.5 align-top">
                          <div className={`inline-flex h-[22px] min-w-[44px] items-center justify-center rounded-lg border px-2 text-[13px] font-semibold tabular-nums ${scoreBg(j.resume_match)} ${scoreColor(j.resume_match)}`}>
                            {j.resume_match}
                          </div>
                        </td>
                        <td className="px-4 py-2.5 align-top">
                          <div className="flex h-[22px] items-center">
                            {isApplying ? <ApplyingChip /> : <StatusChip status={j.application_status} firstSeenAt={j.first_seen_at} />}
                          </div>
                        </td>
                        <td className="px-4 py-2.5 align-top w-[280px] max-w-[280px]">
                          <div className="flex items-start gap-2">
                            {/* Clamp: an untruncated title like "Software Engineer II (Node,
                                React, Typescript)" wraps to 4 lines and drags the whole row
                                out of alignment with its neighbours. */}
                            <div className="font-medium text-zinc-100 leading-[1.35] line-clamp-2" title={j.title}>
                              {j.title}
                            </div>
                            <SourceBadge source={j.source} />
                          </div>
                          <div className="mt-1 text-[11px] leading-tight text-zinc-500 truncate">
                            {j.seniority_level || j.employment_type || j.category || "—"}
                          </div>
                        </td>
                        <td className="px-4 py-2.5 align-top" onClick={e => e.stopPropagation()}>
                          <VariantPicker value={j.resume_variant} onChange={(v) => updateVariant(j.job_id, v)} />
                        </td>
                        {/* Company absorbs salary and location. Both had their own column
                            and both were mostly noise: salary is filled on 26% of rows, and
                            location reads "United States"/"Anywhere" on 82% of them. Show
                            each only when it actually says something. */}
                        <td className="px-4 py-2.5 align-top w-[300px] max-w-[300px]">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate text-zinc-200 leading-[1.35]">{j.company}</span>
                            {j.is_intermediary && (
                              <span
                                className="shrink-0 rounded border border-amber-700/60 bg-amber-950/40 px-1 py-0.5 text-[10px] leading-none text-amber-400"
                                title={
                                  j.actual_employer
                                    ? `Staffing/recruiting agency reposting a role for ${j.actual_employer} — not the employer.`
                                    : "Staffing/recruiting agency reposting someone else's role — not the employer."
                                }
                              >
                                ⚠ agency
                              </span>
                            )}
                          </div>
                          <div className="mt-1 flex items-center gap-1.5 text-[11px] leading-tight text-zinc-500">
                            {isSpecificLocation(j.location) && <span className="truncate">{j.location}</span>}
                            {j.remote === "true" && (
                              <span className="shrink-0 rounded bg-emerald-500/10 px-1 py-0.5 text-[10px] leading-none text-emerald-300">
                                Remote
                              </span>
                            )}
                            {hasSalary(j.salary) && (
                              <span className="shrink-0 tabular-nums text-zinc-400">{formatSalary(j.salary)}</span>
                            )}
                            {!isSpecificLocation(j.location) && !hasSalary(j.salary) && j.remote !== "true" && (
                              <span className="truncate">{[j.company_employees, j.industry].filter(Boolean).join(" · ") || "—"}</span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-2.5 align-top max-w-[240px]">
                          <SkillTags raw={j.skills} />
                        </td>
                        <td className="px-4 py-2.5 align-top text-[12px] text-zinc-500 whitespace-nowrap">
                          <div className="leading-[1.35]">{formatRelative(j.posted_at)}</div>
                        </td>
                        <td className="px-4 py-2.5 text-right align-top">
                          <div className="flex items-center justify-end gap-1">
                            {/* The package holds the cover letter, the apply link and the
                                agency warning — it belongs where the eye already goes for
                                actions, not buried under the company name. */}
                            {j.has_research && (
                              <button
                                onClick={(e) => { e.stopPropagation(); setPackageFor(j); }}
                                className="inline-flex h-[26px] items-center gap-1 rounded-md border border-indigo-500/40 bg-indigo-500/10 px-2 text-[11px] font-medium text-indigo-200 transition hover:border-indigo-400 hover:bg-indigo-500/20"
                                title="Open the welcome package — company research, cover letter, resume gaps"
                              >
                                📄 Package
                              </button>
                            )}
                            <FlagButton flagged={!!j.flagged} onToggle={(next) => toggleFlag(j.job_id, next)} />
                            {(j.apply_url || j.job_url) && (
                              <a
                                href={j.apply_url || j.job_url}
                                target="_blank"
                                rel="noreferrer"
                                onClick={e => e.stopPropagation()}
                                className="inline-flex h-[26px] w-[26px] items-center justify-center rounded-md border border-white/[0.06] bg-white/[0.03] text-zinc-300 hover:border-indigo-500/30 hover:bg-indigo-500/10 hover:text-indigo-200 transition"
                                title={j.apply_url ? "Open the job's apply page in a new tab" : "No direct apply link — open the job post"}
                                aria-label="Open apply link"
                              >
                                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
                                </svg>
                              </a>
                            )}
                            {(j.drive_folder_url || j.application_status === "drafted") && (
                              <a
                                href={driveLinkFor(j)}
                                target="_blank"
                                rel="noreferrer"
                                onClick={e => e.stopPropagation()}
                                className="inline-flex h-[26px] w-[26px] items-center justify-center rounded-md border border-white/[0.06] bg-white/[0.03] text-zinc-400 hover:bg-white/[0.08] hover:text-zinc-200 transition"
                                title={j.drive_folder_url ? "Open Drive folder" : "Search Drive for this application package"}
                                aria-label="Open Drive folder"
                              >
                                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
                                </svg>
                              </a>
                            )}
                            {!["applied", "interviewing", "offered", "rejected", "withdrawn"].includes(j.application_status) && (
                              <button
                                onClick={(e) => { e.stopPropagation(); updateStatus(j.job_id, "applied"); }}
                                className="inline-flex h-[26px] w-[26px] items-center justify-center rounded-md border border-emerald-500/25 bg-emerald-500/10 text-emerald-300 hover:border-emerald-500/50 hover:bg-emerald-500/20 transition"
                                title="Mark as applied (after you submit the form manually)"
                                aria-label="Mark as applied"
                              >
                                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.4}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                                </svg>
                              </button>
                            )}
                            <button
                              onClick={(e) => { e.stopPropagation(); deleteJob(j.job_id, j.title, j.company); }}
                              className="inline-flex h-[26px] w-[26px] items-center justify-center rounded-md border border-white/[0.06] bg-white/[0.03] text-zinc-400 hover:border-rose-500/30 hover:bg-rose-500/10 hover:text-rose-300 transition"
                              title="Delete this job"
                              aria-label="Delete job"
                            >
                              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                              </svg>
                            </button>
                            <span
                              className="ml-1 flex h-[26px] w-[22px] items-center justify-center text-zinc-600 transition group-hover/row:text-zinc-400"
                              aria-hidden
                            >
                              <svg
                                className={`h-3.5 w-3.5 transition-transform ${isOpen ? "rotate-90" : ""}`}
                                fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                              >
                                <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                              </svg>
                            </span>
                          </div>
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="bg-white/[0.015]">
                          <td colSpan={11} className="px-6 py-5">
                            <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
                              <div className="lg:col-span-2">
                                <div className="text-[11px] uppercase tracking-wide text-zinc-500">Description</div>
                                <p className="mt-1.5 text-[13px] leading-relaxed text-zinc-300">
                                  {j.description_summary || "—"}
                                </p>
                                {j.company_description && (
                                  <>
                                    <div className="mt-4 text-[11px] uppercase tracking-wide text-zinc-500">About {j.company}</div>
                                    <p className="mt-1.5 text-[13px] leading-relaxed text-zinc-400">
                                      {j.company_description.slice(0, 500)}
                                      {j.company_description.length > 500 ? "…" : ""}
                                    </p>
                                  </>
                                )}
                                {j.notes && (
                                  <>
                                    <div className="mt-4 text-[11px] uppercase tracking-wide text-zinc-500">Auto-apply notes</div>
                                    <p className="mt-1.5 font-mono text-[12px] text-zinc-400">{j.notes}</p>
                                  </>
                                )}
                              </div>
                              <div className="space-y-3">
                                <DetailRow label="Years required" value={j.years_required} />
                                <DetailRow label="Education" value={j.education} />
                                <DetailRow label="Company HQ" value={j.company_hq} />
                                <DetailRow label="Applicants" value={j.applicants} />
                                <DetailRow label="Benefits" value={sanitizeJoinedList(j.benefits)} />
                                <DetailRow label="Easy Apply" value={j.easy_apply === "true" ? "Yes" : "No"} />
                                <DetailRow label="Applied at" value={j.applied_at || "—"} />
                                <DetailRow label="Week tag" value={j.week_tag} />

                                <div className="pt-3">
                                  <div className="text-[11px] uppercase tracking-wide text-zinc-500">Links</div>
                                  <div className="mt-2 flex flex-wrap gap-1.5">
                                    {j.company_website && <LinkChip href={j.company_website} label="Website" />}
                                    {j.company_url && <LinkChip href={j.company_url} label="LinkedIn co." />}
                                    {j.job_url && <LinkChip href={j.job_url} label="LinkedIn job" />}
                                  </div>
                                </div>

                                {(j.contact_email || j.careers_url) && (
                                  <div className="pt-3">
                                    <div className="text-[11px] uppercase tracking-wide text-zinc-500">
                                      Recruiting contact
                                    </div>
                                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                                      {j.careers_url && <LinkChip href={j.careers_url} label="Careers page" />}
                                      {j.contact_email && (
                                        <a
                                          href={`mailto:${j.contact_email}`}
                                          onClick={(e) => e.stopPropagation()}
                                          className="rounded border border-zinc-700 px-1.5 py-0.5 text-[11px] text-zinc-300 hover:border-zinc-500 hover:text-zinc-100"
                                        >
                                          {j.contact_email}
                                        </a>
                                      )}
                                      {j.contact_type === "generic" && (
                                        <span
                                          className="text-[10px] text-zinc-500"
                                          title="Company's general mailbox, published on their careers page — not a recruiter's personal address."
                                        >
                                          general inbox
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                )}

                                <div className="pt-3">
                                  <div className="flex items-center justify-between">
                                    <div className="text-[11px] uppercase tracking-wide text-zinc-500">Change status</div>
                                    <button
                                      onClick={(e) => { e.stopPropagation(); deleteJob(j.job_id, j.title, j.company); }}
                                      className="inline-flex items-center gap-1 rounded-md border border-rose-500/25 bg-rose-500/10 px-2 py-1 text-[11px] text-rose-300 hover:bg-rose-500/20 transition"
                                      title="Delete this job row"
                                    >
                                      <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                                      </svg>
                                      Delete
                                    </button>
                                  </div>
                                  <div className="mt-2 flex flex-wrap gap-1.5">
                                    {["drafted", "applied", "interviewing", "rejected", "withdrawn"].map(s => (
                                      <button
                                        key={s}
                                        onClick={(e) => { e.stopPropagation(); updateStatus(j.job_id, s); }}
                                        className="rounded-md border border-white/[0.06] bg-white/[0.03] px-2 py-1 text-[11px] text-zinc-300 hover:bg-white/[0.08] transition"
                                      >
                                        {STATUS_STYLES[s]?.label || s}
                                      </button>
                                    ))}
                                  </div>
                                </div>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          {sortedJobs.length > pageSize && (
            <Pagination
              page={page}
              pageSize={pageSize}
              total={sortedJobs.length}
              onPage={setPage}
              loading={loading}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function Pagination({
  page, pageSize, total, onPage, loading,
}: {
  page: number; pageSize: number; total: number;
  onPage: (n: number) => void; loading: boolean;
}) {
  const start = page * pageSize + 1;
  const end = Math.min((page + 1) * pageSize, total);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const atFirst = page === 0;
  const atLast = page >= pageCount - 1;
  return (
    <div className="mt-3 flex items-center justify-between rounded-xl border border-white/[0.05] bg-white/[0.02] px-4 py-2.5 text-[12px]">
      <div className="text-zinc-400">
        Showing <span className="text-zinc-200 tabular-nums">{start.toLocaleString()}</span>
        –<span className="text-zinc-200 tabular-nums">{end.toLocaleString()}</span>
        {" "}of <span className="text-zinc-200 tabular-nums">{total.toLocaleString()}</span>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={() => onPage(Math.max(0, page - 1))}
          disabled={atFirst || loading}
          className="rounded-md border border-white/[0.08] bg-white/[0.03] px-3 py-1 text-zinc-300 hover:bg-white/[0.08] transition disabled:opacity-40"
        >
          ← Prev
        </button>
        <span className="tabular-nums text-zinc-500">
          {page + 1} / {pageCount}
        </span>
        <button
          onClick={() => onPage(Math.min(pageCount - 1, page + 1))}
          disabled={atLast || loading}
          className="rounded-md border border-white/[0.08] bg-white/[0.03] px-3 py-1 text-zinc-300 hover:bg-white/[0.08] transition disabled:opacity-40"
        >
          Next →
        </button>
      </div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <div className="flex items-start justify-between gap-3 border-b border-white/[0.04] pb-2 text-[12px]">
      <span className="text-zinc-500">{label}</span>
      <span className="text-right text-zinc-300">{value}</span>
    </div>
  );
}

interface Research {
  what_they_do?: string;
  outlook?: string;
  outlook_signal?: string;
  outlook_sources?: string[];
  glassdoor_rating?: number | null;
  glassdoor_url?: string;
  glassdoor_review_count?: number | null;
  satisfaction_note?: string;
  cover_letter?: string;
  resume_gaps?: string[];
  resume_strengths?: string[];
  scheduler_link?: string;
  is_intermediary?: boolean;
  actual_employer?: string;
  intermediary_note?: string;
}

const SIGNAL: Record<string, { icon: string; color: string }> = {
  growing: { icon: "📈", color: "text-emerald-400" },
  stable: { icon: "➡️", color: "text-zinc-300" },
  uncertain: { icon: "❓", color: "text-amber-400" },
  declining: { icon: "📉", color: "text-rose-400" },
  unknown: { icon: "❓", color: "text-zinc-500" },
};

/** Modal rendering the welcome-package briefing for one job. */
function WelcomePackageModal({ job, onClose }: { job: Job; onClose: () => void }) {
  const [data, setData] = useState<Research | null>(null);
  const [error, setError] = useState<string>("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    fetch(`/api/jobs/${encodeURIComponent(job.job_id)}/research`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).error || `HTTP ${r.status}`);
        return r.json();
      })
      .then((d) => { if (live) setData(d); })
      .catch((e) => { if (live) setError(String(e.message || e)); });
    return () => { live = false; };
  }, [job.job_id]);

  // Close on Escape — a modal that traps the user is worse than no modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const sig = SIGNAL[data?.outlook_signal || "unknown"] ?? SIGNAL.unknown;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-6"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl rounded-lg border border-zinc-800 bg-zinc-950 p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-lg text-zinc-100">{job.title}</div>
            <div className="mt-0.5 text-sm text-zinc-400">
              {job.company} · {job.location || "—"} · score {job.resume_match}
            </div>
          </div>
          <button onClick={onClose} className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:text-zinc-100">
            Close
          </button>
        </div>

        {/* The briefing is where the decision gets made, so the application
            starts here too — otherwise you read the cover letter, then go hunt
            for the row again. apply_url is missing on ~40% of listings, so fall
            back to the job post, which every row has. */}
        <div className="mt-4 flex flex-wrap items-center gap-2 border-y border-zinc-800 py-3">
          <a
            href={job.apply_url || job.job_url}
            target="_blank"
            rel="noreferrer"
            className="rounded bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500"
          >
            {job.apply_url ? "Open apply page ↗" : "Open job post ↗"}
          </a>
          {data?.cover_letter && (
            <button
              onClick={() => {
                navigator.clipboard?.writeText(data.cover_letter || "");
                setCopied(true);
                setTimeout(() => setCopied(false), 1600);
              }}
              className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:border-zinc-500"
            >
              {copied ? "✓ Copied" : "Copy cover letter"}
            </button>
          )}
          {job.contact_email && (
            <a
              href={`mailto:${job.contact_email}?subject=${encodeURIComponent(`Application — ${job.title}`)}`}
              className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:border-zinc-500"
            >
              Email {job.contact_email}
            </a>
          )}
          {job.careers_url && (
            <a href={job.careers_url} target="_blank" rel="noreferrer"
               className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:border-zinc-500">
              Careers page ↗
            </a>
          )}
        </div>

        {!data && !error && <div className="mt-6 text-sm text-zinc-500">Loading briefing…</div>}
        {error && <div className="mt-6 text-sm text-rose-400">Could not load: {error}</div>}

        {data && (
          <div className="mt-5 space-y-5 text-sm">
            {data.is_intermediary && (
              <div className="rounded border border-amber-700/60 bg-amber-950/30 p-3 text-amber-300">
                <span className="font-medium">⚠ Not the employer.</span>{" "}
                {job.company} is a staffing/recruiting intermediary
                {data.actual_employer ? <> reposting a role for <span className="font-medium">{data.actual_employer}</span></> : null}.
                {data.intermediary_note ? ` ${data.intermediary_note}` : ""}
              </div>
            )}

            <Section title="What they do">
              <p className="text-zinc-300">{data.what_they_do || "—"}</p>
            </Section>

            <Section title={`Outlook ${sig.icon}`}>
              <p className={`mb-1 ${sig.color}`}>{data.outlook_signal || "unknown"}</p>
              <p className="text-zinc-300">{data.outlook || "No evidence found."}</p>
              {!!data.outlook_sources?.length && (
                <ul className="mt-2 space-y-0.5">
                  {data.outlook_sources.map((u) => (
                    <li key={u}>
                      <a href={u} target="_blank" rel="noreferrer" className="text-[11px] text-zinc-500 hover:text-zinc-300 break-all">{u}</a>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section title="Employee satisfaction">
              {data.glassdoor_rating ? (
                <p className="text-zinc-300">
                  <span className="text-zinc-100">{data.glassdoor_rating}/5</span>
                  {data.glassdoor_review_count ? ` (${data.glassdoor_review_count} reviews)` : ""}
                  {data.glassdoor_url && (
                    <> — <a href={data.glassdoor_url} target="_blank" rel="noreferrer" className="text-zinc-400 underline hover:text-zinc-200">Glassdoor</a></>
                  )}
                </p>
              ) : (
                <p className="text-zinc-500">No Glassdoor data found — not estimated.</p>
              )}
              {data.satisfaction_note && <p className="mt-1 text-[12px] text-zinc-400 italic">{data.satisfaction_note}</p>}
            </Section>

            <Section title="Cover letter">
              <p className="whitespace-pre-wrap rounded border border-zinc-800 bg-zinc-900/50 p-3 text-zinc-300">
                {data.cover_letter || "—"}
              </p>
            </Section>

            {!!data.resume_gaps?.length && (
              <Section title="Where the resume is short">
                <ul className="list-disc space-y-1 pl-4 text-zinc-300">
                  {data.resume_gaps.map((g, i) => <li key={i}>{g}</li>)}
                </ul>
              </Section>
            )}

            {!!data.resume_strengths?.length && (
              <Section title="What already lines up">
                <ul className="list-disc space-y-1 pl-4 text-zinc-300">
                  {data.resume_strengths.map((s, i) => <li key={i}>{s}</li>)}
                </ul>
              </Section>
            )}

            {data.scheduler_link && (
              <Section title="Scheduler in the posting">
                <a href={data.scheduler_link} target="_blank" rel="noreferrer" className="text-zinc-300 underline break-all">
                  {data.scheduler_link}
                </a>
              </Section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[11px] uppercase tracking-wide text-zinc-500">{title}</div>
      {children}
    </div>
  );
}

function LinkChip({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="rounded-md border border-white/[0.06] bg-white/[0.03] px-2 py-1 text-[11px] text-zinc-300 hover:bg-white/[0.08] transition"
    >
      {label} ↗
    </a>
  );
}

function RunCard({
  run, jobMap, onDismiss,
}: {
  run: ApplyRun;
  jobMap: Record<string, Job>;
  onDismiss: (id: string) => void;
}) {
  const [open, setOpen] = useState(true);

  const rows = run.jobs.map(snap => {
    const live = jobMap[snap.job_id];
    const status = live?.application_status || "drafted";
    const terminal = TERMINAL_STATUSES.has(status);
    return {
      snap,
      live,
      status,
      terminal,
      notes: live?.notes || "",
      apply_url: live?.apply_url || snap.apply_url,
    };
  });

  const applied = rows.filter(r => r.status === "applied").length;
  const needsManual = rows.filter(r => r.status === "needs_manual").length;
  const failed = rows.filter(r => r.status === "application_failed").length;
  const pending = rows.filter(r => !r.terminal).length;
  const isActive = pending > 0;

  const elapsed = Math.max(0, Math.floor((Date.now() - run.started_at) / 60000));
  const kindLabel = run.kind === "selected" ? "Selected" : run.kind === "drive" ? "From Drive" : "Full pipeline";

  return (
    <div className={`rounded-2xl border backdrop-blur-xl ${isActive ? "border-indigo-500/30 bg-indigo-500/[0.05]" : "border-white/[0.06] bg-white/[0.02]"}`}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex w-full items-center gap-3 px-5 py-3.5 text-left"
      >
        {isActive ? (
          <Spinner />
        ) : (
          <div className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500/20">
            <svg className="h-3 w-3 text-emerald-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
            </svg>
          </div>
        )}
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-semibold text-zinc-100">
              {isActive ? "Applying…" : "Run complete"}
            </span>
            <span className="rounded-md border border-white/[0.06] bg-white/[0.04] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400">
              {kindLabel}
            </span>
            {run.dry_run && (
              <span className="rounded-md border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-300">
                Dry run
              </span>
            )}
          </div>
          <div className="mt-0.5 text-[11.5px] text-zinc-500 tabular-nums">
            {rows.length} jobs · ✓ {applied} applied · ⚠ {needsManual} manual · ✗ {failed} failed · {pending} pending · started {elapsed}m ago
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {!isActive && (
            <button
              onClick={(e) => { e.stopPropagation(); onDismiss(run.id); }}
              className="rounded-md border border-white/[0.06] bg-white/[0.03] px-2 py-1 text-[11px] text-zinc-400 hover:bg-white/[0.08] transition"
              title="Remove this run from the tracker"
            >
              Dismiss
            </button>
          )}
          <svg
            className={`h-4 w-4 text-zinc-500 transition-transform ${open ? "rotate-180" : ""}`}
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
          </svg>
        </div>
      </button>

      {open && (
        <div className="border-t border-white/[0.04] px-5 py-3">
          <div className="grid grid-cols-1 gap-1.5">
            {rows.map(r => <RunJobRow key={r.snap.job_id} row={r} />)}
            {rows.length === 0 && (
              <div className="py-3 text-center text-[12px] text-zinc-500">
                Waiting for the pipeline to decide which jobs to apply to…
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function RunJobRow({ row }: { row: {
  snap: RunJobSnapshot;
  status: string;
  terminal: boolean;
  notes: string;
  apply_url: string;
} }) {
  const { snap, status, terminal, notes, apply_url } = row;
  const s = STATUS_STYLES[status] || STATUS_STYLES.new;
  return (
    <div className="flex items-center gap-3 rounded-lg border border-white/[0.03] bg-white/[0.015] px-3 py-2 text-[12.5px]">
      <div className="w-5 flex-shrink-0">
        {!terminal ? <Spinner small /> : status === "applied" ? (
          <span className="flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500/25 text-emerald-300">
            <svg className="h-2.5 w-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>
          </span>
        ) : status === "needs_manual" ? (
          <span className="flex h-4 w-4 items-center justify-center rounded-full bg-orange-500/25 text-orange-300 text-[10px] font-bold">!</span>
        ) : (
          <span className="flex h-4 w-4 items-center justify-center rounded-full bg-red-500/25 text-red-300">
            <svg className="h-2.5 w-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
          </span>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="truncate text-zinc-200">{snap.title}</div>
        <div className="truncate text-[11px] text-zinc-500">{snap.company}</div>
      </div>
      <div className="flex-shrink-0">
        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium ${s.bg} ${s.text}`}>
          <span className={`h-1 w-1 rounded-full ${s.dot}`} />
          {s.label}
        </span>
      </div>
      {notes && terminal && (
        <div className="hidden max-w-[320px] truncate text-[11px] text-zinc-500 lg:block" title={notes}>
          {notes}
        </div>
      )}
      {apply_url && (
        <a
          href={apply_url}
          target="_blank"
          rel="noreferrer"
          className="flex-shrink-0 rounded-md border border-white/[0.06] bg-white/[0.03] px-2 py-0.5 text-[10.5px] text-zinc-300 hover:bg-white/[0.08] transition"
        >
          Link ↗
        </a>
      )}
    </div>
  );
}

function Spinner({ small }: { small?: boolean } = {}) {
  const size = small ? "h-4 w-4" : "h-5 w-5";
  return (
    <svg className={`${size} animate-spin text-indigo-300`} fill="none" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
      <path d="M21 12a9 9 0 00-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

function SortHeader({
  label, sortKey, active, dir, onClick,
}: {
  label: string;
  sortKey: SortKey;
  active: SortKey;
  dir: SortDir;
  onClick: (k: SortKey) => void;
}) {
  const isActive = active === sortKey;
  return (
    <th className="px-4 py-3 text-left font-medium">
      <button
        type="button"
        onClick={() => onClick(sortKey)}
        className={`inline-flex items-center gap-1 transition ${isActive ? "text-zinc-200" : "text-zinc-500 hover:text-zinc-300"}`}
      >
        {label}
        <span className={`text-[10px] ${isActive ? "opacity-100" : "opacity-30"}`}>
          {isActive && dir === "asc" ? "▲" : "▼"}
        </span>
      </button>
    </th>
  );
}


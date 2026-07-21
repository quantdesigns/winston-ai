"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";

/* ── types ── */

interface AgentInfo {
  name: string;
  description: string;
  model?: string;
  workspace?: string;
  short_name?: string;
  tools?: string[];
  entry_point?: boolean;
}

interface HealthStatus {
  status: string;
  uptime: string;
  agents: number;
  active_sessions: number;
  active_schedules: number;
}

/* ── constants ── */

/* Tool icon SVGs — small inline paths for popular tools */
const TOOL_SVG: Record<string, string> = {
  Git: "M21.6 11.3L12.7 2.4a1.4 1.4 0 00-2 0l-1.8 1.9 2.3 2.3a1.7 1.7 0 012.1 2.2l2.2 2.2a1.7 1.7 0 11-1 1l-2-2.1v5.3a1.7 1.7 0 11-1.4-.2v-5.4a1.7 1.7 0 01-.9-2.2L8 4.2l-5.6 5.6a1.4 1.4 0 000 2l8.9 8.9a1.4 1.4 0 002 0l8.3-8.3a1.4 1.4 0 000-2z",
  Figma: "M8 24a4 4 0 004-4v-4H8a4 4 0 000 8zm0-24a4 4 0 000 8h4V0H8zm8 0a4 4 0 000 8h-4V0h4zm0 8a4 4 0 100 8 4 4 0 000-8zM8 8a4 4 0 000 8h4V8H8z",
  Slack: "M5.04 15.16a2.5 2.5 0 01-2.5 2.5 2.5 2.5 0 01-2.5-2.5 2.5 2.5 0 012.5-2.5h2.5v2.5zm1.27 0a2.5 2.5 0 012.5-2.5 2.5 2.5 0 012.5 2.5v6.3a2.5 2.5 0 01-2.5 2.5 2.5 2.5 0 01-2.5-2.5v-6.3zM8.81 5.04a2.5 2.5 0 01-2.5-2.5 2.5 2.5 0 012.5-2.5 2.5 2.5 0 012.5 2.5v2.5H8.81zm0 1.27a2.5 2.5 0 012.5 2.5 2.5 2.5 0 01-2.5 2.5h-6.3a2.5 2.5 0 01-2.5-2.5 2.5 2.5 0 012.5-2.5h6.3z",
  "Google Workspace": "M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z M5.84 14.09a6.5 6.5 0 010-4.17V7.07H2.18a11 11 0 000 9.86l3.66-2.84z M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z",
  "YouTube Data": "M23.5 6.19a3 3 0 00-2.11-2.13C19.5 3.5 12 3.5 12 3.5s-7.5 0-9.39.56A3 3 0 00.5 6.19 31.2 31.2 0 000 12a31.2 31.2 0 00.5 5.81 3 3 0 002.11 2.13c1.89.56 9.39.56 9.39.56s7.5 0 9.39-.56a3 3 0 002.11-2.13A31.2 31.2 0 0024 12a31.2 31.2 0 00-.5-5.81zM9.6 15.6V8.4L15.84 12 9.6 15.6z",
  "Web Search": "M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z",
  "Web Fetch": "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z",
  "Image Gen": "M21 3H3a2 2 0 00-2 2v14a2 2 0 002 2h18a2 2 0 002-2V5a2 2 0 00-2-2zm0 16H3V5h18v14zM8.5 13.5l2.5 3 3.5-4.5 4.5 6H5l3.5-5z",
  Playwright: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-5.5-2.5l7.51-3.49L17.5 6.5 9.99 9.99 6.5 17.5zm5.5-6.6c.61 0 1.1.49 1.1 1.1s-.49 1.1-1.1 1.1-1.1-.49-1.1-1.1.49-1.1 1.1-1.1z",
  "Security Tools": "M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z",
  Remotion: "M2 12l10-10 10 10-10 10L2 12zm10-6.83L5.17 12 12 18.83 18.83 12 12 5.17z",
  Manim: "M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5",
  "Trend Analysis": "M3 3v18h18M7 16l4-4 4 4 5-5",
  "Sub-Agents": "M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75",
  Scheduling: "M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z",
  Email: "M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z",
  "Google Drive": "M7.71 3.5L1.15 15l3.43 6 6.55-11.5L7.71 3.5zm1.14 0l6.56 11.5H22l-6.56-11.5H8.85zM15.28 16H2.14l3.42 6h13.15l-3.43-6z",
};

/* Whether tool icon uses stroke (outline) vs fill */
const TOOL_SVG_STROKE = new Set([
  "Web Search", "Web Fetch", "Manim", "Trend Analysis", "Sub-Agents",
  "Scheduling", "Email", "Security Tools",
]);

/* Figma uses a 0-24 viewBox while most others use 0-24 too */
const TOOL_VIEWBOX: Record<string, string> = {
  Figma: "0 0 20 28",
  Slack: "0 0 24 24",
};

const TOOL_ICONS: Record<string, { color: string; bg: string }> = {
  "Web Search": { color: "text-sky-400", bg: "bg-sky-500/10 ring-sky-500/20" },
  "Web Fetch": { color: "text-sky-400", bg: "bg-sky-500/10 ring-sky-500/20" },
  Git: { color: "text-orange-400", bg: "bg-orange-500/10 ring-orange-500/20" },
  Figma: { color: "text-purple-400", bg: "bg-purple-500/10 ring-purple-500/20" },
  "Google Workspace": { color: "text-blue-400", bg: "bg-blue-500/10 ring-blue-500/20" },
  "Google Drive": { color: "text-blue-400", bg: "bg-blue-500/10 ring-blue-500/20" },
  Slack: { color: "text-green-400", bg: "bg-green-500/10 ring-green-500/20" },
  "YouTube Data": { color: "text-red-400", bg: "bg-red-500/10 ring-red-500/20" },
  "Image Gen": { color: "text-pink-400", bg: "bg-pink-500/10 ring-pink-500/20" },
  Playwright: { color: "text-emerald-400", bg: "bg-emerald-500/10 ring-emerald-500/20" },
  "Security Tools": { color: "text-red-400", bg: "bg-red-500/10 ring-red-500/20" },
  Remotion: { color: "text-indigo-400", bg: "bg-indigo-500/10 ring-indigo-500/20" },
  Manim: { color: "text-amber-400", bg: "bg-amber-500/10 ring-amber-500/20" },
  "Trend Analysis": { color: "text-cyan-400", bg: "bg-cyan-500/10 ring-cyan-500/20" },
  "Sub-Agents": { color: "text-violet-400", bg: "bg-violet-500/10 ring-violet-500/20" },
  Scheduling: { color: "text-yellow-400", bg: "bg-yellow-500/10 ring-yellow-500/20" },
  Email: { color: "text-blue-400", bg: "bg-blue-500/10 ring-blue-500/20" },
};

const MODEL_BADGE: Record<string, { label: string; full: string; color: string; bg: string; ring: string }> = {
  opus: { label: "Opus 4.6", full: "Claude Opus 4.6", color: "text-amber-300", bg: "bg-amber-500/10", ring: "ring-amber-500/20" },
  sonnet: { label: "Sonnet 4.6", full: "Claude Sonnet 4.6", color: "text-blue-300", bg: "bg-blue-500/10", ring: "ring-blue-500/20" },
  haiku: { label: "Haiku 4.5", full: "Claude Haiku 4.5", color: "text-emerald-300", bg: "bg-emerald-500/10", ring: "ring-emerald-500/20" },
};

/* ── helpers ── */

function isEntryPoint(a: AgentInfo): boolean {
  return a.entry_point !== false; // default true when unset
}

function buildHierarchy(
  agents: AgentInfo[],
  workspace: string | null
): AgentInfo[][] {
  if (workspace === null) {
    const orch = agents.find((a) => a.name === "winston");
    const standalone = agents.filter(
      (a) => a.name !== "winston" && (!a.workspace || a.workspace === "personal") && isEntryPoint(a)
    );
    const helpers = agents.filter(
      (a) => a.name !== "winston" && (!a.workspace || a.workspace === "personal") && !isEntryPoint(a)
    );
    const rows: AgentInfo[][] = [];
    if (orch) rows.push([orch]);
    if (standalone.length) rows.push(standalone);
    if (helpers.length) rows.push(helpers);
    return rows;
  }
  const wsAgents = agents.filter((a) => a.workspace === workspace);
  const order = ["research", "director", "assets", "deliver"];
  const sortFn = (a: AgentInfo, b: AgentInfo) => {
    const ai = order.indexOf(a.short_name || "");
    const bi = order.indexOf(b.short_name || "");
    if (ai >= 0 && bi >= 0) return ai - bi;
    if (ai >= 0) return -1;
    if (bi >= 0) return 1;
    return (a.short_name || a.name).localeCompare(b.short_name || b.name);
  };
  const entry = wsAgents.filter(isEntryPoint).sort(sortFn);
  const helpers = wsAgents.filter((a) => !isEntryPoint(a)).sort(sortFn);
  const rows: AgentInfo[][] = [];
  if (entry.length) rows.push(entry);
  if (helpers.length) rows.push(helpers);
  return rows;
}

/* ── small components ── */

function ToolIcon({ tool, className }: { tool: string; className?: string }) {
  const path = TOOL_SVG[tool];
  if (!path) return null;
  const isStroke = TOOL_SVG_STROKE.has(tool);
  const viewBox = TOOL_VIEWBOX[tool] || "0 0 24 24";
  return (
    <svg className={className || "h-3 w-3"} viewBox={viewBox} fill={isStroke ? "none" : "currentColor"} stroke={isStroke ? "currentColor" : "none"} strokeWidth={isStroke ? 2 : 0} strokeLinecap="round" strokeLinejoin="round">
      {path.split(" M").map((d, i) => (
        <path key={i} d={i === 0 ? d : `M${d}`} />
      ))}
    </svg>
  );
}

function ToolBadge({ tool, iconOnly }: { tool: string; iconOnly?: boolean }) {
  const style = TOOL_ICONS[tool] || { color: "text-zinc-400", bg: "bg-zinc-500/10 ring-zinc-500/20" };
  const hasIcon = !!TOOL_SVG[tool];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium leading-tight ring-1 ring-inset ${style.color} ${style.bg}`}
      title={tool}
    >
      {hasIcon && <ToolIcon tool={tool} className="h-3 w-3 shrink-0" />}
      {!iconOnly && tool}
    </span>
  );
}

function ToolOverflow({ tools }: { tools: string[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function close(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        className="rounded-md bg-white/[0.04] px-2 py-0.5 text-[11px] font-medium text-zinc-500 ring-1 ring-inset ring-white/[0.06] transition-colors hover:bg-white/[0.08] hover:text-zinc-300"
      >
        +{tools.length}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 min-w-[180px] rounded-xl border border-white/[0.06] bg-[var(--surface-2)] p-2 shadow-2xl shadow-black/60">
          <p className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-widest text-zinc-600">
            All tools
          </p>
          <div className="flex flex-wrap gap-1.5">
            {tools.map((t) => (
              <ToolBadge key={t} tool={t} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ModelBadge({ model }: { model: string }) {
  const style = MODEL_BADGE[model] || MODEL_BADGE.sonnet;
  return (
    <span
      title={style.full}
      className={`inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-semibold tracking-wider ring-1 ring-inset ${style.color} ${style.bg} ${style.ring}`}
    >
      {style.label}
    </span>
  );
}

function StatCard({
  label,
  value,
  sub,
  icon,
  accentColor,
}: {
  label: string;
  value: string | number;
  sub?: string;
  icon: React.ReactNode;
  accentColor: string;
}) {
  return (
    <div className="glass-card group relative overflow-hidden rounded-2xl p-5 transition-all duration-300 hover:border-white/[0.08]">
      <div className={`absolute -right-4 -top-4 h-24 w-24 rounded-full blur-3xl opacity-[0.07] ${accentColor}`} />
      <div className="relative flex items-start justify-between">
        <div>
          <p className="text-[13px] font-medium text-zinc-500">{label}</p>
          <p className="mt-1.5 text-2xl font-semibold tracking-tight text-zinc-100">
            {value}
          </p>
          {sub && (
            <p className="mt-0.5 text-[12px] text-zinc-600">{sub}</p>
          )}
        </div>
        <div className="rounded-xl bg-white/[0.03] p-2.5 text-zinc-600">
          {icon}
        </div>
      </div>
    </div>
  );
}

/* ── workspace dropdown ── */

function WorkspaceDropdown({
  workspaces,
  active,
  onChange,
}: {
  workspaces: string[];
  active: string | null;
  onChange: (ws: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function close(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node))
        setOpen(false);
    }
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const label = active === null ? "Personal" : active;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2.5 rounded-xl border border-white/[0.06] bg-white/[0.03] px-3.5 py-2 text-[13px] font-medium capitalize text-zinc-300 transition-all duration-200 hover:border-white/[0.1] hover:bg-white/[0.05]"
      >
        <span className="flex h-5 w-5 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 text-[10px] font-bold text-white">
          {label[0].toUpperCase()}
        </span>
        {label}
        <svg
          className={`ml-1 h-3.5 w-3.5 text-zinc-500 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-2 min-w-[220px] overflow-hidden rounded-xl border border-white/[0.06] bg-[#131318] shadow-2xl shadow-black/60">
          <div className="p-1.5">
            <p className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-zinc-600">
              Workspaces
            </p>
            <button
              onClick={() => { onChange(null); setOpen(false); }}
              className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-[13px] font-medium transition-all duration-150 ${
                active === null
                  ? "bg-white/[0.06] text-white"
                  : "text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-200"
              }`}
            >
              <span className="flex h-5 w-5 items-center justify-center rounded-lg bg-gradient-to-br from-amber-500 to-orange-600 text-[10px] font-bold text-white">
                P
              </span>
              Personal
              {active === null && (
                <svg className="ml-auto h-3.5 w-3.5 text-indigo-400" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                </svg>
              )}
            </button>
            {workspaces.map((ws) => (
              <button
                key={ws}
                onClick={() => { onChange(ws); setOpen(false); }}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-[13px] font-medium capitalize transition-all duration-150 ${
                  active === ws
                    ? "bg-white/[0.06] text-white"
                    : "text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-200"
                }`}
              >
                <span className="flex h-5 w-5 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500 to-purple-600 text-[10px] font-bold text-white">
                  {ws[0].toUpperCase()}
                </span>
                {ws}
                {active === ws && (
                  <svg className="ml-auto h-3.5 w-3.5 text-indigo-400" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── agent card ── */

function AgentCard({
  agent,
  isExpanded,
  onToggle,
}: {
  agent: AgentInfo;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const name = agent.short_name || agent.name;

  return (
    <div className="group">
      <div
        className={`glass-card-hover relative rounded-2xl transition-all duration-300 ${
          isExpanded
            ? "border-white/[0.08] bg-white/[0.04] shadow-lg shadow-black/20"
            : ""
        }`}
      >
        {/* top gradient line */}
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/[0.06] to-transparent" />

        <div className="flex items-center gap-4 p-5">
          {/* agent avatar */}
          <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-white/[0.06] to-white/[0.02] ring-1 ring-inset ring-white/[0.06]">
            <span className="text-sm font-bold capitalize text-zinc-400 transition-colors duration-200 group-hover:text-zinc-200">
              {name[0]}
            </span>
          </div>

          {/* info */}
          <button
            onClick={onToggle}
            className="min-w-0 flex-1 text-left"
          >
            <div className="flex items-center gap-2.5">
              <span className="text-[15px] font-semibold capitalize tracking-tight text-zinc-100 transition-colors duration-200 group-hover:text-white">
                {name}
              </span>
              {agent.model && <ModelBadge model={agent.model} />}
            </div>
            <p className="mt-0.5 truncate text-[13px] leading-relaxed text-zinc-500 transition-colors duration-200 group-hover:text-zinc-400">
              {agent.description}
            </p>
          </button>

          {/* tools (desktop) */}
          <div className="hidden shrink-0 items-center gap-1.5 lg:flex">
            {(agent.tools || []).slice(0, 3).map((t) => (
              <ToolBadge key={t} tool={t} />
            ))}
            {(agent.tools || []).length > 3 && (
              <ToolOverflow tools={(agent.tools || []).slice(3)} />
            )}
          </div>

          {/* actions */}
          <div className="flex shrink-0 items-center gap-2">
            <button
              onClick={onToggle}
              className="rounded-lg p-2 text-zinc-600 transition-all duration-200 hover:bg-white/[0.04] hover:text-zinc-400"
              title="Expand"
            >
              <svg
                className={`h-4 w-4 transition-transform duration-300 ${isExpanded ? "rotate-180" : ""}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            <Link
              href={`/agents/${agent.name}`}
              className="flex items-center gap-1.5 rounded-xl bg-white/[0.04] px-4 py-2 text-[13px] font-medium text-zinc-400 ring-1 ring-inset ring-white/[0.06] transition-all duration-200 hover:bg-white/[0.07] hover:text-white hover:ring-white/[0.1]"
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
              Chat
            </Link>
            <Link
              href={`/schedules?agent=${encodeURIComponent(agent.name)}`}
              className="flex items-center gap-1.5 rounded-xl bg-white/[0.04] px-4 py-2 text-[13px] font-medium text-zinc-400 ring-1 ring-inset ring-white/[0.06] transition-all duration-200 hover:bg-white/[0.07] hover:text-white hover:ring-white/[0.1]"
              title="Schedule this agent"
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
              Schedule
            </Link>
          </div>
        </div>

        {/* expanded detail */}
        {isExpanded && (
          <div className="border-t border-white/[0.04] px-5 pb-5">
            <AgentDetail agent={agent} />
          </div>
        )}
      </div>
    </div>
  );
}

/* ── agent detail with pretty/raw toggle ── */

function AgentDetail({ agent }: { agent: AgentInfo }) {
  const [prompt, setPrompt] = useState("");
  const [original, setOriginal] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [mode, setMode] = useState<"pretty" | "raw">("pretty");

  useEffect(() => {
    fetch(`/api/agents/${agent.name}`)
      .then((r) => r.json())
      .then((data) => {
        const p = data.system_prompt || "";
        setPrompt(p);
        setOriginal(p);
      })
      .catch(() => setPrompt("(failed to load)"))
      .finally(() => setLoading(false));
  }, [agent.name]);

  const dirty = prompt !== original;

  async function save() {
    setSaving(true);
    setSaved(false);
    try {
      const res = await fetch(`/api/agents/${agent.name}/prompt`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ system_prompt: prompt }),
      });
      if (res.ok) {
        setOriginal(prompt);
        setSaved(true);
        setTimeout(() => setSaved(false), 4000);
      }
    } catch {
      // connection error
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="pt-4">
      {/* tools row (visible on mobile when expanded) */}
      {agent.tools && agent.tools.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-1.5 lg:hidden">
          {agent.tools.map((t) => (
            <ToolBadge key={t} tool={t} />
          ))}
        </div>
      )}
      {/* all tools on desktop */}
      {agent.tools && agent.tools.length > 3 && (
        <div className="mb-4 hidden flex-wrap gap-1.5 lg:flex">
          {agent.tools.map((t) => (
            <ToolBadge key={t} tool={t} />
          ))}
        </div>
      )}

      {/* editor chrome */}
      <div className="overflow-hidden rounded-xl border border-white/[0.05] bg-[#0a0a0f]">
        {/* toolbar */}
        <div className="flex items-center justify-between border-b border-white/[0.05] px-4 py-2.5">
          <div className="flex items-center gap-1 rounded-lg bg-white/[0.03] p-0.5">
            <button
              onClick={() => setMode("pretty")}
              className={`rounded-md px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide transition-all duration-200 ${
                mode === "pretty"
                  ? "bg-white/[0.07] text-zinc-200 shadow-sm"
                  : "text-zinc-600 hover:text-zinc-400"
              }`}
            >
              Preview
            </button>
            <button
              onClick={() => setMode("raw")}
              className={`rounded-md px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide transition-all duration-200 ${
                mode === "raw"
                  ? "bg-white/[0.07] text-zinc-200 shadow-sm"
                  : "text-zinc-600 hover:text-zinc-400"
              }`}
            >
              Edit
            </button>
          </div>
          <div className="flex items-center gap-3">
            <span className="font-mono text-[11px] text-zinc-700">{agent.name}.md</span>
            {saved && (
              <span className="flex items-center gap-1.5 text-[11px] font-medium text-emerald-400">
                <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                </svg>
                Saved
              </span>
            )}
            {dirty && !saved && (
              <button
                onClick={save}
                disabled={saving}
                className="rounded-lg bg-indigo-600 px-3.5 py-1.5 text-[11px] font-semibold text-white transition-all duration-200 hover:bg-indigo-500 disabled:opacity-50"
              >
                {saving ? "Saving..." : "Save & Restart"}
              </button>
            )}
          </div>
        </div>

        {/* content */}
        {loading ? (
          <div className="space-y-3 px-6 py-6">
            <div className="skeleton h-4 w-3/4" />
            <div className="skeleton h-4 w-1/2" />
            <div className="skeleton h-4 w-5/6" />
          </div>
        ) : mode === "pretty" ? (
          <div className="markdown-body max-h-[560px] overflow-auto px-6 py-5">
            <ReactMarkdown>{prompt}</ReactMarkdown>
          </div>
        ) : (
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            spellCheck={false}
            className="block w-full resize-y bg-transparent px-5 py-4 font-mono text-[13px] leading-relaxed text-zinc-300 placeholder-zinc-700 focus:outline-none"
            rows={Math.min(Math.max(prompt.split("\n").length + 2, 10), 28)}
          />
        )}
      </div>
    </div>
  );
}

/* ── nav link ── */

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="flex items-center gap-2 rounded-xl px-3.5 py-2 text-[13px] font-medium text-zinc-500 transition-all duration-200 hover:bg-white/[0.04] hover:text-zinc-200"
    >
      {children}
    </Link>
  );
}

/* ── main page ── */

export default function Home() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [serviceUp, setServiceUp] = useState<boolean | null>(null);
  const [activeWorkspace, setActiveWorkspace] = useState<string | null>(null);
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);

  useEffect(() => {
    async function fetchData() {
      try {
        const [healthRes, agentsRes] = await Promise.all([
          fetch("/api/health"),
          fetch("/api/agents"),
        ]);
        if (healthRes.ok) {
          setHealth(await healthRes.json());
          setServiceUp(true);
        } else {
          setServiceUp(false);
        }
        if (agentsRes.ok) setAgents(await agentsRes.json());
      } catch {
        setServiceUp(false);
      }
    }
    fetchData();
  }, []);

  const toggleAgent = useCallback(
    (name: string) => setExpandedAgent((p) => (p === name ? null : name)),
    []
  );

  // The "Personal" entry is rendered by the fixed button at the top of the
  // dropdown — and also covers agents whose name is prefixed `personal-` — so
  // we exclude "personal" from the per-workspace list to avoid duplicates.
  const workspaceNames = [
    ...new Set(
      agents
        .filter((a) => a.workspace && a.workspace !== "personal")
        .map((a) => a.workspace!)
    ),
  ].sort();

  const tiers = buildHierarchy(agents, activeWorkspace);

  return (
    <div className="noise-bg relative min-h-screen bg-[#09090b] text-white">
      {/* ambient background gradients */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -left-[300px] -top-[200px] h-[600px] w-[600px] rounded-full bg-indigo-600/[0.04] blur-[120px]" />
        <div className="absolute -right-[200px] top-[300px] h-[500px] w-[500px] rounded-full bg-violet-600/[0.03] blur-[120px]" />
        <div className="absolute bottom-0 left-1/3 h-[400px] w-[600px] rounded-full bg-blue-600/[0.02] blur-[120px]" />
      </div>

      {/* header */}
      <header className="sticky top-0 z-40 border-b border-white/[0.04] bg-[#09090b]/80 backdrop-blur-2xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3.5">
          <div className="flex items-center gap-5">
            {/* logo */}
            <div className="flex items-center gap-3">
              <div className="relative flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 shadow-lg shadow-indigo-500/20">
                <span className="text-sm font-bold text-white">W</span>
              </div>
              <h1 className="text-[17px] font-semibold tracking-tight text-zinc-100">
                Winston
              </h1>
            </div>

            {/* divider */}
            <div className="h-5 w-px bg-white/[0.06]" />

            {/* workspace selector */}
            <WorkspaceDropdown
              workspaces={workspaceNames}
              active={activeWorkspace}
              onChange={(ws) => {
                setActiveWorkspace(ws);
                setExpandedAgent(null);
              }}
            />

            {/* status */}
            {serviceUp !== null && (
              <>
                <div className="h-5 w-px bg-white/[0.06]" />
                <div className="flex items-center gap-2">
                  <span
                    className={`relative flex h-2 w-2`}
                  >
                    {serviceUp && (
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-40" />
                    )}
                    <span
                      className={`relative inline-flex h-2 w-2 rounded-full ${
                        serviceUp ? "bg-emerald-400" : "bg-red-400"
                      }`}
                    />
                  </span>
                  {health ? (
                    <span className="text-[12px] font-medium text-zinc-500">
                      {health.uptime}
                    </span>
                  ) : serviceUp === false ? (
                    <span className="text-[12px] font-medium text-red-400">
                      Offline
                    </span>
                  ) : null}
                </div>
              </>
            )}
          </div>

          {/* nav */}
          <nav className="flex items-center gap-1">
            <NavLink href="/voice">
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
              </svg>
              Voice
            </NavLink>
            <NavLink href="/schedules">
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              Schedules
            </NavLink>
            <NavLink href="/jobs">
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 14.15v4.073a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V10.604M20.25 14.15l-6.05 2.415a2.25 2.25 0 01-1.4 0L3.75 10.604M20.25 14.15L21 13.85M3.75 10.604L3 10.3m0 0l9-3.6 9 3.6-9 3.6-9-3.6z" />
              </svg>
              Jobs
            </NavLink>
          </nav>
        </div>
      </header>

      {/* main content */}
      <main className="relative z-10 mx-auto max-w-6xl px-6 pb-20 pt-8">
        {/* stats row */}
        {health && (
          <div className="mb-10 grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatCard
              label="Status"
              value={serviceUp ? "Operational" : "Down"}
              sub="All systems"
              accentColor="bg-emerald-500"
              icon={
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
                </svg>
              }
            />
            <StatCard
              label="Uptime"
              value={health.uptime}
              accentColor="bg-blue-500"
              icon={
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              }
            />
            <StatCard
              label="Agents"
              value={health.agents}
              sub={`${health.active_sessions} active`}
              accentColor="bg-indigo-500"
              icon={
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
                </svg>
              }
            />
            <StatCard
              label="Schedules"
              value={health.active_schedules}
              sub="Active cron jobs"
              accentColor="bg-violet-500"
              icon={
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" />
                </svg>
              }
            />
          </div>
        )}

        {/* loading skeleton */}
        {agents.length === 0 && serviceUp !== false && (
          <div className="space-y-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="glass-card rounded-2xl p-5">
                <div className="flex items-center gap-4">
                  <div className="skeleton h-10 w-10 rounded-xl" />
                  <div className="flex-1 space-y-2">
                    <div className="skeleton h-4 w-32" />
                    <div className="skeleton h-3 w-64" />
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* offline state */}
        {serviceUp === false && (
          <div className="flex flex-col items-center justify-center py-32">
            <div className="mb-4 rounded-2xl bg-red-500/10 p-4">
              <svg className="h-8 w-8 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
              </svg>
            </div>
            <p className="text-[15px] font-medium text-zinc-300">Service Unreachable</p>
            <p className="mt-1 text-[13px] text-zinc-600">Check that the Winston router is running</p>
          </div>
        )}

        {/* agent list */}
        <div className="space-y-3">
          {tiers.map((tier, tierIdx) => {
            const isHelperTier =
              tier.length > 1 && tier.every((a) => a.entry_point === false);
            return (
            <div key={tierIdx}>
              {activeWorkspace === null && tierIdx === 0 && tier.length === 1 && (
                <div className="mb-4 flex items-center gap-3">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.15em] text-zinc-600">
                    Orchestrator
                  </p>
                  <div className="h-px flex-1 bg-gradient-to-r from-white/[0.04] to-transparent" />
                </div>
              )}
              {activeWorkspace === null && tierIdx === 1 && (
                <div className="mb-4 mt-8 flex items-center gap-3">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.15em] text-zinc-600">
                    Agents
                  </p>
                  <div className="h-px flex-1 bg-gradient-to-r from-white/[0.04] to-transparent" />
                </div>
              )}
              {activeWorkspace === null && isHelperTier && (
                <div className="mb-4 mt-8 flex items-center gap-3">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.15em] text-zinc-600">
                    Helpers
                  </p>
                  <span className="text-[10px] text-zinc-700">called by other agents</span>
                  <div className="h-px flex-1 bg-gradient-to-r from-white/[0.04] to-transparent" />
                </div>
              )}
              {activeWorkspace !== null && isHelperTier && (
                <div className="mb-4 mt-6 flex items-center gap-3">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.15em] text-zinc-600">
                    Helpers
                  </p>
                  <span className="text-[10px] text-zinc-700">called by other agents — not scheduled directly</span>
                  <div className="h-px flex-1 bg-gradient-to-r from-white/[0.04] to-transparent" />
                </div>
              )}
              <div className="space-y-3">
                {tier.map((agent) => (
                  <AgentCard
                    key={agent.name}
                    agent={agent}
                    isExpanded={expandedAgent === agent.name}
                    onToggle={() => toggleAgent(agent.name)}
                  />
                ))}
              </div>
            </div>
            );
          })}
        </div>
      </main>
    </div>
  );
}

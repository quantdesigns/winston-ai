"use client";

import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import Link from "next/link";

/* ── types ── */

interface AgentInfo {
  name: string;
  description: string;
  model?: string;
  workspace?: string;
  short_name?: string;
  entry_point?: boolean;
}

interface Schedule {
  id: string;
  agent_id: string;
  cron: string;
  prompt: string;
  slack_channel?: string;
  timezone?: string;
  status: string;
}

interface CalendarEvent {
  schedule: Schedule;
  agent: AgentInfo | undefined;
  date: Date;
  hour: number;
  minute: number;
}

type ViewMode = "list" | "day" | "week";

/* ── constants ── */

const DAYS = [
  { label: "Sun", value: 0 },
  { label: "Mon", value: 1 },
  { label: "Tue", value: 2 },
  { label: "Wed", value: 3 },
  { label: "Thu", value: 4 },
  { label: "Fri", value: 5 },
  { label: "Sat", value: 6 },
];

const REPEAT_OPTIONS = [
  { label: "Every day", value: "daily" },
  { label: "Weekdays", value: "weekdays" },
  { label: "Specific days", value: "specific" },
  { label: "Monthly (1st)", value: "monthly" },
];

const COMMON_TIMEZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "Asia/Tokyo",
  "Asia/Shanghai",
  "Asia/Kolkata",
  "Australia/Sydney",
  "UTC",
];

const SLACK_CHANNELS = [
  { label: "#rivalytics", value: "#rivalytics" },
  { label: "#all-quant-designs", value: "#all-quant-designs" },
  { label: "#codephil", value: "#codephil" },
  { label: "#quizos", value: "#quizos" },
];

const HOUR_START = 6;
const HOUR_END = 23;
const HOUR_HEIGHT = 60; // px per hour row

const WORKSPACE_COLORS: Record<string, { bg: string; border: string; text: string; dot: string }> = {
  team: { bg: "bg-violet-500/15", border: "border-violet-500/30", text: "text-violet-300", dot: "bg-violet-500" },
  acme: { bg: "bg-emerald-500/15", border: "border-emerald-500/30", text: "text-emerald-300", dot: "bg-emerald-500" },
  personal: { bg: "bg-amber-500/15", border: "border-amber-500/30", text: "text-amber-300", dot: "bg-amber-500" },
};

function getWorkspaceColor(workspace: string | undefined) {
  if (!workspace) return WORKSPACE_COLORS.personal;
  return WORKSPACE_COLORS[workspace] || { bg: "bg-blue-500/15", border: "border-blue-500/30", text: "text-blue-300", dot: "bg-blue-500" };
}

/* ── helpers ── */

function buildCron(
  hour: number,
  minute: number,
  repeat: string,
  selectedDays: number[]
): string {
  const dayPart =
    repeat === "daily"
      ? "*"
      : repeat === "weekdays"
        ? "1-5"
        : repeat === "monthly"
          ? "*"
          : selectedDays.sort().join(",") || "*";
  const dayOfMonth = repeat === "monthly" ? "1" : "*";
  return `${minute} ${hour} ${dayOfMonth} * ${dayPart}`;
}

function cronToHuman(cron: string): string {
  const parts = cron.split(" ");
  if (parts.length !== 5) return cron;
  const [min, hr, dom, , dow] = parts;
  const h = parseInt(hr);
  const m = parseInt(min);
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  const time = `${h12}:${m.toString().padStart(2, "0")} ${ampm}`;

  if (dom === "1") return `1st of every month at ${time}`;
  if (dow === "*") return `Every day at ${time}`;
  if (dow === "1-5") return `Weekdays at ${time}`;

  const dayNames = dow.split(",").map((d) => {
    const day = DAYS.find((x) => x.value === parseInt(d));
    return day?.label || d;
  });
  return `${dayNames.join(", ")} at ${time}`;
}

// Default prompts for agents -- used when selecting an agent in the schedule form.
// Falls back to the agent description if no explicit default is set.
const PROMPT_DEFAULTS: Record<string, string> = {
  "acme-social":
    "Run the weekly Acme Insights social media content pipeline. Research competitive intelligence trends, write 3 platform-optimized posts, and generate branded images.",
  marketing: "Run a marketing briefing -- analyze recent campaigns and suggest next steps.",
  pentester: "Run a security scan summary of recent findings and recommendations.",
  winston: "Check in with a daily briefing -- calendar, priorities, and pending items.",
};

function getDefaultPrompt(agent: AgentInfo): string {
  return PROMPT_DEFAULTS[agent.name] || agent.description || "";
}

function groupAgentsByWorkspace(agents: AgentInfo[]): {
  workspaces: { name: string; agents: AgentInfo[] }[];
  standalone: AgentInfo[];
} {
  const wsMap = new Map<string, AgentInfo[]>();
  const standalone: AgentInfo[] = [];

  for (const agent of agents) {
    if (agent.workspace) {
      const list = wsMap.get(agent.workspace) || [];
      list.push(agent);
      wsMap.set(agent.workspace, list);
    } else {
      standalone.push(agent);
    }
  }

  const workspaces = Array.from(wsMap.entries())
    .map(([name, agents]) => ({ name, agents }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { workspaces, standalone };
}

function shortTz(tz: string): string {
  const parts = tz.split("/");
  return parts[parts.length - 1].replace(/_/g, " ");
}

/* ── cron-to-occurrences logic ── */

function cronMatchesDate(cron: string, date: Date): boolean {
  const parts = cron.split(" ");
  if (parts.length !== 5) return false;
  const [, , dom, , dow] = parts;

  const dayOfWeek = date.getDay(); // 0=Sun
  const dayOfMonth = date.getDate();

  // Check day-of-month
  if (dom !== "*") {
    const domValues = expandCronField(dom, 1, 31);
    if (!domValues.includes(dayOfMonth)) return false;
  }

  // Check day-of-week
  if (dow !== "*") {
    const dowValues = expandCronField(dow, 0, 6);
    if (!dowValues.includes(dayOfWeek)) return false;
  }

  return true;
}

function expandCronField(field: string, min: number, max: number): number[] {
  if (field === "*") {
    const result: number[] = [];
    for (let i = min; i <= max; i++) result.push(i);
    return result;
  }

  const values: number[] = [];
  const segments = field.split(",");
  for (const seg of segments) {
    if (seg.includes("-")) {
      const [start, end] = seg.split("-").map(Number);
      for (let i = start; i <= end; i++) values.push(i);
    } else if (seg.includes("/")) {
      const [base, step] = seg.split("/");
      const startVal = base === "*" ? min : Number(base);
      const stepVal = Number(step);
      for (let i = startVal; i <= max; i += stepVal) values.push(i);
    } else {
      values.push(Number(seg));
    }
  }
  return values;
}

function getCronTime(cron: string): { hour: number; minute: number } {
  const parts = cron.split(" ");
  if (parts.length !== 5) return { hour: 0, minute: 0 };
  return { hour: parseInt(parts[1]), minute: parseInt(parts[0]) };
}

function getEventsForDateRange(
  schedules: Schedule[],
  agents: AgentInfo[],
  startDate: Date,
  endDate: Date
): CalendarEvent[] {
  const events: CalendarEvent[] = [];
  const current = new Date(startDate);

  while (current <= endDate) {
    for (const sched of schedules) {
      if (cronMatchesDate(sched.cron, current)) {
        const { hour, minute } = getCronTime(sched.cron);
        const agent = agents.find((a) => a.name === sched.agent_id);
        events.push({
          schedule: sched,
          agent,
          date: new Date(current),
          hour,
          minute,
        });
      }
    }
    current.setDate(current.getDate() + 1);
  }

  return events;
}

/* ── date helpers ── */

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function getWeekStart(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  // Start on Monday
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function getWeekDays(weekStart: Date): Date[] {
  const days: Date[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    days.push(d);
  }
  return days;
}

function formatDateShort(date: Date): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(date);
}

function formatDateFull(date: Date): string {
  return new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(date);
}

function formatDayHeader(date: Date): string {
  return new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(date);
}

function formatHour(hour: number): string {
  if (hour === 0) return "12 AM";
  if (hour < 12) return `${hour} AM`;
  if (hour === 12) return "12 PM";
  return `${hour - 12} PM`;
}

/* ── workspace dropdown for filtering ── */

function WorkspaceFilter({
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

  if (workspaces.length === 0) return null;

  const label = active === null ? "All" : active === "personal" ? "Personal" : active;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex h-9 items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 text-[13px] font-medium capitalize text-zinc-300 transition-all hover:border-white/[0.1] hover:bg-white/[0.05]"
      >
        <span className="flex h-5 w-5 items-center justify-center rounded-md bg-gradient-to-br from-indigo-500 to-violet-600 text-[9px] font-bold text-white">
          {label[0].toUpperCase()}
        </span>
        {label}
        <svg
          className={`ml-0.5 h-3.5 w-3.5 text-zinc-500 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-2 min-w-[200px] overflow-hidden rounded-xl border border-white/[0.06] bg-[var(--surface-2)] shadow-2xl shadow-black/60">
          <div className="p-1.5">
            <p className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-zinc-600">
              Filter
            </p>
            <button
              onClick={() => { onChange(null); setOpen(false); }}
              className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-[13px] font-medium transition-all ${active === null ? "bg-white/[0.06] text-white" : "text-zinc-400 hover:bg-white/[0.04]"}`}
            >
              <span className="flex h-5 w-5 items-center justify-center rounded-md bg-gradient-to-br from-zinc-500 to-zinc-600 text-[9px] font-bold text-white">A</span>
              All
              {active === null && <svg className="ml-auto h-3.5 w-3.5 text-indigo-400" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" /></svg>}
            </button>
            <button
              onClick={() => { onChange("personal"); setOpen(false); }}
              className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-[13px] font-medium transition-all ${active === "personal" ? "bg-white/[0.06] text-white" : "text-zinc-400 hover:bg-white/[0.04]"}`}
            >
              <span className="flex h-5 w-5 items-center justify-center rounded-md bg-gradient-to-br from-amber-500 to-orange-600 text-[9px] font-bold text-white">P</span>
              Personal
              {active === "personal" && <svg className="ml-auto h-3.5 w-3.5 text-indigo-400" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" /></svg>}
            </button>
            {workspaces.map((ws) => (
              <button
                key={ws}
                onClick={() => { onChange(ws); setOpen(false); }}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-[13px] font-medium capitalize transition-all ${active === ws ? "bg-white/[0.06] text-white" : "text-zinc-400 hover:bg-white/[0.04]"}`}
              >
                <span className="flex h-5 w-5 items-center justify-center rounded-md bg-gradient-to-br from-violet-500 to-purple-600 text-[9px] font-bold text-white">
                  {ws[0].toUpperCase()}
                </span>
                {ws}
                {active === ws && <svg className="ml-auto h-3.5 w-3.5 text-indigo-400" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" /></svg>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── view switcher ── */

function ViewSwitcher({ view, onChange }: { view: ViewMode; onChange: (v: ViewMode) => void }) {
  const views: { label: string; value: ViewMode }[] = [
    { label: "List", value: "list" },
    { label: "Day", value: "day" },
    { label: "Week", value: "week" },
  ];
  return (
    <div className="flex h-9 overflow-hidden rounded-lg border border-white/[0.06] bg-white/[0.03]">
      {views.map((v) => (
        <button
          key={v.value}
          onClick={() => onChange(v.value)}
          className={`px-3 text-[13px] font-medium transition-all ${
            view === v.value
              ? "bg-white/[0.08] text-white"
              : "text-zinc-500 hover:bg-white/[0.04] hover:text-zinc-300"
          }`}
        >
          {v.label}
        </button>
      ))}
    </div>
  );
}

/* ── parse cron back into form state ── */

function parseCron(cron: string): {
  hour: number;
  minute: number;
  ampm: "AM" | "PM";
  repeat: string;
  selectedDays: number[];
} {
  const parts = cron.split(" ");
  if (parts.length !== 5) return { hour: 9, minute: 0, ampm: "AM", repeat: "daily", selectedDays: [1] };
  const [min, hr, dom, , dow] = parts;
  const h24 = parseInt(hr);
  const m = parseInt(min);
  const ampm: "AM" | "PM" = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 === 0 ? 12 : h24 > 12 ? h24 - 12 : h24;

  let repeat = "daily";
  let selectedDays = [1];
  if (dom === "1") {
    repeat = "monthly";
  } else if (dow === "1-5") {
    repeat = "weekdays";
  } else if (dow === "*") {
    repeat = "daily";
  } else {
    repeat = "specific";
    selectedDays = dow.split(",").map(Number);
  }

  return { hour: h12, minute: m, ampm, repeat, selectedDays };
}

/* ── schedule editor (inline edit for existing schedules) ── */

function ScheduleEditor({
  schedule,
  agents,
  workspaces,
  standalone,
  onSave,
  onCancel,
  onDelete,
}: {
  schedule: Schedule;
  agents: AgentInfo[];
  workspaces: { name: string; agents: AgentInfo[] }[];
  standalone: AgentInfo[];
  onSave: (updates: Partial<Schedule>) => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const [editPrompt, setEditPrompt] = useState(schedule.prompt);
  const [editSlack, setEditSlack] = useState(schedule.slack_channel || "");
  const parsed = parseCron(schedule.cron);
  const [editHour, setEditHour] = useState(parsed.hour);
  const [editMinute, setEditMinute] = useState(parsed.minute);
  const [editAmpm, setEditAmpm] = useState(parsed.ampm);
  const [editRepeat, setEditRepeat] = useState(parsed.repeat);
  const [editDays, setEditDays] = useState(parsed.selectedDays);

  function handleSave() {
    const h24 =
      editAmpm === "PM"
        ? editHour === 12
          ? 12
          : editHour + 12
        : editHour === 12
          ? 0
          : editHour;
    onSave({
      cron: buildCron(h24, editMinute, editRepeat, editDays),
      prompt: editPrompt,
      slack_channel: editSlack,
    });
  }

  const agent = agents.find((a) => a.name === schedule.agent_id);

  return (
    <div className="glass-card rounded-xl border-indigo-500/20 p-5">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          {agent?.workspace && (
            <span className="rounded bg-violet-900/50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-violet-400">
              {agent.workspace}
            </span>
          )}
          <span className="font-medium capitalize">
            {agent?.short_name || schedule.agent_id}
          </span>
        </div>
        <button
          onClick={onDelete}
          className="text-xs text-red-400 hover:text-red-300"
        >
          Delete schedule
        </button>
      </div>

      {/* Time */}
      <div className="mb-4 flex items-center gap-2">
        <select
          value={editHour}
          onChange={(e) => setEditHour(parseInt(e.target.value))}
          className="rounded-lg border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm tabular-nums"
        >
          {Array.from({ length: 12 }, (_, i) => i + 1).map((h) => (
            <option key={h} value={h}>{h}</option>
          ))}
        </select>
        <span className="text-zinc-500">:</span>
        <select
          value={editMinute}
          onChange={(e) => setEditMinute(parseInt(e.target.value))}
          className="rounded-lg border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm tabular-nums"
        >
          {Array.from({ length: 60 }, (_, i) => i).map((m) => (
            <option key={m} value={m}>{m.toString().padStart(2, "0")}</option>
          ))}
        </select>
        <div className="flex overflow-hidden rounded-lg border border-zinc-700">
          {(["AM", "PM"] as const).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setEditAmpm(p)}
              className={`px-2 py-1.5 text-xs font-medium ${
                editAmpm === p
                  ? "bg-blue-600 text-white"
                  : "bg-zinc-800 text-zinc-400"
              }`}
            >
              {p}
            </button>
          ))}
        </div>
        <div className="ml-2 flex gap-1">
          {REPEAT_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setEditRepeat(opt.value)}
              className={`rounded px-2 py-1 text-xs ${
                editRepeat === opt.value
                  ? "bg-blue-500/20 text-blue-400"
                  : "bg-zinc-800 text-zinc-500"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {editRepeat === "specific" && (
        <div className="mb-4 flex gap-1">
          {DAYS.map((day) => (
            <button
              key={day.value}
              type="button"
              onClick={() =>
                setEditDays((prev) =>
                  prev.includes(day.value)
                    ? prev.filter((d) => d !== day.value)
                    : [...prev, day.value]
                )
              }
              className={`flex h-8 w-8 items-center justify-center rounded-full text-xs ${
                editDays.includes(day.value)
                  ? "bg-blue-600 text-white"
                  : "bg-zinc-800 text-zinc-500"
              }`}
            >
              {day.label}
            </button>
          ))}
        </div>
      )}

      {/* Prompt */}
      <textarea
        value={editPrompt}
        onChange={(e) => setEditPrompt(e.target.value)}
        rows={3}
        className="mb-3 w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm"
      />

      {/* Slack */}
      <select
        value={editSlack}
        onChange={(e) => setEditSlack(e.target.value)}
        className="mb-4 w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm"
      >
        {!SLACK_CHANNELS.some((c) => c.value === editSlack) && editSlack && (
          <option value={editSlack}>{editSlack} (legacy)</option>
        )}
        {SLACK_CHANNELS.map((c) => (
          <option key={c.value} value={c.value}>
            {c.label}
          </option>
        ))}
      </select>

      <div className="flex justify-end gap-2">
        <button
          onClick={onCancel}
          className="rounded-lg bg-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-600"
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium hover:bg-blue-500"
        >
          Save
        </button>
      </div>
    </div>
  );
}

/* ── calendar event block ── */

function EventBlock({
  event,
  onClick,
  compact,
}: {
  event: CalendarEvent;
  onClick: () => void;
  compact?: boolean;
}) {
  const colors = getWorkspaceColor(event.agent?.workspace);
  const h = event.hour;
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  const timeStr = `${h12}:${event.minute.toString().padStart(2, "0")} ${ampm}`;

  return (
    <button
      onClick={onClick}
      className={`w-full rounded-lg border ${colors.border} ${colors.bg} px-2 py-1.5 text-left transition-all hover:brightness-125 ${compact ? "text-[10px]" : "text-xs"}`}
    >
      <div className={`font-medium capitalize ${colors.text} truncate`}>
        {event.agent?.short_name || event.schedule.agent_id}
      </div>
      {!compact && event.agent?.workspace && (
        <span className={`${colors.text} opacity-70`}>
          {event.agent.workspace}
        </span>
      )}
      <div className="text-zinc-500">{timeStr}</div>
    </button>
  );
}

/* ── current time line ── */

function useCurrentTime() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(interval);
  }, []);
  return now;
}

/* ── day view ── */

function DayView({
  date,
  events,
  onDateChange,
  onEventClick,
}: {
  date: Date;
  events: CalendarEvent[];
  onDateChange: (d: Date) => void;
  onEventClick: (scheduleId: string) => void;
}) {
  const now = useCurrentTime();
  const today = new Date();
  const isToday = isSameDay(date, today);

  const dayEvents = events.filter((e) => isSameDay(e.date, date));

  function prevDay() {
    const d = new Date(date);
    d.setDate(d.getDate() - 1);
    onDateChange(d);
  }
  function nextDay() {
    const d = new Date(date);
    d.setDate(d.getDate() + 1);
    onDateChange(d);
  }
  function goToday() {
    onDateChange(new Date());
  }

  const nowHour = now.getHours();
  const nowMinute = now.getMinutes();
  const nowTop = (nowHour - HOUR_START) * HOUR_HEIGHT + (nowMinute / 60) * HOUR_HEIGHT;
  const showNowLine = isToday && nowHour >= HOUR_START && nowHour <= HOUR_END;

  return (
    <div>
      {/* Navigation */}
      <div className="mb-4 flex items-center gap-3">
        <button onClick={prevDay} className="rounded-lg bg-zinc-800 px-2.5 py-1.5 text-sm text-zinc-400 hover:bg-zinc-700 hover:text-white">
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" /></svg>
        </button>
        <button onClick={goToday} className="rounded-lg bg-zinc-800 px-3 py-1.5 text-sm font-medium text-zinc-300 hover:bg-zinc-700">
          Today
        </button>
        <button onClick={nextDay} className="rounded-lg bg-zinc-800 px-2.5 py-1.5 text-sm text-zinc-400 hover:bg-zinc-700 hover:text-white">
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
        </button>
        <h2 className="text-lg font-semibold text-zinc-200">{formatDateFull(date)}</h2>
      </div>

      {/* Timeline */}
      <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900">
        <div className="relative" style={{ height: (HOUR_END - HOUR_START + 1) * HOUR_HEIGHT }}>
          {/* Hour rows */}
          {Array.from({ length: HOUR_END - HOUR_START + 1 }, (_, i) => {
            const hour = HOUR_START + i;
            return (
              <div key={hour} className="absolute left-0 right-0 border-t border-zinc-800/50" style={{ top: i * HOUR_HEIGHT }}>
                <span className="absolute -top-2.5 left-2 text-[11px] text-zinc-600 tabular-nums">
                  {formatHour(hour)}
                </span>
              </div>
            );
          })}

          {/* Events */}
          <div className="absolute left-16 right-2 top-0 bottom-0">
            {dayEvents.map((event, idx) => {
              if (event.hour < HOUR_START || event.hour > HOUR_END) return null;
              const top = (event.hour - HOUR_START) * HOUR_HEIGHT + (event.minute / 60) * HOUR_HEIGHT;
              // Check for overlapping events at same time
              const sameTimeCount = dayEvents.filter((e) => e.hour === event.hour && e.minute === event.minute).length;
              const sameTimeIdx = dayEvents.filter((e, j) => j < idx && e.hour === event.hour && e.minute === event.minute).length;
              const width = sameTimeCount > 1 ? `calc(${100 / sameTimeCount}% - 4px)` : "calc(100% - 4px)";
              const left = sameTimeCount > 1 ? `calc(${(sameTimeIdx * 100) / sameTimeCount}%)` : "0";

              return (
                <div
                  key={`${event.schedule.id}-${idx}`}
                  className="absolute"
                  style={{ top, left, width, minHeight: 44 }}
                >
                  <EventBlock event={event} onClick={() => onEventClick(event.schedule.id)} />
                </div>
              );
            })}
          </div>

          {/* Current time line */}
          {showNowLine && (
            <div className="absolute left-0 right-0 z-10 pointer-events-none" style={{ top: nowTop }}>
              <div className="flex items-center">
                <div className="h-2.5 w-2.5 rounded-full bg-red-500" />
                <div className="h-[2px] flex-1 bg-red-500/80" />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Events outside visible range */}
      {dayEvents.filter((e) => e.hour < HOUR_START || e.hour > HOUR_END).length > 0 && (
        <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-900 p-3">
          <p className="mb-2 text-xs font-medium text-zinc-500">Outside visible hours</p>
          <div className="space-y-1">
            {dayEvents
              .filter((e) => e.hour < HOUR_START || e.hour > HOUR_END)
              .map((event, idx) => (
                <EventBlock key={`off-${event.schedule.id}-${idx}`} event={event} onClick={() => onEventClick(event.schedule.id)} />
              ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── week view ── */

function WeekView({
  weekStart,
  events,
  onWeekChange,
  onEventClick,
}: {
  weekStart: Date;
  events: CalendarEvent[];
  onWeekChange: (d: Date) => void;
  onEventClick: (scheduleId: string) => void;
}) {
  const now = useCurrentTime();
  const today = new Date();
  const weekDays = getWeekDays(weekStart);

  function prevWeek() {
    const d = new Date(weekStart);
    d.setDate(d.getDate() - 7);
    onWeekChange(d);
  }
  function nextWeek() {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + 7);
    onWeekChange(d);
  }
  function goThisWeek() {
    onWeekChange(getWeekStart(new Date()));
  }

  const nowHour = now.getHours();
  const nowMinute = now.getMinutes();
  const nowTop = (nowHour - HOUR_START) * HOUR_HEIGHT + (nowMinute / 60) * HOUR_HEIGHT;
  const showNowLine = nowHour >= HOUR_START && nowHour <= HOUR_END;
  const todayColIdx = weekDays.findIndex((d) => isSameDay(d, today));

  // Group events by day
  const eventsByDay: CalendarEvent[][] = weekDays.map((day) =>
    events.filter((e) => isSameDay(e.date, day))
  );

  const weekEndDate = weekDays[6];
  const headerLabel = `${formatDateShort(weekStart)} - ${formatDateShort(weekEndDate)}`;

  return (
    <div>
      {/* Navigation */}
      <div className="mb-4 flex items-center gap-3">
        <button onClick={prevWeek} className="rounded-lg bg-zinc-800 px-2.5 py-1.5 text-sm text-zinc-400 hover:bg-zinc-700 hover:text-white">
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" /></svg>
        </button>
        <button onClick={goThisWeek} className="rounded-lg bg-zinc-800 px-3 py-1.5 text-sm font-medium text-zinc-300 hover:bg-zinc-700">
          This Week
        </button>
        <button onClick={nextWeek} className="rounded-lg bg-zinc-800 px-2.5 py-1.5 text-sm text-zinc-400 hover:bg-zinc-700 hover:text-white">
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
        </button>
        <h2 className="text-lg font-semibold text-zinc-200">{headerLabel}</h2>
      </div>

      {/* Week grid */}
      <div className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-900">
        {/* Day headers */}
        <div className="sticky top-0 z-10 flex border-b border-zinc-800 bg-zinc-900">
          <div className="w-16 shrink-0" />
          {weekDays.map((day, i) => {
            const isCurrentDay = isSameDay(day, today);
            return (
              <div
                key={i}
                className={`flex-1 border-l border-zinc-800/50 px-2 py-2 text-center ${isCurrentDay ? "bg-blue-500/5" : ""}`}
                style={{ minWidth: 100 }}
              >
                <div className={`text-xs font-medium ${isCurrentDay ? "text-blue-400" : "text-zinc-500"}`}>
                  {formatDayHeader(day)}
                </div>
                <div className={`text-sm font-semibold ${isCurrentDay ? "text-blue-300" : "text-zinc-300"}`}>
                  {day.getDate()}
                </div>
              </div>
            );
          })}
        </div>

        {/* Time grid */}
        <div className="relative flex" style={{ height: (HOUR_END - HOUR_START + 1) * HOUR_HEIGHT }}>
          {/* Hour labels */}
          <div className="relative w-16 shrink-0">
            {Array.from({ length: HOUR_END - HOUR_START + 1 }, (_, i) => {
              const hour = HOUR_START + i;
              return (
                <div key={hour} className="absolute left-0 right-0" style={{ top: i * HOUR_HEIGHT }}>
                  <span className="absolute right-2 -top-2.5 text-[11px] text-zinc-600 tabular-nums">
                    {formatHour(hour)}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Day columns */}
          {weekDays.map((day, colIdx) => {
            const isCurrentDay = isSameDay(day, today);
            const colEvents = eventsByDay[colIdx];
            return (
              <div
                key={colIdx}
                className={`relative flex-1 border-l border-zinc-800/50 ${isCurrentDay ? "bg-blue-500/5" : ""}`}
                style={{ minWidth: 100 }}
              >
                {/* Hour lines */}
                {Array.from({ length: HOUR_END - HOUR_START + 1 }, (_, i) => (
                  <div key={i} className="absolute left-0 right-0 border-t border-zinc-800/50" style={{ top: i * HOUR_HEIGHT }} />
                ))}

                {/* Events */}
                {colEvents.map((event, idx) => {
                  if (event.hour < HOUR_START || event.hour > HOUR_END) return null;
                  const top = (event.hour - HOUR_START) * HOUR_HEIGHT + (event.minute / 60) * HOUR_HEIGHT;
                  return (
                    <div
                      key={`${event.schedule.id}-${idx}`}
                      className="absolute left-1 right-1"
                      style={{ top, minHeight: 36 }}
                    >
                      <EventBlock event={event} onClick={() => onEventClick(event.schedule.id)} compact />
                    </div>
                  );
                })}
              </div>
            );
          })}

          {/* Current time line */}
          {showNowLine && todayColIdx >= 0 && (
            <div className="absolute left-0 right-0 z-10 pointer-events-none" style={{ top: nowTop }}>
              <div className="flex items-center">
                <div className="w-16 shrink-0" />
                <div className="flex flex-1">
                  {weekDays.map((_, i) => (
                    <div key={i} className="flex-1" style={{ minWidth: 100 }}>
                      {i === todayColIdx && (
                        <div className="flex items-center">
                          <div className="h-2.5 w-2.5 -ml-[5px] rounded-full bg-red-500" />
                          <div className="h-[2px] flex-1 bg-red-500/80" />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── main page ── */

export default function Schedules() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [wsFilter, setWsFilter] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [weekStart, setWeekStart] = useState(getWeekStart(new Date()));
  const [syncing, setSyncing] = useState(false);
  const [syncToast, setSyncToast] = useState<string | null>(null);

  // Schedule builder state
  const [hour, setHour] = useState(9);
  const [minute, setMinute] = useState(0);
  const [ampm, setAmpm] = useState<"AM" | "PM">("AM");
  const [repeat, setRepeat] = useState("weekdays");
  const [selectedDays, setSelectedDays] = useState<number[]>([1]);
  const [selectedAgent, setSelectedAgent] = useState("");
  const [prompt, setPrompt] = useState("");
  const [slackChannel, setSlackChannel] = useState(SLACK_CHANNELS[1].value);
  const [timezone, setTimezone] = useState("");

  useEffect(() => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    setTimezone(tz);
    fetchAgents();
    fetchSchedules();
  }, []);

  // Auto-dismiss sync toast
  useEffect(() => {
    if (syncToast) {
      const timer = setTimeout(() => setSyncToast(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [syncToast]);

  async function fetchAgents() {
    try {
      const res = await fetch("/api/agents");
      const data = await res.json();
      setAgents(data || []);
      // Prefer ?agent=<name> from the URL (set by the per-agent Schedule button
      // on the home page); fall back to first agent. Reading window directly
      // avoids the Next.js useSearchParams + Suspense prerender requirement.
      if (data?.length && !selectedAgent) {
        const requested =
          typeof window !== "undefined"
            ? new URLSearchParams(window.location.search).get("agent")
            : null;
        const initial =
          (requested && data.find((a: AgentInfo) => a.name === requested)) ||
          data[0];
        setSelectedAgent(initial.name);
        setPrompt(getDefaultPrompt(initial));
      }
    } catch {
      /* api not running */
    }
  }

  async function fetchSchedules() {
    try {
      const res = await fetch("/api/schedules");
      const data = await res.json();
      setSchedules(data || []);
    } catch {
      /* api not running */
    }
  }

  function toggleDay(day: number) {
    setSelectedDays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]
    );
  }

  async function createSchedule(e: React.FormEvent) {
    e.preventDefault();
    if (prompt.trim().length < 20) {
      alert("Prompt is too short. The agent needs detailed instructions to know what to do.");
      return;
    }
    const h24 =
      ampm === "PM" ? (hour === 12 ? 12 : hour + 12) : hour === 12 ? 0 : hour;
    const cron = buildCron(h24, minute, repeat, selectedDays);
    try {
      await fetch("/api/schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: selectedAgent,
          cron,
          prompt,
          slack_channel: slackChannel,
          timezone,
        }),
      });
      setShowForm(false);
      fetchSchedules();
    } catch {
      alert("Failed to create schedule");
    }
  }

  async function updateSchedule(id: string, updates: Partial<Schedule>) {
    try {
      await fetch(`/api/schedules/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      setEditingId(null);
      fetchSchedules();
    } catch {
      alert("Failed to update schedule");
    }
  }

  async function deleteSchedule(id: string) {
    try {
      await fetch(`/api/schedules/${id}`, { method: "DELETE" });
      fetchSchedules();
    } catch {
      alert("Failed to delete schedule");
    }
  }

  async function syncToGoogleCalendar() {
    setSyncing(true);
    try {
      const res = await fetch("/api/schedules/sync-calendar", { method: "POST" });
      if (res.ok) {
        setSyncToast("Synced to Google Calendar");
      } else {
        setSyncToast("Sync failed -- check server logs");
      }
    } catch {
      setSyncToast("Sync failed -- could not reach server");
    } finally {
      setSyncing(false);
    }
  }

  // Group agents for the selector. "personal" is rendered by the fixed Personal
  // button at the top of the dropdown — also covers any agent whose name is
  // prefixed `personal-` — so drop it from the per-workspace list to avoid a
  // duplicate entry.
  const { workspaces, standalone } = groupAgentsByWorkspace(agents);
  const workspaceNames = workspaces.map((w) => w.name).filter((n) => n !== "personal");

  // Filter schedules by workspace
  const filteredSchedules = schedules.filter((s) => {
    if (wsFilter === null) return true;
    if (wsFilter === "personal") {
      const agent = agents.find((a) => a.name === s.agent_id);
      return !agent?.workspace || agent.workspace === "personal";
    }
    const agent = agents.find((a) => a.name === s.agent_id);
    return agent?.workspace === wsFilter;
  });

  // Filter agents for selector based on workspace filter. "personal" includes
  // both unprefixed agents and those explicitly named `personal-*`.
  // Helper sub-agents (entry_point: false) are hidden — they're called by
  // other agents, not scheduled directly.
  const isSchedulable = (a: AgentInfo) => a.entry_point !== false;
  const selectableAgents = (
    wsFilter === null
      ? agents
      : wsFilter === "personal"
        ? [...standalone, ...agents.filter((a) => a.workspace === "personal")]
        : agents.filter((a) => a.workspace === wsFilter)
  ).filter(isSchedulable);

  // Calendar events for day/week views
  const calendarEvents = useMemo(() => {
    if (viewMode === "day") {
      return getEventsForDateRange(filteredSchedules, agents, selectedDate, selectedDate);
    }
    if (viewMode === "week") {
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekEnd.getDate() + 6);
      return getEventsForDateRange(filteredSchedules, agents, weekStart, weekEnd);
    }
    return [];
  }, [viewMode, filteredSchedules, agents, selectedDate, weekStart]);

  const handleEventClick = useCallback((scheduleId: string) => {
    setEditingId(scheduleId);
    setViewMode("list");
  }, []);

  return (
    <div className="noise-bg relative min-h-screen bg-[var(--surface-0)] text-white">
      {/* Ambient gradient orbs */}
      <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
        <div className="absolute -right-40 top-0 h-[600px] w-[600px] rounded-full bg-indigo-600/[0.03] blur-[120px]" />
        <div className="absolute -left-40 bottom-0 h-[500px] w-[500px] rounded-full bg-violet-600/[0.03] blur-[120px]" />
      </div>

      {/* Sticky header */}
      <header className="sticky top-0 z-20 border-b border-[var(--border)] bg-[var(--surface-0)]/80 px-6 py-3 backdrop-blur-2xl">
        <div className="mx-auto flex max-w-5xl items-center justify-between">
          <div className="flex items-center gap-5">
            <Link href="/" className="rounded-lg p-1.5 text-zinc-500 transition-colors hover:bg-white/5 hover:text-white">
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
            </Link>
            <div className="flex items-center gap-2.5">
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600">
                <svg className="h-3.5 w-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <h1 className="text-lg font-semibold tracking-tight">Schedules</h1>
            </div>
            <WorkspaceFilter
              workspaces={workspaceNames}
              active={wsFilter}
              onChange={setWsFilter}
            />
            {timezone && (
              <span className="hidden text-xs text-zinc-600 sm:inline">{shortTz(timezone)}</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <ViewSwitcher view={viewMode} onChange={setViewMode} />
            <button
              onClick={syncToGoogleCalendar}
              disabled={syncing}
              title="Sync to Google Calendar"
              className="flex h-9 items-center gap-1.5 rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 text-[13px] font-medium text-zinc-400 transition-all hover:border-white/[0.1] hover:bg-white/[0.05] hover:text-white disabled:opacity-50"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" />
              </svg>
              <span className="hidden sm:inline">{syncing ? "Syncing..." : "Sync"}</span>
            </button>
            <button
              onClick={() => setShowForm(!showForm)}
              className="flex h-9 items-center gap-1.5 rounded-lg bg-gradient-to-r from-indigo-600 to-violet-600 px-3.5 text-[13px] font-medium shadow-lg shadow-indigo-600/10 transition-all hover:shadow-indigo-600/20"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
              <span className="hidden sm:inline">New</span>
            </button>
          </div>
        </div>
      </header>

      <main className="relative z-10 mx-auto w-full max-w-5xl px-6 py-6">
        {/* Sync toast */}
        {syncToast && (
          <div className="glass-card mb-4 flex items-center gap-2 rounded-lg border-green-500/10 px-4 py-2.5 text-sm">
            <svg className="h-4 w-4 shrink-0 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
            <span className="text-green-300">{syncToast}</span>
          </div>
        )}

        {showForm && (
          <form
            onSubmit={createSchedule}
            className="glass-card mb-8 rounded-xl p-6"
          >
            {/* Agent selector -- grouped by workspace */}
            <div className="mb-5">
              <label className="mb-1.5 block text-sm font-medium text-zinc-300">
                Agent
              </label>

              {/* Workspace tabs if multiple workspaces exist */}
              {workspaces.length > 0 && (
                <div className="mb-3 space-y-3">
                  {standalone.length > 0 && (
                    <div>
                      <p className="mb-1.5 text-[11px] font-medium uppercase tracking-widest text-zinc-600">
                        Personal
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {standalone.map((agent) => (
                          <button
                            key={agent.name}
                            type="button"
                            onClick={() => {
                              setSelectedAgent(agent.name);
                              setPrompt(getDefaultPrompt(agent));
                            }}
                            className={`rounded-lg border px-3 py-2 text-sm font-medium capitalize transition-all ${
                              selectedAgent === agent.name
                                ? "border-blue-500 bg-blue-500/20 text-blue-400"
                                : "border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-zinc-600"
                            }`}
                          >
                            {agent.short_name || agent.name}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {workspaces.map((ws) => (
                    <div key={ws.name}>
                      <p className="mb-1.5 text-[11px] font-medium uppercase tracking-widest text-zinc-600">
                        <span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-violet-500" />
                        {ws.name}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {ws.agents.map((agent) => (
                          <button
                            key={agent.name}
                            type="button"
                            onClick={() => {
                              setSelectedAgent(agent.name);
                              setPrompt(getDefaultPrompt(agent));
                            }}
                            className={`rounded-lg border px-3 py-2 text-sm font-medium capitalize transition-all ${
                              selectedAgent === agent.name
                                ? "border-violet-500 bg-violet-500/20 text-violet-400"
                                : "border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-zinc-600"
                            }`}
                          >
                            {agent.short_name || agent.name}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Fallback: flat list if no workspaces */}
              {workspaces.length === 0 && agents.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {agents.map((agent) => (
                    <button
                      key={agent.name}
                      type="button"
                      onClick={() => {
                        setSelectedAgent(agent.name);
                        setPrompt(getDefaultPrompt(agent));
                      }}
                      className={`rounded-lg border px-3 py-2 text-sm font-medium capitalize transition-all ${
                        selectedAgent === agent.name
                          ? "border-blue-500 bg-blue-500/20 text-blue-400"
                          : "border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-zinc-600"
                      }`}
                    >
                      {agent.short_name || agent.name}
                    </button>
                  ))}
                </div>
              )}

              {/* Selected agent description */}
              {selectedAgent && (
                <p className="mt-2 text-xs text-zinc-500">
                  {agents.find((a) => a.name === selectedAgent)?.description}
                </p>
              )}
            </div>

            {/* Time Picker */}
            <div className="mb-5">
              <label className="mb-1.5 block text-sm font-medium text-zinc-300">
                Time
              </label>
              <div className="flex items-center gap-2">
                <select
                  value={hour}
                  onChange={(e) => setHour(parseInt(e.target.value))}
                  className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2.5 text-center text-lg tabular-nums"
                >
                  {Array.from({ length: 12 }, (_, i) => i + 1).map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                </select>
                <span className="text-xl text-zinc-500">:</span>
                <select
                  value={minute}
                  onChange={(e) => setMinute(parseInt(e.target.value))}
                  className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2.5 text-center text-lg tabular-nums"
                >
                  {Array.from({ length: 60 }, (_, i) => i).map((m) => (
                    <option key={m} value={m}>
                      {m.toString().padStart(2, "0")}
                    </option>
                  ))}
                </select>
                <div className="flex overflow-hidden rounded-lg border border-zinc-700">
                  {(["AM", "PM"] as const).map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setAmpm(p)}
                      className={`px-3 py-2.5 text-sm font-medium transition-all ${
                        ampm === p
                          ? "bg-blue-600 text-white"
                          : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"
                      }`}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Timezone */}
            <div className="mb-5">
              <label className="mb-1.5 block text-sm font-medium text-zinc-300">
                Timezone
              </label>
              <select
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2.5 text-sm"
              >
                {/* Current timezone first if not in common list */}
                {timezone &&
                  !COMMON_TIMEZONES.includes(timezone) && (
                    <option value={timezone}>{timezone} (local)</option>
                  )}
                {COMMON_TIMEZONES.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz === timezone ? `${tz} (local)` : tz}
                  </option>
                ))}
              </select>
            </div>

            {/* Repeat */}
            <div className="mb-5">
              <label className="mb-1.5 block text-sm font-medium text-zinc-300">
                Repeat
              </label>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {REPEAT_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setRepeat(opt.value)}
                    className={`rounded-lg border px-3 py-2 text-sm transition-all ${
                      repeat === opt.value
                        ? "border-blue-500 bg-blue-500/20 text-blue-400"
                        : "border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-zinc-600"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Day Picker (specific days) */}
            {repeat === "specific" && (
              <div className="mb-5">
                <label className="mb-1.5 block text-sm font-medium text-zinc-300">
                  Days
                </label>
                <div className="flex gap-1.5">
                  {DAYS.map((day) => (
                    <button
                      key={day.value}
                      type="button"
                      onClick={() => toggleDay(day.value)}
                      className={`flex h-10 w-10 items-center justify-center rounded-full text-xs font-medium transition-all ${
                        selectedDays.includes(day.value)
                          ? "bg-blue-600 text-white"
                          : "bg-zinc-800 text-zinc-500 hover:bg-zinc-700"
                      }`}
                    >
                      {day.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Prompt */}
            <div className="mb-5">
              <label className="mb-1.5 block text-sm font-medium text-zinc-300">
                Prompt <span className="text-red-400">*</span>
              </label>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="What should the agent do on each run?"
                required
                rows={4}
                className={`w-full rounded-lg border bg-zinc-800 px-3 py-2.5 text-sm ${
                  prompt.trim().length < 20
                    ? "border-amber-600/50"
                    : "border-zinc-700"
                }`}
              />
              {prompt.trim().length < 20 && (
                <p className="mt-1 text-xs text-amber-500">
                  Prompt should be detailed enough for the agent to know exactly what to do. Use the default or write specific instructions.
                </p>
              )}
            </div>

            {/* Slack Channel */}
            <div className="mb-5">
              <label className="mb-1.5 block text-sm font-medium text-zinc-300">
                Slack Channel
              </label>
              <select
                value={slackChannel}
                onChange={(e) => setSlackChannel(e.target.value)}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2.5 text-sm"
              >
                {SLACK_CHANNELS.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Preview + Actions */}
            <div className="flex items-center justify-between rounded-lg bg-zinc-800/50 px-4 py-3">
              <div>
                <p className="text-sm text-zinc-400">
                  <span className="font-medium capitalize text-zinc-300">
                    {agents.find((a) => a.name === selectedAgent)?.short_name ||
                      selectedAgent}
                  </span>
                  {" -- "}
                  {cronToHuman(
                    buildCron(
                      ampm === "PM"
                        ? hour === 12
                          ? 12
                          : hour + 12
                        : hour === 12
                          ? 0
                          : hour,
                      minute,
                      repeat,
                      selectedDays
                    )
                  )}
                </p>
                <p className="mt-0.5 text-xs text-zinc-600">
                  {shortTz(timezone)}
                  {slackChannel && ` \u00B7 ${slackChannel}`}
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setShowForm(false)}
                  className="rounded-lg bg-zinc-700 px-4 py-2 text-sm hover:bg-zinc-600"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium hover:bg-blue-500"
                >
                  Create
                </button>
              </div>
            </div>
          </form>
        )}

        {/* View: List */}
        {viewMode === "list" && (
          <div className="space-y-3">
            {filteredSchedules.length === 0 && (
              <p className="py-12 text-center text-zinc-600">
                {schedules.length === 0
                  ? "No scheduled agents yet. Create one to get started."
                  : "No schedules in this workspace."}
              </p>
            )}
            {filteredSchedules.map((sched) => {
              const agent = agents.find((a) => a.name === sched.agent_id);
              if (editingId === sched.id) {
                return <ScheduleEditor key={sched.id} schedule={sched} agents={agents} workspaces={workspaces} standalone={standalone} onSave={(updates) => updateSchedule(sched.id, updates)} onCancel={() => setEditingId(null)} onDelete={() => deleteSchedule(sched.id)} />;
              }
              return (
                <div
                  key={sched.id}
                  className="glass-card-hover flex items-center justify-between rounded-xl p-4"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      {agent?.workspace && (
                        <span className="rounded bg-violet-900/50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-violet-400">
                          {agent.workspace}
                        </span>
                      )}
                      <span className="font-medium capitalize">
                        {agent?.short_name || sched.agent_id}
                      </span>
                      <span
                        className={`rounded px-2 py-0.5 text-xs ${
                          sched.status === "active"
                            ? "bg-green-900 text-green-300"
                            : "bg-zinc-800 text-zinc-500"
                        }`}
                      >
                        {sched.status}
                      </span>
                    </div>
                    <p className="mt-1 truncate text-sm text-zinc-400">
                      {sched.prompt}
                    </p>
                    <p className="mt-1 text-xs text-zinc-500">
                      {cronToHuman(sched.cron)}
                      {sched.timezone && ` \u00B7 ${shortTz(sched.timezone)}`}
                      {sched.slack_channel && ` \u00B7 ${sched.slack_channel}`}
                    </p>
                  </div>
                  <div className="ml-3 flex shrink-0 gap-2">
                    <button
                      onClick={() => setEditingId(sched.id)}
                      className="rounded-lg bg-zinc-800 px-3 py-1.5 text-sm text-zinc-400 hover:bg-zinc-700 hover:text-white"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => deleteSchedule(sched.id)}
                      className="rounded-lg bg-zinc-800 px-3 py-1.5 text-sm text-red-400 hover:bg-zinc-700"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* View: Day */}
        {viewMode === "day" && (
          <DayView
            date={selectedDate}
            events={calendarEvents}
            onDateChange={setSelectedDate}
            onEventClick={handleEventClick}
          />
        )}

        {/* View: Week */}
        {viewMode === "week" && (
          <WeekView
            weekStart={weekStart}
            events={calendarEvents}
            onWeekChange={setWeekStart}
            onEventClick={handleEventClick}
          />
        )}
      </main>
    </div>
  );
}

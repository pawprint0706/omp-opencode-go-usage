// OpenCode Go plan usage (rolling 5h / weekly / monthly) in the omp status line.
//
// Usage comes from `GET https://opencode.ai/zen/go/v1/usage`, authenticated with
// the credential omp already stores for the `opencode-go` provider (api_key)
// — the same endpoint omp itself consumes (pi-ai usage/opencode-go.ts):
//
//   { usage: { rolling:
//                { percent, status, resetsAt },   // percent: used 0-100
//              weekly:    { ... },
//              monthly:   { ... } } }             // status: "ok" | "rate-limited"
//
// Display: `OC 5h 37% | Wk 12% | Mo 5%` — used percent per window. Windows are
// joined with `|` on purpose: the status line concatenates several extensions'
// hook statuses with ` · `, so an intra-window `|` keeps this meter readable as
// one group next to others (e.g. `… | Mo 0% · OR $4.89`).
// (`!` = window rate-limited: blocked even below 100%;
//  `?` = last refresh failed: last confirmed numbers, may be stale).
//
// Refresh runs at session start, after every turn, and every 90s.

const STATUS_KEY = "opencode-go";
const USAGE_BASE = "https://opencode.ai/zen/go";
const USAGE_PATH = "/v1/usage";
const REFRESH_MS = 90_000;
const FETCH_TIMEOUT_MS = 10_000;

// Tags follow common Western abbreviations: `5h` names the rolling window by
// its duration (as omp/OpenCode does: limit id `rolling-5h`), `Wk`/`Mo` are
// standard 2-letter forms of week/month (skipping letter `W`, which reads as
// watts, and letter `M`, which reads as meters/minutes).
const WINDOWS = [
  { key: "rolling", tag: "5h" },
  { key: "weekly", tag: "Wk" },
  { key: "monthly", tag: "Mo" },
] as const;

interface UsageStatusCtx {
  agent?: { kind?: string };
  ui: { setStatus(key: string, text: string): void; notify?(message: string, type?: string): void };
  modelRegistry?: {
    getApiKeyForProvider?(provider: string, sessionId?: string): Promise<string | undefined>;
  };
  sessionManager?: { getSessionId?(): string };
  setInterval(fn: () => void, ms: number): unknown;
}

interface Logger {
  debug?(message: string): void;
}

interface Reading {
  tag: string;
  percent: number;
  exhausted: boolean;
}

// Why: the factory module is shared by every session in the process, so the
// last confirmed readings survive a transient failure instead of blanking the
// status line.
let lastReadings: Reading[] | null = null;
let inflight: Promise<void> | null = null;
let warnedFailure = false;
// Opaque value for the `x-opencode-session` header omp itself sends.
let sessionTag: string | undefined;

function setStatus(ctx: UsageStatusCtx, rows: Reading[], stale: boolean): void {
  // `OC 5h 37% | Wk 12% | Mo 5%`; stale appends `?` to every window.
  const staleMark = stale ? "?" : "";
  const text = rows
    .map((r) => `${r.tag} ${r.percent}%${r.exhausted ? "!" : ""}${staleMark}`)
    .join(" | ");
  try {
    ctx.ui.setStatus(STATUS_KEY, text ? `OC ${text}` : text);
  } catch {
    // Why: a no-op/UI-less context must never break the turn.
  }
}

async function resolveKey(ctx: UsageStatusCtx): Promise<string | undefined> {
  try {
    const key = await ctx.modelRegistry?.getApiKeyForProvider?.(
      "opencode-go",
      ctx.sessionManager?.getSessionId?.(),
    );
    if (typeof key === "string" && key.length > 0) return key;
  } catch {
    // Fall through to the environment variable.
  }
  const env = typeof process !== "undefined" ? process.env.OPENCODE_API_KEY : undefined;
  return typeof env === "string" && env.length > 0 ? env : undefined;
}

// Why: mirror omp's own validation — each window needs a finite percent in
// 0..100, a known status, and a parseable resetsAt; one bad window fails the
// whole report rather than showing a partial meter.
function readUsage(payload: unknown): Reading[] | null {
  if (!payload || typeof payload !== "object") return null;
  const usage: unknown = (payload as Record<string, unknown>).usage;
  if (!usage || typeof usage !== "object") return null;
  const usageRec = usage as Record<string, unknown>;
  const rows: Reading[] = [];
  for (const w of WINDOWS) {
    const window: unknown = usageRec[w.key];
    if (!window || typeof window !== "object") return null;
    const windowRec = window as Record<string, unknown>;
    const percent = windowRec.percent;
    const status = windowRec.status;
    if (
      typeof percent !== "number" ||
      !Number.isFinite(percent) ||
      percent < 0 ||
      percent > 100
    ) {
      return null;
    }
    if (status !== "ok" && status !== "rate-limited") return null;
    const resetsAt =
      typeof windowRec.resetsAt === "string" ? Date.parse(windowRec.resetsAt) : Number.NaN;
    if (!Number.isFinite(resetsAt)) return null;
    rows.push({ tag: w.tag, percent, exhausted: status === "rate-limited" });
  }
  return rows;
}

function refresh(ctx: UsageStatusCtx, logger: Logger | undefined): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const key = await resolveKey(ctx);
      if (!key) {
        setStatus(ctx, []);
        return;
      }
      if (!sessionTag) {
        sessionTag = `omu-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
      }
      const response = await fetch(`${USAGE_BASE}${USAGE_PATH}`, {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${key}`,
          "x-opencode-session": sessionTag,
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`usage endpoint returned ${response.status} ${response.statusText}`.trim());
      }
      const payload: unknown = await response.json();
      const rows = readUsage(payload);
      if (!rows) {
        throw new Error(`unexpected payload: ${JSON.stringify(payload).slice(0, 200)}`);
      }
      lastReadings = rows;
      warnedFailure = false;
      setStatus(ctx, rows, false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger?.debug?.(`opencode-go-usage: ${message}`);
      if (lastReadings) {
        setStatus(ctx, lastReadings, true);
      } else {
        setStatus(ctx, []);
        // Why: a stored-but-unusable key is worth one notice; a missing key is
        // the normal case for non-OpenCode-Go users and stays silent.
        if (!warnedFailure) {
          const key = await resolveKey(ctx);
          if (key) {
            warnedFailure = true;
            try {
              ctx.ui.notify?.(`OpenCode Go usage unavailable: ${message}`, "warning");
            } catch {
              // Ignore UI failures.
            }
          }
        }
      }
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export default function opencodeGoUsage(pi: {
  on(event: string, handler: (event: unknown, ctx: UsageStatusCtx) => unknown): void;
  logger?: Logger;
}): void {
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.agent?.kind && ctx.agent.kind !== "main") return;
    await refresh(ctx, pi.logger);
    // Why: managed timer; a throw is contained and it is cleared on
    // session_shutdown.
    ctx.setInterval(() => {
      void refresh(ctx, pi.logger);
    }, REFRESH_MS);
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (ctx.agent?.kind && ctx.agent.kind !== "main") return;
    void refresh(ctx, pi.logger);
  });
}

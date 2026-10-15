# omp-opencode-go-usage

Shows OpenCode Go plan usage at the end of the omp status line:

```
 π · ◒ DeepSeek V4.1 Flash · 📁 ~/dev/app · ◫ 12.1%/1M ⟲ · $0.08 · 5h 37% | Wk 12% | Mo 5%
```

Each window shows `tag used%`, joined with `|`:

| Tag | Window | Meaning |
| --- | --- | --- |
| `5h` | rolling 5-hour window (`rolling-5h`) | used % of the current 5h cycle |
| `Wk` | weekly window | used % of the current week |
| `Mo` | monthly window | used % of the current month |

Windows use `|` rather than `·` so the three readings stay one visual group: the
status line separates *different extensions'* hook statuses with ` · `, so the
meter next to another plugin reads unambiguously, e.g.

```
… · 5h 1% | Wk 0% | Mo 0% · OR $4.89
```

Data source: `GET https://opencode.ai/zen/go/v1/usage` with the credential omp
already stores for the `opencode-go` provider — the same endpoint and response
shape (`usage.{rolling,weekly,monthly}.percent`) omp itself consumes. `percent`
is **used** percent, so the numbers rise as you spend and fall when a window
resets.

Markers:

| Suffix | Meaning |
| --- | --- |
| `!` | that window reports `rate-limited` (blocked even below 100%) |
| `?` | the last refresh failed; numbers are the last confirmed reading |

Both can stack (`5h 33%!?` = that window is rate-limited *and* the last refresh
failed).

## Requirements

- omp 18.x (extension API: `ctx.ui.setStatus`, `ctx.modelRegistry`, `ctx.setInterval`).
- An OpenCode Go credential: `/login opencode-go` in omp, or `OPENCODE_API_KEY`
  in the environment. Without one, the segment stays hidden and no requests are
  made.

## Install

From GitHub:

```
omp plugin install github:pawprint0706/omp-opencode-go-usage
```

From a local folder (copy or `git clone` anywhere), replacing `<path>`:

```
omp plugin install "<path>/omp-opencode-go-usage"
omp plugin list
```

Or as a plain extension file (no plugin plumbing): copy
`extensions/opencode-go-usage.ts` into `~/.omp/agent/extensions/`, then restart
omp.

## Status line

No config change is needed if your config already uses
`statusLine.preset: custom` with `status` in `leftSegments`. Otherwise merge
[`statusline.yml`](./statusline.yml) into `~/.omp/agent/config.yml` (a named
profile uses `~/.omp/profiles/<profile>/agent/config.yml`) and restart omp —
`preset: custom` is what makes omp honor explicit segment lists, and the
existing `segmentOptions` in your config are preserved as-is when you only
append `status` to a segment list you already control.

## How it works

| Trigger | Behavior |
| --- | --- |
| `session_start` | one awaited refresh, then the timer below starts |
| `turn_end` | fire-and-forget refresh (each turn spends usage) |
| every 90 seconds | timer covers usage spent elsewhere; also picks up window resets within 90s |

- **Single-flight**: a refresh already in flight is reused.
- **Timeout** 10s (`AbortSignal.timeout`). On failure the previous numbers stay
  visible with a trailing `?`; if nothing was fetched yet, the segment is
  hidden and — only when a credential exists — one warning is shown per failure
  streak (it stays quiet again once a refresh succeeds). Failure reasons are
  logged as `opencode-go-usage: …` under `~/.omp/logs/`.
- **Main session only**: subagent/advisor sessions (`ctx.agent.kind !== "main"`)
  do not refresh.
- The response shape is validated window-by-window (percent 0–100, known
  status, parseable `resetsAt`); one malformed window fails the whole report
  instead of showing a partial meter.

## Uninstall

```
omp plugin uninstall omp-opencode-go-usage
```

## License

MIT

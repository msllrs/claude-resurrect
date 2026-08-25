# claude-resurrect

Bring back all your Claude Code sessions in Ghostty after a reboot or kernel panic — windows, splits, and resumed conversations — with one command instead of manually re-opening every pane and hunting through `/resume`.

```
claude-resurrect restore
```

## Why

Ghostty's `window-save-state` restores window/split *layout* and (with shell integration) working directories, but never running processes — and macOS state restoration is unreliable after a kernel panic anyway. Claude Code has no "resume all" either. So after a crash you're left re-entering `claude` + `/resume` in every pane.

## How it works

Claude Code maintains a live registry of every running session at `~/.claude/sessions/*.json` — session ID, cwd, interactive vs background-agent, name, status.

1. **A LaunchAgent snapshots every 30 seconds** into `~/.local/state/claude-resurrect/`:
   - the session registry, and
   - Ghostty's window → tab → pane tree (via AppleScript), with each pane matched to the Claude session running in it — by tty when Ghostty exposes it (post-1.3), else by terminal title (Claude sets titles for named sessions/agents), else by working directory.
2. Each snapshot is stamped with the boot session UUID (`kern.bootsessionuuid` — stable across sleep/wake, unlike `kern.boottime`). Sessions you close normally disappear from the registry and are pruned on the next tick — they're never resurrected. If a layout capture fails transiently (AppleScript hiccup, locked screen), the last known layout is carried forward and marked stale instead of being lost.
3. **After a reboot**, the first tick sees the boot session changed and preserves the pre-crash snapshot as `pending-restore.json` (also archived in `archive/`).
4. **`claude-resurrect restore`** rebuilds each window that held Claude sessions: recreates its panes as splits, types `claude --resume <session-id>` into the matched panes (prefixed with a title escape so each pane is named after its session, not the raw command), and opens plain shells at the right cwd in the rest. Sessions that weren't in any captured pane get their own window. Already-running sessions are skipped, so `restore` is always safe to run.

Split *arrangement* is heuristic, not pixel-exact — Ghostty's AppleScript dictionary exposes which panes share a window but no terminal geometry (verified against 1.3.1's sdef: no position/size on the terminal class). Pane count, grouping, working directories, and sessions are all faithful, and you pick the arrangement shape with `--layout grid|columns|rows` (or set it once in the config file; default `grid`).

Background agents that were running standalone are listed at the end with their resume commands rather than auto-opened — check them in agent view (`claude agents`) or rerun with `--include-bg`.

## Install

Requires macOS, [Ghostty](https://ghostty.org) 1.3+, Node ≥ 18, and Claude Code (≥ 2.1.223 for cross-directory resume).

```
git clone https://github.com/msllrs/claude-resurrect
cd claude-resurrect
npm install -g .
claude-resurrect install     # sets up the snapshotter LaunchAgent
```

No dependencies beyond Node (which Claude Code already requires).

## Usage

```
claude-resurrect install     # one-time: sets up the snapshotter LaunchAgent
claude-resurrect restore     # after a reboot: rebuild everything
claude-resurrect restore --dry-run
claude-resurrect restore --include-bg
claude-resurrect restore --layout columns   # split arrangement: grid | columns | rows
claude-resurrect list        # sessions + layout in the latest snapshot
claude-resurrect config      # show the config file path + effective settings
claude-resurrect uninstall
```

## Configuration

Optional, at `~/.config/claude-resurrect/config.json`:

```json
{
  "layout": "columns",
  "includeBg": false,
  "snapshotIntervalSeconds": 30
}
```

- **layout** — split arrangement for rebuilt windows: `grid` (default), `columns`, or `rows`. Precedence: `--layout` flag > `CLAUDE_RESURRECT_LAYOUT` env > config.
- **includeBg** — `true` reopens stray background agents on every restore, same as passing `--include-bg`.
- **snapshotIntervalSeconds** — how often the LaunchAgent snapshots (default 30). Rerun `claude-resurrect install` after changing it — the interval is baked into the plist.

A missing or malformed config file just means defaults — restore is crash recovery, so a typo in the config never blocks it. `claude-resurrect config` shows what's actually in effect.

## The background process

`install` sets up a LaunchAgent (`~/Library/LaunchAgents/com.claude-resurrect.snapshot.plist`) that runs the snapshot every 30s. It executes node through a symlink named **`claude-resurrectd`**, so that's the name you'll see in Activity Monitor / `ps` / System Settings → Login Items — not an anonymous "node".

It persists across shutdowns and reboots automatically: launchd starts it at every login (`RunAtLoad`) and re-runs it on its interval for as long as you're logged in. Each run takes ~a second; it is not a resident process between ticks.

If layout capture stops working (check `snapshot.err.log` in the state dir), grant **claude-resurrectd** Automation permission for Ghostty in System Settings → Privacy & Security → Automation. Session capture works regardless — layout is a bonus layer, and restore degrades to one-window-per-session without it.

## Behavior notes

- **Intentional reboots count as crashes.** Anything still open when the machine goes down gets offered for restore. Close sessions you're done with before shutting down (they're pruned within 30s).
- **Same-directory twins**: when several unnamed sessions share a cwd, pane assignment within that group is arbitrary (nothing distinguishes them until Ghostty ships the `tty` terminal property, already in their main branch). All of them still restore into the right window shape.
- **Tabs** are restored as separate windows for now (tab creation isn't reliably scriptable yet).
- **Automation permission**: AppleScript calls need macOS Automation approval (one prompt per binary). If AppleScript fails entirely, restore falls back to `open -na Ghostty` — sessions come back, but one window each and no splits.
- **Cross-directory resume** requires Claude Code ≥ 2.1.223. If a session's cwd no longer exists (e.g. a cleaned-up worktree), it resumes from `~` instead.
- **Transcript-less sessions are skipped.** A snapshotted session whose conversation transcript no longer exists under `~/.claude/projects/` can't be resumed, so restore drops it (and says so) instead of opening a window for `claude --resume` to fail in.
- **Pid reuse is guarded against.** A registry entry only counts as live if its pid is still running a claude process — stale registry files whose pids were reused by unrelated processes are no longer snapshotted as live.
- **Worktree agents re-home correctly.** A resumed pane starts in the *session's* recorded cwd, not the pane's shell cwd — Ghostty reports where the shell was launched, which for `claude --worktree` sessions is the repo root, not the worktree. Resuming there would duplicate the session under the wrong project.

## Fragility

Two integration points are undocumented/preview and may change:

- `~/.claude/sessions/*.json` is Claude Code internal (observed on v2.1.235). If it changes, the fallback is a `SessionStart`/`SessionEnd` hook pair maintaining our own registry — the hook payload includes `session_id` and `cwd`.
- Ghostty's AppleScript API is marked preview; breaking changes are expected in 1.4. The `open -n` fallback covers total breakage; layout capture degrades gracefully to session-only snapshots.

## Prior art

- [Supersynergy/claude-session-restore](https://github.com/Supersynergy/claude-session-restore) — multi-terminal (Ghostty included), but restores from transcript *history* with recency/keyword ranking ("10 newest + 5 leverage picks"); no snapshot of what was actually open, no layout, no interactive/background distinction.
- [Livshitz/claude-revive](https://github.com/Livshitz/claude-revive) — closest in spirit: reconstructs which sessions were live at crash time, but via heuristics (transcript-flush timestamps near boot) plus an interactive picker; macOS, mainly VSCode/Cursor, no layout restore.
- [Mahrkeenerh/ClaudeRestore](https://github.com/Mahrkeenerh/ClaudeRestore) — Linux equivalent; also verifies transcripts exist before resuming.
- [asadtariq96/cc-session-restore](https://github.com/asadtariq96/cc-session-restore) — same periodic-snapshot idea, iTerm2 only.
- [Franvy/gtab](https://github.com/Franvy/gtab) — Ghostty tab/split *layout* restore (manual named saves, Accessibility-based exact geometry), no processes/sessions.
- [ericblue/cmux-session-manager](https://github.com/ericblue/cmux-session-manager) — snapshot + layout + Claude resumption, but for cmux workspaces.
- tmux + [tmux-claude-resurrect](https://github.com/cookiecad/tmux-claude-resurrect), or [Quil](https://quil.cc/blog/resume-claude-code-session-after-reboot/) — solve it by living inside a multiplexer that survives reboots, with the terminal friction that implies.

The niche this fills: knowing exactly which sessions were *open at the moment the machine died* (a 30s ground-truth snapshot keyed to the boot session UUID, not timestamp heuristics), which window/split each one lived in, distinguishing interactive windows from background agents, and restoring natively into Ghostty. Upstream demand: [anthropics/claude-code#34829](https://github.com/anthropics/claude-code/issues/34829).

## License

MIT

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
2. Each snapshot is stamped with the machine's boot time (`kern.boottime`). Sessions you close normally disappear from the registry and are pruned on the next tick — they're never resurrected.
3. **After a reboot**, the first tick sees the boot time changed and preserves the pre-crash snapshot as `pending-restore.json` (also archived in `archive/`).
4. **`claude-resurrect restore`** rebuilds each window that held Claude sessions: recreates its panes as splits, types `claude --resume <session-id>` into the matched panes, and opens plain shells at the right cwd in the rest. Sessions that weren't in any captured pane get their own window. Already-running sessions are skipped, so `restore` is always safe to run.

Split *arrangement* is heuristic (a 2-column grid), not pixel-exact — the AppleScript API exposes which panes share a window but not their geometry. Pane count, grouping, working directories, and sessions are all faithful.

Background agents that were running standalone are listed at the end with their resume commands rather than auto-opened — check them in agent view (`claude agents`) or rerun with `--include-bg`.

## Usage

```
claude-resurrect install     # one-time: sets up the snapshotter LaunchAgent
claude-resurrect restore     # after a reboot: rebuild everything
claude-resurrect restore --dry-run
claude-resurrect restore --include-bg
claude-resurrect list        # sessions + layout in the latest snapshot
claude-resurrect uninstall
```

No dependencies beyond Node (which Claude Code already requires).

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

## Fragility

Two integration points are undocumented/preview and may change:

- `~/.claude/sessions/*.json` is Claude Code internal (observed on v2.1.235). If it changes, the fallback is a `SessionStart`/`SessionEnd` hook pair maintaining our own registry — the hook payload includes `session_id` and `cwd`.
- Ghostty's AppleScript API is marked preview; breaking changes are expected in 1.4. The `open -n` fallback covers total breakage; layout capture degrades gracefully to session-only snapshots.

## Prior art

- [Supersynergy/claude-session-restore](https://github.com/Supersynergy/claude-session-restore) — restores sessions by scanning transcripts for *recent* sessions; no snapshot of what was actually open, no layout.
- [asadtariq96/cc-session-restore](https://github.com/asadtariq96/cc-session-restore) — same periodic-snapshot idea, iTerm2 only.
- [Franvy/gtab](https://github.com/Franvy/gtab) — Ghostty tab/split *layout* restore (manual named saves, Accessibility-based exact geometry), no processes/sessions.
- tmux + [tmux-claude-resurrect](https://github.com/cookiecad/tmux-claude-resurrect) — works, but means living inside tmux with its Ghostty friction (scrollback, keybinds).

The niche this fills: knowing exactly which sessions were *open at the moment the machine died* (not just recently active), which window/split each one lived in, distinguishing interactive windows from background agents, and restoring natively into Ghostty.

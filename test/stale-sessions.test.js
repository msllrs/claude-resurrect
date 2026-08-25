// Reproduces the field bug from the second real restore (2026-08-25):
//
//  Bug 3: restore opened 6 ghost windows that all landed on "No conversation
//         found with session ID ...". The snapshot contained registry entries
//         (lovable-a8/71/bb/b0/97, purrfect-doodling...) whose transcripts
//         don't exist anywhere under ~/.claude/projects/ — nothing to resume.
//
//         Two layers to it:
//           3a. restore blindly trusts the snapshot: it never checks that a
//               conversation transcript exists before opening a window and
//               typing `claude --resume <id>` into it.
//           3b. the snapshotter's liveness check is pid-based only. Registry
//               files left behind by crashed sessions survive reboots, and
//               once the pid is reused by an unrelated process (EPERM from a
//               system daemon also counts as "alive"), the stale entry is
//               snapshotted as live forever.
//
// Test contract with bin/claude-resurrect (additions over snapshot.test.js):
//   - module exports { snapshot, restore, deps }.
//   - deps.hasConversation(sessionId) -> bool: does a resumable transcript
//     exist for this session (real impl: ~/.claude/projects/*/<id>.jsonl).
//   - deps.openWindow(panes): restore routes all window creation through this
//     so tests can capture instead of driving AppleScript.
//   - deps.pidCommand(pid) -> string|null: the process's command line (real
//     impl: `ps -o command= -p <pid>`). liveSessions() must reject registry
//     entries whose pid no longer runs a claude process.
//   - CLAUDE_RESURRECT_SESSIONS_DIR env var overrides the registry directory
//     read by the real liveSessions() (default ~/.claude/sessions).

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

function freshStateDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-resurrect-test-"));
  process.env.CLAUDE_RESURRECT_STATE_DIR = dir;
  // point at a nonexistent config so the developer's real one never leaks in
  process.env.CLAUDE_RESURRECT_CONFIG = path.join(dir, "config.json");
  return dir;
}

function loadTool() {
  delete require.cache[require.resolve("../bin/claude-resurrect")];
  return require("../bin/claude-resurrect");
}

function mkSession(id, name, extra = {}) {
  return {
    sessionId: id,
    pid: 4242,
    cwd: "/tmp/projA",
    kind: "interactive",
    name,
    status: "idle",
    startedAt: 1,
    ...extra,
  };
}

const GOOD_PANE = mkSession("good-pane-1111-2222-3333-444444444444", "good-pane");
const GHOST_PANE = mkSession("ghost-pane-1111-2222-3333-444444444444", "ghost-pane");
const GOOD_STRAY = mkSession("good-stray-1111-2222-3333-444444444444", "good-stray");
const GHOST_STRAY = mkSession("ghost-stray-1111-2222-3333-444444444444", "ghost-stray");

function pendingSnapshot() {
  return {
    bootId: "boot-uuid-1",
    bootTime: 1000,
    savedAt: "2026-08-25T09-19-26-203Z",
    sessions: [GOOD_PANE, GHOST_PANE, GOOD_STRAY, GHOST_STRAY],
    layout: [
      {
        windowId: "w-good",
        tabs: [{ index: 1, panes: [{ cwd: "/tmp/projA", title: "good-pane", tty: null, sessionId: GOOD_PANE.sessionId }] }],
      },
      {
        windowId: "w-ghost",
        tabs: [{ index: 1, panes: [{ cwd: "/tmp/projA", title: "ghost-pane", tty: null, sessionId: GHOST_PANE.sessionId }] }],
      },
    ],
  };
}

test("bug 3a: restore must not open windows for sessions with no conversation transcript", async () => {
  const dir = freshStateDir();
  const tool = loadTool();
  fs.writeFileSync(path.join(dir, "pending-restore.json"), JSON.stringify(pendingSnapshot()));

  tool.deps.liveSessions = () => []; // everything is dead after the reboot
  tool.deps.hasConversation = (sessionId) => sessionId.startsWith("good");
  const opened = [];
  tool.deps.openWindow = (panes) => opened.push(panes);

  await tool.restore([]);

  const resumed = opened.flat().map((p) => p.resumeId).filter(Boolean);
  assert.ok(resumed.includes(GOOD_PANE.sessionId), "pane session with a transcript is restored");
  assert.ok(resumed.includes(GOOD_STRAY.sessionId), "stray session with a transcript is restored");
  assert.ok(!resumed.includes(GHOST_PANE.sessionId), "pane session without a transcript must not be resumed");
  assert.ok(!resumed.includes(GHOST_STRAY.sessionId), "stray session without a transcript must not be resumed");
  assert.equal(opened.length, 2, "the ghost-only window and the ghost stray must not open windows at all");
});

test("bug 3a: dry-run also skips transcript-less sessions", async () => {
  const dir = freshStateDir();
  const tool = loadTool();
  fs.writeFileSync(path.join(dir, "pending-restore.json"), JSON.stringify(pendingSnapshot()));

  tool.deps.liveSessions = () => [];
  tool.deps.hasConversation = (sessionId) => sessionId.startsWith("good");
  const opened = [];
  tool.deps.openWindow = (panes) => opened.push(panes);

  await tool.restore(["--dry-run"]);

  assert.equal(opened.length, 0, "dry-run never opens windows");
  assert.ok(
    fs.existsSync(path.join(dir, "pending-restore.json")),
    "dry-run must not consume the pending snapshot"
  );
});

test("bug 3b: registry entry whose pid was reused by a non-claude process is not live", () => {
  freshStateDir();
  const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-resurrect-registry-"));
  process.env.CLAUDE_RESURRECT_SESSIONS_DIR = sessionsDir;
  try {
    // both pids are genuinely alive — process.pid runs this test (a node
    // process, close enough to claude for the real matcher is NOT the point:
    // the tool must consult deps.pidCommand, which we control here)
    fs.writeFileSync(
      path.join(sessionsDir, "real.json"),
      JSON.stringify(mkSession("real-claude-1111-2222-3333-444444444444", "real-claude", { pid: process.pid }))
    );
    fs.writeFileSync(
      path.join(sessionsDir, "stale.json"),
      JSON.stringify(mkSession("stale-reuse-1111-2222-3333-444444444444", "stale-reuse", { pid: process.ppid }))
    );

    const tool = loadTool();
    tool.deps.pidCommand = (pid) =>
      pid === process.pid ? "claude --resume real-claude-1111-2222-3333-444444444444" : "/usr/libexec/somedaemon";

    const live = tool.deps.liveSessions();
    const ids = live.map((s) => s.sessionId);
    assert.ok(ids.includes("real-claude-1111-2222-3333-444444444444"), "claude-owned pid stays live");
    assert.ok(!ids.includes("stale-reuse-1111-2222-3333-444444444444"), "reused pid must be treated as dead");
  } finally {
    delete process.env.CLAUDE_RESURRECT_SESSIONS_DIR;
  }
});

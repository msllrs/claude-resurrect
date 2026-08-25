// Field feedback from the 2026-08-25 restore: the original window held 5
// splits side by side (all columns), but restore rebuilt it as a 2-column
// grid. Exact geometry capture is impossible — Ghostty 1.3.1's AppleScript
// dictionary exposes no position/size on terminals (checked Ghostty.sdef) —
// so the arrangement stays a heuristic, but the *style* of the heuristic
// should be the user's choice.
//
// Test contract with bin/claude-resurrect (additions over the other files):
//   - module exports splitPlan(count, style) -> array of count-1 entries
//     {target, direction} where entry i describes how pane i+1 is split off:
//       grid    (default): pane 1 right of pane 0, pane i down from pane i-2
//       columns: every pane splits right of the previous one
//       rows:    every pane splits down from the previous one
//   - restore accepts --layout <grid|columns|rows>; with no flag it reads
//     CLAUDE_RESURRECT_LAYOUT (checked at restore time, not module load),
//     else defaults to "grid". An unknown style falls back to "grid" with a
//     warning rather than aborting a crash-recovery run.
//   - restore passes the style to deps.openWindow(panes, style) so the real
//     openWindow can build the requested arrangement (and the open -n
//     fallback can keep ignoring it).

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

test("splitPlan: grid keeps the historical 2-column arrangement", () => {
  const tool = loadTool();
  assert.deepEqual(tool.splitPlan(1, "grid"), []);
  assert.deepEqual(tool.splitPlan(5, "grid"), [
    { target: 0, direction: "right" },
    { target: 0, direction: "down" },
    { target: 1, direction: "down" },
    { target: 2, direction: "down" },
  ]);
});

test("splitPlan: columns puts every pane side by side", () => {
  const tool = loadTool();
  assert.deepEqual(tool.splitPlan(5, "columns"), [
    { target: 0, direction: "right" },
    { target: 1, direction: "right" },
    { target: 2, direction: "right" },
    { target: 3, direction: "right" },
  ]);
});

test("splitPlan: rows stacks every pane vertically", () => {
  const tool = loadTool();
  assert.deepEqual(tool.splitPlan(3, "rows"), [
    { target: 0, direction: "down" },
    { target: 1, direction: "down" },
  ]);
});

async function restoreStyle(args, env) {
  const dir = freshStateDir();
  const prevEnv = process.env.CLAUDE_RESURRECT_LAYOUT;
  if (env === undefined) delete process.env.CLAUDE_RESURRECT_LAYOUT;
  else process.env.CLAUDE_RESURRECT_LAYOUT = env;
  try {
    const tool = loadTool();
    const session = {
      sessionId: "aaaaaaaa-1111-2222-3333-444444444444",
      pid: 4242,
      cwd: "/tmp/projA",
      kind: "interactive",
      name: "proj-a",
      status: "idle",
      startedAt: 1,
    };
    fs.writeFileSync(
      path.join(dir, "pending-restore.json"),
      JSON.stringify({
        bootId: "boot-uuid-1",
        bootTime: 1000,
        savedAt: "x",
        sessions: [session],
        layout: [
          {
            windowId: "w1",
            tabs: [{ index: 1, panes: [{ cwd: "/tmp/projA", title: "proj-a", tty: null, sessionId: session.sessionId }] }],
          },
        ],
      })
    );
    tool.deps.liveSessions = () => [];
    tool.deps.hasConversation = () => true;
    const styles = [];
    tool.deps.openWindow = (panes, style) => styles.push(style);
    await tool.restore(args);
    assert.equal(styles.length, 1, "exactly one window opens");
    return styles[0];
  } finally {
    if (prevEnv === undefined) delete process.env.CLAUDE_RESURRECT_LAYOUT;
    else process.env.CLAUDE_RESURRECT_LAYOUT = prevEnv;
  }
}

test("restore: --layout flag reaches openWindow", async () => {
  assert.equal(await restoreStyle(["--layout", "columns"]), "columns");
});

test("restore: CLAUDE_RESURRECT_LAYOUT is the default when no flag is given", async () => {
  assert.equal(await restoreStyle([], "rows"), "rows");
});

test("restore: no flag, no env means grid; unknown style falls back to grid", async () => {
  assert.equal(await restoreStyle([]), "grid");
  assert.equal(await restoreStyle(["--layout", "mosaic"]), "grid");
});

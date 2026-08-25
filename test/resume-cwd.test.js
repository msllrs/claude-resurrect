// Reproduces field bug 4 from the 2026-08-25 restore:
//
//  Worktree agent sessions (started via `claude --worktree` from the repo
//  root) came back duplicated: the original entry pinned to the worktree dir
//  AND a new interactive entry homed at the repo root, both with the same
//  session id.
//
//  Cause: Ghostty reports the pane's shell cwd (where `claude --worktree` was
//  launched, e.g. ~/git/lovable), but the session's real cwd is the worktree
//  (~/git/lovable/.claude/worktrees/<name>). The layout pass rebuilt the pane
//  at the pane cwd and typed `claude --resume` there, so Claude Code
//  re-registered the session under the wrong project instead of reattaching
//  it to its worktree.
//
//  Contract: when a pane resumes a session, the pane's working directory must
//  be the SESSION's registry cwd (fall back to the pane cwd only if the
//  session has none). Plain shell panes keep the pane cwd. The stray pass
//  already uses the session cwd.

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

test("bug 4: a resumed pane starts in the session's cwd, not the pane's shell cwd", async () => {
  const dir = freshStateDir();
  const tool = loadTool();

  const agent = {
    sessionId: "aaaaaaaa-1111-2222-3333-444444444444",
    pid: 4242,
    cwd: "/tmp/repo/.claude/worktrees/agent-1", // where the session really runs
    kind: "bg",
    name: "wt-agent",
    status: "idle",
    startedAt: 1,
  };
  fs.writeFileSync(
    path.join(dir, "pending-restore.json"),
    JSON.stringify({
      bootId: "boot-uuid-1",
      bootTime: 1000,
      savedAt: "x",
      sessions: [agent],
      layout: [
        {
          windowId: "w1",
          tabs: [
            {
              index: 1,
              panes: [
                // Ghostty reports the launching shell's cwd, not the worktree
                { cwd: "/tmp/repo", title: "wt-agent", tty: null, sessionId: agent.sessionId },
                { cwd: "/tmp/repo", title: "shell", tty: null, sessionId: null },
              ],
            },
          ],
        },
      ],
    })
  );

  tool.deps.liveSessions = () => [];
  tool.deps.hasConversation = () => true;
  const opened = [];
  tool.deps.openWindow = (panes) => opened.push(panes);

  await tool.restore([]);

  assert.equal(opened.length, 1);
  const [resumePane, shellPane] = opened[0];
  assert.equal(resumePane.resumeId, agent.sessionId);
  assert.equal(
    resumePane.cwd,
    "/tmp/repo/.claude/worktrees/agent-1",
    "resuming pane must use the session's registry cwd so the session re-homes correctly"
  );
  assert.equal(shellPane.resumeId, null);
  assert.equal(shellPane.cwd, "/tmp/repo", "plain shell panes keep the captured pane cwd");
});

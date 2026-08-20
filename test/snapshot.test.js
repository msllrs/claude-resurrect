// Reproduces two field bugs from the first real restore (2026-08-20):
//
//  Bug 1: a single failed Ghostty layout capture (AppleScript hiccup, TCC,
//         Ghostty briefly unscriptable) overwrote the good layout with null,
//         so restore lost all window/split/pane->session info.
//         Fix: inherit the previous snapshot's pane structure (marked stale)
//         and re-match current sessions onto it.
//
//  Bug 2: macOS adjusts kern.boottime on sleep/wake (observed drifting
//         1787147887 -> 1787147888 overnight), so "boot time changed" fired
//         spuriously every sleep cycle, promoting live snapshots to
//         pending-restore and risking clobbering a real pending file.
//         Fix: use kern.bootsessionuuid as the boot identity.
//
// Test contract with bin/claude-resurrect:
//   - CLAUDE_RESURRECT_STATE_DIR env var overrides the state directory.
//   - When require()d as a module it exports { snapshot, deps } where deps
//     holds the injectable probes: bootId(), bootTime(), liveSessions(),
//     captureGhosttyLayout().  (As a CLI its behavior is unchanged.)

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

function freshStateDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-resurrect-test-"));
  process.env.CLAUDE_RESURRECT_STATE_DIR = dir;
  return dir;
}

function loadTool() {
  delete require.cache[require.resolve("../bin/claude-resurrect")];
  return require("../bin/claude-resurrect");
}

const SESSION = {
  sessionId: "aaaaaaaa-1111-2222-3333-444444444444",
  pid: 4242,
  cwd: "/tmp/projA",
  kind: "interactive",
  name: "proj-a",
  status: "idle",
  startedAt: 1,
};

const GOOD_LAYOUT = [
  {
    windowId: "w1",
    tabs: [
      {
        index: 1,
        panes: [
          { cwd: "/tmp/projA", title: "proj-a", tty: null, sessionId: SESSION.sessionId },
          { cwd: "/tmp/other", title: "shell", tty: null, sessionId: null },
        ],
      },
    ],
  },
];

test("bug 1: transient layout-capture failure must not clobber known layout", () => {
  const dir = freshStateDir();
  const tool = loadTool();

  // tick 1: healthy — layout captured
  tool.deps.bootId = () => "boot-uuid-1";
  tool.deps.bootTime = () => 1000;
  tool.deps.liveSessions = () => [{ ...SESSION }];
  tool.deps.captureGhosttyLayout = () => JSON.parse(JSON.stringify(GOOD_LAYOUT));
  tool.snapshot();

  // tick 2: same boot, sessions still alive, but AppleScript hiccups
  tool.deps.captureGhosttyLayout = () => null;
  tool.snapshot();

  const cur = JSON.parse(fs.readFileSync(path.join(dir, "current.json"), "utf8"));
  assert.ok(cur.layout, "layout must be inherited from the previous snapshot, not nulled");
  const panes = cur.layout.flatMap((w) => w.tabs.flatMap((t) => t.panes));
  assert.equal(panes.length, 2, "inherited layout keeps the pane structure");
  assert.ok(
    panes.some((p) => p.sessionId === SESSION.sessionId),
    "live session must be re-matched onto the inherited panes"
  );
  assert.ok(cur.layoutStale, "inherited layout must be marked stale");
});

test("bug 1b: inherited layout drops matches for sessions that ended", () => {
  const dir = freshStateDir();
  const tool = loadTool();

  tool.deps.bootId = () => "boot-uuid-1";
  tool.deps.bootTime = () => 1000;
  tool.deps.liveSessions = () => [{ ...SESSION }];
  tool.deps.captureGhosttyLayout = () => JSON.parse(JSON.stringify(GOOD_LAYOUT));
  tool.snapshot();

  // session exits gracefully AND capture fails on the same tick
  tool.deps.liveSessions = () => [];
  tool.deps.captureGhosttyLayout = () => null;
  tool.snapshot();

  const cur = JSON.parse(fs.readFileSync(path.join(dir, "current.json"), "utf8"));
  const panes = (cur.layout || []).flatMap((w) => w.tabs.flatMap((t) => t.panes));
  assert.ok(
    panes.every((p) => !p.sessionId),
    "ended sessions must not stay matched to inherited panes"
  );
});

test("bug 2: kern.boottime drift within the same boot must not promote to pending", () => {
  const dir = freshStateDir();
  const tool = loadTool();

  tool.deps.bootId = () => "boot-uuid-1";
  tool.deps.bootTime = () => 1787147887;
  tool.deps.liveSessions = () => [{ ...SESSION }];
  tool.deps.captureGhosttyLayout = () => JSON.parse(JSON.stringify(GOOD_LAYOUT));
  tool.snapshot();

  // sleep/wake: boottime drifts by a second, boot session uuid unchanged
  tool.deps.bootTime = () => 1787147888;
  tool.snapshot();

  assert.ok(
    !fs.existsSync(path.join(dir, "pending-restore.json")),
    "no pending-restore may appear while the boot session is unchanged"
  );
});

test("bug 2b: a real reboot still promotes the pre-crash snapshot to pending", () => {
  const dir = freshStateDir();
  const tool = loadTool();

  tool.deps.bootId = () => "boot-uuid-1";
  tool.deps.bootTime = () => 1000;
  tool.deps.liveSessions = () => [{ ...SESSION }];
  tool.deps.captureGhosttyLayout = () => JSON.parse(JSON.stringify(GOOD_LAYOUT));
  tool.snapshot();

  // reboot: new boot session uuid, previous sessions gone
  tool.deps.bootId = () => "boot-uuid-2";
  tool.deps.bootTime = () => 2000;
  tool.deps.liveSessions = () => [];
  tool.deps.captureGhosttyLayout = () => null;
  tool.snapshot();

  const pending = JSON.parse(fs.readFileSync(path.join(dir, "pending-restore.json"), "utf8"));
  assert.equal(pending.sessions.length, 1, "pending holds the pre-crash sessions");
  assert.ok(pending.layout, "pending holds the pre-crash layout");
  const cur = JSON.parse(fs.readFileSync(path.join(dir, "current.json"), "utf8"));
  assert.ok(!cur.layout || cur.layoutStale !== undefined, "post-reboot current is written");
});

test("migration: old snapshot without bootId is not spuriously promoted", () => {
  const dir = freshStateDir();
  const tool = loadTool();

  // simulate a v2 snapshot written before the bootId fix
  fs.writeFileSync(
    path.join(dir, "current.json"),
    JSON.stringify({ bootTime: 1787147887, savedAt: "old", sessions: [{ ...SESSION }], layout: GOOD_LAYOUT })
  );

  tool.deps.bootId = () => "boot-uuid-1";
  tool.deps.bootTime = () => 1787147887; // same boot, no drift
  tool.deps.liveSessions = () => [{ ...SESSION }];
  tool.deps.captureGhosttyLayout = () => JSON.parse(JSON.stringify(GOOD_LAYOUT));
  tool.snapshot();

  assert.ok(
    !fs.existsSync(path.join(dir, "pending-restore.json")),
    "same boottime + missing bootId must be treated as the same boot"
  );
});

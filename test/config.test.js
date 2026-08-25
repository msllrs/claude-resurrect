// User configuration: ~/.config/claude-resurrect/config.json lets users set
// their preferences once instead of remembering flags and env vars.
//
// Test contract with bin/claude-resurrect (additions over the other files):
//   - CLAUDE_RESURRECT_CONFIG env var overrides the config file path
//     (default ~/.config/claude-resurrect/config.json), read at call time.
//   - Recognized keys and precedence (most specific wins):
//       layout                  restore arrangement; flag > CLAUDE_RESURRECT_LAYOUT > config > "grid"
//       includeBg               restore reopens stray background agents; --include-bg > config > false
//       snapshotIntervalSeconds LaunchAgent tick; config > 30. install reads it
//                               when writing the plist (rerun install to apply).
//   - A missing or malformed config file means defaults — never a crash
//     (restore is crash recovery; a typo must not block it). Unknown keys are
//     ignored.
//   - module exports plistXml() so the interval wiring is testable.

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

function freshConfig(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-resurrect-cfg-"));
  const file = path.join(dir, "config.json");
  if (contents !== undefined) fs.writeFileSync(file, contents);
  process.env.CLAUDE_RESURRECT_CONFIG = file;
  return file;
}

function loadTool() {
  delete require.cache[require.resolve("../bin/claude-resurrect")];
  return require("../bin/claude-resurrect");
}

function seedPending(dir, session, layout) {
  fs.writeFileSync(
    path.join(dir, "pending-restore.json"),
    JSON.stringify({ bootId: "b1", bootTime: 1000, savedAt: "x", sessions: [session], layout: layout || null })
  );
}

const INTERACTIVE = {
  sessionId: "aaaaaaaa-1111-2222-3333-444444444444",
  pid: 4242,
  cwd: "/tmp/projA",
  kind: "interactive",
  name: "proj-a",
  status: "idle",
  startedAt: 1,
};
const BG = { ...INTERACTIVE, sessionId: "bbbbbbbb-1111-2222-3333-444444444444", kind: "bg", name: "bg-agent" };

async function runRestore(args, session) {
  const dir = freshStateDir();
  const tool = loadTool();
  seedPending(dir, session);
  tool.deps.liveSessions = () => [];
  tool.deps.hasConversation = () => true;
  const opened = [];
  tool.deps.openWindow = (panes, style) => opened.push({ panes, style });
  await tool.restore(args);
  return opened;
}

test("config: layout is read from the config file", async () => {
  freshConfig(JSON.stringify({ layout: "columns" }));
  delete process.env.CLAUDE_RESURRECT_LAYOUT;
  try {
    const opened = await runRestore([], INTERACTIVE);
    assert.equal(opened.length, 1);
    assert.equal(opened[0].style, "columns");
  } finally {
    delete process.env.CLAUDE_RESURRECT_CONFIG;
  }
});

test("config: env var beats config, flag beats env var", async () => {
  freshConfig(JSON.stringify({ layout: "columns" }));
  process.env.CLAUDE_RESURRECT_LAYOUT = "rows";
  try {
    assert.equal((await runRestore([], INTERACTIVE))[0].style, "rows", "env beats config");
    assert.equal((await runRestore(["--layout", "grid"], INTERACTIVE))[0].style, "grid", "flag beats env");
  } finally {
    delete process.env.CLAUDE_RESURRECT_LAYOUT;
    delete process.env.CLAUDE_RESURRECT_CONFIG;
  }
});

test("config: includeBg=true reopens stray background agents without the flag", async () => {
  freshConfig(JSON.stringify({ includeBg: true }));
  try {
    const opened = await runRestore([], BG);
    assert.equal(opened.length, 1, "bg stray opens when config says includeBg");
    assert.equal(opened[0].panes[0].resumeId, BG.sessionId);
  } finally {
    delete process.env.CLAUDE_RESURRECT_CONFIG;
  }
});

test("config: bg strays stay closed by default", async () => {
  freshConfig(JSON.stringify({}));
  try {
    assert.equal((await runRestore([], BG)).length, 0);
  } finally {
    delete process.env.CLAUDE_RESURRECT_CONFIG;
  }
});

test("config: snapshotIntervalSeconds lands in the LaunchAgent plist, default 30", () => {
  freshStateDir(); // ensureDaemonLink writes under the state dir
  freshConfig(JSON.stringify({ snapshotIntervalSeconds: 60 }));
  try {
    assert.match(loadTool().plistXml(), /<key>StartInterval<\/key><integer>60<\/integer>/);
    freshConfig(JSON.stringify({}));
    assert.match(loadTool().plistXml(), /<key>StartInterval<\/key><integer>30<\/integer>/);
  } finally {
    delete process.env.CLAUDE_RESURRECT_CONFIG;
  }
});

test("config: malformed or missing config file means defaults, never a crash", async () => {
  freshConfig("{ this is not json");
  try {
    const opened = await runRestore([], INTERACTIVE);
    assert.equal(opened.length, 1, "restore still works with a broken config");
    assert.equal(opened[0].style, "grid");
  } finally {
    delete process.env.CLAUDE_RESURRECT_CONFIG;
  }
  freshConfig(undefined); // path set but no file
  try {
    assert.equal((await runRestore([], INTERACTIVE))[0].style, "grid");
  } finally {
    delete process.env.CLAUDE_RESURRECT_CONFIG;
  }
});

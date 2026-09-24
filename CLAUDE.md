# CLAUDE.md

@AGENTS.md

Only the Claude Code specifics are below; everything in `AGENTS.md` applies.

## Working here

- **Run `cd plugin && npm run check` before every commit.** There is no CI; that is the whole net.
- **Fail first:** put the old behaviour back and watch your new test fail before keeping a fix. The
  suite has agreed with bugs before (it compared tool names where schemas mattered).
- **Never start the daemon or launch seats to test.** Seats are real agents with broad permissions
  and they cost money. The suite, your reading and `~/.paseo/daemon.log` are the evidence.
- **Never print or cat a file that can hold a key:** `~/.local/share/seatworks-v2/settings.json`,
  any project `settings.json`, `~/.paseo/config.json`. Test fixtures use fake `sk-or-v1-…` keys.
- **`plugin/content/**` is runtime content.** Before touching a file the KEEP list names (prompts,
  skills, harness settings, some code), read its row in `../v3/CONCEPT.md` §6;
  `plugin/test/catalog/keep.test.ts` fails when one of its anchors goes.
- **`hidesWords` fails the build** when a role's text uses a word it must not see: rephrase, don't
  remove the lint.
- **Comments: one short docstring per function at most** (the rule is in `AGENTS.md`). A comment
  cleanup changes comments only: the code with comments stripped must print the same before and after.
- **Don't click settings in the user's live Paseo** to test the panel: it writes their config.

## Writing

Almost no prose, on purpose: no new markdown files, decision records or comments unless asked (the
owner's decision log, `../v3/DECISIONS.md`, is the exception). Plans go outside the repository. If a
change needs explaining, the commit message explains it.

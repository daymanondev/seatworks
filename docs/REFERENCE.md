# Reference

Lookups, not reading. For how the parts fit together, see [ARCHITECTURE.md](ARCHITECTURE.md). Paths
are under `plugin/` unless they start with `~`.

- **Desk:** [verbs](#desk-verbs) · [records](#records) · [gate detection](#gate-detection) · [letters](#letters) · [mail](#mail) · [permission requests](#permission-requests)
- **Seats:** [hooks](#hooks-and-events) · [harness fields](#harness-fields) · [seat directories](#seat-directories) · [MCP servers](#mcp-servers)
- **Watch:** [facts](#facts) · [holds](#holds)
- **Setup and files:** [settings](#settings) · [panel](#panel) · [state on disk](#state-on-disk) · [evals](#evals) · [known limits](#known-limits)

## Desk verbs

A call runs only when three things hold: the seat's provider maps to a role whose tool set (in
`mcp/tools.json`) holds the verb, the seat's bridge names that same role, and the arguments fit the
schema. A call that doesn't fit is refused, with what is wrong.

| Role | Tools |
|---|---|
| Supervisor | `open_lane` `close_lane` `set_project` `message` `answer` `status` `incidents` `ack` |
| Lead | `start_task` `start_review` `accept` `rework` `cut` `report` `message` `answer` `ask` `status` `incidents` `ack` |
| Peer, Reviewer | `done` `ask` |

| Verb | Effect |
|---|---|
| `open_lane` | Records the lane, takes a working copy and seats a Lead, with a directive that names `CONTEXT.md` once it exists. It can read a GitHub issue. It refuses a lane whose declared write set or `contracts` overlap an open lane's write set, or that reaches a path the project keeps to one writer. The project's own checkout must be clean |
| `close_lane` | Waits for queued merges. With `land`, it [lands the lane](ARCHITECTURE.md#a-lane). Then it cuts leftover tasks, archives their seats and the Lead, and puts the copy away |
| `set_project` | Sets the base branch, the gate command and its timeout (30 min by default), whether the gate runs per lane or per task, and the serial-only paths. An empty gate is an answer, and the desk never detects one over it |
| `start_task` | Seats a writing role on a task. In lane mode it shares the lane's copy. In parallel mode it gets its own slot and `task/…` branch. `skills` must be ones the role has |
| `start_review` | Seats a read-only reviewing role. It runs where the change is now: the task's copy, the lane's copy, or the task branch |
| `accept` | Lane mode: marks the task merged in place and retires the Peer. It is refused if the lane copy is off its branch or dirty. Parallel mode: queues the task for merging |
| `rework` | Sends the task back with a letter. It is refused while another task holds the lane copy |
| `cut` | Stops the task and archives its Peer. It resets the lane copy to where the task started, when nothing merged there since. It is refused while the task's merge runs |
| `report` | Reports to the Supervisor. With `ready`, it runs the lane gate first |
| `ask` | A Lead asks the Supervisor. A Peer or Reviewer asks its Lead, or the Supervisor when the Lead is gone |
| `done` | Hands the task back to the Lead, with a file. On a per-task-gate project, it runs the gate first. It is refused once the task is accepted, queued or cut |
| `message` | The Supervisor messages a lane or a task, and a Lead messages a task in its own lane. A seat stopped on a question takes it as the answer |
| `answer` | Closes an open ask. The Supervisor may answer any ask, others only their own |
| `incidents` | Lists the 50 most recent open or unmarked incidents, with each one's brief. With `closed`, it adds the 20 most recently marked. A Lead sees only its own lane's |
| `ack` | Marks an incident `useful`, `noise` or `unknown`, with an optional note, and closes it |
| `status` | Lanes, tasks, working copies and open asks. A Lead sees its own lane |

Behaviour depends on a role's capabilities (`supervise`, `lead`, `work`, `write`, `review`,
`critique`, `watched`), never its name.

## Records

| Record | States | Ids |
|---|---|---|
| Lane | `open`, `closed` | `L<n>` |
| Task | `running`, `done`, `rework`, `queued`, `merging`, `merged`, `failed`, `cut`, `stalled` | `<lane>-T<n>` for code, `<lane>-R<n>` for review, from one counter per lane |
| Ask | `open`, `answered` | `A<n>` |
| Incident | open until marked | `I<n>` |
| Slot | a git worktree held by a lane or task | `S<n>`, never reused once released |

A lane opened with `detourOf` serves another open lane. When it closes, that lane's Lead gets a
CLEARED letter.

## Gate detection

The first `open_lane` of a project with no gate on record looks in the project root, by the rules in
`catalog/ecosystem.json` (the shipped ones below):

| Found | Gate |
|---|---|
| `package.json` with a real `test` script | `pnpm test`, `yarn test`, `bun run test` or `npm test`, by lockfile |
| `mvnw` or `pom.xml` | `./mvnw -q test` or `mvn -q test` |
| `gradlew` | `./gradlew test` |
| `Cargo.toml` | `cargo test` |
| `go.mod` | `go test ./...` |
| `pyproject.toml` or `pytest.ini` | `pytest -q` |

`catalog/ecosystem.json` also holds the paths only one writer at a time may write (a project's own
`serialOnly` replaces them), how test and docs files are named, and the watch's default patterns. A file
of the same name in the state root replaces it, as `roles.json` does.

## Letters

All of them are written in `desk/letters.ts`; what a seat starts from is in `desk/briefs.ts` and, for a
Lead, `desk/directive.ts`. Each letter carries a key made of its kind and the ids that make it that
letter, never written by hand where it is posted.

| Kind | Letters |
|---|---|
| Opening a seat | OWNER DIRECTIVE, TASK, REVIEW |
| Between seats | MESSAGE, RECONCILE, ASK, ANSWER to your ask, ANSWERED FOR YOU, STILL OPEN, UNANSWERED |
| Work moving | HANDBACK, REWORK, MERGED, MERGE FAILED, MERGE CONFLICT, REPORT, CAN LAND, CLEARED |
| The desk noticing | SILENT, FAILED, WAITING FOR PERMISSION, LANE IDLE, INCIDENT, the bare nudge |
| Answering late | ANSWER to your `<tool>` call, NO ANSWER to your `<tool>` call |

CAN LAND tells whoever tried to land a lane under a seat mid-turn that the turn has ended. NO ANSWER
tells a seat that the plugin stopped before the call it was told to wait for by mail had finished.
RECONCILE tells a Lead what the Supervisor sent its Peer. ANSWERED FOR YOU tells a seat that someone
else answered an ask addressed to it.

## Mail

| Situation | What happens |
|---|---|
| Paseo can't look the seat up | held |
| The seat is archived | never sent. The letters age out |
| The seat has a pending permission | held |
| Running, its agent `steers`, and the turn started at least 60 s ago | **steered** into the turn |
| Running or starting | held |
| Mailed less than 10 minutes ago, with no turn end since | held |
| Otherwise | sent |

| Timing | Value |
|---|---|
| Spool drained | every 500 ms |
| `team.mjs` polls for a reply | every 250 ms, for up to 300 s |
| A call answered "arrives as mail" | after 240 s |
| Spool requests dropped | after 10 minutes |
| A duplicate letter, same kind, same ids and same reader | dropped while waiting, and for 30 minutes after sending |
| A letter nobody took | dropped after 7 days |

## Permission requests

| Seat | Where the request goes |
|---|---|
| Lead | A letter to the Supervisor |
| Peer or Reviewer on a task | A letter to its Lead |
| Supervisor | `attention.log` and `status.md`. You answer it in Paseo |
| Peer or Reviewer with no task | Only Paseo |

The owner answers a question by `message`, and the desk answers it in Paseo. Any other permission
only you can answer.

## Hooks and events

| Hook or event | What the plugin does |
|---|---|
| before `agent.create` | For a `sw2-` provider, builds the seat directory and shapes the launch. A seat that can't be built refuses the launch, with the reason |
| before `agent.session_open` | Seeds the project's records, writes the team block, rebuilds the seat directory if needed, and points the agent's config directory at it |
| `agent.created` | Follows the seat's timeline, if its role can be `watched` |
| `agent.turn_started` | Records the turn's start, for turn reading and steering |
| `agent.turn_ended` | Finishes deferred teardowns, reads the turn, and pumps the seat's mail |
| `agent.permission_requested` | Mails the request to the seat's owner, or logs it |
| `agent.archived` | Forgets the seat's timing, stops its watch, and closes its open incidents |

## Harness fields

`harness/<agent>/harness.json`, read against a schema: a field it doesn't know, at any depth, fails the load and is named.

| Field | Drives |
|---|---|
| `id`, `label` | The harness's name, and the agent half of a provider's label |
| `baseProvider` | The Paseo provider it extends: `claude`, `codex`, `pi`, `omp` or `opencode` |
| `configDirEnv`, `profileRoot` | The variable that points the agent at its seat directory, and where those live |
| `contextFile` | The file in the seat directory that gets the working rules |
| `skillsDir` | Where skills are linked, each to its copy under `content/` |
| `settings` | Base settings, the per-role overlay, and `inherits`: keys taken from your own config for that agent. The plugin writes the seat's settings file whole |
| `mcp` | The MCP file, how servers are delivered, transports, seed and clear rules, and `desk` fields |
| `links`, `files` | Files linked from your own setup (logins, history), and files composed per role |
| `modelCatalog` | A command whose model list is written as the agent's catalog |
| `stateWrites` | Where the seat's writable state paths go |
| `projectContextOption` | The provider option that receives the working directory |
| `steers` | Whether mail may be steered into a running turn |
| `mcpCall`, `mcpServerField` | How the agent names a call to an MCP server, or the field that holds the server's name, so a call to the desk is known as one |
| `timeline` | Where the agent's timeline differs from the rest: where it keeps a command's exit code when not in the call, calls it sends that are not the seat's, and the marks of an input that was not JSON |
| `checks` | Files the Health tab looks for |
| `provider` | Env, launch command, `forceFlags`, and the starting mode |

Required: `id`, `label`, `baseProvider`, `configDirEnv`, `profileRoot`, `skillsDir`, `settings`,
`mcp` and `provider`.

## Seat directories

One per role, agent and project: `<profileRoot>/sw2-<role>-<agent>-<slug>`. It is rebuilt when the
settings revision changes, its settings file is gone, or a login appeared since.

| Agent | Directory | Written there | Launch |
|---|---|---|---|
| Claude Code | `~/.claude/profiles/…` | `settings.json` (deny rules, sandbox), `.claude.json` (its own MCP servers cleared), `skills/`, a `projects` link, `CLAUDE.md` for working rules | `bin/seat-room` with `--setting-sources user`, so the project's settings, hooks and skills stay out |
| Codex | `~/.codex/seats/…` | `config.toml` (`model_provider` and `model_providers` from your own `~/.codex/config.toml`; `workspace-write`, or `read-only` for Reviewer and Critic; `approval_policy = "never"`; subagents off), `model-catalog.json`, `rules/seatworks.rules`, `skills/`, an `auth.json` link, `AGENTS.md` | Paseo's Codex provider |
| Pi | `~/.pi/seats/…` | `settings.json` (`pi-mcp-adapter`, project trust off, tool lists for Reviewer and Critic), `mcp.json`, `skills/`, links to login, models and npm | Paseo's Pi provider |
| OpenCode | `~/.config/opencode-seats/…` | `opencode/opencode.json` (your providers, permissions with command denials, subagents and questions off, autoupdate and sharing off), `opencode/AGENTS.md`, `opencode/skills/`, a link to your git config | Paseo's OpenCode provider, with its env given at each session |
| Oh My Pi | `~/.omp/seats/…` | `config.yml` (command denials in `bash.patterns`, tool denials, subagents, questions, memory and other agents' config off), `mcp.json`, `AGENTS.md`, `skills/`, links to its login and models | Paseo's omp provider |

- **Claude Code** still reads the project's `CLAUDE.md`: the working directory is passed as an
  additional directory.
- **Codex** needs the `codex` CLI to build a seat, because the build asks it for its models.
- **Oh My Pi** reads `config.yml` as YAML; the plugin writes it as JSON, which YAML reads too.
- **OpenCode** uses `XDG_CONFIG_HOME` as its config variable, and Paseo runs one OpenCode server for
  every seat, so a seat's own env reaches it only through the session. It keeps a failed command's
  exit code beside the call, where the watch reads it.

## MCP servers

| Server | Kind | What it gives |
|---|---|---|
| `team` | Always there, for a seat with a tool set | The role's desk verbs |
| `intellij-index` | Proxy over HTTP to a JetBrains IDE. Needs `.idea` | Code-index tools |
| `code-search` | Proxy over stdio (`uvx … semble`) | One `search` tool |
| `context7` | Plain HTTP, no key | Library docs. Queries leave the machine |

Catalog servers are off until a settings layer turns them on. One that names no roles goes to every
role with desk tools except the Critic. `mcp/code.mjs` can pin calls to the seat's git root, sync
changed files, open and close the working copy in the backend, wait out indexing, rewrite errors and
replace tool descriptions.

## Facts

**From a seat's turn**, in code:

| Fact | Level | Fires when |
|---|---|---|
| `destructive` | page | A shell command matches the destructive pattern, checked per segment. Removing scratch files under the temp directory doesn't count |
| `stuck` | attend | In the last 20 steps: the same action and result 4 times, the same action failing 3 times, the same words 3 times, or two actions alternating 3 times |
| `no-recovery` | attend | Ten steps after a failed command, neither that program nor the gate has passed |
| `test-weakened` / `suppressed` | attend | An edit removes assertions from a test or adds a skip, or adds a suppression like `@ts-ignore` |
| `unverified` | attend | A Peer hands back with no gate result after writing files it never ran the gate on. Needs a gate |
| `long-turn` | attend | A turn runs past `longTurnMinutes`, or past three times this seat's median turn, whichever is longer |
| `call-failed` / `gate-failed` / `outside-scope` | note | Evidence only, never an incident alone |

**From a lane's record**, read by the patrol. Each names the lane's Lead:

| Fact | Fires when |
|---|---|
| `rework-loop` | One task was sent back `reworksAt` times |
| `patched-not-fixed` | That many sendings-back are spread over two or more tasks |
| `reviews-unconverged` | `reviewsAt` reviews of one target, none accepted or cut |
| `certainty-only` | A review's focus asks only for what the Reviewer is sure of |
| `brief-prewritten` | A code task's brief has a code fence, or steps naming a file and a member |
| `accepted-unfinished` | A task merged whose Peer handed it back `partial` or `blocked`, or never at all |

[ANTIPATTERNS.md](ANTIPATTERNS.md) says which pattern each fact answers.

## Holds

An incident is sent once. Until then it may be held:

| Held | Meaning |
|---|---|
| shadow | `attention.watch` is off, the default. Nothing is sent |
| budget | `incidentsPerDay` attend-level incidents went out in the last 24 h |
| nobody | Nobody to tell, or the only candidate is the watched seat. The patrol retries |

A page never waits. A sighting whose exact words were already marked `noise` for that seat and kind
opens nothing. Archiving a seat closes its incidents, and they still wait to be marked.

## Settings

There are two layers: `~/.local/share/seatworks-v3/settings.json` for the machine, and
`projects/<slug>/settings.json` for a project. The project layer wins per value.

| Setting | Where |
|---|---|
| Each role's agent, model and thinking | panel |
| MCP servers: on or off, roles, options, pasted snippets | panel |
| `attention.watch`, the mail switch | panel (*Mail incidents*) |
| The Flow switch | panel |
| Rules per role, or for every seat | by hand |
| The Flow interval, and the other attention values | by hand |

| Attention value | Default |
|---|---|
| `tickSeconds` (machine layer only) | 30 |
| `leadIdleMinutes` | 12 |
| `askRemindMinutes` / `maxReminders` | 15 / 2 |
| `watch` | false |
| `incidentsPerDay` | 5 |
| `longTurnMinutes` | 30 |
| `reworksAt` / `reviewsAt` | 3 / 3 |
| `destructive` / `testPath` / `suppressed` / `repeatsAt` | patterns, and 3 |

A `roles.json` in `~/.local/share/seatworks-v3/` replaces the preset whole. A role names `defaults`
or `follows`, never both. A follower takes the agent, model and thinking of the role it follows until
it is given its own. Each role still needs its settings files under `harness/<agent>/settings/`.

## Panel

| Tab | What it holds |
|---|---|
| **Team** | The agent per role, its model and thinking. The Supervisor's chip also holds the land check and *Mail incidents* |
| **Flow** | Supervisors, lanes, tasks and open asks, live. Then the incidents not yet marked |
| **MCP** | Servers on or off, their roles and options, and adding one from a snippet |
| **Health** | The machine's checks and, on a project, its lanes' status |
| **Plugin** | Updates, Migrate and Clean up, for the whole machine |

Models and modes come from Paseo, which asks each agent. The plugin lists them once a load, and **Refresh**
under the Team tab asks again. A role's chosen model is written as that provider's default in
Paseo (`additionalModels`), so Paseo's own picker offers every model and starts on the role's.


The panel talks to the server only through the `seatworks.*` RPCs in `shared/rpc.ts`. Detaching a
project keeps its ledger and logs, and is refused while a lane is open or a working copy is out.

## State on disk

```
~/.paseo/config.json                      providers sw2-<role>-<agent>, agent profiles
~/.local/share/seatworks-v3/
  roles.json                              optional; replaces the shipped preset
  settings.json                           machine settings
  settings.json.bak-<time>                what Migrate repaired, as it was; can hold a pasted token
  kit.json                                which kit runs, and since when
  content.json                            the shipped prompts, skills and guides you have taken in
  own/                                    your own copies, kept over the shipped ones
  models.json                             each agent's models as Paseo lists them
  outbox.json                             waiting letters, all projects
  intents.json                            seats to archive when their turn ends; answers promised as mail
  spool/requests/  spool/replies/         seat tool calls
  content/<name>-<hash>/                  copies of the guides and skills seats read; safe to delete
  guides -> content/guides-<hash>
  worktrees/<slug>/S<n>/                  isolated working copies
  projects/<slug>/                        slug = repo folder name + 6 hex chars of sha1(root)
    meta.json  settings.json  project.json
    ledger.json  incidents.json
    events.log  attention.log  status.md
    handbacks/  gates/  notebook.md  CONTEXT.md
<profileRoot>/sw2-<role>-<agent>-<slug>/  one seat directory per role, agent and project
```

`events.log` is the provenance record: one JSON line per tool call and per lane, task, merge, gate
and slot event. Every kind and its fields are one type, `DeskEvent` in `desk/events.ts`; a kind only
gains fields, and a field that changes meaning takes a new kind. The watch writes these kinds there:

| Group | Kinds |
|---|---|
| Watch | `watch.fact`, `watch.finding`, `watch.unbriefed`, `watch.offline` |
| Incidents | `incident.open`, `incident.held`, `incident.told`, `incident.read`, `incident.ack`, `incident.lookup-failed`, `incident.post-failed` |

`call.malformed` is logged when a seat's own harness rejected a tool call before it reached the desk.

## Evals

`npm run check` needs no key and launches no seat. This one calls a real model, so it sits outside
it:

| Command | What it measures |
|---|---|
| `npm run eval:triggers -- --agent "claude -p"` | Whether a real agent opens each skill on the briefs it should |

## Known limits

- **Oh My Pi can't be steered through Paseo.** Mail to a running omp seat waits for its turn to end.
- **Pi, Oh My Pi and OpenCode have no sandbox.** Pi has no command rules either, so a Pi seat is held
  only by its tools. Oh My Pi and OpenCode have command denials, such as `git push` and `gh`, but no
  path rules.
- **Reading an archived seat's history leaves its agent running.** Paseo resumes the agent to serve
  it and never closes it; `paseo logs` or the app's history view does this. The watch stops rather
  than read a seat once it is archived.
- **A Codex seat can call only the tools the kit can name.** Codex refuses any MCP call not
  approved ahead, so the desk's tools and proxied servers are approved at launch; a server you add
  whose tools the kit doesn't know stays out of reach on Codex.
- **Codex command rules match argument prefixes**, so `git -C <path> push` is not caught.
- **A steer Paseo can't hand over replaces the turn.** A Claude seat that is compacting refuses a
  steer the same way.
- **A turn running before a daemon restart** is never steered, and is read as having started
  30 minutes ago.
- **A project-layer save** doesn't rewrite the Paseo providers.
- **The watch can't see a sub-agent's work.** It isn't on the seat's timeline.

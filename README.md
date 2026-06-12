# wf-engine

Standalone runner for Claude Code workflow scripts on **Windows**.

Executes the same `.js` workflow files used by Claude Code's built-in Workflow tool, but talks to the Anthropic API directly — no extra Claude Code runtime needed.

---

## Requirements

- **Windows 10 or 11**
- **Node.js 20 or newer** — download at [nodejs.org](https://nodejs.org)
- **Claude Code CLI** installed and logged in — OR an `ANTHROPIC_API_KEY`

---

## Setup

1. Extract the ZIP anywhere you want, e.g. `C:\tools\wf-engine`
2. Open a terminal in that folder and run:

```cmd
npm install
```

Done. No global install needed.

---

## Authentication

### Option A — Use your existing Claude Code login (recommended)

If you have Claude Code installed and are logged in, wf-engine reuses your OAuth token automatically. Nothing to configure.

To log in: open Claude Code and run `/login`, or run `claude login` in a terminal.

### Option B — API key

Open PowerShell or CMD and set your key before running:

```powershell
# PowerShell
$env:ANTHROPIC_API_KEY = "sk-ant-..."

# CMD
set ANTHROPIC_API_KEY=sk-ant-...
```

---

## Running a Workflow

Open CMD or PowerShell in the `wf-engine` folder:

```cmd
wf-engine.cmd --project C:\path\to\your\project --name codebase-survey
```

Or via npm:

```cmd
npm start -- --project C:\path\to\your\project --name codebase-survey
```

---

## All Options

```
wf-engine.cmd --project DIR (--script FILE | --name NAME | --inline "JS")
              [--args JSON] [--model ID] [--max-turns N] [--timeout SEC]
              [--save] [--prepare] [--resume RUNID]

Required:
  --project DIR    Path to the codebase the workflow will work on.

Pick one source:
  --script FILE    Path to a .js workflow file.
  --name NAME      Name of a built-in or saved workflow.
  --inline "JS"    Paste workflow source directly as a string.

Optional:
  --args JSON      JSON value passed to the script as the global `args`.
  --model ID       Claude model to use (default: claude-sonnet-4-6).
  --max-turns N    Max tool turns per agent (default: 20).
  --timeout SEC    Hard time cap for the whole run.
  --save           Save the workflow to <project>\.claude\workflows\<name>.js
  --prepare        Validate only — no API call, no run. Prints file paths.
  --resume RUNID   Resume a previous run using cached agent results.
```

---

## Built-in Workflows

Three workflows are ready to use out of the box:

| Name | What it does |
|------|-------------|
| `codebase-survey` | Maps the repo structure, stack, and key files. |
| `roadmap` | Suggests a prioritized improvement roadmap based on the codebase. |
| `security-audit` | Reviews the codebase for common security issues. |

### Examples

```cmd
:: Survey a project
wf-engine.cmd --project C:\my-project --name codebase-survey

:: Security audit
wf-engine.cmd --project C:\my-project --name security-audit

:: Generate a roadmap and save the result
wf-engine.cmd --project C:\my-project --name roadmap
```

---

## Writing Your Own Workflow

Create a `.js` file starting with `export const meta = { name, description }`, then write an async body using the injected globals.

### Simple example

```js
export const meta = {
  name: 'count-files',
  description: 'Count files in the project root.',
}

const result = await agent('How many files are in the root of the project?')
log(result)
```

### Available globals

| Global | What it does |
|--------|-------------|
| `agent(prompt, opts?)` | Runs a sub-agent with shell access. Returns its final text, or a validated object when `opts.schema` is set. |
| `parallel(thunks)` | Runs an array of `() => Promise` at the same time. Failures return `null`. |
| `pipeline(items, ...stages)` | Passes each item through multiple stages independently. |
| `log(msg)` | Print a message to the console. |
| `phase(title)` | Label the current stage in the output. |
| `args` | Whatever you passed with `--args JSON`. |
| `workflow(name, args?)` | Call another saved workflow as a step. |

### Structured output example

```js
export const meta = {
  name: 'find-todos',
  description: 'Find all TODO comments.',
}

const SCHEMA = {
  type: 'object',
  properties: {
    todos: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          line: { type: 'number' },
          text: { type: 'string' },
        },
        required: ['file', 'line', 'text'],
      },
    },
  },
  required: ['todos'],
}

const result = await agent(
  'Find every TODO / FIXME / HACK comment. Return file path, line number, and text.',
  { schema: SCHEMA }
)

log('Found ' + result.todos.length + ' items')
return result
```

### Run multiple agents in parallel

```js
export const meta = {
  name: 'multi-review',
  description: 'Review code from multiple angles at once.',
}

const checks = ['security', 'performance', 'readability']

const results = await parallel(
  checks.map(c => () => agent('Review the codebase for ' + c + ' issues. List the top 3.', { label: c }))
)

checks.forEach((c, i) => { log('=== ' + c + ' ==='); log(results[i]) })
```

### Save a workflow for reuse

```cmd
:: Save it into the project
wf-engine.cmd --project C:\my-project --script .\my-workflow.js --save

:: Run it by name later
wf-engine.cmd --project C:\my-project --name my-workflow
```

Saved workflows go in `<project>\.claude\workflows\`.

---

## Resuming a Run

Every run creates a snapshot and journal in `%USERPROFILE%\.wf-engine\runs\`. Resume from a prior run to skip already-completed agents:

```cmd
:: The run ID is printed at the end of every run (e.g. wf_a1b2c3d4e5f6)
wf-engine.cmd --project C:\my-project --name codebase-survey --resume wf_a1b2c3d4e5f6
```

---

## Shell Used by Sub-Agents

wf-engine detects which shell to use automatically:

1. **Git Bash** — if installed (recommended, install from [git-scm.com](https://git-scm.com/download/win))
2. **WSL bash** — if Windows Subsystem for Linux is set up
3. **PowerShell** — fallback, always available

Bash gives agents the best compatibility with common commands like `grep`, `find`, `sed`, etc.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `@anthropic-ai/sdk not found` | Run `npm install` in the wf-engine folder. |
| `cannot read .credentials.json` | Log in to Claude Code first (`claude login`), or set `ANTHROPIC_API_KEY`. |
| `AUTH FAILED` | OAuth token expired — run `claude login` again, or set `ANTHROPIC_API_KEY`. |
| `syntax error (TypeScript not allowed)` | Workflow files must be plain JavaScript — no TypeScript types. |
| Sub-agent commands fail | Install [Git for Windows](https://git-scm.com/download/win) to get bash. |
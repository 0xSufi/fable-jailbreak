#!/usr/bin/env node
// wf-engine.mjs — STANDALONE dynamic-workflow runner.
//
// Runs the SAME workflow `.js` scripts that cc-wasm's WorkflowTool runs
// (export const meta = {...} followed by a body using agent/parallel/pipeline/
// log/phase/args/budget/workflow globals), but WITHOUT the cc-wasm bundle. It
// talks to the Anthropic Messages API directly via @anthropic-ai/sdk, reusing
// the existing cc-wasm OAuth login in ~/.claude/.credentials.json.
//
// Deps: @anthropic-ai/sdk (resolved via NODE_PATH set by the `wf-engine`
// launcher) + node builtins only. NOTHING from the cc-wasm source tree.
//
// Each agent() is one sub-agent run as a Messages tool-use loop in the project
// cwd, with a single `bash` tool (+ a `submit_result` tool in schema mode).
//
// @anthropic-ai/sdk is loaded by ABSOLUTE PATH via a dynamic import — ESM does
// NOT consult NODE_PATH for bare specifiers, so the `wf-engine` launcher passes
// the SDK's entry path in WF_SDK_PATH (falling back to the known location).

import { createContext, runInContext } from 'node:vm';
import { randomBytes, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function stderrEarly(s) { process.stderr.write(s + '\n'); }

// Resolve the SDK (absolute path; ESM ignores NODE_PATH for bare imports).
const SDK_CANDIDATES = [
  process.env.WF_SDK_PATH,
  '/data2/code/Dyspel/cwd/monorepo/packages/cc-wasm/node_modules/@anthropic-ai/sdk/index.mjs',
  path.join(path.dirname(new URL(import.meta.url).pathname), 'app', 'node_modules', '@anthropic-ai', 'sdk', 'index.mjs'),
].filter(Boolean);
let Anthropic;
{
  let lastErr;
  for (const cand of SDK_CANDIDATES) {
    try {
      const url = cand.startsWith('/') ? 'file://' + cand : cand;
      Anthropic = (await import(url)).default;
      if (Anthropic) break;
    } catch (e) { lastErr = e; }
  }
  if (!Anthropic) {
    stderrEarly(`wf-engine: FATAL cannot load @anthropic-ai/sdk (tried: ${SDK_CANDIDATES.join(', ')})${lastErr ? ' — ' + lastErr.message : ''}`);
    process.exit(1);
  }
}

// ───────────────────────── constants ─────────────────────────
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const PING_MODEL = 'claude-haiku-4-5-20251001';
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const OAUTH_BETA = 'oauth-2025-04-20';
// OAuth tokens are ONLY accepted when the system prompt STARTS with exactly this line.
const CC_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude.";

const AGENT_MAX_TOKENS = 8192;
const AGENT_TIMEOUT_MS = 120000; // per bash command
const BASH_MAX_BUFFER = 1024 * 1024; // 1MB
const BASH_OUTPUT_CAP = 16000; // chars
const DEFAULT_MAX_TURNS = 20;
const LIFETIME_AGENT_CAP = 1000;
const COLLECTION_CAP = 4096;

// ───────────────────────── small utils ─────────────────────────
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const stderr = (s) => process.stderr.write(s + '\n');
function mungeProject(p) { return p.replace(/\//g, '-'); }
function runId() { return 'wf_' + randomBytes(6).toString('hex'); }
function sha256(s) { return createHash('sha256').update(s).digest('hex'); }
// Deterministic JSON (sorted keys) so resume keys are stable across runs.
function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

function pretty(v, cap = 4000) {
  let s;
  try { s = typeof v === 'string' ? v : JSON.stringify(v, null, 2); }
  catch { s = String(v); }
  if (s === undefined) s = 'undefined';
  if (s.length > cap) s = s.slice(0, cap) + '\n…(truncated)';
  return s;
}

// ───────────────────────── auth ─────────────────────────
// Returns { mode:'oauth'|'apiKey', token, betas } and refreshes the OAuth token
// in place (read-modify-write, mode 0600) when near expiry. Falls back to the
// existing token on refresh failure.
async function resolveAuth() {
  // API-key override: drop OAuth beta + system-prompt-prefix requirement.
  if (process.env.ANTHROPIC_API_KEY) {
    return { mode: 'apiKey', token: process.env.ANTHROPIC_API_KEY, betas: [] };
  }

  const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
  let raw;
  try { raw = fs.readFileSync(credPath, 'utf8'); }
  catch (e) {
    throw new Error(
      `cannot read ${credPath} (${e.code || e.message}). Log in with cc-wasm \`/login\`, ` +
      `or set ANTHROPIC_API_KEY.`,
    );
  }
  let json;
  try { json = JSON.parse(raw); }
  catch { throw new Error(`${credPath} is not valid JSON — re-login with cc-wasm \`/login\`.`); }

  const oauth = json.claudeAiOauth;
  if (!oauth || !oauth.accessToken) {
    throw new Error(
      `${credPath} has no claudeAiOauth.accessToken — not logged in. ` +
      `Run cc-wasm \`/login\`, or set ANTHROPIC_API_KEY.`,
    );
  }

  let accessToken = oauth.accessToken;
  const needRefresh = typeof oauth.expiresAt === 'number' && Date.now() >= oauth.expiresAt - 60000;
  if (needRefresh && oauth.refreshToken) {
    stderr('wf-engine: OAuth token near expiry — refreshing…');
    try {
      const resp = await fetch(OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: oauth.refreshToken,
          client_id: OAUTH_CLIENT_ID,
        }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${await resp.text().catch(() => '')}`.trim());
      const tok = await resp.json();
      if (!tok.access_token) throw new Error('response missing access_token');
      // read-modify-write, preserving all other top-level keys (v/alg/iv/ct/tag/…).
      const fresh = JSON.parse(fs.readFileSync(credPath, 'utf8'));
      fresh.claudeAiOauth = {
        ...fresh.claudeAiOauth,
        accessToken: tok.access_token,
        refreshToken: tok.refresh_token || fresh.claudeAiOauth.refreshToken,
        expiresAt: Date.now() + (tok.expires_in || 0) * 1000,
      };
      fs.writeFileSync(credPath, JSON.stringify(fresh, null, 2), { mode: 0o600 });
      try { fs.chmodSync(credPath, 0o600); } catch {}
      accessToken = tok.access_token;
      stderr('wf-engine: token refreshed OK.');
    } catch (e) {
      stderr(`wf-engine: WARNING token refresh failed (${e.message}); using existing token (may still be valid).`);
    }
  }

  return { mode: 'oauth', token: accessToken, betas: [OAUTH_BETA] };
}

function makeClient(auth) {
  const opts = {
    maxRetries: 2,
    timeout: 600000,
    defaultHeaders: {
      'x-app': 'cli',
      'User-Agent': 'claude-cli/wf-engine',
    },
  };
  if (auth.mode === 'oauth') {
    opts.authToken = auth.token; // → Authorization: Bearer <token>
    opts.apiKey = null;
    opts.defaultHeaders['anthropic-beta'] = OAUTH_BETA;
  } else {
    opts.apiKey = auth.token;
  }
  return new Anthropic(opts);
}

// First text concatenated out of a Messages response.
function textOf(message) {
  if (!message || !Array.isArray(message.content)) return '';
  return message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

// Build a system prompt. In OAuth mode the FIRST block MUST begin with CC_PREFIX.
function systemFor(auth, instructions) {
  if (auth.mode === 'oauth') {
    return instructions ? `${CC_PREFIX}\n\n${instructions}` : CC_PREFIX;
  }
  // apiKey mode: no prefix requirement.
  return instructions || undefined;
}

// 1-token ping to verify the token is accepted before running anything.
async function authPing(client, auth) {
  const system = systemFor(auth, null);
  const req = {
    model: PING_MODEL,
    max_tokens: 1,
    messages: [{ role: 'user', content: 'ping' }],
  };
  if (system) req.system = system;
  await client.messages.create(req);
}

// ───────────────────────── concurrency semaphore ─────────────────────────
function makeSemaphore(max) {
  let active = 0;
  const q = [];
  const acquire = () =>
    new Promise((res) => {
      const tryRun = () => {
        if (active < max) { active++; res(); }
        else q.push(tryRun);
      };
      tryRun();
    });
  const release = () => {
    active--;
    const next = q.shift();
    if (next) next();
  };
  return { acquire, release };
}

// ───────────────────────── bash tool ─────────────────────────
function runBash(command, cwd, signal) {
  return new Promise((resolve) => {
    execFile(
      'bash', ['-lc', command],
      { cwd, timeout: AGENT_TIMEOUT_MS, maxBuffer: BASH_MAX_BUFFER, signal },
      (err, stdout, stderrOut) => {
        let out = (stdout || '') + (stderrOut || '');
        if (err) {
          // Never throw — return the error text as the result so the model can react.
          if (err.killed && err.signal === 'SIGTERM') out += `\n[bash: command timed out after ${AGENT_TIMEOUT_MS}ms]`;
          else if (err.code === 'ABORT_ERR' || (signal && signal.aborted)) out += `\n[bash: aborted]`;
          else if (typeof err.code === 'number') out += `\n[bash: exit code ${err.code}]`;
          else out += `\n[bash: ${err.message}]`;
        }
        if (out.length > BASH_OUTPUT_CAP) {
          out = out.slice(0, BASH_OUTPUT_CAP) + `\n…[output truncated at ${BASH_OUTPUT_CAP} chars]`;
        }
        if (out === '') out = '(no output)';
        resolve(out);
      },
    );
  });
}

const BASH_TOOL = {
  name: 'bash',
  description:
    'Execute a bash command in the repository working directory and return its combined ' +
    'stdout+stderr. Use this to read files (cat/sed/grep), edit them (sed -i, tee, heredocs), ' +
    'list/search the tree, and run builds/tests/linters. Output is capped.',
  input_schema: {
    type: 'object',
    properties: { command: { type: 'string', description: 'The bash command to run.' } },
    required: ['command'],
  },
};

// ───────────────────────── minimal JSON-schema check ─────────────────────────
// Lenient: validate top-level type + required keys; accept the object otherwise.
function schemaCheck(value, schema) {
  if (!isObj(schema)) return { ok: true };
  const t = schema.type;
  if (t === 'object') {
    if (!isObj(value)) return { ok: false, why: 'expected an object' };
    for (const k of schema.required || []) {
      if (!(k in value)) return { ok: false, why: `missing required property "${k}"` };
    }
  } else if (t === 'array') {
    if (!Array.isArray(value)) return { ok: false, why: 'expected an array' };
  } else if (t === 'string') {
    if (typeof value !== 'string') return { ok: false, why: 'expected a string' };
  } else if (t === 'number' || t === 'integer') {
    if (typeof value !== 'number') return { ok: false, why: 'expected a number' };
  } else if (t === 'boolean') {
    if (typeof value !== 'boolean') return { ok: false, why: 'expected a boolean' };
  }
  return { ok: true };
}

// ───────────────────────── the agent loop ─────────────────────────
function makeAgentRunner(client, auth, ctxState) {
  // ctxState: { project, defaultModel, maxTurns, abort, usage, sem }
  return async function agent(prompt, opts = {}) {
    if (typeof prompt !== 'string' || !prompt) {
      throw new Error('agent(prompt): prompt must be a non-empty string');
    }
    if (!isObj(opts)) opts = {};
    if (ctxState.usage.agentCount >= LIFETIME_AGENT_CAP) {
      throw new Error(`agent lifetime cap reached (${LIFETIME_AGENT_CAP} agents)`);
    }
    ctxState.usage.agentCount++;

    const label = opts.label || ctxState.currentPhase || `agent#${ctxState.usage.agentCount}`;
    const model = opts.model || ctxState.defaultModel;
    const schema = isObj(opts.schema) ? opts.schema : null;

    // Resume key (computed synchronously, before any await, so admission order
    // is deterministic). Content-based: (prompt, schema, model) + an occurrence
    // index disambiguating identical calls. label/phase are display-only and
    // excluded, so re-labeling doesn't bust the cache. On --resume, a key that
    // was journaled in the prior run is served from cache (no API call).
    const contentKey = sha256(prompt + '\0' + stableStringify({ schema: schema || null, model }));
    const occ = ctxState.occ.get(contentKey) || 0;
    ctxState.occ.set(contentKey, occ + 1);
    const cacheKey = sha256(contentKey + '\0' + occ);
    if (ctxState.resumeMap && ctxState.resumeMap.has(cacheKey)) {
      ctxState.usage.cached = (ctxState.usage.cached || 0) + 1;
      stderr(`   ▸ agent[${label}] cached (resume hit)`);
      return ctxState.resumeMap.get(cacheKey);
    }

    await ctxState.sem.acquire();
    const t0 = Date.now();
    stderr(`   ▸ agent[${label}] start (model=${model}${schema ? ', schema' : ''})`);
    try {
      const instructions =
        `You are a sub-agent in an automated workflow. Your FINAL message is consumed ` +
        `programmatically (not shown to a human) — return exactly what is asked, no preamble. ` +
        `You are working in the repository at ${ctxState.project}. Use the bash tool to ` +
        `inspect/modify files and run commands. Be efficient.` +
        (schema
          ? ` When done, call submit_result exactly once with your final answer; do not answer in prose.`
          : '');
      const system = systemFor(auth, instructions);

      const tools = [BASH_TOOL];
      if (schema) {
        tools.push({
          name: 'submit_result',
          description: 'Submit your final structured answer. Call this exactly once when done.',
          input_schema: schema,
        });
      }

      const messages = [{ role: 'user', content: prompt }];
      let result = schema ? null : '';

      for (let turn = 0; turn < ctxState.maxTurns; turn++) {
        if (ctxState.abort.signal.aborted) { stderr(`   ▸ agent[${label}] aborted`); return null; }

        let resp;
        try {
          const req = { model, max_tokens: AGENT_MAX_TOKENS, messages, tools };
          if (system) req.system = system;
          resp = await client.messages.create(req, { signal: ctxState.abort.signal });
        } catch (e) {
          if (e instanceof Anthropic.APIUserAbortError) { stderr(`   ▸ agent[${label}] aborted`); return null; }
          // Terminal API error after the SDK's own retries → resolve null, warn.
          stderr(`   ▸ agent[${label}] WARNING API error: ${e.message} → null`);
          return null;
        }

        // Accumulate usage.
        if (resp.usage) {
          ctxState.usage.inputTokens += resp.usage.input_tokens || 0;
          ctxState.usage.outputTokens += resp.usage.output_tokens || 0;
        }

        if (resp.stop_reason === 'refusal') {
          stderr(`   ▸ agent[${label}] WARNING model refused → null`);
          return null;
        }

        const toolUses = resp.content.filter((b) => b.type === 'tool_use');
        if (resp.stop_reason !== 'tool_use' || toolUses.length === 0) {
          // Final turn. Without schema → concatenated text. With schema but no
          // submit_result call → null.
          if (!schema) result = textOf(resp);
          break;
        }

        // Execute each tool_use, append assistant + a user tool_result message.
        messages.push({ role: 'assistant', content: resp.content });
        const toolResults = [];
        let submitted = false;
        let submittedValue = null;

        for (const tu of toolUses) {
          ctxState.usage.toolCalls++;
          if (tu.name === 'bash') {
            const cmd = tu.input && typeof tu.input.command === 'string' ? tu.input.command : '';
            const out = cmd
              ? await runBash(cmd, ctxState.project, ctxState.abort.signal)
              : '[bash: missing "command" string]';
            toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: out });
          } else if (tu.name === 'submit_result' && schema) {
            const chk = schemaCheck(tu.input, schema);
            if (chk.ok) {
              submitted = true;
              submittedValue = tu.input;
              toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: 'OK' });
            } else {
              toolResults.push({
                type: 'tool_result', tool_use_id: tu.id, is_error: true,
                content: `Invalid submit_result: ${chk.why}. Fix and call submit_result again.`,
              });
            }
          } else {
            toolResults.push({
              type: 'tool_result', tool_use_id: tu.id, is_error: true,
              content: `Unknown tool "${tu.name}".`,
            });
          }
        }
        messages.push({ role: 'user', content: toolResults });

        if (submitted) { result = submittedValue; break; }
      }

      const dt = Date.now() - t0;
      stderr(`   ▸ agent[${label}] done (${dt}ms)`);
      // Journal non-null results so a later --resume can serve them from cache.
      // null (refusal / skip / API error) is NOT journaled, so it re-runs.
      if (result !== null && result !== undefined && ctxState.journalAppend) {
        ctxState.journalAppend({ key: cacheKey, label, result });
      }
      return result;
    } finally {
      ctxState.sem.release();
    }
  };
}

// ───────────────────────── meta parsing ─────────────────────────
// Locate `export const meta`, brace-match the object literal (respecting
// quotes/escapes/template strings), eval the literal, return { meta, body }.
function parseWorkflow(src) {
  const i = src.indexOf('export const meta');
  if (i === -1) throw new Error('script must start with `export const meta = {...}`');
  const b = src.indexOf('{', i);
  if (b === -1) throw new Error('could not find the meta object literal `{`');

  let depth = 0, q = null, esc = false, end = -1;
  for (let j = b; j < src.length; j++) {
    const ch = src[j];
    if (q) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === q) q = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') q = ch;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
  }
  if (end === -1) throw new Error('could not brace-match the meta object literal');

  const literal = src.slice(b, end);
  let meta;
  try {
    // Pure object literal — evaluate in a throwaway sandbox (no access to anything).
    meta = runInContext(`(${literal})`, createContext(Object.create(null)), { timeout: 1000 });
  } catch (e) {
    throw new Error(`meta is not a valid object literal: ${e.message}`);
  }
  if (!isObj(meta)) throw new Error('meta must be an object literal');
  if (!meta.name || typeof meta.name !== 'string') throw new Error('meta.name is required (string)');
  if (!meta.description || typeof meta.description !== 'string') throw new Error('meta.description is required (string)');

  // Body = everything after the literal, with a leading `;`/blank line trimmed.
  let body = src.slice(end).replace(/^[;\s]*\n/, '');
  // Reject TypeScript-y bodies via a Function() syntax pre-check.
  try {
    // eslint-disable-next-line no-new, no-new-func
    new Function(`async function __c(){'use strict';\n${body}\n}`);
  } catch (e) {
    throw new Error(`workflow body has a syntax error (TypeScript not allowed): ${e.message}`);
  }
  return { meta, body };
}

// ───────────────────────── workflow resolution ─────────────────────────
function resolveWorkflowFile(nameOrRef, project) {
  if (isObj(nameOrRef) && nameOrRef.scriptPath) {
    return path.resolve(nameOrRef.scriptPath);
  }
  const name = typeof nameOrRef === 'string' ? nameOrRef : (nameOrRef && nameOrRef.name);
  if (!name) return null;
  const dirs = [
    path.join(project, '.claude', 'workflows'),
    path.join(os.homedir(), '.claude', 'workflows'),
    path.join(os.homedir(), '.cc-wasm', 'workflows'),
    // bundled templates shipped with this package (roadmap / security-audit /
    // codebase-survey) — resolvable by --name out of the box.
    path.join(path.dirname(new URL(import.meta.url).pathname), 'workflows'),
  ];
  for (const d of dirs) {
    for (const ext of ['.js', '.mjs']) {
      const p = path.join(d, name + ext);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

// ───────────────────────── the executor ─────────────────────────
// Runs a parsed workflow body inside a node:vm with all globals injected.
// `nestDepth` enforces one-level workflow() nesting.
async function executeWorkflow({ client, auth, body, project, args, defaultModel, maxTurns, abort, usage, sem, nestDepth, journalAppend, resumeMap, occ }) {
  const ctxState = {
    project, defaultModel, maxTurns, abort, usage, sem, currentPhase: null,
    journalAppend, resumeMap, occ,
  };
  const agent = makeAgentRunner(client, auth, ctxState);

  function log(msg) { stderr(`   • ${msg == null ? '' : String(msg)}`); }
  function phase(title) {
    ctxState.currentPhase = title == null ? null : String(title);
    stderr(`── phase: ${ctxState.currentPhase} ──`);
  }

  function checkCollection(items, who) {
    if (!Array.isArray(items)) throw new Error(`${who}(items): items must be an array`);
    if (items.length > COLLECTION_CAP) throw new Error(`${who}: at most ${COLLECTION_CAP} items (got ${items.length})`);
  }

  async function parallel(thunks) {
    checkCollection(thunks, 'parallel');
    return Promise.all(thunks.map(async (t) => {
      try { return typeof t === 'function' ? await t() : await t; }
      catch { return null; } // each throw → null; never reject.
    }));
  }

  async function pipeline(items, ...stages) {
    checkCollection(items, 'pipeline');
    // Each item flows through all stages; a throw drops it to null and skips
    // remaining stages. No barrier between stages.
    return Promise.all(items.map(async (orig, index) => {
      let prev = orig;
      for (const stage of stages) {
        if (typeof stage !== 'function') continue;
        try { prev = await stage(prev, orig, index); }
        catch { return null; }
      }
      return prev;
    }));
  }

  async function workflow(nameOrRef, subArgs) {
    if (nestDepth >= 1) throw new Error('workflow(): one-level nesting only (cannot nest deeper)');
    const file = resolveWorkflowFile(nameOrRef, project);
    if (!file) throw new Error(`workflow(): could not resolve "${typeof nameOrRef === 'string' ? nameOrRef : JSON.stringify(nameOrRef)}"`);
    let subSrc;
    try { subSrc = fs.readFileSync(file, 'utf8'); }
    catch (e) { throw new Error(`workflow(): cannot read ${file}: ${e.message}`); }
    const { body: subBody } = parseWorkflow(subSrc);
    stderr(`── workflow(${path.basename(file)}) [nested] ──`);
    // Reuse the SAME usage/sem/abort/journal/occ so caps, accounting, and
    // resume are global across nested workflows.
    return executeWorkflow({
      client, auth, body: subBody, project, args: subArgs === undefined ? null : subArgs,
      defaultModel, maxTurns, abort, usage, sem, nestDepth: nestDepth + 1,
      journalAppend, resumeMap, occ,
    });
  }

  const budget = { total: null, spent: () => 0, remaining: () => Infinity };

  // Determinism bans (match cc-wasm): Date.now / Math.random / argless new Date throw.
  const BAN = (what) =>
    () => { throw new Error(`${what} is unavailable in workflow scripts (breaks reproducibility); use deterministic logic instead`); };

  const SafeMath = Object.create(Math);
  SafeMath.random = BAN('Math.random()');

  const RealDate = Date;
  function SafeDate(...a) {
    if (!(this instanceof SafeDate)) {
      // Date(...) called as a function.
      throw new Error('Date() as a function is unavailable in workflow scripts (breaks reproducibility)');
    }
    if (a.length === 0) {
      throw new Error('argless new Date() is unavailable in workflow scripts (breaks reproducibility); pass an explicit timestamp');
    }
    return new RealDate(...a);
  }
  SafeDate.prototype = RealDate.prototype;
  SafeDate.parse = RealDate.parse;
  SafeDate.UTC = RealDate.UTC;
  SafeDate.now = BAN('Date.now()');

  // Sandbox globals — standard JS built-ins, NO require/import/process/fs.
  const sandbox = {
    // injected workflow API
    agent, parallel, pipeline, log, phase, workflow, budget,
    args: args === undefined ? null : args,
    // determinism-safe built-ins
    Math: SafeMath,
    Date: SafeDate,
    // standard built-ins
    JSON, Array, Object, String, Number, Boolean, RegExp, Map, Set, WeakMap, WeakSet,
    Promise, Symbol, Error, TypeError, RangeError, SyntaxError,
    parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
    Infinity, NaN, undefined,
    console: { log: (...a) => log(a.join(' ')), error: (...a) => stderr('   • ' + a.join(' ')), warn: (...a) => stderr('   • ' + a.join(' ')) },
  };
  sandbox.globalThis = sandbox;

  const context = createContext(sandbox, {
    codeGeneration: { strings: false, wasm: false },
  });

  const wrapped = `(async () => { 'use strict';\n${body}\n})()`;
  return runInContext(wrapped, context, { filename: 'workflow.js' });
}

// ───────────────────────── CLI ─────────────────────────
function parseArgs(argv) {
  const o = { model: DEFAULT_MODEL, maxTurns: DEFAULT_MAX_TURNS, timeout: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--project': o.project = next(); break;
      case '--script': o.script = next(); break;
      case '--name': o.name = next(); break;
      case '--inline': o.inline = next(); break;
      case '--args': o.args = next(); break;
      case '--model': o.model = next(); break;
      case '--max-turns': o.maxTurns = parseInt(next(), 10); break;
      case '--timeout': o.timeout = parseInt(next(), 10); break;
      case '--save': o.save = true; break;
      case '--prepare': case '--dry-run': o.prepare = true; break;
      case '--resume': o.resume = next(); break;
      case '-h': case '--help': o.help = true; break;
      default: throw new Error(`unknown arg: ${a}`);
    }
  }
  return o;
}

const HELP = `wf-engine — standalone dynamic-workflow runner (no cc-wasm bundle).

Usage:
  wf-engine --project DIR (--script FILE | --name NAME | --inline 'JS')
            [--args JSON] [--model ID] [--max-turns N] [--timeout SEC]

  --project DIR    Codebase to run against (the workflow cwd). Required.
  --script FILE    Path to a workflow .js (starts with \`export const meta\`).
  --name NAME      Saved workflow (resolved from DIR/.claude/workflows, then
                   ~/.claude/workflows, then ~/.cc-wasm/workflows).
  --inline 'JS'    Inline workflow source.
  --args JSON      Value exposed to the script as the \`args\` global.
  --model ID       Model for subagents (default ${DEFAULT_MODEL}).
  --max-turns N    Max tool-use turns per agent (default ${DEFAULT_MAX_TURNS}).
  --timeout SEC    Hard wall-clock cap for the whole run (aborts agents).
  --save           Also save the workflow into DIR/.claude/workflows/<name>.js
                   (reusable as --name <name>).
  --prepare        Validate + (with --save) write the workflow on disk, print
    (--dry-run)    its paths, and EXIT without running. No API call.
  --resume RUNID   Resume a prior run: agent() calls whose (prompt, schema,
                   model) match the journaled run return cached results; only
                   new/changed calls hit the API. Reuses RUNID.

Saved workflows resolve from DIR/.claude/workflows, ~/.claude/workflows,
~/.cc-wasm/workflows, then this package's bundled workflows/ (roadmap,
security-audit, codebase-survey).

Auth: reuses cc-wasm OAuth in ~/.claude/.credentials.json (auto-refresh).
      Set ANTHROPIC_API_KEY to override.`;

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); }
  catch (e) { stderr(`wf-engine: ${e.message}`); stderr(HELP); process.exit(2); }
  if (opts.help) { console.log(HELP); process.exit(0); }

  if (!opts.project) { stderr('wf-engine: --project DIR is required'); process.exit(2); }
  let project;
  try { project = fs.realpathSync(opts.project); }
  catch { stderr(`wf-engine: project dir not found: ${opts.project}`); process.exit(2); }

  const sel = [opts.script, opts.name, opts.inline].filter(Boolean);
  if (sel.length !== 1) { stderr('wf-engine: provide exactly one of --script / --name / --inline'); process.exit(2); }

  // Resolve the source.
  let src, scriptPath;
  if (opts.script) {
    scriptPath = path.resolve(opts.script);
    try { src = fs.readFileSync(scriptPath, 'utf8'); }
    catch (e) { stderr(`wf-engine: cannot read --script ${scriptPath}: ${e.message}`); process.exit(2); }
  } else if (opts.name) {
    scriptPath = resolveWorkflowFile(opts.name, project);
    if (!scriptPath) { stderr(`wf-engine: no saved workflow "${opts.name}.js" in project/user dirs`); process.exit(2); }
    src = fs.readFileSync(scriptPath, 'utf8');
  } else {
    scriptPath = `<inline:${opts.name || 'workflow'}>`;
    src = opts.inline;
  }

  // Parse args JSON.
  let argsVal = null;
  if (opts.args != null) {
    try { argsVal = JSON.parse(opts.args); }
    catch { argsVal = opts.args; } // accept a raw string
  }

  // Parse + validate the workflow.
  let parsed;
  try { parsed = parseWorkflow(src); }
  catch (e) { stderr(`wf-engine: ${e.message}`); process.exit(2); }
  const { meta, body } = parsed;

  // Run artifacts (snapshots + journals) live in the tool's OWN home, NOT in
  // cc-wasm's config dir — wf-engine only *reads* ~/.claude for the OAuth login.
  // Override with WF_ENGINE_HOME.
  const WF_HOME = process.env.WF_ENGINE_HOME || path.join(os.homedir(), '.wf-engine');
  const snapDir = path.join(WF_HOME, 'runs', mungeProject(project));
  const savedPath = path.join(project, '.claude', 'workflows', `${meta.name}.js`);

  // --save: write the workflow into the project as a named workflow.
  if (opts.save) {
    try {
      fs.mkdirSync(path.dirname(savedPath), { recursive: true });
      fs.writeFileSync(savedPath, src);
      stderr(`wf-engine: saved workflow → ${savedPath} (run: --name ${meta.name})`);
    } catch (e) { stderr(`wf-engine: WARNING could not save workflow: ${e.message}`); }
  }

  // --prepare/--dry-run: validated (above) + optionally saved; print paths and
  // EXIT without auth or any run. No API call.
  if (opts.prepare) {
    const out = [
      '----- prepared workflow -----',
      `workflow  : ${meta.name}`,
      `status    : prepared (validated, not run)`,
      `scriptPath: ${scriptPath}`,
    ];
    if (opts.save) out.push(`saved     : ${savedPath}`);
    out.push(`result    : null`);
    out.push(`snapshots : ${snapDir}/wf_<id>.json   (created on a run)`);
    out.push(`run now   : wf-engine --project '${project}' ` + (opts.save ? `--name ${meta.name}` : opts.script ? `--script ${scriptPath}` : `--name ${meta.name}`));
    process.stdout.write(out.join('\n') + '\n');
    process.exit(0);
  }

  // Auth.
  let auth, client;
  try {
    auth = await resolveAuth();
    client = makeClient(auth);
    stderr(`wf-engine: auth mode=${auth.mode}; verifying token with a ${PING_MODEL} ping…`);
    await authPing(client, auth);
    stderr('wf-engine: auth OK (token accepted).');
  } catch (e) {
    const isAuth = e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError;
    stderr(`wf-engine: AUTH FAILED — ${e.message}`);
    if (isAuth) {
      stderr('wf-engine: the API rejected the token. Re-login with cc-wasm `/login` to refresh, ' +
             'or set ANTHROPIC_API_KEY to use a raw key.');
    }
    process.exit(1);
  }

  // Run.
  if (opts.resume && !/^wf_[a-z0-9-]{6,}$/.test(opts.resume)) {
    stderr('wf-engine: --resume must be a run id like wf_xxxxxxxxxxxx'); process.exit(2);
  }
  const id = opts.resume || runId();
  const journalPath = path.join(snapDir, `${id}.journal.jsonl`);
  let resumeMap = null;
  if (opts.resume) {
    resumeMap = new Map();
    try {
      for (const ln of fs.readFileSync(journalPath, 'utf8').split('\n')) {
        if (!ln) continue;
        try { const r = JSON.parse(ln); if (r && r.key) resumeMap.set(r.key, r.result); } catch {}
      }
      stderr(`wf-engine: resume ${id} — loaded ${resumeMap.size} cached agent result(s)`);
    } catch (e) {
      stderr(`wf-engine: --resume ${id}: no journal at ${journalPath} (${e.code || e.message}); running fresh with this id`);
    }
  }
  try { fs.mkdirSync(snapDir, { recursive: true }); } catch {}
  // Journal every non-null agent result so a later --resume can replay it.
  const journalAppend = (rec) => { try { fs.appendFileSync(journalPath, JSON.stringify(rec) + '\n'); } catch {} };
  const occ = new Map();

  const abort = new AbortController();
  const usage = { agentCount: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, cached: 0 };
  const sem = makeSemaphore(Math.min(16, Math.max(2, os.cpus().length - 2)));

  let timer = null;
  if (opts.timeout && opts.timeout > 0) {
    timer = setTimeout(() => { stderr(`wf-engine: timeout ${opts.timeout}s reached — aborting`); abort.abort(); }, opts.timeout * 1000);
  }

  stderr(`wf-engine: runId=${id} workflow=${meta.name} model=${opts.model} project=${project}`);
  if (Array.isArray(meta.phases) && meta.phases.length) {
    stderr(`wf-engine: phases: ${meta.phases.map((p) => p.title || p).join(' → ')}`);
  }

  const t0 = Date.now();
  let status = 'completed', result = null, errMsg = null;
  try {
    result = await executeWorkflow({
      client, auth, body, project, args: argsVal,
      defaultModel: opts.model, maxTurns: opts.maxTurns, abort, usage, sem, nestDepth: 0,
      journalAppend, resumeMap, occ,
    });
  } catch (e) {
    status = 'failed';
    errMsg = e && e.message ? e.message : String(e);
    stderr(`wf-engine: workflow FAILED: ${errMsg}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (abort.signal.aborted && status === 'completed') status = 'failed';
  const durationMs = Date.now() - t0;
  const totalTokens = usage.inputTokens + usage.outputTokens;

  // Write snapshot. (snapDir was computed earlier, before the run.)
  const snapPath = path.join(snapDir, `${id}.json`);
  const snapshot = {
    runId: id,
    workflowName: meta.name,
    status,
    result,
    error: errMsg,
    agentCount: usage.agentCount,
    cachedAgents: usage.cached || 0,
    totalTokens,
    totalToolCalls: usage.toolCalls,
    durationMs,
    scriptPath,
    journalPath,
    timestamp: new Date().toISOString(),
  };
  try {
    fs.mkdirSync(snapDir, { recursive: true });
    fs.writeFileSync(snapPath, JSON.stringify(snapshot, null, 2));
  } catch (e) {
    stderr(`wf-engine: WARNING could not write snapshot: ${e.message}`);
  }

  // Result block to stdout (wf-run style).
  const lines = [
    '----- workflow result -----',
    `runId    : ${id}`,
    `workflow : ${meta.name}`,
    `status   : ${status}`,
    `agents   : ${usage.agentCount}${usage.cached ? ` (${usage.cached} cached)` : ''}   tokens: ${totalTokens}   toolCalls: ${usage.toolCalls}   durationMs: ${durationMs}`,
  ];
  if (errMsg) lines.push(`error    : ${errMsg}`);
  lines.push(`result   : ${pretty(result, 4000)}`);
  lines.push(`snapshot : ${snapPath}`);
  lines.push(`resume   : wf-engine --project '${project}' ${opts.script ? `--script ${scriptPath}` : `--name ${meta.name}`} --resume ${id}`);
  process.stdout.write(lines.join('\n') + '\n');

  process.exit(status === 'completed' ? 0 : 1);
}

main().catch((e) => { stderr(`wf-engine: FATAL ${e && e.stack ? e.stack : e}`); process.exit(1); });

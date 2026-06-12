export const meta = {
  name: 'roadmap',
  description: 'Read ROADMAP.md and start working on it: parse open items, work each in priority order, verify, write a PROGRESS report',
  whenToUse: 'When you have a ROADMAP.md (or similar task list) in a repo and want a multi-agent pass that actually works through its open items.',
  phases: [
    { title: 'Read', detail: 'parse ROADMAP.md into actionable items' },
    { title: 'Work', detail: 'one agent per open item, priority order' },
    { title: 'Verify', detail: 'confirm each item was actually addressed' },
    { title: 'Report', detail: 'write PROGRESS.md + updated status table' },
  ],
}

// args (all optional): { file?: 'ROADMAP.md', limit?: 8, mode?: 'apply'|'plan' }
//   file  — the roadmap file to read (default ROADMAP.md)
//   limit — max open items to work this run (default 8)
//   mode  — 'apply' (default): actually make the changes; 'plan': only propose
const FILE = (args && args.file) || 'ROADMAP.md'
const LIMIT = (args && typeof args.limit === 'number') ? args.limit : 8
const MODE = (args && args.mode === 'plan') ? 'plan' : 'apply'

const ITEMS_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          detail: { type: 'string' },
          priority: { type: 'string' }, // high | medium | low
          status: { type: 'string' },   // todo | in-progress | done
        },
        required: ['title'],
      },
    },
  },
  required: ['items'],
}

const WORK_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    summary: { type: 'string' },
    filesTouched: { type: 'array', items: { type: 'string' } },
    complete: { type: 'boolean' },
    followUp: { type: 'string' },
  },
  required: ['summary', 'complete'],
}

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    verdict: { type: 'string' }, // done | partial | not-done
    notes: { type: 'string' },
  },
  required: ['verdict'],
}

phase('Read')
log('reading ' + FILE)
const parsed = await agent(
  'Read ' + FILE + ' in this repository. Extract its actionable items as structured data — for each: a short kebab id, title, what needs doing (detail), priority (high/medium/low), and current status (todo/in-progress/done). ' +
    'Infer priority/status from headings, checkboxes ([ ]/[x]), or "Status:" lines. If ' + FILE + ' does not exist, return {items: []}.',
  { label: 'parse-roadmap', schema: ITEMS_SCHEMA },
)
const rank = { high: 0, medium: 1, med: 1, low: 2 }
const open = ((parsed && parsed.items) || [])
  .filter(it => !/done|complete|\[x\]/i.test(String(it.status || '')))
  .sort((a, b) => (rank[String(a.priority || '').toLowerCase()] ?? 1) - (rank[String(b.priority || '').toLowerCase()] ?? 1))
  .slice(0, LIMIT)
log(open.length + ' open item(s) to ' + (MODE === 'plan' ? 'plan' : 'work') + ' (of ' + ((parsed && parsed.items || []).length) + ' total)')

if (open.length === 0) {
  return { file: FILE, itemsWorked: 0, note: 'No open items found in ' + FILE + ' (missing file or all done).' }
}

phase('Work')
const instruction = MODE === 'plan'
  ? 'Investigate the relevant code and produce a concrete implementation PLAN (files to change, the approach, risks). Do NOT edit files.'
  : 'Investigate the relevant code, IMPLEMENT the change (edit files), and run any quick checks (build/lint/tests) you can. Keep the change focused on this item.'
const worked = await pipeline(open, (it, _orig, i) =>
  agent(
    'Work on this ROADMAP item in the current repository.\nItem: ' + JSON.stringify(it) + '\n\n' + instruction +
      '\nThen report: what you did, which files you touched, whether it is complete, and any follow-up needed.',
    { label: 'work:' + (it.id || it.title || ('#' + i)), phase: 'Work', schema: WORK_SCHEMA },
  ).then(w => (w ? { item: it, ...w } : { item: it, summary: '(agent returned nothing)', complete: false })),
)

phase('Verify')
const verified = await pipeline(worked.filter(Boolean), (w, _orig, i) =>
  agent(
    'Verify the work claimed for ROADMAP item "' + (w.id || (w.item && w.item.title) || ('#' + i)) + '". ' +
      'Re-read the affected files and decide whether the change is real, correct, and complete. Be skeptical. ' +
      'Claimed work: ' + JSON.stringify({ summary: w.summary, filesTouched: w.filesTouched, complete: w.complete }),
    { label: 'verify:' + (w.id || ('#' + i)), phase: 'Verify', schema: VERIFY_SCHEMA },
  ).then(v => ({ ...w, verify: v || { verdict: 'unknown' } })),
)

phase('Report')
const report = await agent(
  'Write a concise PROGRESS.md to the repository root summarizing this work session driven by ' + FILE + '. ' +
    'Use the Write tool to create/overwrite PROGRESS.md. For each item include: title, what was done, files touched, verification verdict, and remaining follow-ups. ' +
    'End the file with an "Updated status" markdown table (item | status | notes) suitable for pasting back into ' + FILE + '. ' +
    'After writing it, reply with just the absolute path you wrote.\n\nResults: ' + JSON.stringify(verified),
  { label: 'write-progress', phase: 'Report' },
)

return {
  file: FILE,
  mode: MODE,
  itemsWorked: verified.length,
  completed: verified.filter(w => w.verify && /done/i.test(String(w.verify.verdict))).length,
  reportPath: typeof report === 'string' ? report.trim() : null,
  items: verified.map(w => ({
    id: w.id || (w.item && w.item.title),
    complete: w.complete,
    verdict: w.verify && w.verify.verdict,
    filesTouched: w.filesTouched || [],
    followUp: w.followUp || '',
  })),
}

export const meta = {
  name: 'security-audit',
  description: 'Multi-agent security audit of a codebase',
  phases: [
    { title: 'Map', detail: 'enumerate high-risk areas' },
    { title: 'Audit', detail: 'one auditor per area' },
    { title: 'Verify', detail: 'adversarially confirm each finding' },
  ],
}

const AREAS_SCHEMA = {
  type: 'object',
  properties: {
    areas: {
      type: 'array',
      items: {
        type: 'object',
        properties: { path: { type: 'string' }, why: { type: 'string' } },
        required: ['path'],
      },
    },
  },
  required: ['areas'],
}

const BUGS_SCHEMA = {
  type: 'object',
  properties: {
    bugs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          severity: { type: 'string' },
          detail: { type: 'string' },
          location: { type: 'string' },
        },
        required: ['title', 'severity'],
      },
    },
  },
  required: ['bugs'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string' },
    reason: { type: 'string' },
  },
  required: ['verdict'],
}

phase('Map')
log('mapping the attack surface')
const surface = await agent(
  'Survey this codebase. Identify the modules/contracts and the highest-risk areas (auth, money movement, access control, external calls, parsing, crypto). Return the top areas to audit.',
  { label: 'attack-surface', schema: AREAS_SCHEMA },
)
const areas = (surface && surface.areas) || []
log(areas.length + ' areas to audit')

phase('Audit')
const found = await parallel(
  areas.map(a => () =>
    agent(
      'Audit ' + a.path + ' for security vulnerabilities' +
        (a.why ? ' (flagged because: ' + a.why + ')' : '') +
        '. Read the actual code. Report concrete bugs with severity and exact location.',
      { label: 'audit:' + a.path, phase: 'Audit', schema: BUGS_SCHEMA },
    ),
  ),
)
const allBugs = found.filter(Boolean).flatMap(f => f.bugs || [])
log(allBugs.length + ' candidate findings')

phase('Verify')
const checked = await pipeline(allBugs, (bug, _orig, i) =>
  agent(
    'Adversarially verify this security finding. Read the actual code and decide if it is REAL or a FALSE POSITIVE. Be skeptical. Finding: ' +
      JSON.stringify(bug),
    { label: 'verify #' + i, phase: 'Verify', schema: VERDICT_SCHEMA },
  ).then(v => (v ? { ...bug, verdict: v.verdict, why: v.reason } : null)),
)
const confirmed = checked
  .filter(Boolean)
  .filter(b => /real|confirm|valid|true/i.test(String(b.verdict)))

return {
  areasAudited: areas.length,
  candidates: allBugs.length,
  confirmed,
}

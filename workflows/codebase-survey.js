export const meta = {
  name: 'codebase-survey',
  description: 'Survey a repository: map its structure, stack, and entry points, then summarize',
  whenToUse: 'A quick, read-only orientation pass over an unfamiliar codebase.',
  phases: [
    { title: 'Map', detail: 'inventory the repo' },
    { title: 'Summarize', detail: 'one synthesized overview' },
  ],
}

const MAP_SCHEMA = {
  type: 'object',
  properties: {
    stack: { type: 'string' },
    entryPoints: { type: 'array', items: { type: 'string' } },
    topDirs: { type: 'array', items: { type: 'string' } },
    notable: { type: 'array', items: { type: 'string' } },
  },
  required: ['stack', 'topDirs'],
}

phase('Map')
log('inventorying the repository')
const map = await agent(
  'Survey the repository in the current directory (read-only). Use bash (ls, find, cat package.json / go.mod / Cargo.toml, etc.) to determine: the tech stack, the main entry points, the top-level directories and what they hold, and anything notable (build system, tests, CI). Do not modify anything.',
  { label: 'inventory', schema: MAP_SCHEMA },
)

phase('Summarize')
const overview = await agent(
  'Write a concise architectural overview of this repository for a new contributor, based on this inventory: ' +
    JSON.stringify(map) +
    '. Cover what it is, how it is structured, where to start reading, and how to build/test it.',
  { label: 'overview' },
)

return { map, overview }

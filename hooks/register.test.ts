import { expect, test } from 'claude-code/testing'

import { parseRefs, refState, branchSentence, classify, groupStatus, parseStatus, shortCmd, statusVerb, findPr, isoAge, readCfg, openPrTo, parseChecks, parseJobs, parsePrs, summarize, vercelItem } from './model'
import { bodySvg, funnelSvg, headerSvg, pathSvg } from './svg'
import type { CardSpec } from './svg'

test('parsePrs lists open PRs first and reads each check', () => {
  const list = parsePrs(
    JSON.stringify([
      { number: 58, title: 'old', headRefName: 'develop', baseRefName: 'master', url: 'u58', state: 'CLOSED' },
      {
        number: 57,
        title: 'sièges',
        headRefName: 'develop',
        baseRefName: 'staging',
        url: 'u57',
        state: 'OPEN',
        statusCheckRollup: [
          { name: 'web', status: 'COMPLETED', conclusion: 'SUCCESS' },
          { name: 'rules', status: 'IN_PROGRESS', conclusion: '' },
          { name: null },
        ],
      },
    ]),
  )
  expect(list[0]?.number).toBe(57)
  expect(list[0]?.checks).toBe('pending')
  expect(list[0]?.checkList).toEqual([
    { name: 'web', state: 'ok' },
    { name: 'rules', state: 'run' },
  ])
  expect(findPr(list, 'develop', 'staging')?.number).toBe(57)
  expect(openPrTo(list, 'master')).toBe(undefined)
})

test('a failing check turns the PR red', () => {
  expect(parseChecks([{ name: 'web', status: 'COMPLETED', conclusion: 'FAILURE' }])).toEqual([{ name: 'web', state: 'fail' }])
})

test('deploy jobs keep the four deploy steps and their state', () => {
  const items = parseJobs([
    { name: 'changes', status: 'completed', conclusion: 'success' },
    { name: 'deploy-functions', status: 'completed', conclusion: 'failure', completedAt: '2026-10-07T16:58:30Z' },
    { name: 'deploy-flutter', status: 'completed', conclusion: 'skipped' },
    { name: 'deploy-rules', status: 'in_progress', conclusion: null },
  ])
  expect(items.map(i => [i.label, i.state])).toEqual([
    ['Functions', 'fail'],
    ['Flutter', 'skipped'],
    ['Règles', 'run'],
  ])
  const env = { runId: 1, runUrl: '', sha: 'abc', items, at: null }
  expect(summarize(env)).toBe('fail')
  expect(summarize(null)).toBe('none')
  expect(vercelItem('success', 'u', undefined)?.state).toBe('ok')
  expect(vercelItem(undefined, '', undefined)).toBe(null)
})

test('isoAge is short and French', () => {
  const now = Date.parse('2026-10-07T12:00:00Z')
  expect(isoAge('2026-10-07T11:57:00Z', now)).toBe('3 min')
  expect(isoAge('2026-10-07T07:00:00Z', now)).toBe('5 h')
})

test('a card is a one-line header plus a body that only exists when it is open', () => {
  const base: Omit<CardSpec, 'rows'> = { color: 'blue', node: 'stage', rail: 6, railPrev: 7, railNext: 5, reached: true, isCurrent: true, title: 'origin/develop', pills: [{ text: '5', kind: 'blue' }], meta: 'en attente de staging' }
  const rows: CardSpec['rows'] = [{ t: 'commit', sha: '6a7d4fb1', text: 'feat(sieges): jalons 2 et 3', age: '1 h' }, { t: 'note', text: '… et 2 de plus' }]
  const head = headerSvg({ ...base, rows })
  expect(head.source.startsWith('<svg')).toBe(true)
  expect(head.height).toBe(30)
  expect(head.source).toContain('origin/develop')
  expect(bodySvg({ ...base, rows: null })).toBe(null)
  expect(bodySvg({ ...base, rows })?.source).toContain('6a7d4fb1')
  expect(funnelSvg({ branches: 4, develop: 5, staging: 0, prodOk: true, current: 1 }).source).toContain('branches')
})

test('text is escaped in the picture', () => {
  const c = headerSvg({ color: 'green', node: 'src', rail: 3, railPrev: 3, railNext: 3, reached: true, isCurrent: false, title: 'a<b>&c', pills: [], meta: '', rows: null })
  expect(c.source).toContain('a&lt;b&gt;&amp;c')
})

test('options have neutral defaults and can be overridden', () => {
  const d = readCfg(undefined)
  expect([d.dev, d.stg, d.mst, d.stgWorkflow, d.runbook]).toEqual(['develop', 'staging', 'master', 'deploy-staging.yml', 'docs/prod-promotion-runbook.md'])
  const o = readCfg({ integrationBranch: 'main', stagingBranch: 'preview', stagingWorkflow: '', protectedBranches: 'main, release', ignoreJobs: '' })
  expect([o.dev, o.stg, o.stgWorkflow]).toEqual(['main', 'preview', ''])
  expect(o.protectedBranches).toEqual(['main', 'release'])
  expect(o.ignoreJobs).toEqual(['changes', 'notify-skip'])
})

test('a job outside the ignore list shows under its own name', () => {
  const items = parseJobs([{ name: 'build-docs', status: 'completed', conclusion: 'success' }, { name: 'changes', status: 'completed', conclusion: 'success' }])
  expect(items.map(i => i.label)).toEqual(['build-docs'])
})

test('git status: branch line, groups and verbs are worded as git words them', () => {
  const out = '## develop...origin/develop [ahead 2]\nM  staged.ts\n M loose.ts\nMM both.ts\n?? new.ts\n'
  expect(branchSentence(out)).toBe("On branch develop · ahead of origin/develop by 2")
  expect(branchSentence('## feature/x\n')).toBe('On branch feature/x · no upstream')
  const files = parseStatus(out)
  expect(files.length).toBe(4)
  const g = groupStatus(files)
  expect(g.staged.map(f => f.path)).toEqual(['staged.ts', 'both.ts'])
  expect(g.unstaged.map(f => f.path)).toEqual(['loose.ts', 'both.ts'])
  expect(g.untracked.map(f => f.path)).toEqual(['new.ts'])
  expect([statusVerb('A '), statusVerb(' D'), statusVerb('??')]).toEqual(['new file:', 'deleted:', ''])
})

test('the journal tells actions from reads', () => {
  expect(classify(['git', 'push', 'origin', 'develop'])).toBe('action')
  expect(classify(['git', 'status', '--porcelain'])).toBe('read')
  expect(classify(['git', 'branch', '-r', '--merged', 'develop'])).toBe('read')
  expect(classify(['git', 'branch', '-d', 'x'])).toBe('action')
  expect(classify(['git', 'worktree', 'list'])).toBe('read')
  expect(classify(['git', 'worktree', 'remove', '/p'])).toBe('action')
  expect(classify(['gh', 'pr', 'list'])).toBe('read')
  expect(classify(['gh', 'pr', 'merge', '57'])).toBe('action')
  expect(classify(['gh', 'run', 'rerun', '1'])).toBe('action')
  expect(classify(['sh', '.husky/pre-push'])).toBe('action')
  expect(shortCmd(['gh', 'pr', 'create', '--title', 'Promotion develop → staging']))
    .toBe('gh pr create --title "Promotion develop → staging"')
})

test('the path wraps onto more rows in a narrow pane and keeps one row in a wide one', () => {
  const node = (i: number) => ({ id: `n${i}`, name: `origin/n${i}`, sub: 'ok', color: 'blue' as const, tone: 'ok' as const, isCurrent: i === 1, isGhost: false })
  const nodes = [0, 1, 2, 3, 4, 5, 6].map(node)
  const wide = pathSvg(nodes, 860, 1)
  const narrow = pathSvg(nodes, 330, 1)
  expect(narrow.height > wide.height).toBe(true)
  expect(wide.source).toContain('origin/n6')
})

test('refs: local, origin and gone are read from for-each-ref', () => {
  const rows = parseRefs('develop\torigin/develop\t\nfeature/x\torigin/feature/x\t[ahead 2, behind 1]\nold\torigin/old\t[gone]\n')
  expect(rows.map(r => [r.name, r.ahead, r.behind, r.isGone])).toEqual([['develop', 0, 0, false], ['feature/x', 2, 1, false], ['old', 0, 0, true]])
  expect(parseRefs('origin/HEAD\norigin/develop\n', 'origin/').map(r => r.name)).toEqual(['develop'])
  const st = refState('develop', { isCore: false, isMerged: false, ahead: 3, upstream: null, isGone: false, dirty: 0, local: true, origin: false })
  expect(st.text).toBe('3 commits hors develop · jamais poussée')
  expect(st.tone).toBe('run')
})

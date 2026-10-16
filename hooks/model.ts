import type { Check, CheckState, DeployItem, EnvDeploy, FileChange, Pr } from '../types'

// The mod's options, read once. Every default is a common setup (develop → staging → master).
export type Cfg = {
  dev: string
  stg: string
  mst: string
  stgWorkflow: string
  mstWorkflow: string
  stgName: string
  mstName: string
  runbook: string
  prePush: string
  protectedBranches: string[]
  ignoreJobs: string[]
}

const text = (v: unknown, d: string): string => (typeof v === 'string' && v.trim() !== '' ? v.trim() : d)
const list = (v: unknown, d: string): string[] =>
  text(v, d)
    .split(',')
    .map(x => x.trim())
    .filter(x => x !== '')

export const readCfg = (o: Readonly<Record<string, unknown>> | undefined): Cfg => ({
  dev: text(o?.integrationBranch, 'develop'),
  stg: text(o?.stagingBranch, 'staging'),
  mst: text(o?.productionBranch, 'master'),
  stgWorkflow: typeof o?.stagingWorkflow === 'string' ? o.stagingWorkflow.trim() : 'deploy-staging.yml',
  mstWorkflow: typeof o?.productionWorkflow === 'string' ? o.productionWorkflow.trim() : 'deploy-master.yml',
  stgName: text(o?.stagingName, 'staging'),
  mstName: text(o?.productionName, 'production'),
  runbook: typeof o?.runbook === 'string' ? o.runbook.trim() : 'docs/prod-promotion-runbook.md',
  prePush: typeof o?.prePushHook === 'string' ? o.prePushHook.trim() : '.husky/pre-push',
  protectedBranches: list(o?.protectedBranches, 'master,main,staging,preprod'),
  ignoreJobs: list(o?.ignoreJobs, 'changes,notify-skip'),
})

export const ageLabel = (fetchedAt: number | null, now: number): string => {
  if (fetchedAt === null) return 'jamais'
  const minutes = Math.max(0, Math.round((now - fetchedAt * 1000) / 60000))
  if (minutes < 60) return `${minutes} min`
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h`
  return `${Math.round(minutes / 1440)} j`
}

// Age of an ISO timestamp (GitHub's createdAt), short: "3 min", "2 h", "4 j".
export const isoAge = (iso: string | null, now: number): string => {
  if (iso === null) return ''
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const minutes = Math.max(0, Math.round((now - t) / 60000))
  if (minutes < 1) return "à l'instant"
  if (minutes < 60) return `${minutes} min`
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h`
  return `${Math.round(minutes / 1440)} j`
}

export const parseWorktrees = (porcelain: string): { path: string; branch: string | null }[] =>
  porcelain
    .split('\n\n')
    .map(block => block.split('\n'))
    .map(lines => ({
      path: (lines.find(l => l.startsWith('worktree ')) ?? '').slice('worktree '.length),
      branch: (lines.find(l => l.startsWith('branch refs/heads/')) ?? '').slice('branch refs/heads/'.length) || null,
    }))
    .filter(w => w.path !== '')

// `git status --porcelain` must not be trimmed: the first column of the first line may be a space.
export const parseStatus = (porcelain: string): FileChange[] =>
  porcelain
    .split('\n')
    .filter(l => l.length > 3 && !l.startsWith('## '))
    .map(l => ({ code: l.slice(0, 2), path: l.slice(3) }))

export const parseRepo = (remoteUrl: string | null): { url: string; slug: string } | null => {
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec((remoteUrl ?? '').trim())

  return m === null ? null : { url: `https://github.com/${m[1]}/${m[2]}`, slug: `${m[1]}/${m[2]}` }
}

export const parseLog = (out: string | null) =>
  (out ?? '')
    .split('\n')
    .filter(l => l !== '')
    .map(l => l.split('\t'))
    .map(([sha, full, subject, age]) => ({ sha: sha ?? '', full: full ?? '', subject: subject ?? '', age: age ?? '' }))

type Rollup = { name?: string | null; workflowName?: string | null; conclusion?: string | null; status?: string | null; state?: string | null; context?: string | null }

const checkState = (c: Rollup): CheckState => {
  const done = c.status === undefined || c.status === null || c.status === 'COMPLETED'
  const result = (c.conclusion ?? c.state ?? '').toUpperCase()
  if (['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ERROR', 'STARTUP_FAILURE'].includes(result)) return 'fail'
  if (!done || result === 'PENDING' || result === 'EXPECTED' || (result === '' && c.status !== undefined)) return 'run'

  return 'ok'
}

export const parseChecks = (rollup: Rollup[] | undefined): Check[] => {
  const seen = new Set<string>()
  const out: Check[] = []
  for (const c of rollup ?? []) {
    const name = (c.name ?? c.context ?? '').trim()
    if (name === '' || seen.has(name)) continue
    seen.add(name)
    out.push({ name, state: checkState(c) })
  }

  return out
}

export type PrRow = {
  number: number
  title?: string
  headRefName: string
  baseRefName?: string
  url?: string
  state: Pr['state']
  statusCheckRollup?: Rollup[]
}

// gh lists newest first: the list keeps that order, open PRs first so a lookup by head finds the live one.
export const parsePrs = (json: string): Pr[] => {
  const rows = JSON.parse(json) as PrRow[]
  const prs = rows.map((row): Pr => {
    const checkList = parseChecks(row.statusCheckRollup)
    const isFail = checkList.some(c => c.state === 'fail')
    const isRun = checkList.some(c => c.state === 'run')

    return {
      number: row.number,
      title: row.title ?? '',
      url: row.url ?? '',
      state: row.state,
      base: row.baseRefName ?? '',
      head: row.headRefName,
      checks: checkList.length === 0 ? 'none' : isFail ? 'fail' : isRun ? 'pending' : 'ok',
      checkList,
    }
  })

  return [...prs.filter(p => p.state === 'OPEN'), ...prs.filter(p => p.state !== 'OPEN')]
}

export const findPr = (list: Pr[], head: string, base?: string): Pr | undefined =>
  list.find(p => p.head === head && (base === undefined || p.base === base) && p.state === 'OPEN') ??
  list.find(p => p.head === head && (base === undefined || p.base === base))

export const openPrTo = (list: Pr[], base: string): Pr | undefined => list.find(p => p.base === base && p.state === 'OPEN')

const JOB_LABEL: Record<string, string> = {
  'deploy-functions': 'Functions',
  'deploy-rules': 'Règles',
  'deploy-flutter': 'Flutter',
  'deploy-burn-worker': 'Burn worker',
}

type Job = { name: string; status: string; conclusion: string | null; url?: string; completedAt?: string | null; startedAt?: string | null }

const jobState = (j: Job): DeployItem['state'] => {
  if (j.status !== 'completed') return 'run'
  const c = (j.conclusion ?? '').toLowerCase()
  if (c === 'success') return 'ok'
  if (c === 'skipped' || c === 'neutral') return 'skipped'

  return 'fail'
}

export const parseJobs = (jobs: Job[], ignore: readonly string[] = ['changes', 'notify-skip']): DeployItem[] =>
  jobs
    .filter(j => !ignore.includes(j.name))
    .map(j => ({
      key: j.name,
      label: JOB_LABEL[j.name] ?? j.name,
      state: jobState(j),
      url: j.url ?? '',
      at: Date.parse(j.completedAt ?? j.startedAt ?? '') || null,
    }))

export const vercelItem = (state: string | undefined, url: string, at: string | undefined): DeployItem | null => {
  if (state === undefined) return null
  const s = state.toLowerCase()
  const mapped: DeployItem['state'] = s === 'success' ? 'ok' : s === 'failure' || s === 'error' ? 'fail' : s === 'inactive' ? 'skipped' : 'run'

  return { key: 'vercel', label: 'Web (Vercel)', state: mapped, url, at: Date.parse(at ?? '') || null }
}

export type DeploySummary = 'fail' | 'run' | 'ok' | 'none'
export const summarize = (env: EnvDeploy | null): DeploySummary => {
  if (env === null || env.items.length === 0) return 'none'
  if (env.items.some(i => i.state === 'fail')) return 'fail'
  if (env.items.some(i => i.state === 'run')) return 'run'

  return 'ok'
}

export const tailLines = (text: string, n = 4): string =>
  text
    .split('\n')
    .map(l => l.trim())
    .filter(l => l !== '')
    .slice(-n)
    .join(' / ')

export const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many)

export const prChecksWord = (pr: Pr): string => (pr.checks === 'ok' ? 'checks ok' : pr.checks === 'fail' ? 'checks en échec' : pr.checks === 'pending' ? 'checks en cours' : 'sans checks')

// The "## develop...origin/develop [ahead 2]" line `git status --porcelain -b` opens with, as `git status` words it.
export const branchSentence = (porcelain: string): string => {
  const line = porcelain.split('\n').find(l => l.startsWith('## '))
  if (line === undefined) return ''
  const body = line.slice(3)
  if (body.startsWith('HEAD (no branch)')) return 'HEAD detached'
  const [local = '', rest = ''] = body.split('...')
  const upstream = rest.split(' ')[0] ?? ''
  const ahead = /ahead (\d+)/.exec(rest)?.[1]
  const behind = /behind (\d+)/.exec(rest)?.[1]
  const gone = rest.includes('gone')
  const tail = upstream === '' ? 'no upstream' : gone ? `upstream ${upstream} is gone` : ahead && behind ? `ahead ${ahead}, behind ${behind} of ${upstream}` : ahead ? `ahead of ${upstream} by ${ahead}` : behind ? `behind ${upstream} by ${behind}` : `up to date with ${upstream}`

  return `On branch ${local.replace(/^No commits yet on /, '')} · ${tail}`
}

// The word git prints before a path in the long format of `git status`.
export const statusVerb = (code: string): string => {
  if (code === '??') return ''
  const c = code.trim()[0] ?? ''

  return c === 'M' ? 'modified:' : c === 'A' ? 'new file:' : c === 'D' ? 'deleted:' : c === 'R' ? 'renamed:' : c === 'C' ? 'copied:' : c === 'U' ? 'both modified:' : 'changed:'
}

export type StatusGroups = { staged: FileChange[]; unstaged: FileChange[]; untracked: FileChange[] }
export const groupStatus = (files: FileChange[]): StatusGroups => ({
  staged: files.filter(f => f.code !== '??' && f.code[0] !== ' ' && f.code[0] !== undefined),
  unstaged: files.filter(f => f.code !== '??' && f.code[1] !== ' ' && f.code[1] !== undefined),
  untracked: files.filter(f => f.code === '??'),
})

// What a command did to the world: the journal lists actions, and reads only when asked.
const GIT_READS = new Set(['status', 'rev-parse', 'rev-list', 'log', 'diff', 'merge-base', 'show', 'for-each-ref', 'ls-files', 'cat-file'])
export const classify = (argv: readonly string[]): 'read' | 'action' => {
  const [bin = '', sub = '', sub2 = ''] = argv
  if (bin === 'stat') return 'read'
  if (bin === 'gh') return sub === 'api' || ((sub === 'pr' || sub === 'run') && (sub2 === 'list' || sub2 === 'view')) ? 'read' : 'action'
  if (bin !== 'git') return 'action'
  if (GIT_READS.has(sub)) return 'read'
  if (sub === 'branch') return argv.some(a => ['-d', '-D', '-m', '-M', '-c', '-C'].includes(a)) ? 'action' : 'read'
  if (sub === 'worktree') return sub2 === 'list' ? 'read' : 'action'
  if (sub === 'remote') return sub2 === 'get-url' ? 'read' : 'action'

  return 'action'
}

export const shortCmd = (argv: readonly string[], max = 120): string => {
  const text = argv.map(a => (/\s/.test(a) ? `"${a.length > 40 ? `${a.slice(0, 39)}…` : a}"` : a)).join(' ')

  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

export const clock = (ms: number): string => {
  const d = new Date(ms)
  const two = (n: number) => String(n).padStart(2, '0')

  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
}

export type RefRow = { name: string; upstream: string; ahead: number; behind: number; isGone: boolean }

// `git for-each-ref --format=%(refname:short)%09%(upstream:short)%09%(upstream:track)`: one row per ref.
export const parseRefs = (out: string | null, strip = ''): RefRow[] =>
  (out ?? '')
    .split('\n')
    .filter(l => l.trim() !== '')
    .map(l => l.split('\t'))
    .map(([raw = '', upstream = '', track = '']) => ({
      name: strip !== '' && raw.startsWith(strip) ? raw.slice(strip.length) : raw,
      upstream,
      ahead: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0),
      behind: Number(/behind (\d+)/.exec(track)?.[1] ?? 0),
      isGone: track.includes('gone'),
    }))
    .filter(r => r.name !== '' && r.name !== 'HEAD' && r.name !== 'origin')

// What a branch name reads like in the inventory, in one short phrase.
export const refState = (dev: string, r: { isCore: boolean; isMerged: boolean; ahead: number; upstream: { ahead: number; behind: number } | null; isGone: boolean; dirty: number; local: boolean; origin: boolean }): { text: string; tone: 'dim' | 'ok' | 'run' | 'fail' } => {
  const bits: string[] = []
  if (r.dirty > 0) bits.push(`✎ ${r.dirty}`)
  if (r.upstream !== null && r.upstream.ahead > 0) bits.push(`⇡${r.upstream.ahead} à pousser`)
  if (r.upstream !== null && r.upstream.behind > 0) bits.push(`⇣${r.upstream.behind} de retard`)
  if (r.isGone) bits.push('supprimée sur origin')
  if (!r.isCore && r.isMerged) bits.push('fusionnée, à supprimer')
  else if (!r.isCore && r.ahead > 0) bits.push(`${r.ahead} ${r.ahead === 1 ? 'commit' : 'commits'} hors ${dev}`)
  if (!r.isCore && r.local && !r.origin) bits.push('jamais poussée')
  const tone = r.isGone || (r.upstream?.behind ?? 0) > 0 ? 'fail' : r.dirty > 0 || (r.upstream?.ahead ?? 0) > 0 || (r.local && !r.origin && r.ahead > 0) ? 'run' : r.isMerged && !r.isCore ? 'ok' : 'dim'

  return { text: bits.join(' · '), tone }
}

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, UiPressArgument } from 'claude-code'

import type { Cfg } from './model'
import type { CommitDetail, CommitList, Deploys, EnvDeploy, LaneCommit, LogEntry, Pr, Prs, RefInfo, Snapshot, Worktree } from '../types'
import { ageLabel, branchSentence, classify, clock, findPr, groupStatus, parseRefs, readCfg, refState, shortCmd, statusVerb, isoAge, openPrTo, parseJobs, parseLog, parsePrs, parseRepo, parseStatus, parseWorktrees, plural, summarize, tailLines, vercelItem } from './model'
import { bodySvg, headerSvg, pathSvg } from './svg'
import type { CardSpec, ColorKey, PathNode, Pill, Row } from './svg'

const PANE = 'pulse-saas'
const LANE_COMMITS = 8
const FILES_SHOWN = 6
// The options, set by `register` (a reload runs it again). Defaults are a common setup.
let CFG: Cfg = readCfg(undefined)
const isKept = (b: string): boolean => ['main', 'preprod', 'HEAD', CFG.dev, CFG.stg, CFG.mst, ...CFG.protectedBranches].includes(b)
// Branches the mod never pushes: they move through a PR only.
const isPrOnly = (b: string): boolean => b === CFG.stg || b === CFG.mst || CFG.protectedBranches.includes(b)
const ZERO_SHA = '0000000000000000000000000000000000000000'
const DEFAULT_OPEN: string[] = []

const snap = atom({ plugin: 'pulse-saas', key: 'snap' } as const, null)
const prs = atom({ plugin: 'pulse-saas', key: 'prs' } as const, { list: [], status: 'none' })
const deploys = atom({ plugin: 'pulse-saas', key: 'deploys' } as const, { staging: null, master: null, status: 'none' })
const armed = atom({ plugin: 'pulse-saas', key: 'armed' } as const, null)
const busy = atom({ plugin: 'pulse-saas', key: 'busy' } as const, null)
const flash = atom({ plugin: 'pulse-saas', key: 'flash' } as const, null)
const open = atom({ plugin: 'pulse-saas', key: 'open' } as const, DEFAULT_OPEN)
const shut = atom({ plugin: 'pulse-saas', key: 'shut' } as const, DEFAULT_OPEN)
const logs = atom({ plugin: 'pulse-saas', key: 'logs' } as const, [])
const reads = atom({ plugin: 'pulse-saas', key: 'reads' } as const, [])
const logAll = atom({ plugin: 'pulse-saas', key: 'logAll' } as const, false)
const lists = atom({ plugin: 'pulse-saas', key: 'lists' } as const, {})
const details = atom({ plugin: 'pulse-saas', key: 'details' } as const, {})
const openRefs = atom({ plugin: 'pulse-saas', key: 'openRefs' } as const, [])
const openCommits = atom({ plugin: 'pulse-saas', key: 'openCommits' } as const, [])
const lastAt = atom({ plugin: 'pulse-saas', key: 'lastAt' } as const, 0)

type Exec = { ok: boolean; out: string; err: string }
type Outcome = { ok: boolean; text: string; url?: string }
type Run = (argv: readonly string[], cwd?: string, timeoutMs?: number) => Promise<string | null>

const MAX_LOG = 80
let seq = 0
const readBuf: LogEntry[] = []

// Every command the pane runs is written to the journal. Actions land at once; reads wait in a buffer and
// join the journal in one write (a refresh runs dozens, and each state write redraws the pane).
async function flushReads($: EngineInterface): Promise<void> {
  if (readBuf.length === 0) return
  const batch = readBuf.splice(0, readBuf.length)
  await update($, reads, list => [...list, ...batch].slice(-MAX_LOG))
}

async function exec($: EngineInterface, argv: readonly string[], cwd?: string, timeoutMs = 20000, stdin?: string): Promise<Exec> {
  const kind = classify(argv)
  const t0 = await $.clock.now()
  const entry: LogEntry = { id: ++seq, at: t0, cmd: shortCmd(argv), where: cwd === undefined ? '' : (cwd.split('/').at(-1) ?? ''), state: 'run', ms: null, note: '', kind }
  if (kind === 'action') await update($, logs, list => [...list, entry].slice(-MAX_LOG))
  let r: Exec
  try {
    const init = { timeoutMs, ...(cwd === undefined ? {} : { cwd }), ...(stdin === undefined ? {} : { stdin }) }
    const res = await $.process.run(argv, init)
    r = { ok: res.exitCode === 0, out: res.stdout, err: res.stderr }
  } catch (e) {
    r = { ok: false, out: '', err: e instanceof Error ? e.message : String(e) }
  }
  const done: LogEntry = { ...entry, state: r.ok ? 'ok' : 'fail', ms: (await $.clock.now()) - t0, note: r.ok ? '' : tailLines(`${r.err}\n${r.out}`, 2) }
  if (kind === 'action') await update($, logs, list => list.map(x => (x.id === done.id ? done : x)))
  else readBuf.push(done)

  return r
}

function runner($: EngineInterface): Run {
  return async (argv, cwd, timeoutMs = 20000) => {
    const full = argv[0] === 'gh' || argv[0] === 'stat' ? argv : ['git', ...argv]
    const r = await exec($, full, cwd, timeoutMs)

    return r.ok ? r.out.trim() : null
  }
}

async function collect($: EngineInterface, run: Run, now: number): Promise<Snapshot> {
  const has = async (ref: string) => (await run(['rev-parse', '--verify', '--quiet', ref])) !== null
  const pick = async (b: string) => ((await has(`origin/${b}`)) ? `origin/${b}` : b)
  const count = async (range: string, cwd?: string) => Number((await run(['rev-list', '--count', range], cwd)) ?? 0) || 0

  // Promotion and PR merge commits differ by SHA but add no content: count them as aligned.
  const extra = async (base: string, head: string) =>
    (await run(['diff', '--quiet', `${base}...${head}`])) === null ? await count(`${base}..${head}`) : 0

  // Merge commits carry no work: a lane lists real commits only. `%ct` is the commit time, aged by the pane.
  const lane = async (id: Snapshot['lanes'][number]['id'], range: string) => {
    const out = await run(['log', '--no-merges', `-n${LANE_COMMITS}`, '--format=%h%x09%H%x09%s%x09%ct', range])
    const total = Number((await run(['rev-list', '--no-merges', '--count', range])) ?? 0) || 0
    const commits = parseLog(out)

    return { id, range, commits, more: Math.max(0, total - commits.length) }
  }

  const dev = await pick(CFG.dev)
  const stg = await pick(CFG.stg)
  const mst = await pick(CFG.mst)
  const hasStaging = await has(stg)
  const hasMaster = await has(mst)
  const hasOriginDev = await has(`origin/${CFG.dev}`)
  const devTip = await run(['rev-parse', dev])

  const branch = (await run(['branch', '--show-current'])) || null
  const top = await run(['rev-parse', '--show-toplevel'])
  const entries = parseWorktrees((await run(['worktree', 'list', '--porcelain'])) ?? '')
  const mainPath = entries.at(0)?.path ?? top ?? ''

  const worktrees: Worktree[] = []
  for (const [i, w] of entries.entries()) {
    const status = await exec($, ['git', 'status', '--porcelain', '-b'], w.path)
    const files = status.ok ? parseStatus(status.out) : []
    const tip = w.branch === null ? null : await run(['rev-parse', w.branch])
    const isOwn = w.branch !== null && !isKept(w.branch) && tip !== devTip
    worktrees.push({
      path: w.path,
      name: w.path.split('/').at(-1) ?? w.path,
      branch: w.branch,
      isMain: i === 0,
      dirty: files.length,
      files,
      unpushed: await count('HEAD --not --remotes', w.path),
      onOrigin: w.branch !== null && (await has(`origin/${w.branch}`)),
      ahead: w.branch === null || isKept(w.branch) ? 0 : await count(`${dev}..${w.branch}`),
      branchLine: status.ok ? branchSentence(status.out) : '',
      isMerged: i > 0 && isOwn && (await run(['merge-base', '--is-ancestor', w.branch as string, dev])) !== null,
    })
  }

  const remoteMerged: string[] = []
  const merged = (await run(['branch', '-r', '--merged', dev])) ?? ''
  for (const line of merged.split('\n').map(l => l.trim())) {
    if (!line.startsWith('origin/') || line.includes('->')) continue
    const name = line.slice('origin/'.length)
    if (isKept(name) || (await run(['rev-parse', line])) === devTip) continue
    remoteMerged.push(name)
  }

  // Branches that live on origin only (no worktree here, not yet merged): where a PR can start.
  const localBranches = new Set(worktrees.map(w => w.branch))
  const remoteBranches: Snapshot['remoteBranches'] = []
  const refs = (await run(['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin'])) ?? ''
  for (const ref of refs.split('\n').map(l => l.trim())) {
    if (!ref.startsWith('origin/')) continue
    const name = ref.slice('origin/'.length)
    if (name === '' || isKept(name) || localBranches.has(name) || remoteMerged.includes(name)) continue
    remoteBranches.push({ name, ahead: await count(`${dev}..${ref}`) })
  }

  // The inventory: every branch name, wherever it lives (local, origin, a worktree), with how far it stands from the integration branch.
  const refFmt = '--format=%(refname:short)%09%(upstream:short)%09%(upstream:track)'
  const localRows = parseRefs(await run(['for-each-ref', refFmt, 'refs/heads']))
  const remoteRows = parseRefs(await run(['for-each-ref', refFmt, 'refs/remotes/origin']), 'origin/')
  const lines = (out: string | null, strip = '') => new Set((out ?? '').split('\n').map(x => x.trim().replace(strip, '')).filter(x => x !== ''))
  const mergedLocal = lines(await run(['branch', '--merged', dev, '--format=%(refname:short)']))
  const mergedRemote = lines(await run(['branch', '-r', '--merged', dev, '--format=%(refname:short)']), 'origin/')
  const inventory: RefInfo[] = []
  for (const name of new Set([...localRows.map(x => x.name), ...remoteRows.map(x => x.name)])) {
    const loc = localRows.find(x => x.name === name)
    const onOrigin = remoteRows.some(x => x.name === name)
    const core = isKept(name)
    const ref = loc !== undefined ? name : `origin/${name}`
    const wt = worktrees.find(w => w.branch === name)
    const ahead = core ? 0 : await count(`${dev}..${ref}`)
    const mergedSet = loc !== undefined ? mergedLocal : mergedRemote
    inventory.push({
      name,
      local: loc !== undefined,
      origin: onOrigin,
      worktree: wt?.name ?? null,
      ahead,
      upstream: loc !== undefined && loc.upstream !== '' ? { ahead: loc.ahead, behind: loc.behind } : null,
      isGone: loc?.isGone ?? false,
      isMerged: !core && mergedSet.has(name) && (await run(['rev-parse', ref])) !== devTip,
      isCore: core,
      dirty: wt?.dirty ?? 0,
    })
  }
  for (const w of worktrees) {
    if (w.branch !== null) continue
    inventory.push({ name: `(détaché) ${w.name}`, local: true, origin: false, worktree: w.name, ahead: await count(`${dev}..HEAD`, w.path), upstream: null, isGone: false, isMerged: false, isCore: false, dirty: w.dirty })
  }

  const repo = parseRepo(await run(['remote', 'get-url', 'origin']))
  const common = await run(['rev-parse', '--git-common-dir'])
  const stamp =
    common === null
      ? null
      : (await run(['stat', '-f', '%m', `${common}/FETCH_HEAD`])) ?? (await run(['stat', '-c', '%Y', `${common}/FETCH_HEAD`]))
  const fetchedAt = stamp !== null && /^\d{9,}$/.test(stamp) ? Number(stamp) : null

  return {
    current: { branch },
    develop: {
      unpushed: hasOriginDev ? await count(`origin/${CFG.dev}..${CFG.dev}`) : 0,
      behind: hasOriginDev ? await count(`${CFG.dev}..origin/${CFG.dev}`) : 0,
    },
    hasStaging,
    hasMaster,
    toStaging: await count(`${stg}..${dev}`),
    toMaster: await count(`${mst}..${stg}`),
    stagingExtra: await extra(dev, stg),
    masterExtra: await extra(stg, mst),
    lanes: [
      await lane('develop-local', hasOriginDev ? `origin/${CFG.dev}..${CFG.dev}` : `${CFG.dev}@{u}..${CFG.dev}`),
      await lane('develop-origin', `${stg}..${hasOriginDev ? `origin/${CFG.dev}` : CFG.dev}`),
      await lane('staging', `${mst}..${stg}`),
      await lane('master', mst),
    ],
    worktrees,
    remoteMerged,
    remoteBranches,
    refs: inventory,
    repoUrl: repo?.url ?? null,
    repoSlug: repo?.slug ?? null,
    fetchedAt,
    takenAt: now,
  }
}

async function refresh($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  await update($, lastAt, () => now)
  const next = await collect($, runner($), now)
  await update($, snap, () => next)
  await flushReads($)
}

async function slugOf($: EngineInterface): Promise<string | null> {
  const s = await read($, snap)
  if (s?.repoSlug) return s.repoSlug
  const r = await exec($, ['git', 'remote', 'get-url', 'origin'])

  return r.ok ? (parseRepo(r.out)?.slug ?? null) : null
}

async function loadPrs($: EngineInterface): Promise<boolean> {
  const gh = await exec(
    $,
    ['gh', 'pr', 'list', '--state', 'all', '--limit', '60', '--json', 'number,title,headRefName,baseRefName,state,url,statusCheckRollup'],
    undefined,
    30000,
  )
  let parsed: Prs = { list: [], status: 'unavailable' }
  if (gh.ok) {
    try {
      parsed = { list: parsePrs(gh.out), status: 'ok' }
    } catch {
      parsed = { list: [], status: 'unavailable' }
    }
  }
  await update($, prs, () => parsed)

  return parsed.status === 'ok'
}

// One environment's deployment: the jobs of its latest deploy workflow run, plus the Vercel deployment of the same commit.
async function envDeploy($: EngineInterface, slug: string, workflow: string, branch: string): Promise<EnvDeploy | null> {
  const runs = await exec($, ['gh', 'run', 'list', '--repo', slug, '--workflow', workflow, '--branch', branch, '--limit', '1', '--json', 'databaseId,createdAt,url,headSha'], undefined, 30000)
  if (!runs.ok) throw new Error(tailLines(runs.err))
  const run = (JSON.parse(runs.out) as { databaseId: number; createdAt: string; url: string; headSha: string }[]).at(0)
  if (run === undefined) return null

  const jobs = await exec($, ['gh', 'run', 'view', String(run.databaseId), '--repo', slug, '--json', 'jobs'], undefined, 30000)
  const items = jobs.ok ? parseJobs((JSON.parse(jobs.out) as { jobs: Parameters<typeof parseJobs>[0] }).jobs, CFG.ignoreJobs) : []

  const dep = await exec($, ['gh', 'api', `repos/${slug}/deployments?sha=${run.headSha}&per_page=1`])
  if (dep.ok) {
    const id = (JSON.parse(dep.out) as { id: number }[]).at(0)?.id
    if (id !== undefined) {
      const st = await exec($, ['gh', 'api', `repos/${slug}/deployments/${id}/statuses?per_page=1`])
      const row = st.ok ? (JSON.parse(st.out) as { state: string; environment_url?: string; log_url?: string; created_at?: string }[]).at(0) : undefined
      const v = vercelItem(row?.state, row?.environment_url || row?.log_url || '', row?.created_at)
      if (v !== null) items.unshift(v)
    }
  }

  return { runId: run.databaseId, runUrl: run.url, sha: run.headSha.slice(0, 8), items, at: Date.parse(run.createdAt) || null }
}

async function loadDeploys($: EngineInterface): Promise<void> {
  const slug = await slugOf($)
  let next: Deploys = { staging: null, master: null, status: 'unavailable' }
  if (slug !== null) {
    try {
      next = {
        staging: CFG.stgWorkflow === '' ? null : await envDeploy($, slug, CFG.stgWorkflow, CFG.stg),
        master: CFG.mstWorkflow === '' ? null : await envDeploy($, slug, CFG.mstWorkflow, CFG.mst),
        status: 'ok',
      }
    } catch {
      next = { staging: null, master: null, status: 'unavailable' }
    }
  }
  await update($, deploys, () => next)
}

async function reloadAll($: EngineInterface): Promise<void> {
  await refresh($)
  await Promise.all([loadPrs($), loadDeploys($)])
}

// Every button goes through here: a flash line while it runs, then the outcome and a toast. A change of the
// world (push, PR, merge...) runs alone; a refresh or a fetch never blocks one, and never overwrites its line.
async function act($: EngineInterface, id: string, label: string, work: () => Promise<Outcome>, cmd = ''): Promise<void> {
  const isRead = id === 'refresh' || id === 'fetch'
  const running = await read($, busy)
  if (!isRead && running !== null) {
    const text = `Une action est déjà en cours : ${running}. Réessaie quand elle est finie.`
    await update($, flash, () => ({ kind: 'fail', text, at: 0}))
    $.ui.toast(text, { timeoutMs: 5000 })

    return
  }
  await update($, armed, () => null)
  if (!isRead) await update($, busy, () => id)
  if (!isRead || running === null) await update($, flash, () => ({ kind: 'pending', text: cmd === '' ? `${label}…` : `${label}… $ ${cmd}`, at: 0 }))
  let outcome: Outcome
  try {
    outcome = await work()
  } catch (e) {
    outcome = { ok: false, text: `${label} : ${e instanceof Error ? e.message : String(e)}` }
  }
  await flushReads($)
  const at = await $.clock.now()
  if (!isRead || (await read($, busy)) === null) await update($, flash, () => ({ kind: outcome.ok ? 'ok' : 'fail', text: outcome.text, at, ...(outcome.url === undefined ? {} : { url: outcome.url }) }))
  if (!isRead) await update($, busy, () => null)
  $.ui.toast(`${outcome.ok ? '✓' : '✗'} ${outcome.text}`, { timeoutMs: outcome.ok ? 3000 : 8000 })
}

async function doRefresh($: EngineInterface): Promise<Outcome> {
  await refresh($)
  await Promise.all([loadPrs($), loadDeploys($)])
  const s = await read($, snap)
  const dirty = s?.worktrees.reduce((n, w) => n + w.dirty, 0) ?? 0

  return { ok: true, text: `Rafraîchi : ${dirty} ${plural(dirty, 'fichier modifié', 'fichiers modifiés')}, ${s?.worktrees.length ?? 0} worktrees, PR et déploiements relus.` }
}

async function doFetch($: EngineInterface): Promise<Outcome> {
  const fetched = await exec($, ['git', 'fetch', 'origin', '--prune'], undefined, 60000)
  await reloadAll($)
  if (!fetched.ok) return { ok: false, text: `Fetch a échoué : ${tailLines(fetched.err) || 'réseau ou accès'}.` }

  return { ok: true, text: 'Fetch terminé, PR et déploiements relus.' }
}

// Pushes a branch the way a terminal would, hooks included: Git runs with repo hooks off here, so the
// husky pre-push guard is replayed by hand when the branch is checked out somewhere to run it on.
async function pushBranch($: EngineInterface, s: Snapshot, branch: string): Promise<Outcome> {
  if (isPrOnly(branch)) return { ok: false, text: `${branch} ne se pousse pas directement : passe par une PR.` }
  const wt = s.worktrees.find(w => w.branch === branch)
  const sha = (await exec($, ['git', 'rev-parse', branch])).out.trim()
  const remote = await exec($, ['git', 'rev-parse', '--verify', '--quiet', `origin/${branch}`])
  const remoteSha = remote.ok ? remote.out.trim() : ZERO_SHA

  let guard = 'sans garde locale (branche non extraite : la CI vérifiera à la PR)'
  if (wt !== undefined && CFG.prePush !== '') {
    const hook = await exec($, ['sh', CFG.prePush, 'origin', ''], wt.path, 600000, `refs/heads/${branch} ${sha} refs/heads/${branch} ${remoteSha}\n`)
    if (!hook.ok) return { ok: false, text: `pre-push a refusé ${branch} : ${tailLines(`${hook.out}\n${hook.err}`) || 'voir le terminal'}` }
    guard = 'pre-push OK'
  }

  const pushed = await exec($, ['git', 'push', ...(remote.ok ? [] : ['-u']), 'origin', branch], wt?.path, 120000)
  await refresh($)
  if (!pushed.ok) return { ok: false, text: `Push de ${branch} refusé : ${tailLines(pushed.err) || 'erreur git'}` }

  return { ok: true, text: `${branch} poussé sur origin (${guard}).` }
}

async function createPr($: EngineInterface, s: Snapshot, head: string, base: string): Promise<Outcome> {
  if (s.repoSlug === null) return { ok: false, text: 'Dépôt GitHub introuvable (remote origin).' }
  const args = ['gh', 'pr', 'create', '--repo', s.repoSlug, '--base', base, '--head', head]
  if (head === CFG.dev && base === CFG.stg) {
    const log = await exec($, ['git', 'log', '--no-merges', '--format=- %s (%h)', '-n40', `origin/${base}..origin/${head}`])
    args.push('--title', `Promotion ${CFG.dev} → ${CFG.stg}`, '--body', `Commits embarqués :\n\n${log.out.trim()}\n`)
  } else {
    args.push('--fill')
  }
  const r = await exec($, args, s.worktrees.at(0)?.path, 60000)
  if (!r.ok) return { ok: false, text: `PR ${head} → ${base} refusée : ${tailLines(`${r.err}\n${r.out}`) || 'erreur gh'}` }
  await loadPrs($)
  const url = r.out.trim().split('\n').at(-1) ?? ''

  return { ok: true, text: `PR ${head} → ${base} créée : ${url}`, url }
}

// A merge moves a branch for real (and, into staging or master, starts a deploy): the button asks twice.
async function mergePr($: EngineInterface, s: Snapshot, pr: Pr): Promise<Outcome> {
  if (s.repoSlug === null) return { ok: false, text: 'Dépôt GitHub introuvable (remote origin).' }
  const r = await exec($, ['gh', 'pr', 'merge', String(pr.number), '--repo', s.repoSlug, '--merge'], s.worktrees.at(0)?.path, 90000)
  if (!r.ok) return { ok: false, text: `Fusion de #${pr.number} refusée : ${tailLines(`${r.err}\n${r.out}`) || 'erreur gh'}` }
  await reloadAll($)

  return { ok: true, text: `PR #${pr.number} fusionnée dans ${pr.base}.` }
}

async function rerunFailed($: EngineInterface, s: Snapshot, env: EnvDeploy): Promise<Outcome> {
  if (s.repoSlug === null || env.runId === null) return { ok: false, text: 'Run introuvable.' }
  const r = await exec($, ['gh', 'run', 'rerun', String(env.runId), '--repo', s.repoSlug, '--failed'], undefined, 60000)
  await loadDeploys($)

  return r.ok ? { ok: true, text: 'Étapes en échec relancées.' } : { ok: false, text: `Relance refusée : ${tailLines(`${r.err}\n${r.out}`) || 'erreur gh'}` }
}

async function openUrl($: EngineInterface, target: string): Promise<Outcome> {
  const r = await exec($, ['open', target])

  return r.ok ? { ok: true, text: `Ouvert : ${target}` } : { ok: false, text: `Impossible d'ouvrir ${target}.` }
}

async function removeWorktree($: EngineInterface, s: Snapshot, w: Worktree): Promise<Outcome> {
  const run = runner($)
  const home = s.worktrees.at(0)?.path
  const removed = await run(['worktree', 'remove', w.path], home)
  const dropped = removed !== null && w.branch !== null ? await run(['branch', '-d', w.branch], home) : null
  await refresh($)
  if (removed === null) return { ok: false, text: `${w.name} : git a refusé (changements non commités ?).` }
  if (dropped === null) return { ok: false, text: `${w.name} retiré, mais la branche ${w.branch} n'est pas supprimée (git branch -d a refusé).` }

  return { ok: true, text: `${w.name} retiré, branche ${w.branch} supprimée.` }
}

async function removeRemote($: EngineInterface, s: Snapshot): Promise<Outcome> {
  const r = await exec($, ['git', 'push', 'origin', '--delete', ...s.remoteMerged], undefined, 60000)
  await refresh($)

  return r.ok
    ? { ok: true, text: `${s.remoteMerged.length} branches distantes supprimées.` }
    : { ok: false, text: `La suppression distante a échoué : ${tailLines(r.err)}` }
}

// ---- the pane's data, derived ---------------------------------------------------------------

type Source = { id: string; name: string; branch: string | null; wt?: Worktree; ahead: number; dirty: number; unpushed: boolean; merged: boolean }

function sourcesOf(s: Snapshot, list: Pr[]): Source[] {
  const out: Source[] = []
  for (const w of s.worktrees) {
    if (w.isMain && (w.branch === null || isKept(w.branch))) continue
    if (w.branch !== null && isKept(w.branch)) continue
    const unpushed = w.unpushed > 0 || (!w.onOrigin && w.ahead > 0)
    if (!w.isMerged && w.dirty === 0 && !unpushed && w.ahead === 0) continue
    out.push({ id: w.branch ?? `wt:${w.name}`, name: w.branch ?? `${w.name} (détaché)`, branch: w.branch, wt: w, ahead: w.ahead, dirty: w.dirty, unpushed, merged: w.isMerged })
  }
  for (const b of s.remoteBranches) {
    if (b.ahead === 0) continue
    // Its newest PR is merged: the work is done (the branch carries a promotion or merge commit develop lacks).
    if (findPr(list, b.name)?.state === 'MERGED') continue
    out.push({ id: b.name, name: b.name, branch: b.name, ahead: b.ahead, dirty: 0, unpushed: false, merged: false })
  }

  return out
}

const pending = (src: Source[]) => src.filter(x => !x.merged)

// Where the work stands: 0 branches, 1 develop, 2 staging, 3 prod.
function stageOf(s: Snapshot, list: Pr[], d: Deploys, src: Source[]): number {
  if (summarize(d.master) === 'run') return 3
  if (s.toMaster > 0 || summarize(d.staging) === 'run' || summarize(d.staging) === 'fail' || openPrTo(list, CFG.mst) !== undefined) return 2
  if (s.toStaging > 0 || s.develop.unpushed > 0 || openPrTo(list, CFG.stg) !== undefined) return 1

  return pending(src).length > 0 ? 0 : 3
}

function statusText(s: Snapshot, list: Pr[], d: Deploys, src: Source[], stage: number): string {
  const stgPr = openPrTo(list, CFG.stg)
  const mstPr = openPrTo(list, CFG.mst)
  if (stage === 3) return summarize(d.master) === 'run' ? 'Déploiement prod en cours.' : summarize(d.master) === 'fail' ? 'Un déploiement prod a échoué : relance-le.' : 'Tout est en prod. Rien ne descend de plus.'
  if (stage === 2) {
    if (summarize(d.staging) === 'run') return 'Déploiement staging en cours.'
    if (summarize(d.staging) === 'fail') return 'Un déploiement staging a échoué : relance-le avant de promouvoir.'
    if (mstPr !== undefined) return `PR #${mstPr.number} vers ${CFG.mst} ouverte, ${mstPr.checks === 'ok' ? 'checks ok : prête à fusionner' : 'checks en cours'}.`

    return `${s.toMaster} ${plural(s.toMaster, 'commit', 'commits')} sur staging, prêts à promouvoir en prod.`
  }
  if (stage === 1) {
    if (s.develop.unpushed > 0) return `${s.develop.unpushed} ${plural(s.develop.unpushed, 'commit', 'commits')} sur ${CFG.dev} à pousser.`
    if (stgPr !== undefined) return `${s.toStaging} commits attendent le merge de la PR #${stgPr.number} (${stgPr.checks === 'ok' ? 'checks ok' : stgPr.checks === 'fail' ? 'checks en échec' : 'checks en cours'}).`

    return `${s.toStaging} commits sur origin/${CFG.dev}, aucune PR vers ${CFG.stg}.`
  }

  return `${pending(src).length} ${plural(pending(src).length, 'branche', 'branches')} de travail à faire avancer.`
}

// ---- on-demand loaders ------------------------------------------------------------------------

// A list of commits for a key: `range` is any `git log` range, `limit` how many to load.
async function loadCommits($: EngineInterface, key: string, range: string, limit: number, cwd?: string): Promise<void> {
  const run = runner($)
  const out = await run(['log', '--no-merges', `-n${limit}`, '--format=%h%x09%H%x09%s%x09%ct', range], cwd)
  const total = Number((await run(['rev-list', '--no-merges', '--count', range], cwd)) ?? 0) || 0
  await update($, lists, all => ({ ...all, [key]: { commits: parseLog(out), total, limit } as CommitList }))
  await flushReads($)
}

// What a click on a commit unfolds: its full message, the files it touched, who holds it.
async function loadDetail($: EngineInterface, s: Snapshot, c: LaneCommit): Promise<void> {
  const body = await exec($, ['git', 'show', '-s', '--format=%B', c.full])
  const stat = await exec($, ['git', 'show', '--stat', '--format=', c.full])
  const holders = await exec($, ['git', 'branch', '-a', '--contains', c.full, '--format=%(refname:short)'])
  const names = holders.out.split('\n').map(l => l.trim()).filter(l => l !== '' && !l.includes('->'))
  const set = new Set(names)
  const detail: CommitDetail = {
    body: body.out.trim(),
    stat: stat.out.trim(),
    holders: names.slice(0, 12),
    worktrees: s.worktrees.filter(w => w.branch !== null && set.has(w.branch)).map(w => ({ name: w.name, path: w.path, branch: w.branch as string })),
  }
  await update($, details, all => ({ ...all, [c.full]: detail }))
  await flushReads($)
}

async function deleteLocal($: EngineInterface, s: Snapshot, name: string): Promise<Outcome> {
  const r = await exec($, ['git', 'branch', '-d', name], s.worktrees.at(0)?.path)
  await refresh($)

  return r.ok ? { ok: true, text: `Branche locale ${name} supprimée.` } : { ok: false, text: `git a refusé de supprimer ${name} : ${tailLines(r.err) || 'non fusionnée ?'}` }
}

async function deleteRemote($: EngineInterface, name: string): Promise<Outcome> {
  const r = await exec($, ['git', 'push', 'origin', '--delete', name], undefined, 60000)
  await refresh($)

  return r.ok ? { ok: true, text: `${name} supprimée sur origin.` } : { ok: false, text: `Suppression de ${name} sur origin refusée : ${tailLines(r.err) || 'erreur git'}` }
}

// The commands as the person would type them, for the tooltip and the flash line. They mirror the functions above.
const pushCmd = (s: Snapshot, branch: string): string => {
  const wt = s.worktrees.find(w => w.branch === branch)
  const known = s.refs.find(r => r.name === branch)
  const hook = wt !== undefined && CFG.prePush !== '' ? `(cd ${wt.name} && sh ${CFG.prePush} origin) puis ` : ''

  return `${hook}git push ${known?.origin ? '' : '-u '}origin ${branch}`
}
const prCmd = (s: Snapshot, head: string, base: string): string =>
  `gh pr create --repo ${s.repoSlug ?? '?'} --base ${base} --head ${head} ${head === CFG.dev && base === CFG.stg ? '--title "Promotion … " --body <liste des commits>' : '--fill'}`

const rowText = (r: Row): string =>
  r.t === 'commit' ? `${r.sha} ${r.text}` : r.t === 'pr' ? `PR #${r.pr.number} ${r.pr.head} → ${r.pr.base}` : r.t === 'deploy' ? `${r.item.label} : ${r.item.state}` : r.t === 'file' ? `${r.code} ${r.path}` : r.t === 'status' ? `${r.code} ${r.verb} ${r.path}` : r.t === 'log' ? `${r.time} ${r.state} ${r.cmd}` : r.t === 'ref' ? `${r.name} ${r.local ? 'local ' : ''}${r.origin ? 'origin ' : ''}${r.wt ? 'worktree ' : ''}${r.state}` : r.text

const RAIL: Record<string, number> = { src: 3, dev: 7, od: 6, 'gate-stg': 5, stg: 4, 'gate-prom': 3, mst: 2.5 }


const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text)

export const register: Register = (on, options) => {
  CFG = readCfg(options)
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'pulse3', description: 'Entonnoir des branches vers la prod : PR, checks et déploiements' })
    void reloadAll($)
    // Pending checks and running deploys change on their own: look again every 20 s, and only then.
    $.clock.every(20000, async () => {
      const [p, d, b] = [await read($, prs), await read($, deploys), await read($, busy)]
      const waiting = p.list.some(x => x.state === 'OPEN' && x.checks === 'pending') || summarize(d.staging) === 'run' || summarize(d.master) === 'run'
      if (waiting && b === null) void Promise.all([loadPrs($), loadDeploys($)])
    })

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if ((await $.clock.now()) - (await read($, lastAt)) > 30000) void reloadAll($)

    return next(e)
  })

  on('command.run', { command: 'pulse3' }, async ($, e) => {
    const opened = await $.ui.open({ id: PANE, title: 'Pulse+' })
    if (e.args.trim() === 'fetch') void act($, 'fetch', 'Fetch', () => doFetch($), 'git fetch origin --prune')
    else void act($, 'refresh', 'Rafraîchissement', () => doRefresh($), 'lectures git + gh pr list + gh run list')

    return { text: opened.isPlaced ? 'Pulse ouvert (volet à côté de la conversation).' : `Pulse n'a pas de place : ${opened.reason}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const T = $.ui.resolve(e) as unknown as Record<string, any>
    const { Box, Button, Text } = T as { Box: any; Button: any; Text: any }
    const Svg = T.Svg as any
    const s = await read($, snap)
    const p = await read($, prs)
    const d = await read($, deploys)
    const busyId = await read($, busy)
    const logList = await read($, logs)
    const readList = await read($, reads)
    const showAll = await read($, logAll)
    const arm = await read($, armed)
    const last = await read($, flash)
    const userOpen = await read($, open)
    const userShut = await read($, shut)
    const listsV = await read($, lists)
    const detailsV = await read($, details)
    const refsOpen = await read($, openRefs)
    const commitsOpen = await read($, openCommits)
    const props = e.props as { bodyColumns?: number } | undefined
    const rowsAvail = e.viewport?.rows ?? 40
    const cols = props?.bodyColumns ?? e.viewport?.columns ?? 60
    // Sizes follow the pane: about 8.4 px a column, the pictures scaled to fill it (never smaller than 0.95, never past 1.3).
    const px = cols * 8.4
    const k = Math.min(1.3, Math.max(0.95, px / 620))
    const bodyU = Math.round(Math.min(760, Math.max(300, px / k - 8)))
    const headU = Math.round(Math.min(430, Math.max(280, bodyU * 0.56)))
    const now = await $.clock.now()

    if (s === null) return <Text dimColor>Pulse lit le dépôt…</Text>

    const src = sourcesOf(s, p.list)
    const stage = stageOf(s, p.list, d, src)
    const stgPr = openPrTo(p.list, CFG.stg)
    const mstPr = openPrTo(p.list, CFG.mst)
    const todo = pending(src).length + (s.develop.unpushed > 0 ? 1 : 0) + (s.toStaging > 0 ? 1 : 0) + (s.toMaster > 0 ? 1 : 0)
    const home = s.worktrees.at(0)?.path

    // ---- buttons: each one carries the command behind it, shown in the bar when the pointer is on it ------------
    const tips = new Map<string, string>()
    const scopeOf = (id: string) => `tip:${id}`.slice(0, 64)
    const hov = (id: string, cmd: string) => {
      tips.set(id, cmd)

      return { scope: scopeOf(id) }
    }
    const act1 = (id: string, label: string, cmd: string, work: () => Promise<Outcome>, primary = true) => (
      <Button key={id} label={busyId === id ? `… ${label}` : label} {...(primary ? { variant: 'primary' } : {})} hover={hov(id, cmd)} onPress={() => void act($, id, label, work, cmd)} />
    )
    const link = (id: string, label: string, target: string) => (
      <Button key={id} label={label} hover={hov(id, `open ${target}`)} onPress={() => void act($, id, label, () => openUrl($, target), `open ${target}`)} />
    )
    const copyBtn = (id: string, label: string, text: string) => (
      <Button key={id} label={label} hover={hov(id, `copie dans le presse-papiers : ${text}`)} onPress={(press: UiPressArgument) => $.ui.copy({ text, surface: press.surface })} />
    )
    // Two presses: the first arms the button and says what it will do, the second does it.
    const confirm = (id: string, label: string, ask: string, cmd: string, work: () => Promise<Outcome>) => (
      <Button
        key={id}
        label={busyId === id ? `… ${label}` : arm === id ? ask : label}
        variant="primary"
        hover={hov(id, cmd)}
        onPress={() => {
          if (arm === id) void act($, id, label, work, cmd)
          else {
            void update($, armed, () => id)
            $.clock.after(8000, () => void update($, armed, cur => (cur === id ? null : cur)))
          }
        }}
      />
    )

    // ---- commits: native rows (selectable text, real buttons), each opening into its message, files and holders ----
    const toggleCommit = async (key: string, c: LaneCommit) => {
      const isOpen = commitsOpen.includes(key)
      await update($, openCommits, list => (isOpen ? list.filter(x => x !== key) : [...list, key]))
      if (!isOpen && !(c.full in detailsV)) await loadDetail($, s, c)
    }
    const ageOf = (c: LaneCommit) => ageLabel(Number(c.age), now)
    const commitBlock = (ctx: string, c: LaneCommit, indent = 3) => {
      const key = `${ctx}:${c.full}`
      const isOpen = commitsOpen.includes(key)
      const det = detailsV[c.full]
      const subject = clip(c.subject, Math.max(24, cols - indent * 2 - 26))
      const body = det === undefined ? [] : det.body.split('\n').slice(0, 12)
      const stat = det === undefined ? [] : det.stat.split('\n').filter(x => x.trim() !== '').slice(0, 10)

      return (
        <Box key={key} flexDirection="column">
          <Box gap={1} paddingLeft={indent}>
            <Text dimColor>{isOpen ? '▾' : '▸'}</Text>
            <Text dimColor>{c.sha}</Text>
            <Button key={`cb-${key}`} plain label={subject} hover={hov(`c-${key}`, `git show --stat ${c.sha}`)} onPress={() => void toggleCommit(key, c)} />
            <Text dimColor>{ageOf(c)}</Text>
          </Box>
          {isOpen && (
            <Box flexDirection="column" paddingLeft={indent + 3}>
              {det === undefined && <Text dimColor>chargement…</Text>}
              {body.map((line, i) => <Text key={`b-${key}-${i}`}>{line === '' ? ' ' : line}</Text>)}
              {stat.map((line, i) => <Text key={`s-${key}-${i}`} dimColor>{line.trim()}</Text>)}
              {det !== undefined && det.holders.length > 0 && <Text dimColor>{`dans : ${det.holders.join(', ')}`}</Text>}
              {det !== undefined && (
                <Box gap={1} marginTop={1} flexWrap="wrap">
                  {s.repoUrl !== null && link(`gh-${key}`, 'Voir sur GitHub', `${s.repoUrl}/commit/${c.full}`)}
                  {copyBtn(`cp-${key}`, 'Copier le hash', c.full)}
                  {det.worktrees.map(w => link(`wt-${key}-${w.path}`, `⎇ ${w.name}`, w.path))}
                </Box>
              )}
            </Box>
          )}
        </Box>
      )
    }
    // A list of commits with its "+25" button; `list` undefined means it is still loading.
    const commitsNode = (ctx: string, list: CommitList | undefined, range: string, loadKey: string, cwd?: string, indent = 3): any[] => {
      if (list === undefined) return [<Box key={`${ctx}-load`} paddingLeft={indent}><Text dimColor>chargement…</Text></Box>]
      const rows: any[] = list.commits.map(c => commitBlock(ctx, c, indent))
      if (list.commits.length === 0) rows.push(<Box key={`${ctx}-none`} paddingLeft={indent}><Text dimColor>aucun commit propre à cette branche</Text></Box>)
      const rest = list.total - list.commits.length
      if (rest > 0) {
        const cmd = `git log --no-merges -n${list.limit + 25} ${range}`
        rows.push(
          <Box key={`${ctx}-more`} gap={1} paddingLeft={indent}>
            <Text dimColor>{`… et ${rest} de plus`}</Text>
            <Button key={`more-${ctx}`} label="+25" hover={hov(`more-${ctx}`, cmd)} onPress={() => void loadCommits($, loadKey, range, list.limit + 25, cwd)} />
          </Box>,
        )
      }

      return rows
    }

    // ---- cards ---------------------------------------------------------------------------
    type CardX = { id: string; spec: CardSpec; buttons: unknown[]; native: unknown[]; nativeRows: number; attention: boolean; order: number }
    const cards: CardX[] = []
    let idx = 0
    const railOf = (key: string) => RAIL[key] ?? 4
    const push = (
      id: string,
      railKey: string,
      color: ColorKey,
      node: CardSpec['node'],
      title: string,
      pills: Pill[],
      meta: string,
      rows: Row[],
      buttons: unknown[],
      opts: { isCurrent?: boolean; isMerged?: boolean; reached?: boolean; native?: unknown[]; nativeRows?: number; attention?: boolean } = {},
    ) => {
      const spec: CardSpec = { color, node, rail: railOf(railKey), railPrev: 0, railNext: 0, reached: opts.reached ?? true, isCurrent: opts.isCurrent ?? false, isMerged: opts.isMerged ?? false, title, pills, meta, rows }
      cards.push({ id, spec, buttons, native: opts.native ?? [], nativeRows: opts.nativeRows ?? 0, attention: opts.attention ?? false, order: idx++ })
    }

    const deployRows = (env: EnvDeploy | null, title: string): Row[] => {
      if (d.status === 'unavailable') return [{ t: 'label', text: title }, { t: 'note', text: `déploiements indisponibles : gh a refusé (workflow « ${title.includes(CFG.stgName) ? CFG.stgWorkflow : CFG.mstWorkflow} » introuvable ?). Règle-le dans les options.` }]
      if (env === null || env.items.length === 0) return [{ t: 'label', text: title }, { t: 'note', text: 'aucun déploiement trouvé' }]

      return [{ t: 'label', text: title }, ...env.items.map((item): Row => ({ t: 'deploy', item, age: item.at === null ? '' : isoAge(new Date(item.at).toISOString(), now) }))]
    }
    const deployPill = (env: EnvDeploy | null): Pill[] => {
      const sum = summarize(env)

      return sum === 'fail' ? [{ text: 'échec', kind: 'red' }] : sum === 'run' ? [{ text: 'en cours', kind: 'blue' }] : sum === 'ok' ? [{ text: 'déployé', kind: 'green' }] : []
    }
    const deployButtons = (env: EnvDeploy | null, id: string): unknown[] => {
      if (env === null) return []
      const out: unknown[] = []
      if (env.runUrl !== '') out.push(link(`run-${id}`, 'Run', env.runUrl))
      if (summarize(env) === 'fail') out.push(act1(`rerun-${id}`, 'Relancer', `gh run rerun ${env.runId} --repo ${s.repoSlug} --failed`, () => rerunFailed($, s, env)))

      return out
    }
    const prPill = (pr: Pr): Pill => (pr.state === 'MERGED' ? { text: `#${pr.number} fusionnée`, kind: 'violet' } : pr.checks === 'ok' ? { text: `#${pr.number} ✓`, kind: 'green' } : pr.checks === 'fail' ? { text: `#${pr.number} ✕`, kind: 'red' } : { text: `#${pr.number} …`, kind: 'amber' })
    const prButtons = (pr: Pr, id: string, ask: string): unknown[] => {
      const out: unknown[] = [link(`open-${id}`, 'Ouvrir', pr.url), copyBtn(`copy-${id}`, 'Copier le lien', pr.url)]
      if (pr.state === 'OPEN' && pr.checks === 'ok') out.push(confirm(`merge-${id}`, 'Fusionner', ask, `gh pr merge ${pr.number} --repo ${s.repoSlug} --merge`, () => mergePr($, s, pr)))

      return out
    }
    const laneInfo = (id: 'develop-local' | 'develop-origin' | 'staging' | 'master') => {
      const l = s.lanes.find(x => x.id === id)
      const list: CommitList = listsV[`lane:${id}`] ?? { commits: l?.commits ?? [], total: (l?.commits.length ?? 0) + (l?.more ?? 0), limit: LANE_COMMITS }

      return { list, range: l?.range ?? '', key: `lane:${id}` }
    }
    const laneNative = (id: 'develop-local' | 'develop-origin' | 'staging' | 'master') => {
      const li = laneInfo(id)
      const nodes = commitsNode(`lane-${id}`, li.list, li.range, li.key)

      return { native: nodes, nativeRows: li.list.commits.length + 1 }
    }

    // git status: what `git status` says in every worktree, in its own colours
    {
      const dirty = s.worktrees.filter(w => w.dirty > 0)
      const total = dirty.reduce((n, w) => n + w.dirty, 0)
      const rows: Row[] = []
      for (const w of s.worktrees) {
        if (w.dirty === 0 && !w.branchLine.includes('ahead') && !w.branchLine.includes('behind') && !w.isMain) continue
        rows.push({ t: 'label', text: `⎇ ${w.name}` })
        if (w.branchLine !== '') rows.push({ t: 'branch', text: w.branchLine })
        const g = groupStatus(w.files)
        const section = (title: string, files: typeof w.files, tone: 'ok' | 'fail') => {
          if (files.length === 0) return
          rows.push({ t: 'note', text: `${title}:` })
          for (const f of files.slice(0, 60)) rows.push({ t: 'status', tone, code: f.code, verb: statusVerb(f.code), path: f.path })
          if (files.length > 60) rows.push({ t: 'note', text: `… et ${files.length - 60} de plus` })
        }
        section('Changes to be committed', g.staged, 'ok')
        section('Changes not staged for commit', g.unstaged, 'fail')
        section('Untracked files', g.untracked, 'fail')
        if (w.dirty === 0) rows.push({ t: 'note', text: 'nothing to commit, working tree clean' })
      }
      push('git-status', 'src', total > 0 ? 'amber' : 'green', 'src', 'git status', [{ text: total > 0 ? `${total} ${plural(total, 'fichier', 'fichiers')}` : 'propre', kind: total > 0 ? 'amber' : 'green' }], `${dirty.length} ${plural(dirty.length, 'worktree sale', 'worktrees sales')}`, rows, [], { attention: total > 0 })
    }

    // Branches: every worktree, every local branch, every branch on origin. Each opens into its commits and its buttons.
    {
      const toggleRef = async (x: RefInfo, range: string, cwd: string | undefined) => {
        const isOpen = refsOpen.includes(x.name)
        await update($, openRefs, list => (isOpen ? list.filter(n => n !== x.name) : [...list, x.name]))
        if (!isOpen && listsV[`ref:${x.name}`] === undefined) await loadCommits($, `ref:${x.name}`, range, x.isCore ? 15 : 25, cwd)
      }
      const chip = (text: string, color: string) => <Text key={`chip-${text}-${color}`} backgroundColor={color} color="black" bold>{` ${text} `}</Text>
      const toneColor = (t: string) => (t === 'fail' ? 'red' : t === 'run' ? 'yellow' : t === 'ok' ? 'green' : undefined)
      const refRow = (x: RefInfo): any => {
        const isOpen = refsOpen.includes(x.name)
        const wt = s.worktrees.find(w => w.name === x.worktree)
        const detached = x.name.startsWith('(détaché)')
        const pr = detached ? undefined : findPr(p.list, x.name)
        const live = pr !== undefined && pr.state === 'OPEN' ? pr : undefined
        const st = refState(CFG.dev, x)
        const refName = x.local ? x.name : `origin/${x.name}`
        const range = detached ? `${CFG.dev}..HEAD` : x.isCore ? refName : `${CFG.dev}..${refName}`
        const cwd = detached ? wt?.path : undefined
        const prText = pr === undefined ? '' : pr.state === 'MERGED' ? `PR #${pr.number} fusionnée` : pr.state === 'CLOSED' ? `PR #${pr.number} fermée` : `PR #${pr.number} ${pr.checks === 'ok' ? '✓' : pr.checks === 'fail' ? '✕' : '…'}`
        const state = [st.text, prText].filter(v => v !== '').join(' · ')
        const buttons: unknown[] = []
        const needsPush = x.local && !detached && !isPrOnly(x.name) && ((x.upstream?.ahead ?? 0) > 0 || (!x.origin && x.ahead > 0))
        if (needsPush) buttons.push(act1(`push-${x.name}`, 'Pousser', pushCmd(s, x.name), () => pushBranch($, s, x.name)))
        else if (live !== undefined) buttons.push(...prButtons(live, `ref-${x.name}`, `Confirmer : fusionner #${live.number} ?`))
        else if (!x.isCore && !detached && x.ahead > 0 && !x.isMerged && x.origin) buttons.push(act1(`pr-${x.name}`, `PR → ${CFG.dev}`, prCmd(s, x.name, CFG.dev), () => createPr($, s, x.name, CFG.dev)))
        if (x.isMerged && !x.isCore && !detached) {
          if (wt !== undefined && !wt.isMain) buttons.push(confirm(`rmwt-${x.name}`, 'Supprimer le worktree', `Confirmer : supprimer ${wt.name} ?`, `git worktree remove ${wt.path} puis git branch -d ${x.name}`, () => removeWorktree($, s, wt)))
          else if (x.local && wt === undefined) buttons.push(confirm(`rml-${x.name}`, 'Supprimer en local', `Confirmer : git branch -d ${x.name} ?`, `git branch -d ${x.name}`, () => deleteLocal($, s, x.name)))
          if (x.origin) buttons.push(confirm(`rmo-${x.name}`, 'Supprimer sur origin', `Confirmer : supprimer ${x.name} sur origin ?`, `git push origin --delete ${x.name}`, () => deleteRemote($, x.name)))
        }

        return (
          <Box key={`ref-${x.name}`} flexDirection="column">
            <Box gap={1} flexWrap="wrap" alignItems="center">
              <Button key={`rt-${x.name}`} plain label={`${isOpen ? '▾' : '▸'} ${clip(x.name, Math.max(24, cols - 60))}`} hover={hov(`rt-${x.name}`, `git log --no-merges ${range}`)} onPress={() => void toggleRef(x, range, cwd)} />
              {x.local && chip('local', 'cyan')}
              {x.origin && chip('origin', 'blue')}
              {x.worktree !== null && chip('worktree', 'magenta')}
              {state !== '' && <Text color={toneColor(st.tone)} dimColor={st.tone === 'dim'}>{state}</Text>}
              {buttons}
            </Box>
            {isOpen && (
              <Box flexDirection="column" paddingLeft={2} marginBottom={1}>
                {wt !== undefined && (
                  <Box gap={1} paddingLeft={3}>
                    <Text dimColor>{`⎇ ${wt.path}`}</Text>
                    {link(`wto-${x.name}`, 'Ouvrir', wt.path)}
                  </Box>
                )}
                {pr !== undefined && <Box paddingLeft={3}><Text dimColor>{`PR #${pr.number} ${pr.head} → ${pr.base} · ${pr.title}`}</Text></Box>}
                {commitsNode(`ref-${x.name}`, listsV[`ref:${x.name}`], range, `ref:${x.name}`, cwd, 3)}
              </Box>
            )}
          </Box>
        )
      }
      const order = (a: RefInfo, b: RefInfo) => Number(b.isCore) - Number(a.isCore) || a.name.localeCompare(b.name)
      const localOnly = s.refs.filter(x => x.local && !x.origin).sort(order)
      const both = s.refs.filter(x => x.local && x.origin).sort(order)
      const originOnly = s.refs.filter(x => !x.local && x.origin).sort(order)
      const heading = (text: string) => <Box key={`h-${text}`} paddingLeft={1} marginTop={1}><Text bold dimColor>{text.toUpperCase()}</Text></Box>
      const native: any[] = []
      native.push(heading(`Worktrees · ${s.worktrees.length}`))
      for (const w of s.worktrees) {
        const state = w.isMerged ? 'fusionné' : w.unpushed > 0 ? `⇡${w.unpushed} non poussé` : w.dirty > 0 ? `✎ sale ${w.dirty}` : 'propre'
        const color = w.isMerged ? 'magenta' : w.unpushed > 0 ? 'cyan' : w.dirty > 0 ? 'yellow' : 'green'
        native.push(
          <Box key={`wt-${w.path}`} gap={1} flexWrap="wrap" paddingLeft={1}>
            <Text bold>{w.name}</Text>
            <Text dimColor>{w.branch ?? 'détaché'}</Text>
            <Text color={color}>{state}</Text>
            {w.isMain && <Text dimColor>(principal)</Text>}
            <Text dimColor>{w.path}</Text>
            {link(`wtopen-${w.path}`, 'Ouvrir', w.path)}
          </Box>,
        )
      }
      native.push(heading(`Local seulement, pas sur origin · ${localOnly.length}`))
      for (const x of localOnly) native.push(refRow(x))
      native.push(heading(`Local et origin · ${both.length}`))
      for (const x of both) native.push(refRow(x))
      native.push(heading(`Origin seulement, pas en local · ${originOnly.length}`))
      for (const x of originOnly) native.push(refRow(x))
      const attention = s.refs.some(x => refState(CFG.dev, x).tone === 'fail' || (x.local && !x.origin && x.ahead > 0))
      const nOpen = refsOpen.reduce((n, name) => n + Math.min(26, (listsV[`ref:${name}`]?.commits.length ?? 3) + 2), 0)
      push(
        'branches', 'src', 'cyan', 'src', 'Branches',
        [{ text: `${s.refs.filter(x => x.local).length} local`, kind: 'cyan' }, { text: `${s.refs.filter(x => x.origin).length} origin`, kind: 'blue' }, { text: `${s.worktrees.length} ${plural(s.worktrees.length, 'worktree', 'worktrees')}`, kind: 'violet' }],
        localOnly.length > 0 ? `${localOnly.length} jamais ${plural(localOnly.length, 'poussée', 'poussées')}` : '', [], [], { native, nativeRows: s.worktrees.length + s.refs.length + 6 + nOpen, attention },
      )
    }

    // develop (local)
    push('dev', 'dev', 'cyan', 'stage', CFG.dev, [{ text: String(s.develop.unpushed), kind: 'cyan' }], 'à pousser (local)', [],
      s.develop.unpushed > 0 ? [act1('push-dev', 'Pousser', pushCmd(s, CFG.dev), () => pushBranch($, s, CFG.dev))] : [],
      { isCurrent: stage === 1 && s.develop.unpushed > 0, ...laneNative('develop-local') })

    // origin/develop
    push('od', 'od', 'blue', 'stage', `origin/${CFG.dev}`, [{ text: String(s.toStaging), kind: 'blue' }], `en attente de ${CFG.stg}`, [], [],
      { isCurrent: stage === 1 && s.develop.unpushed === 0, ...laneNative('develop-origin') })

    // gate develop -> staging (nothing to show while there is no PR and nothing to promote)
    if (s.hasStaging && (stgPr !== undefined || s.toStaging > 0)) {
      const pr = stgPr
      const rows: Row[] = pr !== undefined ? [{ t: 'pr', pr }] : [{ t: 'note', text: s.toStaging > 0 ? `${s.toStaging} commits sur origin/${CFG.dev} sans PR vers ${CFG.stg}.` : `Rien à promouvoir vers ${CFG.stg}.` }]
      const buttons: unknown[] = []
      if (pr !== undefined) buttons.push(...prButtons(pr, 'stg', `Confirmer : fusionner #${pr.number} dans ${CFG.stg} ?`))
      else if (s.toStaging > 0) buttons.push(s.develop.unpushed > 0 ? <Text key="need-push" dimColor>{`pousse ${CFG.dev} d'abord`}</Text> : act1('pr-stg', 'Lancer la PR', prCmd(s, CFG.dev, CFG.stg), () => createPr($, s, CFG.dev, CFG.stg)))
      push('gate-stg', 'gate-stg', 'amber', 'gate', `PR ${CFG.dev} → ${CFG.stg}`, pr === undefined ? [{ text: 'aucune', kind: 'grey' }] : [prPill(pr)], '', rows, buttons, { isCurrent: stgPr !== undefined && stage === 1, reached: stage >= 1 })
    }

    // staging
    if (s.hasStaging) push('stg', 'stg', 'amber', 'stage', `origin/${CFG.stg}`, [{ text: String(s.toMaster), kind: 'amber' }, ...deployPill(d.staging)], 'en attente de prod',
      deployRows(d.staging, `Déploiements · ${CFG.stgName}`), deployButtons(d.staging, 'stg'), { isCurrent: stage === 2, reached: stage >= 2, attention: summarize(d.staging) === 'fail', ...laneNative('staging') })

    // gate staging -> master
    if (s.hasStaging && s.hasMaster && (mstPr !== undefined || s.toMaster > 0)) {
      const pr = mstPr
      const rows: Row[] = pr !== undefined ? [{ t: 'pr', pr }] : [{ t: 'note', text: s.toMaster > 0 ? `${s.toMaster} commits prêts : branche promote/* puis PR vers ${CFG.mst}.` : 'Rien à promouvoir en prod.' }]
      const buttons: unknown[] = []
      if (pr !== undefined) buttons.push(...prButtons(pr, 'prom', `Confirmer : fusionner #${pr.number} dans ${CFG.mst} (prod) ?`))
      else if (s.toMaster > 0 && home !== undefined && CFG.runbook !== '') buttons.push(link('runbook', 'Runbook', `${home}/${CFG.runbook}`))
      push('gate-prom', 'gate-prom', 'green', 'gate', `PR promote/* → ${CFG.mst}`, pr === undefined ? [{ text: 'aucune', kind: 'grey' }] : [prPill(pr)], '', rows, buttons, { isCurrent: pr !== undefined, reached: stage >= 2 })
    }

    // master
    if (s.hasMaster) push('mst', 'mst', 'green', 'stage', `origin/${CFG.mst}`, [{ text: 'prod', kind: 'green' }, ...deployPill(d.master)], '',
      deployRows(d.master, `Déploiements · ${CFG.mstName}`), deployButtons(d.master, 'mst'), { isCurrent: stage === 3, reached: stage >= 3, attention: summarize(d.master) === 'fail', ...laneNative('master') })

    // the journal: every action the pane ran, newest first; reads only when asked
    {
      const entries = (showAll ? [...logList, ...readList] : [...logList]).sort((a, b) => a.id - b.id).slice(-40).reverse()
      const failed = logList.filter(x => x.state === 'fail').length
      const native: any[] = entries.length === 0
        ? [<Box key="j-none" paddingLeft={3}><Text dimColor>{showAll ? 'aucune commande lancée' : 'aucune action lancée (le journal liste les pushs, PR, fusions...)'}</Text></Box>]
        : entries.flatMap((x): any[] => [
            <Box key={`j-${x.id}`} gap={1} paddingLeft={3}>
              <Text color={x.state === 'ok' ? 'green' : x.state === 'fail' ? 'red' : 'yellow'} bold>{x.state === 'ok' ? '✓' : x.state === 'fail' ? '✕' : '…'}</Text>
              <Text dimColor>{clock(x.at)}</Text>
              <Text>{x.where === '' ? x.cmd : `${x.cmd}  · ${x.where}`}</Text>
              {x.ms !== null && <Text dimColor>{x.ms >= 1000 ? `${(x.ms / 1000).toFixed(1)} s` : `${x.ms} ms`}</Text>}
            </Box>,
            ...(x.note === '' ? [] : [<Box key={`jn-${x.id}`} paddingLeft={8}><Text color="red">{x.note}</Text></Box>]),
          ])
      const buttons: unknown[] = [
        <Button key="log-all" label={showAll ? 'Actions seules' : 'Toutes les commandes'} hover={hov('log-all', 'affiche aussi les lectures git et gh')} onPress={() => void update($, logAll, v => !v)} />,
      ]
      if (logList.length + readList.length > 0)
        buttons.push(<Button key="log-clear" label="Effacer" hover={hov('log-clear', 'vide le journal (aucune commande lancée)')} onPress={() => { void update($, logs, () => []); void update($, reads, () => []) }} />)
      push('journal', 'mst', 'violet', 'src', 'Journal', [{ text: String(logList.length), kind: 'grey' }, ...(failed > 0 ? [{ text: `${failed} en échec`, kind: 'red' as const }] : [])], showAll ? 'toutes les commandes' : 'actions', [], buttons, { native, nativeRows: entries.length, attention: failed > 0 })
    }

    // Neighbouring rail widths, so each picture's rail eases into the next one's.
    cards.forEach((c, i) => {
      c.spec.railPrev = i === 0 ? c.spec.rail : (cards[i - 1] as CardX).spec.rail
      c.spec.railNext = i === cards.length - 1 ? c.spec.rail : (cards[i + 1] as CardX).spec.rail
    })

    // ---- the path: develop -> origin/develop -> PR -> origin/staging -> promote -> PR -> origin/master ----------
    const dep = (env: EnvDeploy | null): { sub: string; tone: PathNode['tone'] } => {
      const sum = summarize(env)

      return sum === 'fail' ? { sub: 'déploiement ✕', tone: 'fail' } : sum === 'run' ? { sub: 'déploiement …', tone: 'run' } : sum === 'ok' ? { sub: 'déployé ✓', tone: 'ok' } : { sub: '', tone: 'dim' }
    }
    const checksTone = (pr: Pr): PathNode['tone'] => (pr.checks === 'ok' ? 'ok' : pr.checks === 'fail' ? 'fail' : 'run')
    const checksSub = (pr: Pr) => (pr.checks === 'ok' ? 'checks ✓' : pr.checks === 'fail' ? 'checks ✕' : pr.checks === 'pending' ? 'checks …' : 'ouverte')
    const promoteRef = s.refs.find(x => /^promote\//.test(x.name) && !x.isMerged)
    const cur = stage === 1 ? (s.develop.unpushed > 0 ? 'dev' : stgPr !== undefined ? 'prStg' : 'od') : stage === 2 ? (mstPr !== undefined ? 'prMst' : promoteRef !== undefined ? 'promote' : 'stg') : stage === 3 ? 'mst' : ''
    const nodes: PathNode[] = [
      { id: 'dev', name: CFG.dev, sub: s.develop.unpushed > 0 ? `${s.develop.unpushed} à pousser` : 'à jour', color: 'cyan', tone: s.develop.unpushed > 0 ? 'run' : 'ok', isCurrent: cur === 'dev', isGhost: false },
      { id: 'od', name: `origin/${CFG.dev}`, sub: s.toStaging > 0 ? `${s.toStaging} en attente` : 'rien en attente', color: 'blue', tone: s.toStaging > 0 ? 'run' : 'dim', isCurrent: cur === 'od', isGhost: false },
    ]
    if (s.hasStaging && stgPr !== undefined) nodes.push({ id: 'prStg', name: `PR #${stgPr.number}`, sub: checksSub(stgPr), color: 'amber', tone: checksTone(stgPr), isCurrent: cur === 'prStg', isGhost: false })
    if (s.hasStaging) {
      const dp = dep(d.staging)
      nodes.push({ id: 'stg', name: `origin/${CFG.stg}`, sub: dp.sub !== '' && dp.tone !== 'ok' ? dp.sub : s.toMaster > 0 ? `${s.toMaster} en attente` : dp.sub || 'rien en attente', color: 'amber', tone: dp.tone !== 'dim' && dp.tone !== 'ok' ? dp.tone : s.toMaster > 0 ? 'run' : dp.tone, isCurrent: cur === 'stg', isGhost: false })
    }
    if (s.hasStaging && s.hasMaster) {
      nodes.push({ id: 'promote', name: promoteRef?.name ?? 'promote/*', sub: promoteRef === undefined ? 'aucune' : promoteRef.origin ? 'sur origin' : 'en local', color: 'violet', tone: promoteRef === undefined ? 'dim' : 'run', isCurrent: cur === 'promote', isGhost: promoteRef === undefined })
      if (mstPr !== undefined) nodes.push({ id: 'prMst', name: `PR #${mstPr.number}`, sub: checksSub(mstPr), color: 'amber', tone: checksTone(mstPr), isCurrent: cur === 'prMst', isGhost: false })
    }
    if (s.hasMaster) {
      const dp = dep(d.master)
      nodes.push({ id: 'mst', name: `origin/${CFG.mst}`, sub: dp.sub || 'prod', color: 'green', tone: dp.tone, isCurrent: cur === 'mst', isGhost: false })
    }
    const path = pathSvg(nodes, bodyU, k)

    // Which cards open by themselves: those that matter first (current stage, a PR, a failure), while the pane has rows left.
    const CELL = 18
    const bodyRows = (c: CardX) => Math.ceil((bodySvg({ ...c.spec }, bodyU, k)?.height ?? 0) / CELL) + c.nativeRows
    let used = 5 + Math.ceil(path.height / CELL) + cards.length * Math.ceil((30 * k) / CELL)
    const openSet = new Set(userOpen.filter(id => !userShut.includes(id)))
    for (const id of openSet) used += bodyRows(cards.find(c => c.id === id) ?? ({ spec: { rows: null }, nativeRows: 0 } as unknown as CardX))
    const matters = (c: CardX) => (c.attention || c.spec.isCurrent ? 0 : c.spec.rows?.some(r => r.t === 'pr' || (r.t === 'deploy' && r.item.state === 'fail')) ? 1 : 2)
    for (const c of [...cards].sort((a, b) => matters(a) - matters(b) || a.order - b.order)) {
      if (openSet.has(c.id) || userShut.includes(c.id)) continue
      const h = bodyRows(c)
      // What does not matter yet only fills spare room, and leaves a margin.
      if (h > 0 && used + h <= rowsAvail - (matters(c) > 1 ? 8 : 3)) {
        openSet.add(c.id)
        used += h
      }
    }
    const isOpen = (id: string) => openSet.has(id)
    const toggleCard = (id: string) => (
      <Button
        key={`t-${id}`}
        plain
        dimColor
        label={isOpen(id) ? '▾' : '▸'}
        hover={hov(`t-${id}`, isOpen(id) ? 'replie la carte' : 'déplie la carte')}
        onPress={() => {
          if (isOpen(id)) {
            void update($, open, list => list.filter(x => x !== id))
            void update($, shut, list => [...list.filter(x => x !== id), id])
          } else {
            void update($, shut, list => list.filter(x => x !== id))
            void update($, open, list => [...list.filter(x => x !== id), id])
          }
        }}
      />
    )

    // ---- header ----------------------------------------------------------------------------
    const flashColor = last === null ? undefined : last.kind === 'ok' ? 'green' : last.kind === 'fail' ? 'red' : 'cyan'
    const allOpen = openSet.size > 3
    const header = (
      <Box key="head" flexDirection="column">
        <Box gap={2} flexWrap="wrap">
          <Text bold color={todo > 0 ? 'yellow' : 'green'}>● Pulse+</Text>
          <Text color={todo > 0 ? 'yellow' : 'green'}>{todo > 0 ? `à traiter · ${todo}` : 'à jour'}</Text>
          <Text dimColor>{`fetch il y a ${ageLabel(s.fetchedAt, now)}`}</Text>
          {act1('refresh', 'Rafraîchir', 'lectures git + gh pr list + gh run list', () => doRefresh($))}
          {act1('fetch', 'Fetch', 'git fetch origin --prune, puis relecture de gh', () => doFetch($), false)}
          <Button
            key="all"
            plain
            dimColor
            label={allOpen ? 'Tout replier' : 'Tout déplier'}
            hover={hov('all', 'affiche ou masque le détail de toutes les cartes')}
            onPress={() => {
              const all = cards.map(c => c.id)
              void update($, open, () => (allOpen ? [] : all))
              void update($, shut, () => (allOpen ? all : []))
            }}
          />
        </Box>
        <Text>{`Étape ${stage + 1}/4 · ${statusText(s, p.list, d, src, stage)}`}</Text>
        {last !== null && (
          <Box gap={2} flexWrap="wrap">
            <Text color={flashColor}>{`${last.kind === 'ok' ? '✓' : last.kind === 'fail' ? '✗' : '…'} ${last.text}`}</Text>
            {last.url !== undefined && last.url !== '' && link('flash-open', 'Ouvrir sur GitHub', last.url)}
          </Box>
        )}
      </Box>
    )

    // ---- the body ---------------------------------------------------------------------------
    const bodyNodes: any[] = [header]
    if (Svg === undefined) {
      for (const c of cards) {
        bodyNodes.push(
          <Box key={c.id} flexDirection="column" marginBottom={1}>
            <Text bold>{`${c.spec.title}  ${c.spec.pills.map(x => x.text).join(' ')}  ${c.spec.meta}`}</Text>
            {isOpen(c.id) && c.spec.rows !== null && c.spec.rows.map((r, i) => <Text key={`${c.id}-${i}`} dimColor>{rowText(r)}</Text>)}
            {isOpen(c.id) && c.native}
            <Box gap={1}>{toggleCard(c.id)}{c.buttons}</Box>
          </Box>,
        )
      }
    } else {
      bodyNodes.push(<Svg key="path" source={path.source} width={Math.round(bodyU * k)} alt={`Chemin : ${nodes.map(n => `${n.name} ${n.sub}`).join(', puis ')}`} />)
      for (const c of cards) {
        const head = headerSvg(c.spec, headU, k)
        const body = isOpen(c.id) ? bodySvg(c.spec, bodyU, k) : null
        bodyNodes.push(
          <Box key={c.id} flexDirection="column">
            <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={1}>
              <Svg source={head.source} width={Math.round(headU * k)} alt={`${c.spec.title} ${c.spec.pills.map(x => x.text).join(', ')}`} />
              {toggleCard(c.id)}
              {c.buttons}
            </Box>
            {body !== null && <Svg source={body.source} width={Math.round(bodyU * k)} alt={`Détails de ${c.spec.title}`} />}
            {isOpen(c.id) && c.native.length > 0 && <Box flexDirection="column" paddingLeft={2} marginBottom={1}>{c.native}</Box>}
          </Box>,
        )
      }
    }
    if (s.remoteMerged.length > 0) {
      bodyNodes.push(
        <Box key="clean" gap={2} flexWrap="wrap">
          <Text color="magenta">{`⎇ ${s.remoteMerged.length} ${plural(s.remoteMerged.length, 'branche distante déjà fusionnée', 'branches distantes déjà fusionnées')}`}</Text>
          {confirm('clean', 'Nettoyer les fusionnés', `Confirmer : supprimer ${s.remoteMerged.length} sur origin ?`, `git push origin --delete ${s.remoteMerged.join(' ')}`, () => removeRemote($, s))}
        </Box>,
      )
    }
    bodyNodes.push(<Text key="size" dimColor>{`volet ${cols} colonnes, ${rowsAvail} lignes · survole un bouton pour voir sa commande`}</Text>)

    // The command bar: hidden lines, one per button, each shown while the pointer is on its button. Top and bottom, so it is in view.
    const tipBar = (key: string) => (
      <Box key={key} height={1}>
        <Text dimColor>{'commande › '}</Text>
        {[...tips].map(([id, cmd]) => (
          <Box key={`${key}-${id}`} display="none" hover={{ scope: scopeOf(id), display: 'flex' }}>
            <Text color="yellow">{clip(cmd, Math.max(30, cols - 14))}</Text>
          </Box>
        ))}
      </Box>
    )

    return (
      <Box flexDirection="column">
        {[tipBar('tip-top'), ...bodyNodes, tipBar('tip-bottom')]}
      </Box>
    )
  })
}

// One line of `git status --porcelain`: `code` is the two-letter XY column, `path` what git prints.
export type FileChange = { code: string; path: string }

export type Worktree = {
  path: string
  name: string
  branch: string | null
  isMain: boolean
  dirty: number
  files: FileChange[]
  unpushed: number
  onOrigin: boolean
  ahead: number
  isMerged: boolean
  // `git status --porcelain -b`'s opening line, worded as `git status` does
  branchLine: string
}

export type CheckState = 'ok' | 'fail' | 'run'
export type Check = { name: string; state: CheckState }

export type Pr = {
  number: number
  title: string
  url: string
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  base: string
  head: string
  checks: 'ok' | 'fail' | 'pending' | 'none'
  checkList: Check[]
}

export type Prs = { list: Pr[]; status: 'none' | 'ok' | 'unavailable' }

// One branch name, wherever it lives: a local branch, its origin counterpart, a worktree that has it checked out.
export type RefInfo = {
  name: string
  local: boolean
  origin: boolean
  worktree: string | null
  // commits the branch holds that the integration branch lacks
  ahead: number
  // the local branch against its upstream
  upstream: { ahead: number; behind: number } | null
  isGone: boolean
  isMerged: boolean
  isCore: boolean
  dirty: number
}

export type RemoteBranch = { name: string; ahead: number }
export type LaneCommit = { sha: string; full: string; subject: string; age: string }
export type Lane = { id: 'develop-local' | 'develop-origin' | 'staging' | 'master'; range: string; commits: LaneCommit[]; more: number }

// A list of commits read on demand: how many are loaded, and how many the range holds.
export type CommitList = { commits: LaneCommit[]; total: number; limit: number }

// What a click on a commit unfolds: full message, files touched, branches and worktrees that hold it.
export type CommitDetail = { body: string; stat: string; holders: string[]; worktrees: { name: string; path: string; branch: string }[] }

export type Snapshot = {
  current: { branch: string | null }
  develop: { unpushed: number; behind: number }
  hasStaging: boolean
  hasMaster: boolean
  toStaging: number
  toMaster: number
  stagingExtra: number
  masterExtra: number
  lanes: Lane[]
  worktrees: Worktree[]
  remoteMerged: string[]
  remoteBranches: RemoteBranch[]
  refs: RefInfo[]
  repoUrl: string | null
  repoSlug: string | null
  fetchedAt: number | null
  takenAt: number
}

// One deployment step of an environment: a job of the deploy workflow, or the Vercel deployment.
export type DeployItem = { key: string; label: string; state: 'ok' | 'fail' | 'run' | 'skipped'; url: string; at: number | null }
export type EnvDeploy = { runId: number | null; runUrl: string; sha: string; items: DeployItem[]; at: number | null }
export type Deploys = { staging: EnvDeploy | null; master: EnvDeploy | null; status: 'none' | 'ok' | 'unavailable' }

// One command the pane ran: `kind` tells an action (push, PR, merge...) from a read the journal hides by default.
export type LogEntry = { id: number; at: number; cmd: string; where: string; state: 'run' | 'ok' | 'fail'; ms: number | null; note: string; kind: 'read' | 'action' }

// The answer to the last click: what is running, what worked, what failed. `url` adds an "Ouvrir" button.
export type Flash = { kind: 'pending' | 'ok' | 'fail'; text: string; at: number; url?: string }

declare module 'claude-code' {
  interface PluginState {
    'pulse-saas': {
      snap: Snapshot | null
      prs: Prs
      deploys: Deploys
      armed: string | null
      busy: string | null
      flash: Flash | null
      open: string[]
      shut: string[]
      logs: LogEntry[]
      reads: LogEntry[]
      logAll: boolean
      lists: Record<string, CommitList>
      details: Record<string, CommitDetail>
      openRefs: string[]
      openCommits: string[]
      lastAt: number
    }
  }
}

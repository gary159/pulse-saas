import type { Check, DeployItem, Pr } from '../types'

// Everything the pane draws as a picture: the funnel strip and one SVG per card.
// The picture cannot be clicked: every action is a native Button the register module puts under it.

// Widths in CSS pixels: a one-line header sits beside its buttons, an open card's body spans the pane.
export const HEAD_W = 340
export const BODY_W = 440
// A picture is drawn in user units and shown scaled by k, so the pane's width and height decide its size, not the markup's.
const GUT = 28
const RAIL_X = 12
const PAD = 12

export type Kind = 'amber' | 'green' | 'cyan' | 'blue' | 'violet' | 'red' | 'grey'
export type Pill = { text: string; kind: Kind }
export type ColorKey = 'cyan' | 'blue' | 'amber' | 'green' | 'violet'

export type Row =
  | { t: 'commit'; sha: string; text: string; age: string }
  | { t: 'label'; text: string }
  | { t: 'note'; text: string }
  | { t: 'file'; code: string; path: string }
  | { t: 'pr'; pr: Pr }
  | { t: 'branch'; text: string }
  | { t: 'ref'; name: string; local: boolean; origin: boolean; wt: boolean; state: string; tone: 'dim' | 'ok' | 'run' | 'fail' }
  | { t: 'status'; tone: 'ok' | 'fail'; code: string; verb: string; path: string }
  | { t: 'log'; state: 'run' | 'ok' | 'fail'; time: string; cmd: string; ms: number | null; note: string }
  | { t: 'deploy'; item: DeployItem; age: string }

export type CardSpec = {
  color: ColorKey
  node: 'stage' | 'src' | 'gate'
  rail: number
  railPrev: number
  railNext: number
  reached: boolean
  isCurrent: boolean
  isMerged?: boolean
  title: string
  pills: Pill[]
  meta: string
  rows: Row[] | null
}

const FONT = "'Plus Jakarta Sans', system-ui, -apple-system, 'Segoe UI', sans-serif"
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace"

const STYLE = `
:root{--bg:#262624;--page:#1f1e1d;--line:#3d3c38;--fg:#faf9f5;--dim:#a9a79e;--off:#3d3c38;--cyan:#4fc3d9;--blue:#7d93ff;--amber:#f5b83d;--green:#3ddc97;--violet:#b48cff;--red:#ff6b70;
--s-amber:#3b2f10;--t-amber:#ffd37a;--s-green:#11352a;--t-green:#7be8b5;--s-cyan:#0f353d;--t-cyan:#8fe3f2;--s-blue:#222a55;--t-blue:#b4c0ff;--s-violet:#2d2352;--t-violet:#d9c8ff;--s-red:#431b1e;--t-red:#ffa8ac;--s-grey:#34332f;--t-grey:#d0cec4}
@media (prefers-color-scheme: light){:root{--bg:#ffffff;--page:#eef0f7;--line:#e6e8f2;--fg:#1b1f3b;--dim:#6b7090;--off:#dfe2f0;--cyan:#17a2c0;--blue:#4f6bff;--amber:#e89a0c;--green:#1fb36b;--violet:#7c3aed;--red:#e5484d;
--s-amber:#fff3d6;--t-amber:#9a6200;--s-green:#def7ea;--t-green:#0e7a47;--s-cyan:#d8f3f8;--t-cyan:#0b6f84;--s-blue:#e9edff;--t-blue:#3a54e0;--s-violet:#eee7ff;--t-violet:#6d3fd6;--s-red:#ffe3e4;--t-red:#b3262b;--s-grey:#eceef7;--t-grey:#4b5075}}
text{font-family:${FONT}}
.m{font-family:${MONO}}
.fg{fill:var(--fg)}.dim{fill:var(--dim)}
.ok{fill:var(--green)}.run{fill:var(--amber)}.fail{fill:var(--red)}.skip{fill:var(--dim)}
.p-amber{fill:var(--s-amber)}.tt-amber{fill:var(--t-amber)}.p-green{fill:var(--s-green)}.tt-green{fill:var(--t-green)}
.p-cyan{fill:var(--s-cyan)}.tt-cyan{fill:var(--t-cyan)}.p-blue{fill:var(--s-blue)}.tt-blue{fill:var(--t-blue)}
.p-violet{fill:var(--s-violet)}.tt-violet{fill:var(--t-violet)}.p-red{fill:var(--s-red)}.tt-red{fill:var(--t-red)}
.p-grey{fill:var(--s-grey)}.tt-grey{fill:var(--t-grey)}
`

export const esc = (s: string): string => s.replace(/[&<>"]/g, c => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'))
const tw = (s: string, size: number, bold = false): number => s.length * size * (bold ? 0.6 : 0.55)
export const fit = (s: string, maxPx: number, size: number): string => {
  const max = Math.max(3, Math.floor(maxPx / (size * 0.55)))

  return s.length <= max ? s : `${s.slice(0, max - 1)}…`
}

const COLOR_VAR: Record<ColorKey, string> = { cyan: 'var(--cyan)', blue: 'var(--blue)', amber: 'var(--amber)', green: 'var(--green)', violet: 'var(--violet)' }

const pill = (x: number, y: number, p: Pill, size = 11.5): { svg: string; w: number } => {
  const w = Math.round(tw(p.text, size, true) + size * 1.4)

  return {
    w,
    svg: `<rect x="${x}" y="${y - size * 1.1}" width="${w}" height="${size * 1.55}" rx="${size * 0.78}" class="p-${p.kind}"/><text x="${x + w / 2}" y="${y}" font-size="${size}" font-weight="600" text-anchor="middle" class="tt-${p.kind}">${esc(p.text)}</text>`,
  }
}

const stateClass = (s: DeployItem['state'] | Check['state']): string => (s === 'ok' ? 'ok' : s === 'fail' ? 'fail' : s === 'run' ? 'run' : 'skip')
const stateWord = (s: DeployItem['state']): string => (s === 'ok' ? 'ok' : s === 'fail' ? 'échec' : s === 'run' ? 'en cours' : 'ignoré')

// Row painters: each returns the markup and the height it took.
function paintRow(row: Row, y: number, x0: number, cardW: number): { svg: string; h: number } {
  const L = x0 + 14
  const R = x0 + cardW - PAD
  switch (row.t) {
    case 'label':
      return { h: 26, svg: `<text x="${L}" y="${y + 17}" font-size="10.5" font-weight="700" letter-spacing="1" class="dim">${esc(row.text.toUpperCase())}</text>` }
    case 'note':
      return { h: 22, svg: `<text x="${L}" y="${y + 15}" font-size="12.5" class="dim">${esc(fit(row.text, R - L, 12.5))}</text>` }
    case 'commit': {
      const textX = L + 64
      const ageW = row.age === '' ? 0 : tw(row.age, 11.5) + 8

      return {
        h: 21,
        svg:
          `<text x="${L}" y="${y + 15}" font-size="11.5" class="m dim">${esc(row.sha)}</text>` +
          `<text x="${textX}" y="${y + 15}" font-size="12.5" class="fg">${esc(fit(row.text, R - textX - ageW, 12.5))}</text>` +
          (row.age === '' ? '' : `<text x="${R}" y="${y + 15}" font-size="11.5" text-anchor="end" class="dim">${esc(row.age)}</text>`),
      }
    }
    case 'ref': {
      // Three fixed slots, so where a branch lives reads down a column: local, origin, worktree.
      const nameW = Math.max(120, (R - L) * 0.38)
      const slot = (i: number, on: boolean, text: string, kind: Kind) => (on ? pill(L + nameW + [0, 52, 108][i]!, y + 15, { text, kind }, 10.5).svg : '')
      const tx = L + nameW + 184

      return {
        h: 22,
        svg:
          `<text x="${L}" y="${y + 15}" font-size="12" class="m fg">${esc(fit(row.name, nameW - 8, 12))}</text>` +
          slot(0, row.local, 'local', 'cyan') + slot(1, row.origin, 'origin', 'blue') + slot(2, row.wt, 'worktree', 'violet') +
          (row.state === '' ? '' : `<text x="${tx}" y="${y + 15}" font-size="11.5" class="${row.tone === 'dim' ? 'dim' : row.tone}">${esc(fit(row.state, R - tx, 11.5))}</text>`),
      }
    }
    case 'branch':
      return { h: 22, svg: `<text x="${L}" y="${y + 15}" font-size="12" class="m dim">${esc(fit(row.text, R - L, 12))}</text>` }
    case 'status': {
      // Two columns as git draws them: the index (green when staged) and the work tree (red).
      const cls = row.tone === 'ok' ? 'ok' : 'fail'
      const x = row.code === '??' ? `<tspan class="fail">??</tspan>` : `<tspan class="ok">${esc(row.code[0] === ' ' ? '\u00a0' : (row.code[0] ?? ''))}</tspan><tspan class="fail">${esc(row.code[1] === ' ' ? '\u00a0' : (row.code[1] ?? ''))}</tspan>`
      const vx = L + 26
      const px = vx + (row.verb === '' ? 0 : 86)

      return {
        h: 20,
        svg: `<text x="${L}" y="${y + 14}" font-size="12" class="m">${x}</text>` + (row.verb === '' ? '' : `<text x="${vx}" y="${y + 14}" font-size="12" class="m ${cls}">${esc(row.verb)}</text>`) + `<text x="${px}" y="${y + 14}" font-size="12" class="m ${cls}">${esc(fit(row.path, R - px, 12))}</text>`,
      }
    }
    case 'log': {
      const cls = row.state === 'ok' ? 'ok' : row.state === 'fail' ? 'fail' : 'run'
      const glyph = row.state === 'ok' ? '✓' : row.state === 'fail' ? '✕' : '…'
      const msW = row.ms === null ? 0 : 52
      const cx = L + 66
      let out =
        `<text x="${L}" y="${y + 14}" font-size="12" font-weight="700" class="${cls}">${glyph}</text>` +
        `<text x="${L + 16}" y="${y + 14}" font-size="11" class="m dim">${esc(row.time)}</text>` +
        `<text x="${cx + 22}" y="${y + 14}" font-size="12" class="m fg">${esc(fit(row.cmd, R - cx - 22 - msW, 12))}</text>` +
        (row.ms === null ? '' : `<text x="${R}" y="${y + 14}" font-size="11" text-anchor="end" class="dim">${row.ms >= 1000 ? `${(row.ms / 1000).toFixed(1)} s` : `${row.ms} ms`}</text>`)
      let h = 20
      if (row.note !== '') {
        out += `<text x="${cx + 22}" y="${y + 29}" font-size="11" class="m fail">${esc(fit(row.note, R - cx - 22, 11))}</text>`
        h = 34
      }

      return { h, svg: out }
    }
    case 'file': {
      const p = pill(L, y + 15, { text: row.code.trim() === '??' ? '?' : row.code.replace(' ', '').slice(0, 1) || 'M', kind: row.code.trim() === '??' ? 'grey' : 'amber' })

      return { h: 22, svg: `${p.svg}<text x="${L + p.w + 8}" y="${y + 15}" font-size="12" class="m fg">${esc(fit(row.path, R - L - p.w - 8, 12))}</text>` }
    }
    case 'deploy': {
      const it = row.item
      const cls = stateClass(it.state)

      return {
        h: 26,
        svg:
          `<circle cx="${L + 5}" cy="${y + 12}" r="5" class="${cls}"/>` +
          `<text x="${L + 18}" y="${y + 16}" font-size="12.5" font-weight="600" class="fg">${esc(it.label)}</text>` +
          `<text x="${L + 18 + tw(it.label, 12.5, true) + 10}" y="${y + 16}" font-size="12" font-weight="600" class="${cls}">${esc(stateWord(it.state))}</text>` +
          (row.age === '' ? '' : `<text x="${R}" y="${y + 16}" font-size="11.5" text-anchor="end" class="dim">${esc(row.age)}</text>`),
      }
    }
    case 'pr': {
      const pr = row.pr
      const bx = x0 + PAD
      const bw = cardW - PAD * 2
      let cy = y + 8
      let out = ''
      const open = pr.state === 'OPEN'
      const head = `PR #${pr.number}`
      out += `<text x="${bx + 12}" y="${cy + 22}" font-size="13" font-weight="700" class="fg">${esc(head)}</text>`
      const route = `${pr.head} → ${pr.base}`
      out += `<text x="${bx + 12 + tw(head, 13, true) + 10}" y="${cy + 22}" font-size="12.5" class="dim">${esc(fit(route, bw - 200, 12.5))}</text>`
      const word: Pill = pr.state === 'MERGED' ? { text: 'fusionnée', kind: 'violet' } : pr.state === 'CLOSED' ? { text: 'fermée', kind: 'grey' } : pr.checks === 'ok' ? { text: '✓ checks ok', kind: 'green' } : pr.checks === 'fail' ? { text: '✕ checks en échec', kind: 'red' } : pr.checks === 'pending' ? { text: '… checks en cours', kind: 'amber' } : { text: 'sans checks', kind: 'grey' }
      const wp = pill(0, 0, word)
      out += pill(bx + bw - 12 - wp.w, cy + 22, word).svg
      cy += 30
      if (pr.title !== '') {
        out += `<text x="${bx + 12}" y="${cy + 14}" font-size="12.5" class="fg">${esc(fit(pr.title, bw - 24, 12.5))}</text>`
        cy += 24
      }
      if (open && pr.checkList.length > 0) {
        let cx = bx + 12
        let rowTop = cy
        for (const c of pr.checkList) {
          const w = tw(c.name, 11.5) + 22
          if (cx + w > bx + bw - 12) { cx = bx + 12; rowTop += 20 }
          out += `<text x="${cx}" y="${rowTop + 13}" font-size="11.5" class="${stateClass(c.state)}">${c.state === 'ok' ? '✓' : c.state === 'fail' ? '✕' : '…'}</text><text x="${cx + 14}" y="${rowTop + 13}" font-size="11.5" class="dim">${esc(c.name)}</text>`
          cx += w + 8
        }
        cy = rowTop + 24
      }
      const url = pr.url.replace(/^https?:\/\//, '')
      out += `<text x="${bx + 12}" y="${cy + 12}" font-size="11.5" class="dim">${esc(fit(url, bw - 24, 11.5))}</text>`
      cy += 22
      const h = cy - y + 4

      return { h: h + 6, svg: `<rect x="${bx}" y="${y + 4}" width="${bw}" height="${h - 4}" rx="10" fill="var(--page)" stroke="var(--line)"/>${out}` }
    }
  }
}

const colOf = (c: CardSpec) => (c.reached ? COLOR_VAR[c.color] : 'var(--off)')

// The rail piece of a picture: a polygon easing from its neighbours' widths through the node.
function railSvg(c: CardSpec, H: number, nodeY: number | null): string {
  const col = colOf(c)
  const wTop = (c.railPrev + c.rail) / 2
  const wBot = (c.rail + c.railNext) / 2
  const poly = (ya: number, yb: number, wa: number, wb: number) =>
    `<polygon points="${RAIL_X - wa / 2},${ya} ${RAIL_X + wa / 2},${ya} ${RAIL_X + wb / 2},${yb} ${RAIL_X - wb / 2},${yb}" fill="${col}" opacity="${c.reached ? 1 : 0.7}"/>`
  if (nodeY === null) return poly(0, H, c.rail, c.rail)
  let out = poly(0, nodeY, wTop, c.rail) + poly(nodeY, H, c.rail, wBot)
  out +=
    c.node === 'stage'
      ? `<circle cx="${RAIL_X}" cy="${nodeY}" r="5.5" fill="var(--bg)" stroke="${col}" stroke-width="2.2"/>` + (c.isCurrent ? `<circle cx="${RAIL_X}" cy="${nodeY}" r="9" fill="none" stroke="${col}" stroke-width="1.6" opacity=".5"/>` : '')
      : c.node === 'gate'
        ? `<rect x="${RAIL_X - 4}" y="${nodeY - 4}" width="8" height="8" rx="2" transform="rotate(45 ${RAIL_X} ${nodeY})" fill="var(--bg)" stroke="${col}" stroke-width="2.2"/>`
        : `<circle cx="${RAIL_X}" cy="${nodeY}" r="4" fill="${col}"/>`

  return out
}

// One line: the rail with its node, a dot, the name and its soft pills. Buttons sit beside it, in the Box that holds it.
export function headerSvg(c: CardSpec, w = HEAD_W, k = 1): { source: string; height: number } {
  const H = 30
  const x0 = GUT
  const cw = w - GUT - 2
  const col = colOf(c)
  const frame = `<rect x="${x0}" y="2" width="${cw}" height="${H - 4}" rx="11" fill="var(--bg)" stroke="${c.isCurrent ? col : 'var(--line)'}" stroke-width="${c.isCurrent ? 1.6 : 1}" opacity="${c.isMerged ? 0.75 : 1}"/>`
  let hx = x0 + 22
  let head = `<circle cx="${x0 + 11}" cy="15" r="3.5" fill="${col}"/>`
  // The name keeps at most a share of the line so the pills still fit.
  const room = cw - 30
  const pillsW = c.pills.reduce((n, p) => n + tw(p.text, 10.5, true) + 18, 0)
  const title = fit(c.title, Math.max(room * 0.5, room - pillsW), 12.5)
  head += `<text x="${hx}" y="19.5" font-size="12.5" font-weight="700" class="fg">${esc(title)}</text>`
  hx += tw(title, 12.5, true) + 8
  for (const p of c.pills) {
    if (hx + tw(p.text, 10.5, true) + 12 > x0 + cw - 6) break
    const r = pill(hx, 19, p, 10.5)
    head += r.svg
    hx += r.w + 5
  }
  if (c.meta !== '' && x0 + cw - 8 - hx > 40) head += `<text x="${hx + 2}" y="19" font-size="11" class="dim">${esc(fit(c.meta, x0 + cw - 8 - hx, 11))}</text>`

  return { source: `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(w * k)}" height="${Math.round(H * k)}" viewBox="0 0 ${w} ${H}"><style>${STYLE}</style>${railSvg(c, H, 15)}${frame}${head}</svg>`, height: Math.round(H * k) }
}

// The open card's content, under its header: the rail carries on, the rows sit in a soft frame.
export function bodySvg(c: CardSpec, w = BODY_W, k = 1): { source: string; height: number } | null {
  if (c.rows === null || c.rows.length === 0) return null
  const x0 = GUT
  const cw = w - GUT - 2
  let y = 6
  let body = ''
  for (const r of c.rows) {
    const p = paintRow(r, y, x0, cw)
    body += p.svg
    y += p.h
  }
  const H = y + 6

  return { source: `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(w * k)}" height="${Math.round(H * k)}" viewBox="0 0 ${w} ${H}"><style>${STYLE}</style>${railSvg(c, H, null)}<rect x="${x0}" y="0" width="${cw}" height="${H - 2}" rx="11" fill="var(--page)" stroke="var(--line)"/>${body}</svg>`, height: Math.round(H * k) }
}

// The funnel strip: four columns narrowing toward prod, the current one underlined. One short band.
export type FunnelSpec = { branches: number; develop: number; staging: number; prodOk: boolean; current: number }

export function funnelSvg(f: FunnelSpec, W = BODY_W, k = 1): { source: string; height: number } {
  const H = 50
  const inset = 34
  const path = `M 8 3 H ${W - 8} L ${W - 8 - inset} ${H - 4} H ${8 + inset} Z`
  const cols = [
    { x: W * 0.16, n: String(f.branches), label: 'branches', cls: 'fg' },
    { x: W * 0.39, n: String(f.develop), label: 'develop', cls: 'fg' },
    { x: W * 0.62, n: String(f.staging), label: 'staging', cls: 'fg' },
    { x: W * 0.83, n: f.prodOk ? '✓' : '…', label: 'prod', cls: f.prodOk ? 'ok' : 'run' },
  ]
  let body = ''
  cols.forEach((c, i) => {
    body += `<text x="${Math.round(c.x) - 14}" y="30" font-size="20" font-weight="700" text-anchor="end" class="${c.cls}">${esc(c.n)}</text><text x="${Math.round(c.x) - 8}" y="30" font-size="11" class="dim">${c.label}</text>`
    if (i === f.current) body += `<rect x="${Math.round(c.x) - 40}" y="38" width="80" height="3" rx="1.5" fill="var(--blue)"/>`
  })

  return {
    height: Math.round(H * k),
    source: `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(W * k)}" height="${Math.round(H * k)}" viewBox="0 0 ${W} ${H}"><style>${STYLE}</style><defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#7d93ff"/><stop offset=".6" stop-color="#f5b83d"/><stop offset="1" stop-color="#3ddc97"/></linearGradient></defs><path d="${path}" fill="url(#g)" opacity=".14"/><path d="${path}" fill="none" stroke="url(#g)" stroke-width="2" stroke-linejoin="round"/>${body}</svg>`,
  }
}


// The path a change takes, as a row of boxes joined by arrows; it wraps onto more rows when the pane is narrow.
export type PathNode = { id: string; name: string; sub: string; color: ColorKey; tone: 'dim' | 'ok' | 'run' | 'fail'; isCurrent: boolean; isGhost: boolean }

export function pathSvg(nodes: PathNode[], W = BODY_W, k = 1): { source: string; height: number } {
  const nodeW = 104
  const nodeH = 44
  const pad = 8
  const rowGap = 22
  const minGap = 24
  const perRow = Math.max(1, Math.floor((W - pad * 2 + minGap) / (nodeW + minGap)))
  const rows = Math.ceil(nodes.length / perRow)
  // On a single row the boxes spread over the width; wrapped rows keep one gap so the columns line up.
  const gap = rows === 1 && nodes.length > 1 ? Math.min(60, (W - pad * 2 - nodes.length * nodeW) / (nodes.length - 1)) : minGap
  const left = rows === 1 ? (W - (nodes.length * nodeW + (nodes.length - 1) * gap)) / 2 : pad
  const H = pad * 2 + rows * nodeH + (rows - 1) * rowGap
  const at = (i: number) => ({ x: left + (i % perRow) * (nodeW + gap), y: pad + Math.floor(i / perRow) * (nodeH + rowGap) })
  let out = ''
  nodes.forEach((n, i) => {
    const { x, y } = at(i)
    const col = COLOR_VAR[n.color]
    if (i < nodes.length - 1) {
      const next = at(i + 1)
      if (next.y === y) out += `<line x1="${x + nodeW + 4}" y1="${y + nodeH / 2}" x2="${next.x - 7}" y2="${y + nodeH / 2}" stroke="var(--dim)" stroke-width="1.6"/><polygon points="${next.x - 8},${y + nodeH / 2 - 4} ${next.x - 2},${y + nodeH / 2} ${next.x - 8},${y + nodeH / 2 + 4}" fill="var(--dim)"/>`
      else out += `<polyline points="${x + nodeW / 2},${y + nodeH + 2} ${x + nodeW / 2},${y + nodeH + rowGap / 2} ${next.x + nodeW / 2},${y + nodeH + rowGap / 2} ${next.x + nodeW / 2},${next.y - 7}" fill="none" stroke="var(--dim)" stroke-width="1.6"/><polygon points="${next.x + nodeW / 2 - 4},${next.y - 8} ${next.x + nodeW / 2},${next.y - 2} ${next.x + nodeW / 2 + 4},${next.y - 8}" fill="var(--dim)"/>`
    }
    const stroke = n.isGhost ? 'var(--line)' : col
    out += `<rect x="${x}" y="${y}" width="${nodeW}" height="${nodeH}" rx="10" fill="var(--bg)" stroke="${stroke}" stroke-width="${n.isCurrent ? 2.6 : 1.4}"${n.isGhost ? ' stroke-dasharray="4 3"' : ''}/>`
    if (n.isCurrent) out += `<rect x="${x - 3}" y="${y - 3}" width="${nodeW + 6}" height="${nodeH + 6}" rx="13" fill="none" stroke="${col}" stroke-width="1.2" opacity=".45"/>`
    out += `<text x="${x + nodeW / 2}" y="${y + 18}" font-size="11.5" font-weight="700" text-anchor="middle" class="${n.isGhost ? 'dim' : 'fg'}">${esc(fit(n.name, nodeW - 10, 11.5))}</text>`
    out += `<text x="${x + nodeW / 2}" y="${y + 33}" font-size="10.5" text-anchor="middle" class="${n.tone === 'dim' ? 'dim' : n.tone}">${esc(fit(n.sub, nodeW - 8, 10.5))}</text>`
  })

  return { height: Math.round(H * k), source: `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(W * k)}" height="${Math.round(H * k)}" viewBox="0 0 ${W} ${H}"><style>${STYLE}</style>${out}</svg>` }
}

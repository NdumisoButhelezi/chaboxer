import { useEffect, useMemo, useRef, useState } from 'react'
import type { Note, Folder } from './db'

interface GraphNode {
  id: number
  label: string
  kind: 'note' | 'tag' | 'folder'
  x: number
  y: number
  vx: number
  vy: number
  degree: number
}

interface GraphEdge {
  source: number
  target: number
  kind: 'link' | 'tag' | 'folder'
}

export function extractWikilinks(body: string): string[] {
  return [...body.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1].trim())
}

export function extractTags(body: string): string[] {
  return [...body.matchAll(/(^|\s)#([\w-]+)/g)].map((m) => m[2].toLowerCase())
}

function buildGraph(notes: Note[], folders: Folder[]) {
  const nodes = new Map<number, GraphNode>()
  const edges: GraphEdge[] = []
  let synthId = -1

  const rand = () => (Math.random() - 0.5) * 600

  for (const n of notes) {
    nodes.set(n.id, { id: n.id, label: n.title, kind: 'note', x: rand(), y: rand(), vx: 0, vy: 0, degree: 0 })
  }

  const byTitle = new Map(notes.map((n) => [n.title.toLowerCase(), n.id]))
  const tagIds = new Map<string, number>()
  const folderIds = new Map<number, number>()

  const addEdge = (a: number, b: number, kind: GraphEdge['kind']) => {
    if (a === b) return
    edges.push({ source: a, target: b, kind })
    nodes.get(a)!.degree++
    nodes.get(b)!.degree++
  }

  for (const n of notes) {
    // [[wikilink]] edges to notes whose title matches
    for (const link of extractWikilinks(n.body)) {
      const target = byTitle.get(link.toLowerCase())
      if (target !== undefined) addEdge(n.id, target, 'link')
    }
    // #tag hub nodes
    for (const tag of extractTags(n.body)) {
      if (!tagIds.has(tag)) {
        const id = synthId--
        tagIds.set(tag, id)
        nodes.set(id, { id, label: `#${tag}`, kind: 'tag', x: rand(), y: rand(), vx: 0, vy: 0, degree: 0 })
      }
      addEdge(n.id, tagIds.get(tag)!, 'tag')
    }
    // folder hub nodes
    if (n.folderId !== null) {
      const folder = folders.find((f) => f.id === n.folderId)
      if (folder) {
        if (!folderIds.has(folder.id)) {
          const id = synthId--
          folderIds.set(folder.id, id)
          nodes.set(id, { id, label: folder.name, kind: 'folder', x: rand(), y: rand(), vx: 0, vy: 0, degree: 0 })
        }
        addEdge(n.id, folderIds.get(folder.id)!, 'folder')
      }
    }
  }
  return { nodes: [...nodes.values()], edges }
}

const COLORS = { note: '#60a5fa', tag: '#34d399', folder: '#eab308' }
const EDGE_COLORS = { link: 'rgba(167,139,250,0.5)', tag: 'rgba(52,211,153,0.25)', folder: 'rgba(234,179,8,0.22)' }

export default function GraphView({
  notes, folders, activeId, onOpenNote,
}: {
  notes: Note[]
  folders: Folder[]
  activeId: number | null
  onOpenNote: (id: number) => void
}) {
  const { nodes, edges } = useMemo(() => buildGraph(notes, folders), [notes, folders])
  const [, forceRender] = useState(0)
  const [hover, setHover] = useState<number | null>(null)
  const [view, setView] = useState({ x: 0, y: 0, k: 1 })
  const nodesRef = useRef(nodes)
  nodesRef.current = nodes
  const dragRef = useRef<{ node: GraphNode | null; panning: boolean; px: number; py: number; startX: number; startY: number; moved: boolean }>({ node: null, panning: false, px: 0, py: 0, startX: 0, startY: 0, moved: false })
  const svgRef = useRef<SVGSVGElement>(null)

  // Force simulation
  useEffect(() => {
    let frame = 0
    let ticks = 0
    const nodeIndex = new Map(nodes.map((n) => [n.id, n]))
    const step = () => {
      const alpha = Math.max(0.02, 0.3 * (1 - ticks / 300))
      // repulsion
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j]
          let dx = a.x - b.x, dy = a.y - b.y
          let d2 = dx * dx + dy * dy
          if (d2 < 1) { dx = Math.random(); dy = Math.random(); d2 = 1 }
          const f = (2200 / d2) * alpha
          const d = Math.sqrt(d2)
          a.vx += (dx / d) * f; a.vy += (dy / d) * f
          b.vx -= (dx / d) * f; b.vy -= (dy / d) * f
        }
      }
      // springs
      for (const e of edges) {
        const a = nodeIndex.get(e.source)!, b = nodeIndex.get(e.target)!
        const dx = b.x - a.x, dy = b.y - a.y
        const d = Math.max(1, Math.sqrt(dx * dx + dy * dy))
        const f = (d - 110) * 0.02 * alpha * 4
        a.vx += (dx / d) * f; a.vy += (dy / d) * f
        b.vx -= (dx / d) * f; b.vy -= (dy / d) * f
      }
      // centering + integrate
      for (const n of nodes) {
        n.vx -= n.x * 0.003 * alpha
        n.vy -= n.y * 0.003 * alpha
        if (dragRef.current.node !== n) {
          n.x += n.vx; n.y += n.vy
        }
        n.vx *= 0.85; n.vy *= 0.85
      }
      ticks++
      forceRender((v) => v + 1)
      if (ticks < 300) frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [nodes, edges])

  const toWorld = (clientX: number, clientY: number) => {
    const rect = svgRef.current!.getBoundingClientRect()
    return {
      x: (clientX - rect.left - rect.width / 2 - view.x) / view.k,
      y: (clientY - rect.top - rect.height / 2 - view.y) / view.k,
    }
  }

  const onPointerDown = (e: React.PointerEvent, node?: GraphNode) => {
    e.currentTarget.setPointerCapture?.(e.pointerId)
    dragRef.current = {
      node: node ?? null,
      panning: !node,
      px: e.clientX, py: e.clientY,
      startX: e.clientX, startY: e.clientY,
      moved: false,
    }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (Math.abs(e.clientX - d.startX) + Math.abs(e.clientY - d.startY) > 6) d.moved = true
    if (d.node) {
      if (!d.moved) return // don't jiggle the node on a simple tap
      const p = toWorld(e.clientX, e.clientY)
      d.node.x = p.x; d.node.y = p.y
      d.node.vx = 0; d.node.vy = 0
      forceRender((v) => v + 1)
    } else if (d.panning) {
      setView((v) => ({ ...v, x: v.x + e.clientX - d.px, y: v.y + e.clientY - d.py }))
      d.px = e.clientX; d.py = e.clientY
    }
  }

  const onPointerUp = () => {
    const d = dragRef.current
    // A tap (no drag) on a note node opens it — works on touch too
    if (d.node && !d.moved && d.node.kind === 'note') {
      onOpenNote(d.node.id)
    }
    dragRef.current = { node: null, panning: false, px: 0, py: 0, startX: 0, startY: 0, moved: false }
  }

  const onWheel = (e: React.WheelEvent) => {
    setView((v) => ({ ...v, k: Math.min(3, Math.max(0.3, v.k * (e.deltaY < 0 ? 1.1 : 0.9))) }))
  }

  const nodeIndex = new Map(nodes.map((n) => [n.id, n]))
  const neighbors = new Set<number>()
  if (hover !== null) {
    neighbors.add(hover)
    for (const e of edges) {
      if (e.source === hover) neighbors.add(e.target)
      if (e.target === hover) neighbors.add(e.source)
    }
  }

  return (
    <div className="graph-view">
      <svg
        ref={svgRef}
        onPointerDown={(e) => onPointerDown(e)}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onWheel={onWheel}
      >
        <g style={{ transform: `translate(50%, 50%) translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
          {edges.map((e, i) => {
            const a = nodeIndex.get(e.source)!, b = nodeIndex.get(e.target)!
            const dim = hover !== null && !(neighbors.has(e.source) && neighbors.has(e.target))
            return (
              <line
                key={i}
                x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                stroke={EDGE_COLORS[e.kind]}
                strokeWidth={e.kind === 'link' ? 1.6 : 1}
                opacity={dim ? 0.12 : 1}
              />
            )
          })}
          {nodes.map((n) => {
            const r = Math.min(18, 6 + n.degree * 1.4)
            const dim = hover !== null && !neighbors.has(n.id)
            return (
              <g
                key={n.id}
                transform={`translate(${n.x}, ${n.y})`}
                opacity={dim ? 0.18 : 1}
                style={{ cursor: n.kind === 'note' ? 'pointer' : 'grab' }}
                onPointerDown={(e) => { e.stopPropagation(); onPointerDown(e, n) }}
                onPointerUp={(e) => { e.stopPropagation(); onPointerUp() }}
                onPointerEnter={() => setHover(n.id)}
                onPointerLeave={() => setHover(null)}
              >
                <circle
                  r={r}
                  fill={COLORS[n.kind]}
                  fillOpacity={n.id === activeId ? 0.95 : 0.55}
                  stroke={n.id === activeId ? '#f1f5f9' : COLORS[n.kind]}
                  strokeWidth={n.id === activeId ? 2 : 1}
                />
                <text y={r + 13} textAnchor="middle" className="graph-label">{n.label}</text>
              </g>
            )
          })}
        </g>
      </svg>
      <div className="graph-legend">
        <span><i style={{ background: COLORS.note }} /> note</span>
        <span><i style={{ background: COLORS.tag }} /> #tag</span>
        <span><i style={{ background: COLORS.folder }} /> folder</span>
        <span className="graph-tip">link notes with [[Note Title]] &middot; drag nodes &middot; scroll to zoom</span>
      </div>
    </div>
  )
}

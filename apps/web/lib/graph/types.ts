/** Response von `GET /api/spaces/:space/graph` bzw. `/api/pages/:id/graph`
 *  (Vertrag: apps/api/README.md, Phase 3b). */
export type GraphEdgeType = 'link' | 'relation' | 'hierarchy' | 'tag'
export type GraphNodeStatus = 'released' | 'working' | 'review' | 'archived'

export interface GraphNode {
  id: string
  title: string
  path: string
  status: GraphNodeStatus
  tags: string[]
  updatedAt: string
}

export interface GraphEdge {
  from: string
  to: string
  type: GraphEdgeType
  label: string
}

export interface GraphData {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

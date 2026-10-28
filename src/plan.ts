/** satu operator plan (RelOp), urut pre-order dengan depth untuk ditampilkan sebagai pohon */
export interface PlanNode {
  depth: number;
  op: string;
  logical: string;
  object?: string;
  estRows: number;
  /** biaya operator ini saja (subtree dikurangi anak langsung) */
  cost: number;
  /** persen dari biaya statement */
  pct: number;
  actualRows?: number;
  executions?: number;
}

export interface PlanStatement {
  text: string;
  cost: number;
  nodes: PlanNode[];
}

const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16))).replace(/&amp;/g, '&');
const attrs = (s: string) => Object.fromEntries([...s.matchAll(/([\w:]+)="([^"]*)"/g)].map((m) => [m[1], decode(m[2])]));
const strip = (s?: string) => s?.replace(/^\[|\]$/g, '');

/**
 * ShowPlanXML (SET SHOWPLAN_XML / STATISTICS XML) -> statement + pohon operator.
 * shortcut: parser tag sederhana (regex), cukup untuk struktur ShowPlanXML; bukan parser XML umum.
 */
export function parsePlan(xml: string): PlanStatement[] {
  const statements: PlanStatement[] = [];
  type Open = PlanNode & { subtree: number; childCost: number; node: PlanNode };
  const stack: Open[] = [];
  let stmt: PlanStatement | undefined;
  for (const m of xml.matchAll(/<(\/?)([\w:]+)([^>]*?)(\/?)>/g)) {
    const [, close, tag, rest, selfClose] = m;
    const name = tag.replace(/^.*:/, '');
    if (close) {
      if (name === 'RelOp') {
        const n = stack.pop()!;
        n.node.cost = Math.max(0, n.subtree - n.childCost);
        if (stack.length) stack[stack.length - 1].childCost += n.subtree;
      }
      continue;
    }
    const a = attrs(rest);
    if (name === 'StmtSimple' || name === 'StmtCond' || name === 'StmtCursor') {
      stmt = { text: a.StatementText?.trim() ?? '', cost: Number(a.StatementSubTreeCost ?? 0), nodes: [] };
      statements.push(stmt);
    } else if (name === 'RelOp' && stmt) {
      const node: PlanNode = { depth: stack.length, op: a.PhysicalOp ?? '', logical: a.LogicalOp ?? '', estRows: Number(a.EstimateRows ?? 0), cost: 0, pct: 0 };
      stmt.nodes.push(node);
      if (!selfClose) stack.push({ ...node, subtree: Number(a.EstimatedTotalSubtreeCost ?? 0), childCost: 0, node });
    } else if (name === 'RunTimeCountersPerThread' && stack.length) {
      const n = stack[stack.length - 1].node;
      n.actualRows = (n.actualRows ?? 0) + Number(a.ActualRows ?? 0);
      n.executions = (n.executions ?? 0) + Number(a.ActualExecutions ?? 0);
    } else if (name === 'Object' && stack.length) {
      const n = stack[stack.length - 1].node;
      n.object ??= [strip(a.Schema), strip(a.Table)].filter(Boolean).join('.') + (a.Index ? ` (${strip(a.Index)})` : '');
    }
  }
  for (const s of statements) {
    const total = s.cost || s.nodes.reduce((t, n) => t + n.cost, 0);
    for (const n of s.nodes) n.pct = total ? (n.cost / total) * 100 : 0;
  }
  return statements;
}

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parsePlan } from '../plan';

const XML = `<?xml version="1.0" encoding="utf-16"?>
<ShowPlanXML xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan" Version="1.5"><BatchSequence><Batch><Statements>
<StmtSimple StatementText="SELECT * FROM dbo.Orders o JOIN dbo.Lines l ON l.id = o.id WHERE o.no = &apos;x&apos;" StatementSubTreeCost="1.0">
<QueryPlan><RelOp NodeId="0" PhysicalOp="Nested Loops" LogicalOp="Inner Join" EstimateRows="10" EstimatedTotalSubtreeCost="1.0">
<RunTimeInformation><RunTimeCountersPerThread Thread="0" ActualRows="7" ActualExecutions="1"/></RunTimeInformation>
<NestedLoops>
<RelOp NodeId="1" PhysicalOp="Index Seek" LogicalOp="Index Seek" EstimateRows="1" EstimatedTotalSubtreeCost="0.2">
<RunTimeInformation><RunTimeCountersPerThread Thread="0" ActualRows="1" ActualExecutions="1"/></RunTimeInformation>
<IndexScan><Object Database="[db]" Schema="[dbo]" Table="[Orders]" Index="[IX_no]" Alias="[o]"/></IndexScan></RelOp>
<RelOp NodeId="2" PhysicalOp="Clustered Index Scan" LogicalOp="Clustered Index Scan" EstimateRows="10" EstimatedTotalSubtreeCost="0.7">
<RunTimeInformation><RunTimeCountersPerThread Thread="1" ActualRows="4" ActualExecutions="1"/><RunTimeCountersPerThread Thread="2" ActualRows="3" ActualExecutions="1"/></RunTimeInformation>
<IndexScan><Object Database="[db]" Schema="[dbo]" Table="[Lines]" Index="[PK_Lines]"/></IndexScan></RelOp>
</NestedLoops></RelOp></QueryPlan></StmtSimple></Statements></Batch></BatchSequence></ShowPlanXML>`;

test('parsePlan: statement, operator tree, own cost %, actual rows, objects', () => {
  const [s] = parsePlan(XML);
  assert.equal(s.text, "SELECT * FROM dbo.Orders o JOIN dbo.Lines l ON l.id = o.id WHERE o.no = 'x'");
  assert.deepEqual(s.nodes.map((n) => [n.depth, n.op, n.object, n.estRows, n.actualRows]), [
    [0, 'Nested Loops', undefined, 10, 7],
    [1, 'Index Seek', 'dbo.Orders (IX_no)', 1, 1],
    [1, 'Clustered Index Scan', 'dbo.Lines (PK_Lines)', 10, 7],
  ]);
  assert.deepEqual(s.nodes.map((n) => Math.round(n.pct)), [10, 20, 70], 'own cost = subtree - children');
  assert.equal(parsePlan(XML.replace(/<RunTimeInformation>.*?<\/RunTimeInformation>/gs, ''))[0].nodes[0].actualRows, undefined, 'estimated plan: no actual rows');
});

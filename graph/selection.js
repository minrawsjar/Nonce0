export function selectRelayPath(nodes, { reliabilityFloor, random = Math.random }) {
  const eligible = nodes.filter((node) => node.reliabilityScore >= reliabilityFloor);
  if (eligible.length < 3) throw new Error('INSUFFICIENT_RELAY_DIVERSITY');
  const remaining = [...eligible];
  const selected = [];
  while (selected.length < 3) {
    const total = remaining.reduce((sum, node) => sum + Number(node.batchOccupancy) / (1 + node.recentSelectionCount), 0);
    let cursor = random() * total;
    let index = 0;
    for (; index < remaining.length - 1; index += 1) {
      cursor -= Number(remaining[index].batchOccupancy) / (1 + remaining[index].recentSelectionCount);
      if (cursor < 0) break;
    }
    selected.push(remaining.splice(index, 1)[0].id);
  }
  return selected;
}

export function calculatePrivacyScore({ ringFreshnessScore, meshHealthScore }) {
  return ringFreshnessScore < meshHealthScore ? ringFreshnessScore : meshHealthScore;
}

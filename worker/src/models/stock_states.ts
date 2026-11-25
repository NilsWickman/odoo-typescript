/** Pure state rules of stock moves and transfers (odoo/addons/stock/models/stock_move.py). */

/** stock_move.py:1479-1520 `_get_relevant_state_among_moves`. */
export function relevantState(moves: readonly { state: string; qty: number }[], moveType: string): string {
  const rank: Record<string, number> = { assigned: 4, waiting: 3, partially_available: 2, confirmed: 1 };
  const todo = moves.filter((m) => !["cancel", "done"].includes(m.state) && !(m.state === "assigned" && !m.qty))
    .map((m, i) => ({ m, i })).sort((a, b) => (rank[a.m.state] ?? 0) - (rank[b.m.state] ?? 0) || a.m.qty - b.m.qty || a.i - b.i).map((x) => x.m);
  if (!todo.length) return "assigned";
  if (moveType === "one") {
    if (todo.every((m) => !m.qty)) return "assigned";
    const first = todo[0]!;
    if (first.state === "confirmed" || first.state === "partially_available") return "confirmed";
    return first.state || "draft";
  }
  if (todo[0]!.state !== "assigned" && todo.some((m) => ["assigned", "partially_available"].includes(m.state))) return "partially_available";
  const last = todo[todo.length - 1]!;
  if (last.state === "confirmed" && last.qty === 0) return "assigned";
  return last.state || "draft";
}


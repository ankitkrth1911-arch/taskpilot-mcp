import type { Graph } from "@/lib/api";

const COLORS: Record<string, string> = {
  person: "var(--color-chart-1)",
  task: "var(--color-chart-5)",
  project: "var(--color-chart-2)",
};

export function DependencyGraph({ graph, overdueIds }: { graph: Graph; overdueIds: number[] }) {
  const cols: Record<string, number> = { person: 70, task: 300, project: 530 };
  const groups: Record<string, Graph["nodes"]> = {};
  for (const n of graph.nodes) (groups[n.type in cols ? n.type : "task"] ??= []).push(n);
  const H = Math.max(240, Math.max(...Object.values(groups).map((g) => g.length)) * 44 + 30);
  const pos: Record<string, { x: number; y: number }> = {};
  for (const [type, list] of Object.entries(groups)) {
    const step = (H - 40) / list.length;
    list.forEach((n, i) => (pos[n.id] = { x: cols[type] ?? 300, y: 20 + step * (i + 0.5) }));
  }
  const overdueSet = new Set(overdueIds.map((id) => `t:${id}`).concat(overdueIds.map(String)));

  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-4 text-xs text-muted-foreground">
        {(["person", "task", "project"] as const).map((t) => (
          <span key={t} className="inline-flex items-center gap-1.5">
            <svg width="10" height="10" aria-hidden><circle cx="5" cy="5" r="5" fill={COLORS[t]} /></svg>
            {t === "person" ? "Person" : t === "task" ? "Task" : "Project"}
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5">
          <svg width="12" height="12" aria-hidden><circle cx="6" cy="6" r="4.5" fill="none" stroke="var(--color-danger)" strokeWidth="2" /></svg>
          Overdue
        </span>
        <span className="inline-flex items-center gap-1.5">
          <svg width="18" height="6" aria-hidden><line x1="0" y1="3" x2="18" y2="3" stroke="var(--color-danger)" strokeDasharray="3 2" /></svg>
          Blocks
        </span>
      </div>
      <div className="overflow-x-auto">
        <svg viewBox={`0 0 640 ${H}`} className="min-w-[560px] w-full" role="img" aria-label="Dependency graph of people, tasks and project">
          {graph.edges.map((e, i) => {
            const a = pos[e.from], b = pos[e.to];
            if (!a || !b) return null;
            const blocks = e.type === "blocks";
            if (blocks) {
              const bend = a.x + 70 + Math.abs(a.y - b.y) * 0.15;
              return (
                <path key={i} d={`M${a.x},${a.y} C${bend},${a.y} ${bend},${b.y} ${b.x},${b.y}`} fill="none"
                  stroke="var(--color-danger)" strokeOpacity={0.55} strokeDasharray="4 3">
                  <title>{`${e.from} ${e.type} ${e.to}`}</title>
                </path>
              );
            }
            return (
              <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--color-border)" strokeWidth={1}>
                <title>{`${e.from} ${e.type} ${e.to}`}</title>
              </line>
            );
          })}
          {graph.nodes.map((n) => {
            const p = pos[n.id];
            if (!p) return null;
            const od = n.type === "task" && overdueSet.has(n.id);
            const left = n.type === "person";
            return (
              <g key={n.id}>
                <title>{`${n.label} (${n.type})${od ? " — overdue" : ""}`}</title>
                <circle cx={p.x} cy={p.y} r={8} fill={COLORS[n.type] ?? COLORS["task"]}
                  stroke={od ? "var(--color-danger)" : "var(--color-card)"} strokeWidth={od ? 3 : 2} />
                <text x={left ? p.x - 14 : p.x + 14} y={p.y + 4} fontSize="11" textAnchor={left ? "end" : "start"}
                  fill={od ? "var(--color-danger)" : "var(--color-foreground)"}>
                  {n.label.length > 28 ? n.label.slice(0, 27) + "…" : n.label}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

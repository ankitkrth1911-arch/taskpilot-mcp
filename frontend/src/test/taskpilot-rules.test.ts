import { describe, expect, it } from "vitest";
import { approveActions, daysOverdue, getTasks, parseTrace, runAgent } from "@/lib/api";

describe("TaskPilot rules", () => {
  it("counts days overdue in the browser and ignores done tasks", () => {
    const today = new Date(2026, 9, 17);
    expect(daysOverdue("2026-10-15", "Pending", today)).toBe(2);
    expect(daysOverdue("2026-10-15", "Done", today)).toBe(0);
    expect(daysOverdue("2026-10-20", "Pending", today)).toBe(0);
  });

  it("parses trace entries into tool and args", () => {
    expect(parseTrace('get_task_owner({"task_id":3})')).toEqual({ tool: "get_task_owner", args: '{"task_id":3}' });
    expect(parseTrace("garbage")).toBeNull();
  });

  it("mock flow: overdue 1,3,7, ranked 3,1,7, repeat approval is skipped", async () => {
    const r = await runAgent("Find overdue tasks");
    expect(r.overdue.map((t) => t.id)).toEqual([1, 3, 7]);
    expect(r.ranked?.map((x) => x.taskId)).toEqual([3, 1, 7]);
    expect(r.actions.find((a) => a.id === "a7")?.cc).toBe("Priya");
    const a3 = r.actions.filter((a) => a.id === "a3");
    expect((await approveActions(a3)).results[0]?.result).toBe("done");
    expect((await getTasks()).find((t) => t.id === 3)?.reminderSent).toBe(true);
    expect((await approveActions(a3)).results[0]?.result).toBe("skipped");
  }, 10000);
});

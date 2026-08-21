import type { Task } from "../../lib/tasks";
import { dismissTask } from "../../lib/tasks";

export default function TaskCenter({ tasks }: { tasks: Task[] }) {
  if (tasks.length === 0) return null;
  return (
    <div className="task-center" aria-label="실행 중인 작업">
      {tasks.slice(-3).map((task) => (
        <div className={`task-center__item task-center__item--${task.status}`} key={task.id}>
          <span className="task-center__status" aria-hidden="true">{task.status === "running" ? "●" : task.status === "done" ? "✓" : "!"}</span>
          <span className="task-center__label">{task.label}{task.status === "running" ? ` · ${task.progress ?? 0}%` : task.status === "failed" ? " · 실패" : " · 완료"}</span>
          {task.message && <span className="task-center__message">{task.message}</span>}
          {task.status !== "running" && <button className="task-center__dismiss" aria-label={`${task.label} 닫기`} onClick={() => dismissTask(task.id)}>×</button>}
        </div>
      ))}
    </div>
  );
}

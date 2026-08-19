import { useEffect, useState } from "react";

export interface Task {
  id: string;
  label: string;
  status: "running" | "done" | "failed";
  startedAt: number;
  message?: string;
}

type Listener = (tasks: Task[]) => void;

const listeners = new Set<Listener>();
let tasks: Task[] = [];

function emit() {
  tasks = [...tasks];
  for (const l of listeners) l(tasks);
}

export function subscribeTasks(l: Listener): () => void {
  listeners.add(l);
  l(tasks);
  return () => {
    listeners.delete(l);
  };
}

export function useTasks(): Task[] {
  const [current, setCurrent] = useState<Task[]>(tasks);
  useEffect(() => subscribeTasks(setCurrent), []);
  return current;
}

export function isTaskRunning(labelPrefix: string): boolean {
  return tasks.some((t) => t.label.startsWith(labelPrefix) && t.status === "running");
}

export async function runTask(
  label: string,
  fn: (setMessage: (m: string) => void) => Promise<void>
): Promise<void> {
  const task: Task = { id: crypto.randomUUID(), label, status: "running", startedAt: Date.now() };
  tasks = [...tasks, task];
  emit();

  const setMessage = (m: string) => {
    task.message = m;
    emit();
  };

  try {
    await fn(setMessage);
    if (task.status === "running") {
      task.status = "done";
      task.message = "done";
    }
  } catch (e) {
    task.status = "failed";
    task.message = (e as Error).message.slice(0, 200);
  }
  emit();

  setTimeout(() => {
    tasks = tasks.filter((t) => t.id !== task.id);
    emit();
  }, 90_000);
}

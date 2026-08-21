import { useEffect, useState } from "react";

export interface Task {
  id: string;
  label: string;
  status: "running" | "done" | "failed";
  startedAt: number;
  message?: string;
  progress?: number; // 0..100
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

export function dismissTask(id: string): void {
  tasks = tasks.filter((task) => task.id !== id);
  emit();
}

export function isTaskRunning(labelPrefix: string): boolean {
  return tasks.some((t) => t.label.startsWith(labelPrefix) && t.status === "running");
}

export async function runTask(
  label: string,
  fn: (setMessage: (m: string) => void, setProgress: (p: number) => void) => Promise<void>
): Promise<void> {
  const task: Task = { id: crypto.randomUUID(), label, status: "running", startedAt: Date.now(), progress: 0 };
  tasks = [...tasks, task];
  emit();

  const setMessage = (m: string) => {
    task.message = m;
    emit();
  };
  const setProgress = (p: number) => {
    task.progress = Math.max(0, Math.min(100, Math.round(p)));
    emit();
  };

  try {
    await fn(setMessage, setProgress);
    if (task.status === "running") {
      task.status = "done";
      task.progress = 100;
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

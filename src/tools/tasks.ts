import { addTask, listTasks, completeTask, deleteTask, findTaskByTitle } from '../db.js';

export async function tool_add_task(userId: number, args: {
  title: string; description?: string; priority?: string; due_at?: string;
}) {
  const result = addTask(userId, args.title, {
    description: args.description,
    priority: args.priority ?? 'medium',
    due_at: args.due_at,
  });
  return { success: true, task_id: (result as any).lastInsertRowid, title: args.title };
}

export async function tool_list_tasks(userId: number, args: { include_completed?: boolean }) {
  const tasks = listTasks(userId, args.include_completed ?? false);
  if (tasks.length === 0) return { tasks: [], message: 'No pending tasks.' };

  return {
    tasks: tasks.map(t => ({
      id: t.id,
      title: t.title,
      description: t.description,
      priority: t.priority,
      due_at: t.due_at,
      completed: !!t.completed,
    })),
  };
}

export async function tool_complete_task(userId: number, args: {
  task_id?: number; search_title?: string;
}) {
  if (args.task_id) {
    completeTask(userId, args.task_id);
    return { success: true, message: `Task #${args.task_id} marked as complete.` };
  }

  if (args.search_title) {
    const matches = findTaskByTitle(userId, args.search_title);
    if (matches.length === 0) return { success: false, message: 'No matching task found.' };
    completeTask(userId, matches[0].id);
    return { success: true, message: `"${matches[0].title}" marked as complete.` };
  }

  return { success: false, message: 'Provide task_id or search_title.' };
}

export async function tool_delete_task(userId: number, args: { task_id: number }) {
  deleteTask(userId, args.task_id);
  return { success: true, message: `Task #${args.task_id} deleted.` };
}

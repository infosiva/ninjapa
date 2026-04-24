import { saveNote, searchNotes, listNotes } from '../db.js';

export async function tool_save_note(userId: number, args: {
  content: string; tags?: string[];
}) {
  const result = saveNote(userId, args.content, args.tags ?? []);
  return { success: true, note_id: (result as any).lastInsertRowid, content: args.content };
}

export async function tool_search_notes(userId: number, args: { query: string }) {
  const notes = searchNotes(userId, args.query);
  if (notes.length === 0) return { notes: [], message: `No notes found for "${args.query}".` };
  return {
    notes: notes.map(n => ({
      id: n.id,
      content: n.content,
      tags: JSON.parse(n.tags),
      created_at: n.created_at,
    })),
  };
}

export async function tool_list_notes(userId: number, args: { limit?: number }) {
  const notes = listNotes(userId, args.limit ?? 10);
  if (notes.length === 0) return { notes: [], message: 'No notes yet.' };
  return {
    notes: notes.map(n => ({
      id: n.id,
      content: n.content.slice(0, 200),
      tags: JSON.parse(n.tags),
      created_at: n.created_at,
    })),
  };
}

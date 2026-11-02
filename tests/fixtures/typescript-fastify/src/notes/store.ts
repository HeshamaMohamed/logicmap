export class NotFoundError extends Error {}

export const MAX_NOTE_LENGTH = 500;

export class NoteStore {
  private notes = new Map<string, string>();

  get(id: string): { id: string; text: string } {
    const text = this.notes.get(id);
    if (text === undefined) throw new NotFoundError(`No note ${id}`);
    return { id, text };
  }

  add(text: string): { id: string; text: string } {
    const id = String(this.notes.size + 1);
    this.notes.set(id, text);
    return { id, text };
  }

  remove(id: string): void {
    if (!this.notes.delete(id)) throw new NotFoundError(`No note ${id}`);
  }
}

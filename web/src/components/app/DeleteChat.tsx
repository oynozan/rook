'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { pageUnreachable } from '@/lib/errors';
import { deleteChat } from '@/lib/server/actions';

/** A bin: delete a chat. */
export function TrashIcon({ className }: { className: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.75 4.25h10.5M6.25 4.25V2.75h3.5v1.5M4 4.25l.6 8.1a1.5 1.5 0 0 0 1.5 1.4h3.8a1.5 1.5 0 0 0 1.5-1.4l.6-8.1M6.75 7v4M9.25 7v4" />
    </svg>
  );
}

export type ChatRef = { id: string; title: string };

/**
 * Asks before deleting a chat: names it and says it can't be undone. A modal dialog, so focus stays in it; Escape or a
 * click outside closes it, and focus goes back to the button that opened it. When Rook refuses (money still held in
 * the chat), it says why and links the task to open. Keyed by the chat, so each one starts afresh.
 */
export function DeleteChatDialog({ chat, onClose, onDeleted, onOpenTask }: {
  chat: ChatRef | null;
  onClose: () => void;
  /** Deleted (or found gone already): the ids of its tasks Rook named, for the sidebar to drop at once. */
  onDeleted: (chat: ChatRef, deleted: string[]) => void;
  onOpenTask: (task: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; task?: string } | null>(null);
  const uid = useId();

  useEffect(() => {
    const d = dialog.current;
    if (!chat || !d) return;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!d.open) d.showModal();
    cancel.current?.focus(); // the safe choice first
    return () => {
      if (d.open) d.close();
      // Back to the button that opened it, if it is still there (a deleted chat's row is gone).
      const back = opener.current;
      if (back?.isConnected) requestAnimationFrame(() => back.focus());
    };
  }, [chat]);

  // Escape closes this dialog only: the capture phase keeps it from also closing the sidebar drawer behind it.
  useEffect(() => {
    if (!chat) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      if (!busy) onClose();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [chat, busy, onClose]);

  if (!chat) return null;
  const target = chat;

  async function remove() {
    setBusy(true);
    setError(null);
    const out = await deleteChat(target.id).catch((e) => ({ ok: false as const, message: pageUnreachable(e) }));
    setBusy(false);
    if (out.ok) return onDeleted(target, out.deleted);
    setError({ message: out.message, ...('task' in out && out.task ? { task: out.task } : {}) });
  }

  return (
    <dialog
      ref={dialog}
      aria-labelledby={`${uid}-title`}
      aria-describedby={`${uid}-body`}
      onCancel={(e) => { e.preventDefault(); if (!busy) onClose(); }} // a close request without a key (a phone's back gesture)
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }} // the backdrop
      className="m-auto w-[min(28rem,calc(100%-2rem))] rounded-2xl border border-ink/15 bg-surface p-0 text-ink shadow-2xl shadow-ink/20 backdrop:bg-ink/40"
    >
      <div className="rook-in p-5">
        <h2 id={`${uid}-title`} className="text-lg font-medium tracking-[-0.01em]">Delete this chat?</h2>
        <p id={`${uid}-body`} className="mt-2 text-ink/80">
          <span className="line-clamp-3 font-medium break-words text-ink">“{chat.title}”</span>
          <span className="mt-1 block">Its messages, plans and reports will be removed from your tasks. This can&apos;t be undone.</span>
        </p>
        {error && (
          <p role="alert" className="mt-3 text-sm text-alert">
            {error.message}{' '}
            {error.task && (
              <a href={`/app/${error.task}`} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); onOpenTask(error.task!); }}
                className="font-medium text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink">
                Open the task
              </a>
            )}
          </p>
        )}
        <div className="mt-5 flex flex-wrap justify-end gap-3">
          <button
            ref={cancel}
            type="button"
            onClick={onClose}
            disabled={busy}
            className="inline-flex min-h-11 cursor-pointer items-center justify-center rounded-full border border-ink/25 px-5 font-medium transition-colors duration-200 hover:border-ink hover:bg-ink/5 active:translate-y-px disabled:cursor-wait disabled:text-ink/55 motion-reduce:transition-none max-sm:grow"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void remove()}
            disabled={busy}
            className="inline-flex min-h-11 cursor-pointer items-center justify-center rounded-full bg-alert px-5 font-medium text-surface transition-[background-color,opacity] duration-200 hover:bg-alert/85 active:translate-y-px disabled:cursor-wait disabled:opacity-70 motion-reduce:transition-none max-sm:grow"
          >
            {busy ? 'Deleting…' : 'Delete chat'}
          </button>
        </div>
      </div>
    </dialog>
  );
}

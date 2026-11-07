"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";

type ModalProps = {
  open: boolean;
  title: string;
  description: string;
  busy?: boolean;
  onClose: () => void;
  children: ReactNode;
};

export function Modal({ open, title, description, busy = false, onClose, children }: ModalProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const element = dialog.current;
    if (!open || !element) return;
    const opener = document.activeElement;
    // 背景を操作不可にし、確認が終わるまでTab移動をダイアログ内へ留める。
    element.showModal();
    element.querySelector<HTMLElement>("[data-modal-initial]")?.focus();
    return () => {
      element.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [open]);

  useEffect(() => {
    if (open) dialog.current?.querySelector<HTMLElement>("[data-modal-initial]")?.focus();
  }, [open, title]);

  return <dialog ref={dialog} className="modal" tabIndex={-1} aria-labelledby={titleId} aria-describedby={descriptionId}
    onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}
    onKeyDown={(event) => {
      if (event.key !== "Tab") return;
      const elements = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])')].filter((element) => element.getClientRects().length > 0);
      const first = elements[0];
      const last = elements.at(-1);
      // ブラウザのツールバーへTabが抜ける場合も、確認中は背景と行き来させない。
      if (!first || !last) { event.preventDefault(); event.currentTarget.focus(); }
      else if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === event.currentTarget)) { event.preventDefault(); first.focus(); }
    }}>
    <h2 id={titleId}>{title}</h2>
    <p id={descriptionId} className="muted">{description}</p>
    {children}
  </dialog>;
}

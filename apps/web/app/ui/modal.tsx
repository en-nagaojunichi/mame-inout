"use client";

import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";

type ModalProps = {
  open: boolean;
  title: string;
  description: string;
  busy?: boolean;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
  children: ReactNode;
};

export function Modal({ open, title, description, busy = false, onClose, returnFocusRef, children }: ModalProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const element = dialog.current;
    if (!open || !element) return;
    // 非同期の準備で元ボタンが無効になった場合も、呼出元が保存した操作位置へ戻す。
    const opener = returnFocusRef?.current ?? document.activeElement;
    // 背景を操作不可にし、確認が終わるまでTab移動をダイアログ内へ留める。
    element.showModal();
    element.querySelector<HTMLElement>("[data-modal-initial]")?.focus();
    return () => {
      element.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [open, returnFocusRef]);

  useEffect(() => {
    if (open) dialog.current?.querySelector<HTMLElement>("[data-modal-initial]")?.focus();
  }, [open, title]);

  useEffect(() => {
    const element = dialog.current;
    if (!open || !busy || !element) return;
    // 実行ボタンを無効にするとフォーカスがbodyへ落ちるため、処理中もTabをモーダル内で受け取る。
    const active = document.activeElement;
    if (!element.contains(active) || active?.matches(":disabled")) element.focus();
  }, [open, busy]);

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

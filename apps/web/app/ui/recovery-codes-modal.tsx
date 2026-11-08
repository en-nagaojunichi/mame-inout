"use client";

import { Modal } from "./modal";

export function RecoveryCodesModal({ codes, onClose }: { codes: string[] | null; onClose: () => void }) {
  return <Modal open={codes !== null} title="復旧コードを保存" description="このコードは一度だけ表示します。パスキーが使えなくなったときに備え、端末とは別の安全な場所に保存してください。閉じると再表示できません。" onClose={onClose}>
    <ul className="recovery-codes">{codes?.map((code) => <li key={code}>{code}</li>)}</ul>
    <p className="field-help">紛失した場合は、ログイン後の設定画面で再発行してください。</p>
    <div className="inline-actions"><button data-modal-initial onClick={onClose}>保存したので閉じる</button></div>
  </Modal>;
}

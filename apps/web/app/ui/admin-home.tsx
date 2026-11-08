import Link from "next/link";

export function AdminHome() {
  return <section>
    <div className="page-heading"><div><p className="eyebrow">MameInOut</p><h1>管理ホーム</h1><p className="muted">利用者とQR受付を管理します。</p></div><Link className="button-link" href="/people">利用者を登録・確認</Link></div>
    <section className="content-panel" aria-labelledby="daily-actions-title">
      <h2 id="daily-actions-title">よく使う操作</h2>
      <ul className="home-action-list">
        <li><Link href="/people"><span><strong>利用者・QRコード</strong><span>利用者を探す、登録する、QRを発行する</span></span><span aria-hidden="true">→</span></Link></li>
        <li><Link href="/settings/devices"><span><strong>QR受付端末</strong><span>受付に使う端末の申請を確認・承認する</span></span><span aria-hidden="true">→</span></Link></li>
      </ul>
    </section>
    <section className="content-panel" aria-labelledby="setup-guide-title">
      <h2 id="setup-guide-title">はじめての受付準備</h2><p className="muted">利用者を登録してQRを渡し、入口の端末で受付を始めます。</p>
      <ol className="setup-guide">
        <li><div><strong>利用者を登録し、QRコードを渡す</strong><p>必須項目は表示名だけです。発行したQRは画像として保存するか、紙に印刷します。</p><Link href="/people" className="text-link">利用者を開く</Link></div></li>
        <li><div><strong>受付に使う端末を登録・承認する</strong><p>入口のスマホ・タブレットで登録を申請し、管理者が確認コードを照合して承認します。</p><Link href="/settings/devices" className="text-link">端末の申請を確認</Link></div></li>
        <li><div><strong>受付端末で読み取りを始める</strong><p>承認された同じブラウザで「QR受付を開く」へ進み、入室または退室を選びます。</p><Link href="/reception" className="text-link">このブラウザのQR受付を開く</Link></div></li>
      </ol>
    </section>
    <p className="field-help">記録上の在室状況・履歴を確認する画面は、今後追加します。現在は受付までの動作確認に使用してください。</p>
  </section>;
}

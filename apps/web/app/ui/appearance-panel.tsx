"use client";

import Image from "next/image";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { appearanceImageMaxBytes, appearanceImageMaxSide, appearanceInputSchema, appearanceResponseSchema, defaultDisplayName, type Appearance } from "@mame/contracts";
import { api, ApiFailure } from "./client-api";
import { DefaultBrandIcon, useBrand } from "./brand";
import { Modal } from "./modal";

type ImageKind = "icon" | "favicon";
type DraftImage = { value: string | null; preview: string } | undefined;
const imageHelp = "PNGを選択してください。256×256ピクセル以内に縮小して保存します。保存する画像の上限は64KBです。";

async function prepareImage(file: File) {
  if (file.size > 4 * 1024 * 1024 || !file.size || file.type !== "image/png") throw new Error("4MB以下のPNGファイルを選択してください。");
  const header = new Uint8Array(await file.slice(0, 24).arrayBuffer());
  if (header.length < 24 || [137, 80, 78, 71, 13, 10, 26, 10].some((value, index) => header[index] !== value)) throw new Error("PNGファイルを確認してください。");
  const view = new DataView(header.buffer);
  const width = view.getUint32(16), height = view.getUint32(20);
  // 大きな画像を先に展開してメモリを使い切らないよう、画像ヘッダーでも上限を確認する。
  if (!width || !height || width > 4096 || height > 4096 || width * height > 8_000_000) throw new Error("画像が大きすぎます。4096ピクセル以下・800万画素以下のPNGを選択してください。");
  if (typeof createImageBitmap !== "function") throw new Error("このブラウザでは画像を準備できません。SafariまたはChromeの新しいバージョンでお試しください。");
  const bitmap = await createImageBitmap(file).catch(() => { throw new Error("画像を読み込めませんでした。別のPNGを選択してください。"); });
  try {
    const scale = Math.min(1, appearanceImageMaxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("画像の準備ができませんでした。別のブラウザでお試しください。");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const preview = canvas.toDataURL("image/png");
    if (!preview.startsWith("data:image/png;base64,")) throw new Error("画像をPNGに変換できませんでした。別のPNGを選択してください。");
    const value = preview.slice(preview.indexOf(",") + 1);
    if (Math.floor(value.length * 3 / 4) > appearanceImageMaxBytes) throw new Error("縮小後の画像が64KBを超えています。色数や画像サイズを小さくして選び直してください。");
    return { value, preview };
  } finally { bitmap.close(); }
}

export function AppearancePanel() {
  const { setAppearance } = useBrand();
  const [current, setCurrent] = useState<Appearance | null>(null);
  const [displayName, setDisplayName] = useState(defaultDisplayName);
  const [images, setImages] = useState<Partial<Record<ImageKind, DraftImage>>>({});
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [preparing, setPreparing] = useState<ImageKind | null>(null);
  const [message, setMessage] = useState(""), [error, setError] = useState(false), [conflict, setConflict] = useState(false);
  const [reset, setReset] = useState<"all" | ImageKind | null>(null);
  const inputs = useRef<Partial<Record<ImageKind, HTMLInputElement | null>>>({});
  const generation = useRef(0);
  const mounted = useRef(true);

  function accept(value: Appearance) { setCurrent(value); setDisplayName(value.displayName); setImages({}); setConflict(false); setAppearance(value); }
  useEffect(() => {
    let active = true;
    mounted.current = true;
    void api("/api/admin/appearance", appearanceResponseSchema).then((value) => { if (active) { setCurrent(value); setDisplayName(value.displayName); setAppearance(value); } })
      .catch((cause: unknown) => { if (active) { setError(true); setMessage(cause instanceof Error ? cause.message : "表示設定を読み込めませんでした。"); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; mounted.current = false; };
  }, [setAppearance]);

  async function reload() {
    setLoading(true); setMessage("");
    try { accept(await api("/api/admin/appearance", appearanceResponseSchema)); }
    catch (cause) { setError(true); setMessage(cause instanceof Error ? cause.message : "読み直せませんでした。"); }
    finally { setLoading(false); }
  }
  async function selectImage(kind: ImageKind, file: File | undefined) {
    if (!file) return;
    const ownGeneration = ++generation.current;
    setPreparing(kind); setMessage("");
    try {
      const image = await prepareImage(file);
      if (mounted.current && generation.current === ownGeneration) setImages((before) => ({ ...before, [kind]: image }));
    } catch (cause) { if (mounted.current && generation.current === ownGeneration) { setError(true); setMessage(cause instanceof Error ? cause.message : "画像を選択できませんでした。"); } }
    finally { if (mounted.current && generation.current === ownGeneration) { setPreparing(null); if (inputs.current[kind]) inputs.current[kind]!.value = ""; } }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!current) return;
    setMessage(""); setError(false);
    const input = appearanceInputSchema.safeParse({ expectedVersion: current.version, displayName,
      ...(images.icon ? { iconPng: images.icon.value } : {}), ...(images.favicon ? { faviconPng: images.favicon.value } : {}) });
    if (!input.success) { setError(true); setMessage("表示名を1〜64文字で入力し、画像の選択内容を確認してください。"); return; }
    setBusy(true);
    try { accept(await api("/api/admin/appearance", appearanceResponseSchema, input.data, "PUT")); setMessage("表示設定を保存しました。ほかの端末には、画面を開き直すと反映されます。"); }
    catch (cause) { setError(true); setConflict(cause instanceof ApiFailure && cause.code === "VERSION_CONFLICT"); setMessage(cause instanceof Error ? cause.message : "保存を確認できませんでした。入力内容は保持しています。"); }
    finally { setBusy(false); }
  }
  function confirmReset() {
    generation.current++;
    if (reset === "all") { setDisplayName(defaultDisplayName); setImages({ icon: { value: null, preview: "" }, favicon: { value: null, preview: "" } }); }
    else if (reset) setImages((before) => ({ ...before, [reset]: { value: null, preview: "" } }));
    setReset(null); setMessage("既定値のプレビューに戻しました。「変更を保存」で反映します。"); setError(false);
  }
  const preview = (kind: ImageKind) => images[kind] ? images[kind]!.preview : current && (kind === "icon" ? current.customIcon : current.customFavicon) ? (kind === "icon" ? current.iconUrl : current.faviconUrl) : "";
  const disabled = busy || loading || preparing !== null;
  const dirty = current !== null && (displayName !== current.displayName || Object.values(images).some((image) => image !== undefined));
  return <section>
    <div className="page-heading"><div><p className="eyebrow">システムの設定</p><h1>表示設定</h1><p className="muted">画面の名前とアイコンを、この施設に合わせて変更できます。</p></div></div>
    {message && <div className={`notice ${error ? "error" : "success"}`} role={error ? "alert" : "status"}>{message}</div>}
    {loading && <p role="status">表示設定を読み込んでいます…</p>}
    {!loading && !current && <button className="secondary" onClick={() => void reload()}>表示設定を読み直す</button>}
    {current && <div className="appearance-layout">
      <form className="content-panel appearance-form" onSubmit={(event) => void save(event)}>
        <h2>名前と画像</h2><label htmlFor="appearance-name">システムの表示名</label><input id="appearance-name" value={displayName} maxLength={64} required disabled={disabled} onChange={(event) => setDisplayName(event.target.value)} /><p className="field-help">1〜64文字。ログイン画面・管理画面・受付・タブ・QR印刷に使用します。</p>
        {(["icon", "favicon"] as const).map((kind) => <fieldset key={kind} className="appearance-fieldset" disabled={disabled}><legend>{kind === "icon" ? "システムアイコン" : "ファビコン"}</legend><p className="field-help">{kind === "icon" ? "画面の名前の横に表示する画像です。" : "ブラウザのタブに表示する小さな画像です。"}{imageHelp}</p>
          <label className="visually-hidden" htmlFor={`appearance-${kind}`}>{kind === "icon" ? "システムアイコンのPNG" : "ファビコンのPNG"}</label><input id={`appearance-${kind}`} type="file" accept="image/png" ref={(element) => { inputs.current[kind] = element; }} onChange={(event) => void selectImage(kind, event.target.files?.[0])} />
          <button type="button" className="text-button" disabled={disabled} onClick={() => setReset(kind)}>{kind === "icon" ? "システムアイコン" : "ファビコン"}を既定に戻す</button>
        </fieldset>)}
        {preparing && <p role="status">画像を準備しています…</p>}
        {conflict && <p className="field-help">「現在の設定を読み直す」を押すと未保存の入力を置き換えます。必要な内容を控えてから読み直してください。</p>}
        <p className="field-help">{dirty ? "未保存の変更があります。「変更を保存」で画面へ反映します。" : "保存されている表示設定です。変更すると、ここで保存できます。"}</p>
        <div className="inline-actions"><button type="submit" disabled={disabled || conflict || !dirty}>{busy ? "保存しています…" : "変更を保存"}</button>{conflict && <button type="button" className="secondary" disabled={disabled} onClick={() => void reload()}>現在の設定を読み直す</button>}<button type="button" className="secondary" disabled={disabled} onClick={() => setReset("all")}>すべて既定に戻す</button></div>
      </form>
      <aside className="content-panel appearance-preview" aria-labelledby="appearance-preview-title"><p className="eyebrow">保存前の確認</p><h2 id="appearance-preview-title">表示のプレビュー</h2><p className="field-help">ここで変更を確認し、「変更を保存」で反映します。</p><h3>画面のヘッダー</h3><div className="appearance-header-preview">{preview("icon") ? <Image unoptimized src={preview("icon")} width={36} height={36} alt="選択したシステムアイコン" /> : <DefaultBrandIcon />}<strong>{displayName.trim() || defaultDisplayName}</strong></div><h3>ブラウザのタブ</h3><div className="appearance-tab-preview">{preview("favicon") ? <Image unoptimized src={preview("favicon")} width={20} height={20} alt="選択したファビコン" /> : <DefaultBrandIcon />}<span>管理ホーム | {displayName.trim() || defaultDisplayName}</span></div><p className="field-help">名前や画像を変えても、登録済みのパスキー・受付端末・QR・記録はそのまま使えます。</p></aside>
    </div>}
    <Modal open={reset !== null} title="表示を既定に戻す" description={`${reset === "all" ? "表示名・システムアイコン・ファビコン" : reset === "icon" ? "システムアイコン" : "ファビコン"}を既定値のプレビューに戻します。画面への反映は「変更を保存」の後です。登録済みのパスキーや記録は変更しません。`} onClose={() => setReset(null)}>
      <div className="inline-actions"><button data-modal-initial className="secondary" onClick={() => setReset(null)}>キャンセル</button><button onClick={confirmReset}>既定の表示を使う</button></div>
    </Modal>
  </section>;
}

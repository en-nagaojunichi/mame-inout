"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { z } from "zod";
import {
  attendanceRequestResultSchema, attendanceResultSchema, attendanceTicketSchema, deviceApplicationResponseSchema,
  type AttendanceMode, type AttendanceRecordInput, type AttendanceResult, type DeviceApplicationResponse,
} from "@mame/contracts";
import { ApiFailure } from "./client-api";
import { Modal } from "./modal";
import { QrCamera } from "./qr-camera";

const pendingStorageKey = "mame.reception.pending-request";
const requestIdFormat = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const qrFormat = /^mio1_[A-Za-z0-9_-]{43}$/;
type PendingRequest = { requestId: string; payload?: AttendanceRecordInput; acceptUntil?: string };
type RecoveryState = { message: string; canResend: boolean; acceptUntil?: string };

function savedRequestId(): string | null {
  try {
    const value = sessionStorage.getItem(pendingStorageKey);
    if (value === null) return null;
    if (requestIdFormat.test(value)) return value;
    sessionStorage.removeItem(pendingStorageKey);
    return null;
  } catch {
    throw new Error("このブラウザでは受付の途中状態を保存できません。サイトのデータ保存を許可し、もう一度状態を確認してください。");
  }
}

function saveRequestId(id: string) {
  try {
    // 再読込後の結果照会には要求IDだけを残す。QR・氏名・Cookieは保存しない。
    sessionStorage.setItem(pendingStorageKey, id);
    if (sessionStorage.getItem(pendingStorageKey) !== id) throw new Error();
  } catch {
    throw new Error("受付の途中状態を保存できなかったため、記録は送信していません。サイトのデータ保存を許可してから再開してください。");
  }
}

function removeRequestId(id: string) {
  try { if (sessionStorage.getItem(pendingStorageKey) === id) sessionStorage.removeItem(pendingStorageKey); }
  catch { /* 確認済み要求が残っても次回は照会し、同じ打刻を新規送信しない。 */ }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "通信状態を確認して、もう一度お試しください。";
}

async function receptionApi<T>(path: string, schema: z.ZodType<T>, body?: unknown, businessResult = false): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    let response: Response;
    try {
      response = await fetch(path, {
        method: body === undefined ? "GET" : "POST", cache: "no-store", signal: controller.signal,
        headers: body === undefined ? { Accept: "application/json" } : { "Content-Type": "application/json", Accept: "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new Error("応答を確認できませんでした。通信状態を確認してください。");
    }
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok && !(businessResult && response.status === 409 && schema.safeParse(data).success)) {
      const failure = data as { message?: unknown; code?: unknown } | null;
      throw new ApiFailure(typeof failure?.message === "string" ? failure.message : "受付の状態を確認できませんでした。", response.status,
        typeof failure?.code === "string" ? failure.code : undefined);
    }
    const result = schema.safeParse(data);
    if (!result.success) throw new Error("受付結果の内容を確認できませんでした。結果を再確認してください。");
    if (businessResult) {
      const outcome = (data as { outcome?: unknown }).outcome;
      if ((response.ok && outcome !== "RECORDED") || (response.status === 409 && outcome === "RECORDED")) {
        throw new Error("受付結果の状態を確認できませんでした。結果を再確認してください。");
      }
    }
    return result.data;
  } finally { clearTimeout(timeout); }
}

function resultTime(result: AttendanceResult) {
  return result.recordedAt ? new Intl.DateTimeFormat("ja-JP", {
    timeZone: result.timeZone, dateStyle: "medium", timeStyle: "medium",
  }).format(new Date(result.recordedAt)) : "";
}

function validatedResult(result: AttendanceResult, pending: PendingRequest) {
  if (result.requestId !== pending.requestId || (pending.payload && result.mode !== pending.payload.mode) ||
      (result.outcome === "RECORDED" && (!result.recordedAt || !result.person)) ||
      (result.outcome !== "RECORDED" && result.recordedAt !== null)) {
    throw new Error("この受付の結果を照合できませんでした。管理者に確認してください。");
  }
  return result;
}

export function ReceptionPanel() {
  const [device, setDevice] = useState<DeviceApplicationResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [deviceError, setDeviceError] = useState("");
  const [mode, setMode] = useState<AttendanceMode>("IN");
  const [working, setWorking] = useState(false);
  const [result, setResult] = useState<AttendanceResult | null>(null);
  const [recovery, setRecovery] = useState<RecoveryState | null>(null);
  const [issueError, setIssueError] = useState("");
  const [instruction, setInstruction] = useState("");
  const [discardOpen, setDiscardOpen] = useState(false);
  const pending = useRef<PendingRequest | null>(null);
  const inFlight = useRef(false);
  const active = useRef(true);

  const applyDevice = useCallback((value: DeviceApplicationResponse) => {
    if (!value.claimed || value.device.status !== "APPROVED") throw new Error("有効な受付端末の登録がありません。管理者に承認と有効期限を確認してください。");
    const saved = savedRequestId();
    if (saved) {
      if (pending.current?.requestId !== saved) pending.current = { requestId: saved };
      setRecovery({ message: "前の受付の完了を確認する必要があります。新しく読み取る前に、この受付の結果を確認してください。", canResend: false });
    }
    setDevice(value); setDeviceError("");
  }, []);

  useEffect(() => {
    let current = true;
    active.current = true;
    void receptionApi("/api/devices/current", deviceApplicationResponseSchema)
      .then((value) => { if (current) applyDevice(value); })
      .catch((error: unknown) => { if (current) setDeviceError(errorMessage(error)); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; active.current = false; pending.current = null; };
  }, [applyDevice]);

  useEffect(() => {
    if (!result) return;
    // 表示名を受付画面に残し続けず、短時間で次の読み取り待ちへ戻す。
    const timer = setTimeout(() => { setResult(null); setInstruction(""); }, result.outcome === "RECORDED" ? 3_500 : 5_000);
    return () => { clearTimeout(timer); };
  }, [result]);

  useEffect(() => {
    if (!recovery?.acceptUntil) return;
    const id = pending.current?.requestId;
    const timer = setTimeout(() => {
      const request = pending.current;
      if (!request || request.requestId !== id) return;
      pending.current = { requestId: request.requestId };
      setRecovery((current) => current ? { ...current, canResend: false } : null);
    }, Math.max(0, new Date(recovery.acceptUntil).getTime() - Date.now()));
    return () => { clearTimeout(timer); };
  }, [recovery?.acceptUntil]);

  function receiveResult(value: AttendanceResult, request: PendingRequest) {
    const checked = validatedResult(value, request);
    removeRequestId(request.requestId);
    pending.current = null;
    setRecovery(null); setIssueError(""); setInstruction(""); setResult(checked);
  }

  async function sendRecord(request: PendingRequest) {
    if (!request.payload) return;
    try {
      const value = await receptionApi("/api/reception/records", attendanceResultSchema, request.payload, true);
      receiveResult(value, request);
    } catch (error) {
      // 応答が失われた時点では成功とも失敗とも断定しない。同じ要求だけを照会・再送する。
      if (error instanceof ApiFailure && [401, 403].includes(error.status)) { setDevice(null); setDeviceError(error.message); }
      if (error instanceof ApiFailure && error.status === 410) pending.current = { requestId: request.requestId };
      setRecovery({ message: `記録の完了を確認できません。新しく読み取らず、この受付の結果を確認してください。${errorMessage(error)}`, canResend: false, acceptUntil: request.acceptUntil });
    }
  }

  async function readQr(value: string) {
    if (inFlight.current || pending.current || result || recovery || issueError || !device) return;
    if (!qrFormat.test(value)) {
      setInstruction("このシステムで発行した利用者のQRをかざしてください。読み取ったURLなどは開きません。");
      return;
    }
    inFlight.current = true; setWorking(true); setInstruction(""); setIssueError("");
    try {
      const ticket = await receptionApi("/api/reception/requests", attendanceTicketSchema, {});
      if (!active.current) return;
      // 記録を送る前に要求IDを保存する。保存不能なら送信せず、再読込後の結果不明を防ぐ。
      saveRequestId(ticket.requestId);
      const request = { requestId: ticket.requestId, acceptUntil: ticket.acceptUntil, payload: { requestId: ticket.requestId, mode, qr: value } };
      pending.current = request;
      await sendRecord(request);
    } catch (error) {
      if (error instanceof ApiFailure && [401, 403].includes(error.status)) { setDevice(null); setDeviceError(error.message); }
      setIssueError(errorMessage(error));
    } finally { inFlight.current = false; setWorking(false); }
  }

  async function checkResult() {
    const request = pending.current;
    if (!request || inFlight.current) return;
    inFlight.current = true; setWorking(true);
    try {
      const value = await receptionApi(`/api/reception/requests/${request.requestId}`, attendanceRequestResultSchema);
      if (value.state === "completed") receiveResult(value.result, request);
      else {
        pending.current = { ...request, acceptUntil: value.acceptUntil };
        const canResend = Boolean(request.payload) && new Date(value.acceptUntil).getTime() > Date.now();
        setRecovery({
          message: canResend
            ? "この受付はまだ記録されていません。通信が戻ったら、同じ内容を再送できます。新しい受付要求は作成しません。"
            : "この受付はまだ確定していません。読み取ったQRは保存していないため、再読込後は再送できません。時間をおいて結果を再確認するか、管理者に記録を確認してください。",
          canResend, acceptUntil: value.acceptUntil,
        });
      }
    } catch (error) {
      if (error instanceof ApiFailure && error.status === 410) pending.current = { requestId: request.requestId };
      if (error instanceof ApiFailure && [401, 403].includes(error.status)) { setDevice(null); setDeviceError(error.message); }
      setRecovery({ message: `受付結果を確認できませんでした。${errorMessage(error)} 記録が分からない場合は管理者に確認してください。`, canResend: false, acceptUntil: request.acceptUntil });
    } finally { inFlight.current = false; setWorking(false); }
  }

  async function resend() {
    const request = pending.current;
    if (!request?.payload || !recovery?.canResend || inFlight.current) return;
    inFlight.current = true; setWorking(true);
    try { await sendRecord(request); }
    finally { inFlight.current = false; setWorking(false); }
  }

  async function checkDevice() {
    if (inFlight.current) return;
    inFlight.current = true; setLoading(true);
    try { applyDevice(await receptionApi("/api/devices/current", deviceApplicationResponseSchema)); }
    catch (error) { setDevice(null); setDeviceError(errorMessage(error)); }
    finally { inFlight.current = false; setLoading(false); }
  }

  const paused = working || Boolean(result) || Boolean(recovery) || Boolean(issueError) || discardOpen;
  return <section className={mode === "OUT" ? "reception-out" : "reception-in"} aria-busy={loading || working}>
    <div className="reception-heading"><h1>QR受付</h1>
      <p className="reception-device">{device?.device.name ?? "承認済みの受付端末で利用します"}</p>
      <p className="field-help">利用者のQRを読み取り、入室・退室を記録します。モードは自動で切り替わりません。</p>
    </div>
    {loading && <p role="status">受付端末の登録を確認しています…</p>}
    {!loading && !device && <div className="reception-blocked">
      <h2>受付端末の登録を確認してください</h2><p role="alert">{deviceError}</p>
      <div className="inline-actions"><button disabled={working} onClick={() => void checkDevice()}>登録の状態を再確認</button><Link className="text-link" href="/device">この端末を登録する</Link></div>
      <p className="field-help">管理者でログインしただけでは受付端末になりません。申請したブラウザで承認後の利用開始まで進めてください。</p>
    </div>}
    {device && <fieldset className="reception-mode" disabled={working || Boolean(recovery)}>
      <legend>受付モードを選ぶ</legend><div className="reception-mode-buttons">
        <button type="button" aria-pressed={mode === "IN"} onClick={() => { setMode("IN"); setInstruction(""); }}>入室</button>
        <button type="button" aria-pressed={mode === "OUT"} onClick={() => { setMode("OUT"); setInstruction(""); }}>退室</button>
      </div><p className="reception-current-mode">現在は「{mode === "IN" ? "入室" : "退室"}」の受付です</p>
    </fieldset>}
    {working && <p className="notice" role="status">受付の応答を確認しています。完了するまでQRを新しく読み取らないでください。</p>}
    {instruction && <p className="notice" role="status">{instruction}</p>}
    {result && <div className={`reception-result${result.outcome === "RECORDED" ? "" : " rejected"}`} role="status" aria-live="polite">
      <h2>{result.outcome === "RECORDED" ? result.mode === "IN" ? "入室を記録しました" : "退室を記録しました" : "受付できませんでした"}</h2>
      {result.person && <p className="reception-person">{result.person.displayName}</p>}
      {result.outcome === "RECORDED" ? <p className="reception-time">{resultTime(result)} <span className="field-help">（{result.timeZone}）</span></p> : <p>{result.message}</p>}
      <p className="field-help">表示が消えたら次の方のQRをかざしてください。</p>
    </div>}
    {recovery && <div className="reception-unknown" role="status">
      <h2>この受付の結果を確認してください</h2><p>{recovery.message}</p>
      <div className="inline-actions">
        <button disabled={working || loading} onClick={() => void checkResult()}>この受付の結果を確認</button>
        {recovery.canResend && <button className="secondary" disabled={working} onClick={() => void resend()}>同じ内容を再送</button>}
        <button className="secondary" disabled={working} onClick={() => setDiscardOpen(true)}>管理者に確認して受付を再開</button>
      </div>
    </div>}
    {issueError && <div className="notice error" role="alert"><p>{issueError}</p><p>この読み取りの記録は送信していません。</p><button className="secondary" disabled={working} onClick={() => { setIssueError(""); setInstruction("前のQRをいったんカメラから外してから読み取ってください。"); }}>読み取りを再開</button></div>}
    {device && <QrCamera paused={paused} onRead={(value) => void readQr(value)} />}
    <p className="reception-links"><Link href="/device">受付端末の登録状態を確認する</Link></p>
    <Modal open={discardOpen} title="結果を確認して受付を再開" description="未確認の受付結果を確認済みとして扱います。管理者が入退室の記録を確認してから再開してください。この操作では入退出の記録を追加・取り消しません。" onClose={() => setDiscardOpen(false)}>
      <p>記録の有無を確認せずに再読取すると、利用者に誤った案内をするおそれがあります。</p>
      <div className="inline-actions"><button className="secondary" data-modal-initial onClick={() => setDiscardOpen(false)}>キャンセル</button><button onClick={() => {
        if (pending.current) removeRequestId(pending.current.requestId);
        pending.current = null; setRecovery(null); setIssueError(""); setDiscardOpen(false);
        setInstruction("前のQRをいったんカメラから外してから読み取ってください。");
      }}>管理者が確認済み・再開する</button></div>
    </Modal>
  </section>;
}

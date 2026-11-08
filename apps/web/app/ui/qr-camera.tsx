"use client";

import jsQR from "jsqr";
import { useEffect, useRef, useState } from "react";

type CameraState = "idle" | "starting" | "ready" | "paused" | "denied" | "unavailable";

export function QrCamera({ paused, onRead }: { paused: boolean; onRead: (value: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const currentStream = useRef<MediaStream | null>(null);
  const read = useRef(onRead);
  const lastCode = useRef<string | null>(null);
  const absentSince = useRef<number | null>(null);
  const [wanted, setWanted] = useState(false);
  const [state, setState] = useState<CameraState>("idle");
  const [message, setMessage] = useState("");

  useEffect(() => { read.current = onRead; }, [onRead]);

  useEffect(() => {
    function pauseHiddenCamera() {
      if (document.visibilityState === "hidden") {
        currentStream.current?.getTracks().forEach((track) => track.stop());
        setWanted(false); setState("paused");
      }
    }
    document.addEventListener("visibilitychange", pauseHiddenCamera);
    function pausePageCamera() {
      currentStream.current?.getTracks().forEach((track) => track.stop());
      setWanted(false); setState("paused");
    }
    window.addEventListener("pagehide", pausePageCamera);
    return () => { document.removeEventListener("visibilitychange", pauseHiddenCamera); window.removeEventListener("pagehide", pausePageCamera); };
  }, []);

  useEffect(() => {
    if (!wanted || paused) return;
    let disposed = false;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const element = video.current;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { willReadFrequently: true });

    function scan() {
      if (disposed || !element || !context) return;
      if (element.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && element.videoWidth > 0 && element.videoHeight > 0) {
        // 映像は端末内だけで解析する。フレームは保存・送信せず、読取本文だけを受付処理へ渡す。
        let code: ReturnType<typeof jsQR>;
        try {
          const scale = Math.min(1, 960 / element.videoWidth);
          canvas.width = Math.round(element.videoWidth * scale);
          canvas.height = Math.round(element.videoHeight * scale);
          context.drawImage(element, 0, 0, canvas.width, canvas.height);
          const image = context.getImageData(0, 0, canvas.width, canvas.height);
          code = jsQR(image.data, image.width, image.height, { inversionAttempts: "attemptBoth" });
        } catch {
          setWanted(false); setState("unavailable"); setMessage("映像を読み取れませんでした。カメラを再起動するか、管理者に確認してください。");
          return;
        }
        if (code) {
          absentSince.current = null;
          if (lastCode.current !== code.data) {
            lastCode.current = code.data;
            read.current(code.data);
          }
        } else {
          const now = performance.now();
          absentSince.current ??= now;
          // 同じ紙を置いたままの連続送信を防ぎ、1秒以上外してから同じQRを再受付する。
          if (now - absentSince.current >= 1_000) lastCode.current = null;
        }
      }
      timer = setTimeout(scan, 180);
    }

    const opening = context ? navigator.mediaDevices.getUserMedia({
      audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 960 } },
    }) : Promise.reject(new Error("映像を解析する準備ができません。"));
    void opening.then(async (acquired) => {
      // 許可待ちの間に停止・画面移動した場合も、遅れて取得したカメラを残さない。
      if (disposed || !element) { acquired.getTracks().forEach((track) => track.stop()); return; }
      stream = acquired;
      currentStream.current = acquired;
      acquired.getVideoTracks().forEach((track) => {
        track.addEventListener("ended", () => {
          if (!disposed) { setWanted(false); setState("paused"); setMessage("カメラが停止しました。必要な場合はもう一度起動してください。"); }
        });
      });
      element.srcObject = acquired;
      await element.play();
      if (disposed) return;
      setState("ready"); setMessage("");
      scan();
    }).catch((error: unknown) => {
      if (disposed) return;
      setWanted(false);
      const denied = error instanceof DOMException && ["NotAllowedError", "PermissionDeniedError"].includes(error.name);
      setState(denied ? "denied" : "unavailable");
      setMessage(denied
        ? "カメラを利用するには、このサイトのカメラ許可を有効にしてください。許可できない場合は管理者に受付方法を確認してください。"
        : "カメラを起動できませんでした。他のアプリのカメラを閉じ、SafariまたはChromeで開き直してください。利用できない場合は管理者に確認してください。");
    });

    return () => {
      disposed = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((track) => track.stop());
      if (currentStream.current === stream) currentStream.current = null;
      if (element) { element.pause(); element.srcObject = null; }
      canvas.width = 0; canvas.height = 0;
    };
  }, [wanted, paused]);

  const start = () => {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setState("unavailable");
      setMessage("このブラウザではカメラを利用できません。正しいHTTPSのURLをSafariまたはChromeで開いてください。利用できない場合は管理者に確認してください。");
      return;
    }
    setState("starting"); setMessage(""); setWanted(true);
  };

  const status = paused ? "読み取りを一時停止しています" : wanted && state === "ready" ? "QRをカメラにかざしてください"
    : wanted ? "カメラを起動しています…" : state === "paused" ? "カメラを停止しています" : "カメラは起動していません";

  return <section className="qr-camera" aria-label="QR読み取り用カメラ">
    <div className="qr-camera-view">
      <video ref={video} autoPlay playsInline muted aria-label="QR読み取り用のカメラ映像" />
      <div className="qr-camera-guide" aria-hidden="true" />
      {(!wanted || paused) && <div className="qr-camera-overlay"><span>{status}</span></div>}
    </div>
    <p className="camera-status" role="status">{status}</p>
    {message && <p className="notice error" role="alert">{message}</p>}
    <div className="inline-actions">
      {wanted ? <button className="secondary" onClick={() => { setWanted(false); setState("paused"); setMessage(""); }}>カメラを停止</button>
        : <button disabled={paused} onClick={start}>{state === "denied" || state === "unavailable" ? "カメラを再試行" : "カメラを起動"}</button>}
    </div>
    <p className="field-help">映像は端末内で読み取り、サーバーへ送りません。同じQRを続けて読む場合は、いったんカメラから外してください。</p>
  </section>;
}

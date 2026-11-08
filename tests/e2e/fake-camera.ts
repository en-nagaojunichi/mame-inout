import type { Page } from "@playwright/test";

// 製品の読取経路は変えず、カメラだけをCanvasの映像に置き換える。
// 実QRを含む画像はメモリ内だけで渡し、動画・画像ファイルとして保存しない。
export async function fakeCamera(page: Page, frame: () => Promise<string | null>) {
  await page.exposeFunction("mameTestCameraFrame", frame);
  await page.addInitScript(() => {
    const metadata = { opened: 0, drawn: 0, failed: 0, failureName: "" };
    const testWindow = window as typeof window & {
      mameTestCameraFrame: () => Promise<string | null>;
      mameTestCameraMetadata: typeof metadata;
    };
    testWindow.mameTestCameraMetadata = metadata;
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { configurable: true, value: async () => {
      metadata.opened++;
      const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 640;
      const context = canvas.getContext("2d")!;
      context.fillStyle = "white"; context.fillRect(0, 0, 640, 640);
      const stream = canvas.captureStream(12);
      let drawing = false;
      let decodedSource: string | null = null;
      let decodedImage: HTMLImageElement | null = null;
      const timer = setInterval(() => {
        if (stream.getTracks().every(track => track.readyState === "ended")) { clearInterval(timer); canvas.width = 0; return; }
        if (drawing) return;
        drawing = true;
        void testWindow.mameTestCameraFrame().then(async source => {
          if (source !== decodedSource) {
            const image = source ? new Image() : null;
            if (image && source) { image.src = source; await image.decode(); }
            decodedSource = source;
            decodedImage = image;
          }
          if (!canvas.width || stream.getTracks().every(track => track.readyState === "ended")) return;
          // decode待ちの白フレームを映像へ流さず、1回の同期処理で完成した画面へ描き換える。
          context.fillStyle = "white"; context.fillRect(0, 0, 640, 640);
          if (decodedImage) { context.drawImage(decodedImage, 80, 80, 480, 480); metadata.drawn++; }
        }).catch((error: unknown) => {
          metadata.failed++;
          metadata.failureName = error instanceof Error ? error.name : "unknown";
        }).finally(() => { drawing = false; });
      }, 80);
      return stream;
    } });
  });
  // フレーム本文を出さず、架空カメラの準備状態だけを診断できるようにする。
  return () => page.evaluate(() => (window as typeof window & { mameTestCameraMetadata: { opened: number; drawn: number; failed: number; failureName: string } }).mameTestCameraMetadata);
}

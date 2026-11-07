import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MameInOut | 管理者ログイン",
  description: "スマートフォンとQRコードで入退出を記録するMameInOutの管理者画面。",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ja"><body>{children}</body></html>;
}

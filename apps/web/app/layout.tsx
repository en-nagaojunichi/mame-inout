import type { Metadata } from "next";
import "./globals.css";
import "./ui/appearance.css";
import { BrandProvider } from "./ui/brand";

export const metadata: Metadata = {
  title: "管理者ログイン | 入退出管理システム",
  description: "スマートフォンとQRコードで入退出を記録する管理者画面。",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ja"><body><BrandProvider>{children}</BrandProvider></body></html>;
}

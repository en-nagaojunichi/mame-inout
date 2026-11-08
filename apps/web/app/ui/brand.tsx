"use client";

import Image from "next/image";
import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { appearanceResponseSchema, defaultDisplayName, type Appearance } from "@mame/contracts";
import { api } from "./client-api";

const initial: Appearance = { displayName: defaultDisplayName, version: 1, iconUrl: "/api/appearance/icon?v=1", faviconUrl: "/api/appearance/favicon?v=1", customIcon: false, customFavicon: false };
type BrandContextValue = { appearance: Appearance; refresh: () => Promise<void>; setAppearance: (appearance: Appearance) => void };
const BrandContext = createContext<BrandContextValue>({ appearance: initial, refresh: async () => {}, setAppearance: () => {} });
const titles: Record<string, string> = { "/": "管理者ログイン", "/admin": "管理ホーム", "/people": "利用者", "/presence": "在室一覧", "/attendance": "入退室履歴", "/history": "入退出履歴",
  "/settings": "自分の設定", "/settings/devices": "QR受付端末", "/settings/administrators": "管理者", "/settings/appearance": "表示設定", "/reception": "QR受付", "/device": "QR受付の準備", "/invite": "管理者の登録", "/recover": "ログインの復旧" };

export function BrandProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [appearance, storeAppearance] = useState<Appearance>(initial);
  const setAppearance = useCallback((value: Appearance) => {
    // 初回取得や別画面の古い応答が、保存済みの新しい表示名・画像を巻き戻さないようにする。
    storeAppearance((current) => value.version < current.version ? current : value);
  }, []);
  const refresh = useCallback(async () => { setAppearance(await api("/api/appearance", appearanceResponseSchema)); }, [setAppearance]);
  useEffect(() => {
    let active = true;
    // 表示設定の取得失敗で認証や受付を止めず、既定の名称とローカル図形を利用する。
    void api("/api/appearance", appearanceResponseSchema).then((value) => { if (active) setAppearance(value); }).catch(() => {});
    return () => { active = false; };
  }, [setAppearance]);
  useEffect(() => {
    document.title = `${titles[pathname] ?? "管理画面"} | ${appearance.displayName}`;
    let icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!icon) { icon = document.createElement("link"); icon.rel = "icon"; document.head.append(icon); }
    icon.href = appearance.faviconUrl;
    icon.type = appearance.customFavicon ? "image/png" : "image/svg+xml";
  }, [appearance, pathname]);
  return <BrandContext.Provider value={{ appearance, refresh, setAppearance }}>{children}</BrandContext.Provider>;
}

export const useBrand = () => useContext(BrandContext);

export function DefaultBrandIcon() {
  return <svg className="system-brand-icon" width="32" height="32" viewBox="0 0 64 64" aria-hidden="true" focusable="false"><rect width="64" height="64" rx="14" fill="currentColor" /><path d="M26 14h20v36H26M10 32h25m-8-8 8 8-8 8" fill="none" stroke="#fff" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

export function Brand({ className = "" }: { className?: string }) {
  const { appearance } = useBrand();
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  return <span className={`brand system-brand ${className}`}>{appearance.customIcon && failedUrl !== appearance.iconUrl
    ? <Image unoptimized src={appearance.iconUrl} alt="" width={32} height={32} className="system-brand-icon" onError={() => setFailedUrl(appearance.iconUrl)} />
    : <DefaultBrandIcon />}<span>{appearance.displayName}</span></span>;
}

export function AppVersion() {
  return <span className="app-version">バージョン {process.env.NEXT_PUBLIC_APP_VERSION} <span>検証版</span></span>;
}

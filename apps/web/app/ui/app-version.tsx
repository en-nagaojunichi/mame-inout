export function AppVersion() {
  return <span className="app-version"><span>バージョン</span>{" "}<span className="app-version-number">{process.env.NEXT_PUBLIC_APP_VERSION}</span></span>;
}

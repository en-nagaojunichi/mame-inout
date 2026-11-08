import { ReceptionPanel } from "../ui/reception-panel";
import "./reception.css";

export default function ReceptionPage() {
  return <>
    <a className="skip-link" href="#main">本文へ移動</a>
    <header className="site-header reception-header"><span className="brand"><span className="brand-mark" aria-hidden="true" />MameInOut</span><span className="header-label">QR受付</span></header>
    <main id="main" className="reception-workspace"><ReceptionPanel /></main>
  </>;
}

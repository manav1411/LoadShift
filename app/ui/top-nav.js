import Link from "next/link";
import WindPowerIcon from "@mui/icons-material/WindPower";

export default function TopNav({ children }) {
  return (
    <header className="top-nav">
      <Link className="brand-mark" href="/">
        <WindPowerIcon className="brand-icon" style={{ fontSize: 20 }} aria-hidden="true" />
        LoadShift
      </Link>
      <nav className="top-nav-actions" aria-label="Primary">
        {children}
      </nav>
    </header>
  );
}

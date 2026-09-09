import { Icon, type IconName } from "./Icon";

export function MetricCard({ label, value, detail, icon, tone = "blue" }: { label: string; value: string; detail: string; icon: IconName; tone?: "blue" | "green" | "amber" | "purple" }) {
  return (
    <div className="metric-card">
      <div className={`metric-icon metric-${tone}`}><Icon name={icon} size={17} /></div>
      <div className="metric-copy">
        <span>{label}</span>
        <strong>{value}</strong>
        <small>{detail}</small>
      </div>
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`skeleton ${className}`} aria-hidden="true" />;
}

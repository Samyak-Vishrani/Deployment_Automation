import { Icon } from "./ui/Icon";
import type { LogEntry } from "@/lib/platform/types";

function time(value: string) {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

export function LogViewer({ logs, emptyMessage = "No logs have been emitted yet." }: { logs: LogEntry[]; emptyMessage?: string }) {
  return (
    <div className="log-viewer">
      <div className="log-toolbar"><div className="log-dots"><i /><i /><i /></div><span>pipeline output / live</span><span>{logs.length} lines</span></div>
      <div className="log-lines">
        {logs.length ? logs.map((log) => (
          <div className="log-line" key={log.id}><span className="log-time">{time(log.timestamp)}</span><span className="log-source">{log.source}</span><span className={`log-${log.level}`}>{log.level === "error" ? <Icon name="x" size={11} /> : log.level === "warn" ? "!" : "›"} {log.message}</span></div>
        )) : <div className="empty-inline">{emptyMessage}</div>}
      </div>
    </div>
  );
}

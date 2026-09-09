import { Icon } from "./Icon";

export function Toast({ title, message }: { title: string; message: string }) {
  return <div className="toast" role="status"><Icon name="sparkles" size={16} /><span><strong>{title}</strong><small>{message}</small></span></div>;
}

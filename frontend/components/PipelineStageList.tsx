import { Icon } from "./ui/Icon";
import type { PipelineStage } from "@/lib/platform/types";

export function PipelineStageList({ stages }: { stages: PipelineStage[] }) {
  return (
    <div className="stage-list">
      {stages.map((stage) => {
        const stateClass = stage.status === "succeeded" ? "stage-item-success" : stage.status === "running" ? "stage-item-running" : stage.status === "failed" ? "stage-item-failed" : "";
        return (
          <div className={`stage-item ${stateClass}`} key={stage.id}>
            <span className="stage-marker">
              {stage.status === "succeeded" ? <Icon name="check" size={14} /> : stage.status === "failed" ? <Icon name="x" size={14} /> : stage.status === "running" ? <span className="button-spinner" /> : <span className="stage-marker-number">{stages.indexOf(stage) + 1}</span>}
            </span>
            <div className="stage-copy">
              <div className="stage-copy-top"><strong>{stage.name}</strong>{stage.duration ? <span className="stage-duration">{stage.duration}</span> : null}</div>
              <small>{stage.detail}</small>
            </div>
          </div>
        );
      })}
    </div>
  );
}

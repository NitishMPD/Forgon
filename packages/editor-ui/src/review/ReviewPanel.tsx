import { Button, EmptyState, StatusText } from '../primitives/primitives.js';

export interface ReviewPanelProps {
  threadTitle: string | null;
  changedPaths: readonly string[];
}

// Review shows only what the agent service reported (diff events). Accept, discard and restore
// need a checkpoint service, which is not part of contract v1, so they stay disabled with the reason.
export function ReviewPanel({ threadTitle, changedPaths }: ReviewPanelProps) {
  if (changedPaths.length === 0) {
    return (
      <section className="fg-dock-panel" aria-label="Review">
        <EmptyState title="No changes to review">Agent changes appear here for review before they are saved.</EmptyState>
      </section>
    );
  }
  return (
    <section className="fg-dock-panel" aria-label="Review">
      <div className="fg-toolbar">
        <span className="fg-small">{threadTitle ?? 'Agent changes'}</span>
        <StatusText tone="neutral">Checks not run: no check service connected</StatusText>
      </div>
      <h3 className="fg-section-title">Changed files ({changedPaths.length})</h3>
      <ul className="fg-list-plain fg-mono">
        {changedPaths.map(path => <li key={path}>{path}</li>)}
      </ul>
      <div className="fg-toolbar">
        <Button variant="primary" disabled title="Accepting a draft needs the checkpoint service, which is not connected.">Accept draft</Button>
        <Button disabled title="Discarding needs the checkpoint service, which is not connected.">Discard draft</Button>
        <Button disabled title="Restoring needs a checkpoint service that can roll back the conversation.">Restore checkpoint</Button>
      </div>
      <p className="fg-muted fg-small">No checkpoints are recorded. Accept, discard and restore stay unavailable until a checkpoint service is connected.</p>
    </section>
  );
}

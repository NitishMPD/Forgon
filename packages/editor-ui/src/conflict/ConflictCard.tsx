import type { SceneConflict } from '@forgon/editor-core';
import { diffScenes } from '../model/sceneDiff.js';
import { Button } from '../primitives/primitives.js';

export interface ConflictCardProps {
  conflict: SceneConflict;
  onResolve(choice: 'ours' | 'theirs'): void;
}

export function ConflictCard({ conflict, onResolve }: ConflictCardProps) {
  const changes = diffScenes(conflict.ours, conflict.theirs);
  const rows = changes.flatMap(change => {
    if (change.status === 'only-ours') {
      return [{ key: `${change.entityId}:object`, object: change, path: 'object', ours: 'Object exists in your edit', theirs: null }];
    }
    if (change.status === 'only-theirs') {
      return [{ key: `${change.entityId}:object`, object: change, path: 'object', ours: null, theirs: 'Object exists in the file' }];
    }
    return change.changes.map(property => ({
      key: `${change.entityId}:${property.path}`,
      object: change,
      path: property.path,
      ours: property.ours,
      theirs: property.theirs,
    }));
  });
  return (
    <section className="fg-conflict" role="alert" aria-labelledby="conflict-title">
      <h3 id="conflict-title" className="fg-conflict-title">File changed while you have unsaved edits</h3>
      <p className="fg-conflict-text">
        Nothing was overwritten. Choose which version to keep. Disk revision <code>{conflict.revision.slice(0, 12)}</code>.
      </p>
      {rows.length > 0 ? (
        <div className="fg-table-wrap">
          <table className="fg-table">
            <thead>
              <tr>
                <th scope="col">Object</th>
                <th scope="col">Property</th>
                <th scope="col">Your edit (unsaved)</th>
                <th scope="col">File on disk</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.key}>
                  <td>
                    <span>{row.object.name}</span>
                    <span className="fg-mono fg-muted">{row.object.entityId}</span>
                  </td>
                  <td className="fg-mono">{row.path}</td>
                  <td>{renderValue(row.ours)}</td>
                  <td>{renderValue(row.theirs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="fg-conflict-text">The file and your edit differ only in ordering or formatting.</p>
      )}
      <div className="fg-conflict-actions">
        <Button variant="primary" onClick={() => onResolve('ours')}>Keep mine</Button>
        <Button onClick={() => onResolve('theirs')}>Use file version</Button>
      </div>
    </section>
  );
}

function renderValue(value: string | null) {
  if (value === null) return <span className="fg-muted">(none)</span>;
  return <code className="fg-value">{value}</code>;
}

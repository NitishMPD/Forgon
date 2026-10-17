import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { createId, type Entity } from '@forgon/project-schema';
import type { SceneCommand } from '@forgon/editor-core';
import { Box, Camera, Folder, Lightbulb, Package, Shapes, Sparkles, SquareDashed, Users, Volume2, ListPlus, Circle, type LucideIcon } from 'lucide-react';
import { EmptyState, IconButton, cx } from '../../primitives/primitives.js';
import { noSelection, rangeSelection, selectOne, toggleSelection, type Selection } from '../../model/selection.js';
import { buildRows, parentRowId, stepId } from '../../model/tree.js';
import { duplicatePlan, indentTarget, outdentTarget, reparentCommands } from '../../model/hierarchyOps.js';

export interface HierarchyProps {
  sceneName: string;
  entities: readonly Entity[];
  selection: Selection;
  locked: boolean;
  onSelect(selection: Selection): void;
  onCreate(): void;
  onDelete(entityIds: readonly string[]): void;
  onRename(entityId: string, name: string): void;
  // Every structural change is a SceneCommand, validated by the store like any other edit.
  onCommand(command: SceneCommand): boolean;
  // Explains why a move was not offered (for example, a prefab member). Shown in the Console.
  onNotice(message: string): void;
}

function RenameInput({ initial, onCommit, onCancel }: { initial: string; onCommit(name: string): void; onCancel(): void }) {
  const done = useRef(false);
  const finish = (commit: boolean, value: string): void => {
    if (done.current) return;
    done.current = true;
    if (commit) onCommit(value);
    else onCancel();
  };
  return (
    <input
      className="fg-input fg-tree-rename"
      aria-label="Entity name"
      defaultValue={initial}
      autoFocus
      onFocus={event => event.currentTarget.select()}
      onClick={event => event.stopPropagation()}
      onDoubleClick={event => event.stopPropagation()}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.key === 'Enter') finish(true, event.currentTarget.value);
        if (event.key === 'Escape') finish(false, '');
      }}
      onBlur={event => finish(true, event.currentTarget.value)}
    />
  );
}

// Row icon from what the entity is: the first recognised component wins, then group or empty.
const componentIcons: ReadonlyArray<[string, LucideIcon]> = [
  ['camera', Camera], ['light', Lightbulb], ['audio', Volume2], ['sound', Volume2], ['vfx', Sparkles],
  ['guestQueue', Users], ['render', Box], ['model', Box], ['collision', SquareDashed], ['rigidbody', Shapes],
];

function entityIcon(entity: Entity | undefined, hasChildren: boolean): LucideIcon {
  if (entity?.prefab) return Package;
  const types = new Set(entity?.components.map(component => component.type) ?? []);
  for (const [type, icon] of componentIcons) if (types.has(type)) return icon;
  return hasChildren ? Folder : Circle;
}

export function Hierarchy({ sceneName, entities, selection, locked, onSelect, onCreate, onDelete, onRename, onCommand, onNotice }: HierarchyProps) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [dropRow, setDropRow] = useState<string | null>(null);
  const [dropRoot, setDropRoot] = useState(false);
  const treeRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<string | null>(null);
  const dragging = useRef<readonly string[] | null>(null);
  const byId = new Map(entities.map(entity => [entity.id, entity] as const));
  const rows = buildRows(entities, collapsed);
  const ids = rows.map(row => row.id);
  const primary = selection.primaryId !== null && ids.includes(selection.primaryId) ? selection.primaryId : null;
  const focusId = primary ?? ids[0] ?? null;

  useEffect(() => {
    const id = pendingFocus.current;
    if (id === null) return;
    pendingFocus.current = null;
    treeRef.current?.querySelector<HTMLElement>(`[data-row-id="${id}"]`)?.focus();
  });

  const toggle = (id: string, expand?: boolean): void => {
    setCollapsed(current => {
      const next = new Set(current);
      const shouldCollapse = expand === undefined ? !next.has(id) : !expand;
      if (shouldCollapse) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const reveal = (id: string | null): void => {
    if (id === null) return;
    setCollapsed(current => {
      if (!current.has(id)) return current;
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  };

  const move = (id: string | null, extend: boolean): void => {
    if (id === null) return;
    onSelect(extend ? rangeSelection(selection, ids, id) : selectOne(id));
    pendingFocus.current = id;
  };

  // A move keeps the moved objects selected, reveals their new parent, and keeps focus on the primary row.
  const applyMove = (ids: readonly string[], parentId: string | null): void => {
    const plan = reparentCommands(entities, ids, parentId);
    if (!plan.ok) {
      onNotice(plan.reason);
      return;
    }
    if (!onCommand(plan.value)) return;
    reveal(parentId);
    const [first] = ids;
    if (first !== undefined) {
      pendingFocus.current = first;
      onSelect({ entityIds: [...ids], primaryId: first });
    }
  };

  const duplicate = (ids: readonly string[]): void => {
    const plan = duplicatePlan(entities, ids, createId);
    if (!plan.ok) {
      onNotice(plan.reason);
      return;
    }
    if (!onCommand({ type: 'batch', commands: plan.value.commands })) return;
    const [first] = plan.value.topLevelIds;
    if (first !== undefined) {
      onSelect({ entityIds: plan.value.topLevelIds, primaryId: first });
      pendingFocus.current = first;
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.target instanceof HTMLInputElement) return;
    const index = primary === null ? -1 : ids.indexOf(primary);
    const row = index === -1 ? undefined : rows[index];
    if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault();
      if (locked || primary === null) return;
      if (event.key === 'ArrowRight') {
        const target = indentTarget(entities, primary);
        if (target.ok) applyMove([primary], target.value);
        else onNotice(target.reason);
      } else {
        const target = outdentTarget(entities, primary);
        if (target.ok) applyMove([primary], target.value);
        else onNotice(target.reason);
      }
      return;
    }
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        move(stepId(ids, focusId, 1), event.shiftKey);
        break;
      case 'ArrowUp':
        event.preventDefault();
        move(stepId(ids, focusId, -1), event.shiftKey);
        break;
      case 'Home':
        event.preventDefault();
        move(ids[0] ?? null, false);
        break;
      case 'End':
        event.preventDefault();
        move(ids.at(-1) ?? null, false);
        break;
      case 'ArrowRight':
        if (!row?.hasChildren) break;
        event.preventDefault();
        if (!row.expanded) toggle(row.id, true);
        else move(rows[index + 1]?.id ?? null, false);
        break;
      case 'ArrowLeft':
        event.preventDefault();
        if (row?.hasChildren && row.expanded) toggle(row.id, false);
        else move(parentRowId(rows, index), false);
        break;
      case 'Enter':
      case 'F2':
        if (row && !locked) {
          event.preventDefault();
          setRenamingId(row.id);
        }
        break;
      case 'Delete':
        if (!locked && selection.entityIds.length > 0) {
          event.preventDefault();
          onDelete(selection.entityIds);
        }
        break;
      case 'Escape':
        onSelect(noSelection);
        break;
      case 'a':
        if (event.ctrlKey && !locked) {
          event.preventDefault();
          onSelect({ entityIds: ids, primaryId: primary ?? ids[0] ?? null });
        }
        break;
      case 'd':
        if (event.ctrlKey && !locked && selection.entityIds.length > 0) {
          event.preventDefault();
          duplicate(selection.entityIds);
        }
        break;
    }
  };

  const clickRow = (event: MouseEvent<HTMLDivElement>, id: string): void => {
    pendingFocus.current = id;
    if (event.ctrlKey) onSelect(toggleSelection(selection, id));
    else if (event.shiftKey) onSelect(rangeSelection(selection, ids, id));
    else onSelect(selectOne(id));
  };

  const dragIds = (rowId: string): readonly string[] => (selection.entityIds.includes(rowId) ? selection.entityIds : [rowId]);

  const endDrag = (): void => {
    dragging.current = null;
    setDropRow(null);
    setDropRoot(false);
  };

  // Rows stop propagation so the tree-level handler only sees drags over empty space (the root drop).
  const onRowDragStart = (event: DragEvent<HTMLDivElement>, rowId: string): void => {
    if (locked) {
      event.preventDefault();
      return;
    }
    dragging.current = dragIds(rowId);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', rowId);
  };

  const onRowDragOver = (event: DragEvent<HTMLDivElement>, rowId: string): void => {
    if (!dragging.current) return;
    event.stopPropagation();
    if (reparentCommands(entities, dragging.current, rowId).ok) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      setDropRow(rowId);
      setDropRoot(false);
    } else {
      setDropRow(null);
    }
  };

  const onRowDrop = (event: DragEvent<HTMLDivElement>, rowId: string): void => {
    event.stopPropagation();
    event.preventDefault();
    const ids = dragging.current;
    endDrag();
    if (ids) applyMove(ids, rowId);
  };

  const onTreeDragOver = (event: DragEvent<HTMLDivElement>): void => {
    if (!dragging.current) return;
    if (reparentCommands(entities, dragging.current, null).ok) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      setDropRoot(true);
      setDropRow(null);
    }
  };

  const onTreeDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const ids = dragging.current;
    endDrag();
    if (ids) applyMove(ids, null);
  };

  return (
    <section className="fg-panel fg-hierarchy" aria-labelledby="hierarchy-title">
      <header className="fg-panel-header">
        <h2 id="hierarchy-title" className="fg-panel-title">Hierarchy</h2>
        <span className="fg-panel-subtitle" title={sceneName}>{entities.length} objects</span>
        <IconButton
          label="New entity"
          title={primary ? 'New entity under the selected object' : 'New entity at the root'}
          disabled={locked}
          onClick={onCreate}
        >
          <ListPlus size={16} strokeWidth={1.75} aria-hidden="true" />
        </IconButton>
      </header>
      {entities.length === 0 ? (
        <EmptyState title="No objects" />
      ) : (
        <>
          <p id="hierarchy-help" className="fg-sr-only">
            Alt plus Left or Right moves the selected object up or down a level. Drag an object onto another to make it a child, or onto empty space to move it to the root.
          </p>
          <div
            ref={treeRef}
            className={cx('fg-tree', dropRoot && 'is-drop-root')}
            role="tree"
            aria-label="Scene objects"
            aria-describedby="hierarchy-help"
            aria-multiselectable="true"
            aria-disabled={locked || undefined}
            onKeyDown={onKeyDown}
            onDragOver={onTreeDragOver}
            onDrop={onTreeDrop}
            onDragLeave={event => { if (event.currentTarget === event.target) setDropRoot(false); }}
          >
            {rows.map(row => {
              const selected = selection.entityIds.includes(row.id);
              return (
                <div
                  key={row.id}
                  role="treeitem"
                  aria-level={row.depth + 1}
                  aria-selected={selected}
                  aria-expanded={row.hasChildren ? row.expanded : undefined}
                  tabIndex={row.id === focusId ? 0 : -1}
                  data-row-id={row.id}
                  draggable={!locked && renamingId !== row.id}
                  className={cx(
                    'fg-tree-row',
                    selected && 'is-selected',
                    row.id === primary && 'is-primary',
                    dropRow === row.id && 'is-drop-target',
                  )}
                  style={{ paddingLeft: 8 + row.depth * 14 }}
                  title={`${row.name} · ${row.id}`}
                  onClick={event => clickRow(event, row.id)}
                  onDoubleClick={() => { if (!locked) setRenamingId(row.id); }}
                  onDragStart={event => onRowDragStart(event, row.id)}
                  onDragEnd={endDrag}
                  onDragOver={event => onRowDragOver(event, row.id)}
                  onDragLeave={() => setDropRow(current => (current === row.id ? null : current))}
                  onDrop={event => onRowDrop(event, row.id)}
                >
                  {row.hasChildren ? (
                    <span
                      className={cx('fg-chevron', row.expanded && 'is-open')}
                      aria-hidden="true"
                      onClick={event => { event.stopPropagation(); toggle(row.id); }}
                    />
                  ) : (
                    <span className="fg-chevron-spacer" aria-hidden="true" />
                  )}
                  {(() => { const Icon = entityIcon(byId.get(row.id), row.hasChildren); return <Icon className="fg-tree-icon" size={14} strokeWidth={1.75} aria-hidden="true" />; })()}
                  {renamingId === row.id ? (
                    <RenameInput
                      initial={row.name}
                      onCancel={() => setRenamingId(null)}
                      onCommit={name => {
                        setRenamingId(null);
                        const next = name.trim();
                        if (next !== '' && next !== row.name) onRename(row.id, next);
                      }}
                    />
                  ) : (
                    <span className="fg-tree-name">{row.name}</span>
                  )}
                  {row.prefab ? <span className="fg-sr-only">Prefab</span> : null}
                </div>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}

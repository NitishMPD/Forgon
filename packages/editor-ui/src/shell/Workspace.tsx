import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement, type DragEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import {
  Activity, AudioLines, Bot, Box, ChevronRight, CircleAlert, Clock, Diamond, Eye, Film, Focus, FolderOpen, Gamepad2,
  GitCompareArrows, LayoutDashboard, ListTree, LogOut, MousePointer2, Move, Play, Plus, Redo2, RotateCw, Save, Settings as SettingsIcon,
  Scaling, ShieldCheck, SlidersHorizontal, Sparkles, Square, Terminal, TriangleAlert, Undo2, X, type LucideIcon,
} from 'lucide-react';
import type { SceneCommand } from '@forgon/editor-core';
import { createEntity, type AssetRecord, type Transform } from '@forgon/project-schema';
import { AgentDock } from '../agent/AgentDock.js';
import { AgentsPanel } from '../agent/AgentsPanel.js';
import { threadStatus, threadStatusLabels } from '../agent/threadState.js';
import type { AgentController } from '../agent/useAgentSessions.js';
import type { EditorSnapshot } from '../hooks/useEditorSnapshot.js';
import { AssetsPanel } from '../panels/assets/AssetsPanel.js';
import { ConsolePanel } from '../panels/console/ConsolePanel.js';
import { Hierarchy } from '../panels/hierarchy/Hierarchy.js';
import { Inspector } from '../panels/inspector/Inspector.js';
import { ReviewPanel } from '../review/ReviewPanel.js';
import { countBySeverity, type ConsoleLog, type LogInput } from '../model/consoleLog.js';
import type { FileBanner, SaveStatus } from '../model/fileState.js';
import {
  closePanel, defaultLayout, groupAt, groupIds, groupOf, isPanelVisible, keyboardSplit, movePanel, neighbourGroup, panelIds,
  showPanel, splitLimits, activatePanel, type GroupId, type LayoutState, type PanelId,
} from '../model/layout.js';
import { noSelection, selectOne, type Selection } from '../model/selection.js';
import { planSceneSwitch } from '../model/sceneSwitch.js';
import { topmostIds } from '../model/tree.js';
import { Banner, Button, IconButton, StatusText, cx, type Tone } from '../primitives/primitives.js';
import type { ViewportHandle, ViewportMount, ViewportTool, ViewportView } from '../services.js';
import { Settings } from './Settings.js';
import { ViewportSlot } from './ViewportSlot.js';

export interface SceneEntry {
  id: string;
  path: string;
}

export interface WorkspaceProps {
  projectName: string;
  source: 'project' | 'sample';
  sourcePath: string | null;
  snapshot: EditorSnapshot;
  selection: Selection;
  onSelect(selection: Selection): void;
  onCommand(command: SceneCommand): boolean;
  onUndo(): void;
  onRedo(): void;
  // Resolves true when the scene on disk matches the editor, so a scene switch may proceed.
  onSave(): Promise<boolean>;
  saveStatus: SaveStatus;
  saveDisabledReason: string | null;
  banner: FileBanner | null;
  onDismissBanner(): void;
  onResolveConflict(choice: 'ours' | 'theirs'): void;
  scenes: readonly SceneEntry[];
  onSwitchScene(path: string): void;
  // A scene that failed to open. The current scene stays on screen.
  notice: string | null;
  onDismissNotice(): void;
  assets: readonly AssetRecord[];
  viewportContext?: Omit<ViewportView, 'scene' | 'selectedIds'>;
  saveError?: string | null;
  onRefreshAssets?: (() => Promise<void>) | undefined;
  onImportAsset?: ((license: string) => Promise<void>) | undefined;
  log: ConsoleLog;
  onLog(entry: LogInput): void;
  agent: AgentController | null;
  viewport: ViewportMount | null;
  layout: LayoutState;
  onLayoutChange(layout: LayoutState): void;
  onClose(): void;
}

const iconProps = { size: 14, strokeWidth: 1.75, 'aria-hidden': true } as const;
const panelMime = 'application/x-forgon-panel';
const gap = 8;
const tabStripHeight = 40;

const panelMeta: Record<PanelId, { label: string; icon: LucideIcon }> = {
  viewport: { label: 'Viewport', icon: Box },
  game: { label: 'Game', icon: Gamepad2 },
  hierarchy: { label: 'Hierarchy', icon: ListTree },
  inspector: { label: 'Inspector', icon: SlidersHorizontal },
  composer: { label: 'Composer', icon: Sparkles },
  agents: { label: 'Agents', icon: Bot },
  project: { label: 'Project', icon: FolderOpen },
  console: { label: 'Console', icon: Terminal },
  review: { label: 'Review', icon: GitCompareArrows },
};

// Listed in the add-panel menu so the slot exists, but not built yet. Shown disabled, never as working panels.
const plannedPanels: ReadonlyArray<{ label: string; icon: LucideIcon }> = [
  { label: 'Audio', icon: AudioLines },
  { label: 'Animation', icon: Film },
  { label: 'Timeline', icon: Clock },
  { label: 'Profiler', icon: Activity },
];

const toolButtons: ReadonlyArray<{ id: ViewportTool; label: string; key: string; icon: LucideIcon }> = [
  { id: 'select', label: 'Select', key: 'Q', icon: MousePointer2 },
  { id: 'translate', label: 'Move', key: 'W', icon: Move },
  { id: 'rotate', label: 'Rotate', key: 'E', icon: RotateCw },
  { id: 'scale', label: 'Scale', key: 'R', icon: Scaling },
];

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

const isLeft = (group: GroupId): boolean => group === 'topLeft' || group === 'bottomLeft';
const isTop = (group: GroupId): boolean => group === 'topLeft' || group === 'topRight';
const pct = (value: number): string => `${(value * 100).toFixed(3)}%`;

// Group rectangles are percentages of the dock area, so panels never need measuring to be placed.
function groupBox(layout: LayoutState, group: GroupId): { left: string; top: string; width: string; height: string } {
  const col = layout.columns;
  const row = isLeft(group) ? layout.leftRows : layout.rightRows;
  const half = gap / 2;
  return {
    left: isLeft(group) ? '0px' : `calc(${pct(col)} + ${half}px)`,
    width: `calc(${pct(isLeft(group) ? col : 1 - col)} - ${half}px)`,
    top: isTop(group) ? '0px' : `calc(${pct(row)} + ${half}px)`,
    height: `calc(${pct(isTop(group) ? row : 1 - row)} - ${half}px)`,
  };
}

function panelBox(layout: LayoutState, panel: PanelId): CSSProperties {
  const group = groupOf(layout, panel);
  if (group === null) return { left: 0, top: 0, width: 0, height: 0 };
  const box = groupBox(layout, group);
  return { left: box.left, width: box.width, top: `calc(${box.top} + ${tabStripHeight}px)`, height: `calc(${box.height} - ${tabStripHeight}px)` };
}

type SplitKey = 'columns' | 'leftRows' | 'rightRows';

function SplitHandle({ split, layout, area, onChange }: {
  split: SplitKey;
  layout: LayoutState;
  area: { current: HTMLDivElement | null };
  onChange(value: number): void;
}) {
  const dragging = useRef(false);
  const value = layout[split];
  const vertical = split === 'columns';
  const col = pct(layout.columns);
  const style: CSSProperties = split === 'columns'
    ? { left: `calc(${col} - ${gap / 2}px)`, top: 0, bottom: 0, width: gap }
    : split === 'leftRows'
      ? { left: 0, width: `calc(${col} - ${gap / 2}px)`, top: `calc(${pct(value)} - ${gap / 2}px)`, height: gap }
      : { left: `calc(${col} + ${gap / 2}px)`, right: 0, top: `calc(${pct(value)} - ${gap / 2}px)`, height: gap };
  const label = split === 'columns' ? 'Resize columns' : split === 'leftRows' ? 'Resize left column groups' : 'Resize right column groups';
  const move = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const rect = area.current?.getBoundingClientRect();
    if (!dragging.current || !rect || rect.width === 0 || rect.height === 0) return;
    const next = vertical ? (event.clientX - rect.left) / rect.width : (event.clientY - rect.top) / rect.height;
    onChange(Math.round(Math.min(splitLimits[1], Math.max(splitLimits[0], next)) * 1000) / 1000);
  };
  const end = (event: ReactPointerEvent<HTMLDivElement>): void => {
    dragging.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const owned = vertical ? ['ArrowLeft', 'ArrowRight', 'Home', 'End'] : ['ArrowUp', 'ArrowDown', 'Home', 'End'];
    if (!owned.includes(event.key)) return;
    const next = keyboardSplit(value, event.key, event);
    if (next === null) return;
    event.preventDefault();
    onChange(next);
  };
  return (
    <div
      role="separator"
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      aria-label={label}
      aria-valuemin={Math.round(splitLimits[0] * 100)}
      aria-valuemax={Math.round(splitLimits[1] * 100)}
      aria-valuenow={Math.round(value * 100)}
      tabIndex={0}
      className={cx('fg-split', vertical ? 'fg-split-vertical' : 'fg-split-horizontal')}
      style={style}
      onPointerDown={event => { dragging.current = true; event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={onKeyDown}
    />
  );
}

function AddPanelMenu({ group, layout, onPick, onClose }: {
  group: GroupId;
  layout: LayoutState;
  onPick(panel: PanelId): void;
  onClose(restoreFocus: boolean): void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const outside = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (target && !menuRef.current?.contains(target) && !(target instanceof Element && target.closest(`[data-add-panel="${group}"]`))) onClose(false);
    };
    globalThis.document?.addEventListener('pointerdown', outside);
    return () => globalThis.document?.removeEventListener('pointerdown', outside);
  }, [group, onClose]);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
    const index = items.indexOf(globalThis.document?.activeElement as HTMLButtonElement);
    let next: number | null = null;
    if (event.key === 'ArrowDown') next = (index + 1) % items.length;
    if (event.key === 'ArrowUp') next = (index - 1 + items.length) % items.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = items.length - 1;
    if (event.key === 'Escape') { event.preventDefault(); onClose(true); return; }
    if (event.key === 'Tab') { onClose(false); return; }
    if (next === null) return;
    event.preventDefault();
    items[next]?.focus();
  };
  return (
    <div ref={menuRef} className="fg-menu" role="menu" aria-label="Add panel" onKeyDown={onKeyDown}>
      {panelIds.map(panel => {
        const { label, icon: Icon } = panelMeta[panel];
        const where = groupOf(layout, panel);
        return (
          <button key={panel} type="button" role="menuitem" className="fg-menu-item" onClick={() => onPick(panel)}>
            <Icon {...iconProps} />
            <span>{label}</span>
            <span className="fg-menu-hint">{where === group ? 'Here' : where !== null ? 'Move here' : ''}</span>
          </button>
        );
      })}
      <div className="fg-menu-sep" role="separator" />
      {plannedPanels.map(({ label, icon: Icon }) => (
        <button key={label} type="button" role="menuitem" className="fg-menu-item" disabled aria-disabled="true" title={`${label} is planned and not built yet.`}>
          <Icon {...iconProps} />
          <span>{label}</span>
          <span className="fg-menu-hint">Planned</span>
        </button>
      ))}
    </div>
  );
}

export function Workspace(props: WorkspaceProps) {
  const { snapshot, selection, layout, log, agent } = props;
  const scene = snapshot.scene;
  const [playing, setPlaying] = useState(false);
  const [handle, setHandle] = useState<ViewportHandle | null>(null);
  const [closeArmed, setCloseArmed] = useState(false);
  const [focusToken, setFocusToken] = useState(0);
  const [tool, setTool] = useState<ViewportTool>('select');
  const [pendingScene, setPendingScene] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [menuGroup, setMenuGroup] = useState<GroupId | null>(null);
  const [dropGroup, setDropGroup] = useState<GroupId | null>(null);
  const [view_, setView] = useState<'editor' | 'settings'>('editor');
  const areaRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<string | null>(null);
  const primary = scene.entities.find(entity => entity.id === selection.primaryId) ?? null;
  const conflict = snapshot.conflict;
  const invalid = props.banner?.kind === 'invalid';
  const readOnlyReason = playing
    ? 'Stop to edit. Scene edits are disabled during Play.'
    : invalid ? 'Editing is paused until the scene file is valid again.' : null;
  const canEdit = readOnlyReason === null && conflict === null;
  const view: ViewportView = useMemo(() => ({ ...props.viewportContext, scene, selectedIds: selection.entityIds }), [scene, selection.entityIds, props.viewportContext]);
  const counts = countBySeverity(log.entries);
  const reviewPaths = agent?.activeThread?.changedPaths ?? [];
  const canTool = handle?.setTool !== undefined && canEdit;
  const canFrame = handle?.frameSelection !== undefined && selection.entityIds.length > 0;

  useEffect(() => {
    handle?.setTool?.(canEdit ? tool : 'select');
  }, [handle, tool, canEdit]);

  useEffect(() => {
    const guard = (event: BeforeUnloadEvent): void => {
      if (snapshot.dirty || props.saveStatus === 'saving') { event.preventDefault(); event.returnValue = ''; }
    };
    globalThis.addEventListener?.('beforeunload', guard);
    return () => globalThis.removeEventListener?.('beforeunload', guard);
  }, [snapshot.dirty, props.saveStatus]);

  // Keyboard tab moves re-render the strip; focus follows the moved or activated element.
  useEffect(() => {
    const id = pendingFocus.current;
    if (id === null) return;
    pendingFocus.current = null;
    globalThis.document?.getElementById(id)?.focus();
  });

  const setLayout = (next: LayoutState): void => props.onLayoutChange(next);
  const show = (panel: PanelId): void => setLayout(showPanel(layout, panel));

  const execute = (command: SceneCommand): boolean => {
    if (!canEdit) return false;
    return props.onCommand(command);
  };

  const createObject = (): void => {
    const entity = createEntity('New object', primary?.id ?? null);
    if (execute({ type: 'create', entity })) props.onSelect(selectOne(entity.id));
  };

  const deleteObjects = (ids: readonly string[]): void => {
    const top = topmostIds(scene.entities, ids);
    if (top.length === 0) return;
    if (execute({ type: 'batch', commands: top.map(entityId => ({ type: 'delete' as const, entityId })) })) {
      props.onSelect(noSelection);
    }
  };

  const transformObject = (entityId: string, transform: Transform): void => {
    execute({ type: 'transform', entityId, transform });
  };

  const transformObjects = (changes: readonly { entityId: string; transform: Transform }[]): void => {
    if (changes.length === 0) return;
    execute({ type: 'batch', commands: changes.map(({ entityId, transform }) => ({ type: 'transform', entityId, transform })) });
  };

  const openComposer = (): void => {
    show('composer');
    setFocusToken(token => token + 1);
  };

  const addToAgent = (entityId: string, name: string): void => {
    if (!agent) return;
    agent.addChip({ id: `entity:${entityId}`, kind: 'entity', ref: entityId, label: `${name} · ${entityId}` });
    openComposer();
  };

  const play = (): void => {
    if (!handle?.play) return;
    try { handle.play(scene); setPlaying(true); }
    catch (error) { props.onLog({ source: 'editor', severity: 'error', message: `Could not play: ${String(error)}` }); }
  };

  const stop = (): void => {
    try { handle?.stop?.(); }
    catch (error) { props.onLog({ source: 'editor', severity: 'error', message: `Could not stop: ${String(error)}` }); }
    finally { setPlaying(false); }
  };

  const requestClose = (): void => {
    if (props.saveStatus === 'saving') return;
    if (snapshot.dirty && !closeArmed) {
      setCloseArmed(true);
      return;
    }
    props.onClose();
  };

  // A switch with unsaved edits asks first. A conflict or a failed save blocks it.
  const requestScene = (path: string): void => {
    setSwitchError(null);
    if (props.saveStatus === 'saving' || playing) { setSwitchError('Stop Play and wait for saving to finish before switching scenes.'); return; }
    const plan = planSceneSwitch({ current: props.sourcePath, target: path, dirty: snapshot.dirty, conflict: conflict !== null });
    switch (plan.action) {
      case 'none':
        return;
      case 'switch':
        props.onSwitchScene(path);
        return;
      case 'confirm':
        setPendingScene(path);
        return;
      case 'blocked':
        setSwitchError(plan.reason);
        return;
    }
  };

  const saveAndSwitch = async (): Promise<void> => {
    const target = pendingScene;
    if (target === null) return;
    const saved = await props.onSave();
    if (!saved) {
      setSwitchError('Could not save, so the scene was not switched. Your edits are still here.');
      return;
    }
    setPendingScene(null);
    props.onSwitchScene(target);
  };

  const discardAndSwitch = (): void => {
    const target = pendingScene;
    setPendingScene(null);
    if (target !== null) props.onSwitchScene(target);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const mod = event.ctrlKey && !event.altKey && !event.metaKey;
    const key = event.key.toLowerCase();
    if (mod && key === 's') {
      event.preventDefault();
      void props.onSave();
      return;
    }
    if (isEditableTarget(event.target)) return;
    if (mod && key === 'z' && !event.shiftKey) {
      event.preventDefault();
      if (canEdit && snapshot.canUndo) props.onUndo();
    } else if (mod && (key === 'y' || (key === 'z' && event.shiftKey))) {
      event.preventDefault();
      if (canEdit && snapshot.canRedo) props.onRedo();
    } else if (mod && key === 'l' && event.shiftKey) {
      event.preventDefault();
      if (primary) addToAgent(primary.id, primary.name);
    } else if (mod && key === 'l') {
      event.preventDefault();
      openComposer();
    } else if (mod && key === 'i') {
      event.preventDefault();
      show('inspector');
      pendingFocus.current = 'tab-inspector';
    } else if (!event.ctrlKey && !event.altKey && !event.metaKey) {
      const shortcut = toolButtons.find(item => item.key.toLowerCase() === key);
      if (shortcut && !playing) {
        event.preventDefault();
        setTool(shortcut.id);
      } else if (key === 'f' && canFrame) {
        event.preventDefault();
        handle?.frameSelection?.();
      }
    }
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, group: GroupId, panel: PanelId): void => {
    const tabs = layout.groups[group].tabs;
    const index = tabs.indexOf(panel);
    if (event.altKey && !event.ctrlKey && !event.metaKey) {
      const target = neighbourGroup(group, event.key);
      if (target === null) return;
      event.preventDefault();
      pendingFocus.current = `tab-${panel}`;
      setLayout(movePanel(layout, panel, target));
      return;
    }
    let next: PanelId | undefined;
    if (event.key === 'ArrowRight') next = tabs[(index + 1) % tabs.length];
    if (event.key === 'ArrowLeft') next = tabs[(index - 1 + tabs.length) % tabs.length];
    if (event.key === 'Home') next = tabs[0];
    if (event.key === 'End') next = tabs[tabs.length - 1];
    if (event.key === 'Delete') {
      event.preventDefault();
      const after = closePanel(layout, panel);
      const active = after.groups[group].active;
      pendingFocus.current = active === null ? `add-${group}` : `tab-${active}`;
      setLayout(after);
      return;
    }
    if (next === undefined) return;
    event.preventDefault();
    pendingFocus.current = `tab-${next}`;
    setLayout(activatePanel(layout, next));
  };

  // Tabs drop anywhere on a group: the group under the pointer receives it, before the hovered tab.
  const dragTarget = (event: DragEvent<HTMLDivElement>): GroupId | null => {
    if (!event.dataTransfer.types.includes(panelMime)) return null;
    const rect = areaRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return null;
    return groupAt(layout, (event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height);
  };
  const onDragOver = (event: DragEvent<HTMLDivElement>): void => {
    const target = dragTarget(event);
    if (target === null) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    if (target !== dropGroup) setDropGroup(target);
  };
  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    const target = dragTarget(event);
    setDropGroup(null);
    if (target === null) return;
    const panel = event.dataTransfer.getData(panelMime);
    if (!(panelIds as readonly string[]).includes(panel)) return;
    event.preventDefault();
    const before = (event.target as Element).closest?.('[data-panel-tab]')?.getAttribute('data-panel-tab') ?? null;
    setLayout(movePanel(layout, panel as PanelId, target, (panelIds as readonly string[]).includes(before ?? '') ? before as PanelId : null));
  };

  const saveLabel: { label: string; tone: Tone } = props.source === 'sample'
    ? { label: 'In-memory sample. Not saved.', tone: 'neutral' }
    : conflict ? { label: 'Conflict. Resolve to continue.', tone: 'danger' }
    : props.saveStatus === 'saving' ? { label: 'Saving…', tone: 'info' }
    : props.saveStatus === 'failed' ? { label: 'Save failed. See Console.', tone: 'danger' }
    : snapshot.dirty ? { label: 'Unsaved changes', tone: 'warning' }
    : { label: 'Saved', tone: 'success' };

  const selectedName = primary ? primary.name : null;
  const scenePicker = props.scenes.length > 0;
  const activeThread = agent?.activeThread ?? null;
  const agentLabel = agent === null ? 'Agent not connected' : activeThread ? `${agent.activeProvider?.name ?? 'Agent'} · ${threadStatusLabels[threadStatus(activeThread)]}` : agent.activeProvider?.name ?? 'Agent';
  const saveDisabled = props.saveDisabledReason !== null || !snapshot.dirty || props.saveStatus === 'saving';

  const panelContent: Record<PanelId, ReactElement> = {
    viewport: (
      <ViewportSlot
        mount={props.viewport}
        view={view}
        updatesEnabled={!playing}
        visible={isPanelVisible(layout, 'viewport')}
        onPick={entityId => props.onSelect(entityId === null ? noSelection : selectOne(entityId))}
        onFault={message => props.onLog({ source: 'editor', severity: 'error', message })}
        onTransform={transformObject}
        onTransforms={transformObjects}
        onHandle={setHandle}
      >
        <div className="fg-viewport-toolbar fg-float" role="toolbar" aria-label="Viewport tools">
          {toolButtons.map(item => (
            <IconButton
              key={item.id}
              label={item.label}
              aria-pressed={tool === item.id}
              disabled={!canTool}
              title={canTool ? `${item.label} (${item.key})` : 'Gizmos need the viewport runtime, which is not connected in this build.'}
              onClick={() => setTool(item.id)}
            >
              <item.icon {...iconProps} size={16} />
            </IconButton>
          ))}
          <span className="fg-toolbar-sep" aria-hidden="true" />
          <IconButton
            label="Frame"
            disabled={!canFrame}
            title={canFrame ? 'Frame selection (F)' : 'Select an object and connect the viewport runtime to frame it.'}
            onClick={() => handle?.frameSelection?.()}
          >
            <Focus {...iconProps} size={16} />
          </IconButton>
        </div>
        <div className="fg-viewport-banners">
          {props.saveError ? <Banner tone="danger">{props.saveError}</Banner> : null}
          {pendingScene !== null ? (
            <Banner
              tone="warning"
              actions={(
                <>
                  <Button variant="primary" onClick={() => { void saveAndSwitch(); }}>Save and switch</Button>
                  <Button onClick={discardAndSwitch}>Discard and switch</Button>
                  <Button variant="ghost" onClick={() => { setPendingScene(null); setSwitchError(null); }}>Keep editing</Button>
                </>
              )}
            >
              Unsaved changes. Switch to <span className="fg-mono">{pendingScene}</span>?
            </Banner>
          ) : null}
          {switchError !== null ? (
            <Banner tone="danger" actions={<Button variant="ghost" onClick={() => setSwitchError(null)}>Dismiss</Button>}>{switchError}</Banner>
          ) : null}
          {props.notice !== null ? (
            <Banner tone="danger" actions={<Button variant="ghost" onClick={props.onDismissNotice}>Dismiss</Button>}>{props.notice}</Banner>
          ) : null}
          {props.banner?.kind === 'invalid' ? (
            <Banner tone="danger" actions={<Button variant="ghost" onClick={props.onDismissBanner}>Dismiss</Button>}>
              Showing last valid scene. {props.banner.diagnostics[0]
                ? <><span className="fg-mono">{props.banner.diagnostics[0].path}</span>: {props.banner.diagnostics[0].message}</>
                : 'The file is not valid.'}
            </Banner>
          ) : null}
          {props.banner?.kind === 'deleted' ? (
            <Banner tone="danger" actions={<Button variant="ghost" onClick={props.onDismissBanner}>Dismiss</Button>}>
              Scene file was removed on disk. Showing the last valid scene. <span className="fg-mono">{props.banner.path}</span>
            </Banner>
          ) : null}
        </div>
        {playing ? <div className="fg-viewport-badge fg-float" role="status"><Play {...iconProps} />Playing a snapshot. Stop to edit.</div> : null}
        {props.viewport === null ? (
          <div className="fg-viewport-placeholder">
            <Box size={20} strokeWidth={1.75} aria-hidden="true" />
            <h2 className="fg-section-title">Viewport not connected</h2>
          </div>
        ) : null}
        <div className="fg-viewport-readout fg-float">
          {selectedName ? <><span className="fg-readout-dot" aria-hidden="true" />{selectedName}<span className="fg-mono fg-muted">{primary?.id}</span></> : <span className="fg-muted">Nothing selected</span>}
        </div>
      </ViewportSlot>
    ),
    game: (
      <section className="fg-dock-panel fg-game" aria-label="Game">
        <div className="fg-game-card">
          <Gamepad2 size={20} strokeWidth={1.75} aria-hidden="true" />
          <StatusText tone={playing ? 'success' : 'neutral'}>{playing ? 'Playing a snapshot' : 'Not running'}</StatusText>
          <p className="fg-muted" title="A separate device-size game view is not built yet.">Play runs in the Viewport for now.</p>
          <Button variant="primary" disabled={!playing && !handle?.play} onClick={() => { (playing ? stop : play)(); show('viewport'); }}>
            {playing ? <Square {...iconProps} /> : <Play {...iconProps} />}{playing ? 'Stop' : 'Play'}
          </Button>
        </div>
      </section>
    ),
    hierarchy: (
      <Hierarchy
        sceneName={scene.name}
        entities={scene.entities}
        selection={selection}
        locked={!canEdit}
        onSelect={props.onSelect}
        onCreate={createObject}
        onDelete={deleteObjects}
        onRename={(entityId, name) => { execute({ type: 'rename', entityId, name }); }}
        onCommand={execute}
        onNotice={message => props.onLog({ source: 'editor', severity: 'info', message })}
      />
    ),
    inspector: (
      <Inspector
        scene={scene}
        selection={selection}
        sourcePath={props.sourcePath}
        readOnlyReason={readOnlyReason}
        conflict={conflict}
        onCommand={execute}
        onResolveConflict={props.onResolveConflict}
        onAddToAgent={agent ? addToAgent : null}
      />
    ),
    composer: <AgentDock agent={agent} scene={scene} assets={props.assets} projectOpen={props.source === 'project'} focusToken={focusToken} />,
    agents: <AgentsPanel agent={agent} onOpenThread={openComposer} onOpenSettings={() => setView('settings')} />,
    project: <AssetsPanel assets={props.assets} projectOpen={props.source === 'project'} onRefresh={props.onRefreshAssets} onImport={props.onImportAsset} />,
    console: <ConsolePanel log={log} />,
    review: <ReviewPanel threadTitle={activeThread?.title ?? null} changedPaths={reviewPaths} />,
  };

  return (
    <div className="fg-workspace" data-layout="dock" onKeyDown={onKeyDown}>
      <nav className="fg-rail" aria-label="Main">
        <span className="fg-logo" aria-hidden="true"><Diamond size={16} strokeWidth={2} /></span>
        <IconButton className={cx('fg-rail-item', view_ === 'editor' && 'is-active')} label="Editor" aria-current={view_ === 'editor' ? 'page' : undefined} onClick={() => setView('editor')}><LayoutDashboard {...iconProps} size={18} /></IconButton>
        <IconButton className={cx('fg-rail-item', view_ === 'settings' && 'is-active')} label="Settings" aria-current={view_ === 'settings' ? 'page' : undefined} onClick={() => setView(current => (current === 'settings' ? 'editor' : 'settings'))}><SettingsIcon {...iconProps} size={18} /></IconButton>
        <span className="fg-rail-spacer" />
        <IconButton className="fg-rail-item" label="Close project" title="Close project" onClick={requestClose}><LogOut {...iconProps} size={18} /></IconButton>
      </nav>

      <header className="fg-topbar">
        <div className="fg-crumb">
          <span className="fg-crumb-icon" aria-hidden="true"><Box {...iconProps} /></span>
          <span className="fg-topbar-project" title={props.sourcePath ?? props.projectName}>{props.projectName}</span>
          <ChevronRight {...iconProps} className="fg-muted" />
          {scenePicker ? (
            <select
              className="fg-select fg-topbar-select"
              aria-label="Scene"
              title={conflict !== null ? 'Resolve the file conflict before switching scenes.' : 'Switch scene'}
              value={props.sourcePath ?? ''}
              disabled={props.scenes.length < 2}
              onChange={event => requestScene(event.currentTarget.value)}
            >
              {props.scenes.map(item => <option key={item.id} value={item.path}>{item.path}</option>)}
            </select>
          ) : (
            <span className="fg-topbar-scene">{scene.name}</span>
          )}
        </div>
        <span className="fg-topbar-spacer" />
        <div className="fg-pill fg-play-pill" role="group" aria-label="Mode">
          <span className={cx('fg-mode', playing && 'is-playing')}>{playing ? 'Playing' : 'Edit'}</span>
          <button
            type="button"
            className="fg-play"
            aria-pressed={playing}
            disabled={!playing && !handle?.play}
            title={handle?.play ? 'Play a snapshot of the scene' : 'Play needs the viewport runtime, which is not connected in this build.'}
            onClick={playing ? stop : play}
          >
            <span className="fg-play-icon">{playing ? <Square {...iconProps} /> : <Play {...iconProps} />}</span>
            {playing ? 'Stop' : 'Play'}
          </button>
        </div>
        <div className="fg-pill fg-icon-group" role="group" aria-label="History">
          <IconButton label="Undo" disabled={!snapshot.canUndo || !canEdit} title="Undo (Ctrl+Z)" onClick={props.onUndo}><Undo2 {...iconProps} size={16} /></IconButton>
          <IconButton label="Redo" disabled={!snapshot.canRedo || !canEdit} title="Redo (Ctrl+Shift+Z)" onClick={props.onRedo}><Redo2 {...iconProps} size={16} /></IconButton>
          <IconButton label="Save" disabled={saveDisabled} title={props.saveDisabledReason ?? 'Save (Ctrl+S)'} onClick={() => { void props.onSave(); }}><Save {...iconProps} size={16} /></IconButton>
        </div>
        <span className="fg-topbar-spacer" />
        {closeArmed ? (
          <>
            <Button variant="danger" disabled={props.saveStatus === 'saving'} onClick={props.onClose}>Discard changes and close</Button>
            <Button variant="ghost" onClick={() => setCloseArmed(false)}>Keep editing</Button>
          </>
        ) : null}
      </header>

      <div
        ref={areaRef}
        className="fg-dock-area"
        inert={view_ === 'settings'}
        onDragOver={onDragOver}
        onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropGroup(null); }}
        onDrop={onDrop}
      >
        {groupIds.map(group => {
          const { tabs, active } = layout.groups[group];
          return (
            <section key={group} className={cx('fg-group', dropGroup === group && 'is-drop-target')} style={groupBox(layout, group)} aria-label={`${tabs.map(tab => panelMeta[tab].label).join(', ') || 'Empty'} group`}>
              <div className="fg-tabstrip">
                <div role="tablist" aria-label="Panels" className="fg-tabs">
                  {tabs.map(panel => {
                    const { label, icon: Icon } = panelMeta[panel];
                    const selected = panel === active;
                    const badge = panel === 'review' && reviewPaths.length > 0 ? reviewPaths.length : null;
                    return (
                      <div key={panel} className={cx('fg-tab', selected && 'is-selected')} draggable data-panel-tab={panel}
                        onDragStart={event => { event.dataTransfer.setData(panelMime, panel); event.dataTransfer.effectAllowed = 'move'; }}
                        onDragEnd={() => setDropGroup(null)}
                      >
                        <button
                          type="button"
                          role="tab"
                          id={`tab-${panel}`}
                          aria-selected={selected}
                          aria-controls={`panel-${panel}`}
                          tabIndex={selected ? 0 : -1}
                          title={`${label}. Drag to another group, or Alt+Arrow to move.`}
                          className="fg-tab-main"
                          onClick={() => setLayout(activatePanel(layout, panel))}
                          onKeyDown={event => onTabKeyDown(event, group, panel)}
                        >
                          <Icon {...iconProps} />
                          <span>{label}</span>
                          {badge !== null ? <span className="fg-tab-badge" aria-label={`${badge} changed files`}>{badge}</span> : null}
                        </button>
                        <button type="button" className="fg-tab-close" tabIndex={-1} aria-label={`Close ${label}`} title={`Close ${label} (Delete)`} onClick={() => setLayout(closePanel(layout, panel))}>
                          <X size={12} strokeWidth={2} aria-hidden="true" />
                        </button>
                      </div>
                    );
                  })}
                </div>
                <span className="fg-tabstrip-spacer" />
                <IconButton
                  id={`add-${group}`}
                  data-add-panel={group}
                  label="Add panel"
                  aria-haspopup="menu"
                  aria-expanded={menuGroup === group}
                  onClick={() => setMenuGroup(open => (open === group ? null : group))}
                >
                  <Plus {...iconProps} />
                </IconButton>
                {menuGroup === group ? (
                  <AddPanelMenu
                    group={group}
                    layout={layout}
                    onPick={panel => { setMenuGroup(null); pendingFocus.current = `tab-${panel}`; setLayout(movePanel(layout, panel, group)); }}
                    onClose={restore => { setMenuGroup(null); if (restore) pendingFocus.current = `add-${group}`; }}
                  />
                ) : null}
              </div>
              {tabs.length === 0 ? (
                <div className="fg-group-empty"><Plus size={20} strokeWidth={1.75} aria-hidden="true" /><span>Drop a tab here or press + to add a panel</span></div>
              ) : null}
            </section>
          );
        })}

        {/* Panels keep one stable tree position for the life of the workspace; only their box moves. */}
        {panelIds.map(panel => {
          const visible = isPanelVisible(layout, panel);
          return (
            <div
              key={panel}
              role="tabpanel"
              id={`panel-${panel}`}
              aria-labelledby={groupOf(layout, panel) === null ? undefined : `tab-${panel}`}
              className={cx('fg-panel-host', `fg-panel-host-${panel}`, !visible && 'is-hidden')}
              style={panelBox(layout, panel)}
              inert={!visible}
            >
              {panelContent[panel]}
            </div>
          );
        })}

        <SplitHandle split="columns" layout={layout} area={areaRef} onChange={columns => setLayout({ ...layout, columns })} />
        <SplitHandle split="leftRows" layout={layout} area={areaRef} onChange={leftRows => setLayout({ ...layout, leftRows })} />
        <SplitHandle split="rightRows" layout={layout} area={areaRef} onChange={rightRows => setLayout({ ...layout, rightRows })} />
      </div>

      {view_ === 'settings' ? (
        <Settings
          providers={agent ? agent.connection.providers : null}
          onRefreshProviders={agent?.refreshProviders}
          onResetLayout={() => setLayout(defaultLayout)}
        />
      ) : null}

      <footer className="fg-statusbar">
        <StatusText tone={saveLabel.tone}>{saveLabel.label}</StatusText>
        <span className="fg-status-item"><Eye {...iconProps} size={12} />{props.sourcePath ? `Watching ${props.sourcePath}` : 'Not watching a file'}</span>
        {invalid ? <StatusText tone="danger">Showing last valid scene</StatusText> : null}
        <span className={cx('fg-status-item', counts.errors > 0 && 'fg-tone-danger')} title={`${counts.errors} errors`}><CircleAlert {...iconProps} size={12} />{counts.errors}<span className="fg-sr-only"> errors</span></span>
        <span className={cx('fg-status-item', counts.warnings > 0 && 'fg-tone-warning')} title={`${counts.warnings} warnings`}><TriangleAlert {...iconProps} size={12} />{counts.warnings}<span className="fg-sr-only"> warnings</span></span>
        <span className="fg-status-item fg-muted">{selection.entityIds.length} selected</span>
        {activeThread && threadStatus(activeThread) !== 'idle' ? (
          <button type="button" className="fg-status-item fg-status-link" onClick={openComposer}><Bot {...iconProps} size={12} />{agentLabel}</button>
        ) : null}
        <span className="fg-statusbar-spacer" />
        <span className="fg-status-item fg-muted"><ShieldCheck {...iconProps} size={12} />Scripts do not run on open</span>
      </footer>
      <span className="fg-sr-only" aria-live="polite">{activeThread ? `Agent: ${threadStatusLabels[threadStatus(activeThread)]}` : ''}</span>
    </div>
  );
}

import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { SceneCommand } from '@forgon/editor-core';
import { createEntity, type AssetRecord, type Transform } from '@forgon/project-schema';
import type { AgentController } from '../agent/useAgentSessions.js';
import type { EditorSnapshot } from '../hooks/useEditorSnapshot.js';
import { Hierarchy } from '../panels/hierarchy/Hierarchy.js';
import { Inspector } from '../panels/inspector/Inspector.js';
import { countBySeverity, type ConsoleLog, type LogInput } from '../model/consoleLog.js';
import type { FileBanner, SaveStatus } from '../model/fileState.js';
import { layoutLimits, rightDockSharesInspector, keyboardResize, type DockMode, type LayoutState } from '../model/layout.js';
import { noSelection, selectOne, type Selection } from '../model/selection.js';
import { planSceneSwitch } from '../model/sceneSwitch.js';
import { topmostIds } from '../model/tree.js';
import { Banner, Button, Segmented, StatusText, cx, type Tone } from '../primitives/primitives.js';
import type { ViewportHandle, ViewportMount, ViewportTool, ViewportView } from '../services.js';
import { Dock, type DockTab } from './Dock.js';
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

const frameHeight = 36;
const statusHeight = 24;
const defaultWindowWidth = 1440;

const toolButtons: ReadonlyArray<{ id: ViewportTool; label: string; key: string }> = [
  { id: 'select', label: 'Select', key: 'Q' },
  { id: 'translate', label: 'Move', key: 'W' },
  { id: 'rotate', label: 'Rotate', key: 'E' },
  { id: 'scale', label: 'Scale', key: 'R' },
];

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

function useWindowWidth(): number {
  const [width, setWidth] = useState(() => (typeof globalThis.innerWidth === 'number' ? globalThis.innerWidth : defaultWindowWidth));
  useEffect(() => {
    const update = (): void => setWidth(globalThis.innerWidth);
    update();
    globalThis.addEventListener?.('resize', update);
    return () => globalThis.removeEventListener?.('resize', update);
  }, []);
  return width;
}

interface ResizerProps {
  label: string;
  orientation: 'vertical' | 'horizontal';
  value: number;
  limits: readonly [number, number];
  // +1 when growing the panel moves its edge in the positive direction (x or y), -1 when it moves negative.
  direction: 1 | -1;
  style: CSSProperties;
  onChange(value: number): void;
}

function Resizer({ label, orientation, value, limits, direction, style, onChange }: ResizerProps) {
  const [min, max] = limits;
  const drag = useRef<{ origin: number; start: number } | null>(null);
  const clamp = (next: number): number => Math.min(max, Math.max(min, Math.round(next)));
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    drag.current = { origin: orientation === 'vertical' ? event.clientX : event.clientY, start: value };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const current = drag.current;
    if (!current) return;
    const position = orientation === 'vertical' ? event.clientX : event.clientY;
    onChange(clamp(current.start + (position - current.origin) * direction));
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const horizontalKeys = ['ArrowLeft', 'ArrowRight'];
    const verticalKeys = ['ArrowUp', 'ArrowDown'];
    const owned = orientation === 'vertical' ? horizontalKeys : verticalKeys;
    if (!owned.includes(event.key) && event.key !== 'Home' && event.key !== 'End') return;
    const next = keyboardResize(value, event.key, event, direction, limits);
    if (next === null) return;
    event.preventDefault();
    onChange(next);
  };
  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      tabIndex={0}
      className={cx('fg-resizer', `fg-resizer-${orientation}`)}
      style={style}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
    />
  );
}

export function Workspace(props: WorkspaceProps) {
  const { snapshot, selection, layout, log, agent } = props;
  const scene = snapshot.scene;
  const [tab, setTab] = useState<DockTab>('agent');
  const [providersOpen, setProvidersOpen] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [handle, setHandle] = useState<ViewportHandle | null>(null);
  const [closeArmed, setCloseArmed] = useState(false);
  const [focusToken, setFocusToken] = useState(0);
  const [tool, setTool] = useState<ViewportTool>('select');
  const [pendingScene, setPendingScene] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [rightTab, setRightTab] = useState<'inspector' | 'dock'>('inspector');
  const windowWidth = useWindowWidth();
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
  const sharedRight = layout.dockMode === 'right' && rightDockSharesInspector(windowWidth);
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

  const addToAgent = (entityId: string, name: string): void => {
    if (!agent) return;
    agent.addChip({ id: `entity:${entityId}`, kind: 'entity', ref: entityId, label: `${name} · ${entityId}` });
    setTab('agent');
    setFocusToken(token => token + 1);
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

  const setLayout = (patch: Partial<LayoutState>): void => props.onLayoutChange({ ...layout, ...patch });
  const setMode = (dockMode: DockMode): void => setLayout({ dockMode });

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
      setTab('agent');
      setFocusToken(token => token + 1);
    } else if (mod && event.key === '\\') {
      event.preventDefault();
      setLayout({ hierarchyCollapsed: !layout.hierarchyCollapsed });
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

  const cssVars = {
    '--hier-col': layout.hierarchyCollapsed ? '0px' : `${layout.hierarchyWidth}px`,
    '--insp-col': `${layout.inspectorWidth}px`,
    '--dock-row': layout.dockMode === 'bottom' ? `${layout.dockHeight}px` : '0px',
    '--dock-col': layout.dockMode === 'right' && !sharedRight ? `${layout.dockWidth}px` : '0px',
  } as CSSProperties;
  const bottomReserve = statusHeight + (layout.dockMode === 'bottom' ? layout.dockHeight : 0);
  const rightReserve = layout.dockMode === 'right' && !sharedRight ? layout.dockWidth : 0;

  const saveLabel: { label: string; tone: Tone } = props.source === 'sample'
    ? { label: 'In-memory sample. Not saved.', tone: 'neutral' }
    : conflict ? { label: 'Conflict. Resolve to continue.', tone: 'danger' }
    : props.saveStatus === 'saving' ? { label: 'Saving…', tone: 'info' }
    : props.saveStatus === 'failed' ? { label: 'Save failed. See Console.', tone: 'danger' }
    : snapshot.dirty ? { label: 'Unsaved changes', tone: 'warning' }
    : { label: 'Saved', tone: 'success' };

  const selectedName = primary ? primary.name : null;
  const scenePicker = props.scenes.length > 0;

  const dock = (
    <Dock
      tab={tab}
      onTab={setTab}
      mode={layout.dockMode}
      onMode={setMode}
      agent={agent}
      scene={scene}
      assets={props.assets}
      onRefreshAssets={props.onRefreshAssets}
      onImportAsset={props.onImportAsset}
      projectOpen={props.source === 'project'}
      providersOpen={providersOpen}
      onCloseProviders={() => setProvidersOpen(false)}
      focusToken={focusToken}
      log={log}
      reviewPaths={reviewPaths}
      shared={sharedRight}
    />
  );

  return (
    <div
      className="fg-workspace"
      data-dock={layout.dockMode}
      data-dock-shared={sharedRight ? 'true' : 'false'}
      style={cssVars}
      onKeyDown={onKeyDown}
    >
      <header className="fg-topbar" style={{ gridArea: '1 / 1 / 2 / 5' }}>
        <span className="fg-wordmark">Forgon</span>
        <span className="fg-topbar-project" title={props.sourcePath ?? props.projectName}>{props.projectName}</span>
        <span className="fg-topbar-sep" aria-hidden="true" />
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
        <div className="fg-topbar-group" role="group" aria-label="Mode">
          <Button variant={playing ? 'ghost' : 'default'} aria-pressed={!playing} onClick={stop} disabled={!playing}>Edit</Button>
          <Button
            variant={playing ? 'primary' : 'default'}
            aria-pressed={playing}
            disabled={!playing && !handle?.play}
            title={handle?.play ? 'Play a snapshot of the scene' : 'Play needs the viewport runtime, which is not connected in this build.'}
            onClick={playing ? stop : play}
          >
            {playing ? 'Stop' : 'Play'}
          </Button>
        </div>
        <Button
          variant="ghost"
          aria-pressed={!layout.hierarchyCollapsed}
          onClick={() => setLayout({ hierarchyCollapsed: !layout.hierarchyCollapsed })}
          title="Toggle hierarchy (Ctrl+\\)"
        >
          Hierarchy
        </Button>
        <Button
          variant="default"
          disabled={props.saveDisabledReason !== null || !snapshot.dirty || props.saveStatus === 'saving'}
          title={props.saveDisabledReason ?? 'Save (Ctrl+S)'}
          onClick={() => { void props.onSave(); }}
        >
          Save
        </Button>
        <Button disabled={!snapshot.canUndo || !canEdit} title="Undo (Ctrl+Z)" onClick={props.onUndo}>Undo</Button>
        <Button disabled={!snapshot.canRedo || !canEdit} title="Redo (Ctrl+Shift+Z)" onClick={props.onRedo}>Redo</Button>
        <span className="fg-topbar-spacer" />
        <Button
          variant="ghost"
          aria-expanded={providersOpen}
          aria-controls="dock-panel"
          disabled={!agent}
          title={agent ? 'Agent providers' : 'The agent service is not connected in this build.'}
          onClick={() => { setProvidersOpen(open => !open); setTab('agent'); }}
        >
          {agent?.activeThread ? `Agent · ${agent.activeProvider?.name ?? 'provider'}` : 'Agent · not connected'}
        </Button>
        {closeArmed ? (
          <>
            <Button variant="danger" disabled={props.saveStatus === 'saving'} onClick={props.onClose}>Discard changes and close</Button>
            <Button variant="ghost" onClick={() => setCloseArmed(false)}>Keep editing</Button>
          </>
        ) : (
          <Button variant="ghost" onClick={requestClose}>Close project</Button>
        )}
      </header>

      <div className="fg-hierarchy-area" style={{ gridArea: '2 / 1 / 3 / 2' }} inert={layout.hierarchyCollapsed}>
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
      </div>

      <div className="fg-view-area" style={{ gridArea: '2 / 2 / 3 / 3' }}>
        <ViewportSlot
          mount={props.viewport}
          view={view}
          updatesEnabled={!playing}
          visible={layout.dockMode !== 'fullscreen'}
          onPick={entityId => props.onSelect(entityId === null ? noSelection : selectOne(entityId))}
          onFault={message => props.onLog({ source: 'editor', severity: 'error', message })}
          onTransform={transformObject}
          onTransforms={transformObjects}
          onHandle={setHandle}
        >
          <div className="fg-viewport-toolbar" role="toolbar" aria-label="Viewport tools">
            {toolButtons.map(item => (
              <Button
                key={item.id}
                variant="ghost"
                aria-pressed={tool === item.id}
                disabled={!canTool}
                title={canTool ? `${item.label} (${item.key})` : 'Gizmos need the viewport runtime, which is not connected in this build.'}
                onClick={() => setTool(item.id)}
              >
                {item.label}
              </Button>
            ))}
            <span className="fg-toolbar-sep" aria-hidden="true" />
            <Button
              variant="ghost"
              disabled={!canFrame}
              title={canFrame ? 'Frame selection (F)' : 'Select an object and connect the viewport runtime to frame it.'}
              onClick={() => handle?.frameSelection?.()}
            >
              Frame
            </Button>
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
              <Banner
                tone="danger"
                actions={<Button variant="ghost" onClick={props.onDismissBanner}>Dismiss</Button>}
              >
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
          {playing ? <div className="fg-viewport-badge" role="status">Playing a snapshot. Stop to edit.</div> : null}
          {props.viewport === null ? (
            <div className="fg-viewport-placeholder">
              <h2 className="fg-section-title">Viewport not connected</h2>
              <p className="fg-muted">The scene is loaded with {scene.entities.length} {scene.entities.length === 1 ? 'object' : 'objects'}. The viewport runtime is not connected in this build.</p>
            </div>
          ) : null}
          <div className="fg-viewport-readout">{selectedName ? `Selected: ${selectedName} · ${primary?.id}` : 'Nothing selected'}</div>
        </ViewportSlot>
      </div>

      <div className="fg-inspector-area" style={{ gridArea: '2 / 3 / 3 / 4' }}>
        {sharedRight ? (
          <div className="fg-shared-tabs">
            <Segmented<'inspector' | 'dock'>
              label="Right column"
              options={[{ value: 'inspector', label: 'Inspector' }, { value: 'dock', label: 'Panels' }]}
              value={rightTab}
              onChange={setRightTab}
            />
          </div>
        ) : null}
        {sharedRight && rightTab === 'dock' ? dock : (
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
        )}
      </div>

      {sharedRight ? null : dock}

      <footer className="fg-statusbar" style={{ gridArea: '4 / 1 / 5 / 5' }}>
        <StatusText tone={saveLabel.tone}>{saveLabel.label}</StatusText>
        <span className="fg-muted">{props.sourcePath ? `Watching ${props.sourcePath}` : 'Not watching a file'}</span>
        {invalid ? <StatusText tone="danger">Showing last valid scene</StatusText> : null}
        <span>{counts.errors} errors · {counts.warnings} warnings</span>
        <span className="fg-muted">{selection.entityIds.length} selected</span>
        <span className="fg-statusbar-spacer" />
        <span className="fg-muted">Scripts do not run on open</span>
      </footer>

      {layout.hierarchyCollapsed ? null : (
        <Resizer
          label="Resize hierarchy"
          orientation="vertical"
          value={layout.hierarchyWidth}
          limits={layoutLimits.hierarchyWidth}
          direction={1}
          style={{ left: layout.hierarchyWidth - 3, top: frameHeight, bottom: bottomReserve, width: 6 }}
          onChange={hierarchyWidth => setLayout({ hierarchyWidth })}
        />
      )}
      <Resizer
        label="Resize inspector"
        orientation="vertical"
        value={layout.inspectorWidth}
        limits={layoutLimits.inspectorWidth}
        direction={-1}
        style={{ right: rightReserve + layout.inspectorWidth - 3, top: frameHeight, bottom: bottomReserve, width: 6 }}
        onChange={inspectorWidth => setLayout({ inspectorWidth })}
      />
      {layout.dockMode === 'bottom' ? (
        <Resizer
          label="Resize dock height"
          orientation="horizontal"
          value={layout.dockHeight}
          limits={layoutLimits.dockHeight}
          direction={-1}
          style={{ left: 0, right: 0, bottom: statusHeight + layout.dockHeight - 3, height: 6 }}
          onChange={dockHeight => setLayout({ dockHeight })}
        />
      ) : null}
      {layout.dockMode === 'right' && !sharedRight ? (
        <Resizer
          label="Resize dock width"
          orientation="vertical"
          value={layout.dockWidth}
          limits={layoutLimits.dockWidth}
          direction={-1}
          style={{ right: layout.dockWidth - 3, top: frameHeight, bottom: statusHeight, width: 6 }}
          onChange={dockWidth => setLayout({ dockWidth })}
        />
      ) : null}
    </div>
  );
}

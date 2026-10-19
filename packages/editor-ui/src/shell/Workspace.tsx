import { useEffect, useMemo, useRef, useState, type ReactElement, type KeyboardEvent } from 'react';
import {
  Activity, Bot, Box, ChevronRight, CircleAlert, Eye, FolderOpen, FolderX,
  GitCompareArrows, LayoutDashboard, Network, Play, Redo2, Save, Settings as SettingsIcon,
  MessageSquare, ShieldCheck, SlidersHorizontal, Square, Terminal, TriangleAlert, Undo2, X, type LucideIcon,
} from 'lucide-react';
import { duplicatePlan, type SceneCommand } from '@forgon/editor-core';
import { createEntity, type AssetRecord, type Entity, type ScriptCatalog, type Transform } from '@forgon/project-schema';
import { AgentDock } from '../agent/AgentDock.js';
import { ForgonMark } from '../brand/ForgonMark.js';
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
import { defaultLayout, defaultSnap, toggleCard, type CardId, type LayoutState } from '../model/layout.js';
import { noSelection, selectOne, type Selection } from '../model/selection.js';
import { planSceneSwitch } from '../model/sceneSwitch.js';
import { topmostIds } from '../model/tree.js';
import { placementCommand, type PlacementTarget } from '../model/placement.js';
import { Banner, Button, IconButton, StatusText, cx, type Tone } from '../primitives/primitives.js';
import type { SurfacePoint, ViewportHandle, ViewportMount, ViewportTool, ViewportView } from '../services.js';
import { Settings } from './Settings.js';
import { ConflictCard } from '../conflict/ConflictCard.js';
import { toolButtons, ViewportTools } from './ViewportTools.js';
import { ViewportSlot } from './ViewportSlot.js';

export interface SceneEntry {
  id: string;
  path: string;
}

export interface WorkspaceProps {
  scripts?: ScriptCatalog['scripts'];
  onRefreshScripts?: (() => Promise<void>) | undefined;
  preparePlay?: ((signal: AbortSignal) => Promise<ScriptCatalog>) | undefined;
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
  onClearLog?: (() => void) | undefined;
  agent: AgentController | null;
  viewport: ViewportMount | null;
  layout: LayoutState;
  onLayoutChange(layout: LayoutState): void;
  onClose(): void;
}

const iconProps = { size: 14, strokeWidth: 1.75, 'aria-hidden': true } as const;
const secondaryCards: ReadonlyArray<{ id: CardId; label: string; icon: LucideIcon }> = [
  { id: 'project', label: 'Assets', icon: FolderOpen },
  { id: 'console', label: 'Console', icon: Terminal },
  { id: 'review', label: 'Review', icon: GitCompareArrows },
  { id: 'agents', label: 'Agents', icon: Bot },
  { id: 'stats', label: 'Stats', icon: Activity },
  { id: 'composer', label: 'Chat', icon: MessageSquare },
];

function isEditableTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

export function Workspace(props: WorkspaceProps) {
  const { snapshot, selection, layout, log, agent } = props;
  const scene = snapshot.scene;
  const snap = layout.snap ?? defaultSnap;
  const [playing, setPlaying] = useState(false);
  const [preparingPlay, setPreparingPlay] = useState(false);
  const playGeneration = useRef(0);
  const playPreparation = useRef<AbortController | null>(null);
  useEffect(() => () => { playGeneration.current++; playPreparation.current?.abort(); }, []);
  const [handle, setHandle] = useState<ViewportHandle | null>(null);
  const [closeArmed, setCloseArmed] = useState(false);
  const [focusToken, setFocusToken] = useState(0);
  const [tool, setTool] = useState<ViewportTool>('select');
  const [pendingScene, setPendingScene] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [space, setSpace] = useState<'local' | 'world'>('world');
  const [view_, setView] = useState<'editor' | 'settings'>('editor');
  const pendingFocus = useRef<string | null>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const objectClipboard = useRef<{ entities: Entity[]; ids: readonly string[] } | null>(null);
  const primary = scene.entities.find(entity => entity.id === selection.primaryId) ?? null;
  const conflict = snapshot.conflict;
  const invalid = props.banner?.kind === 'invalid';
  const readOnlyReason = preparingPlay ? 'Preparing scripts for Play…' : playing
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
  }, [handle, canEdit]);

  useEffect(() => {
    handle?.setProgressiveDesign?.(agent?.progressivePromptId ?? null,
      !!agent?.progressiveDesign && !!agent?.progressiveBuilding && !playing && !preparingPlay && view_ === 'editor');
  }, [handle, agent?.progressivePromptId, agent?.progressiveDesign, agent?.progressiveBuilding, playing, preparingPlay, view_]);

  useEffect(() => { handle?.setSpace?.(space); }, [handle]);
  useEffect(() => { handle?.setSnap?.(snap); }, [handle, snap]);
  const addChip = agent?.addChip;
  const removeChip = agent?.removeChip;
  const selectionChip = useRef<string | null>(null);
  useEffect(() => {
    if (selectionChip.current) removeChip?.(selectionChip.current);
    selectionChip.current = primary && addChip ? `selection:${primary.id}` : null;
    if (primary && addChip) addChip({ id: `selection:${primary.id}`, kind: 'entity', ref: primary.id, label: primary.name });
  }, [primary?.id, addChip, removeChip]);
  const running = !!agent?.activeThread && (agent.activeThread.starting || agent.activeThread.activeRunId !== null);
  const wasRunning = useRef(false);
  useEffect(() => {
    if (running && !wasRunning.current) props.onLayoutChange({ ...layout, expandedCard: 'composer' });
    wasRunning.current = running;
  }, [running]);

  useEffect(() => {
    const guard = (event: BeforeUnloadEvent): void => {
      if (snapshot.dirty || props.saveStatus === 'saving') { event.preventDefault(); event.returnValue = ''; }
    };
    globalThis.addEventListener?.('beforeunload', guard);
    return () => globalThis.removeEventListener?.('beforeunload', guard);
  }, [snapshot.dirty, props.saveStatus]);

  // Closing a card returns keyboard focus to its command or visibility toggle.
  useEffect(() => {
    const id = pendingFocus.current;
    if (id === null) return;
    pendingFocus.current = null;
    globalThis.document?.getElementById(id)?.focus();
  });

  const setLayout = (next: LayoutState): void => props.onLayoutChange(next);
  const show = (card: CardId): void => setLayout({ ...layout, expandedCard: card });
  const collapse = (): void => {
    pendingFocus.current = `command-${layout.expandedCard ?? 'composer'}`;
    setLayout({ ...layout, expandedCard: null });
  };

  const execute = (command: SceneCommand): boolean => {
    if (!canEdit) return false;
    return props.onCommand(command);
  };

  const createObject = (): void => {
    const entity = createEntity('New object', primary?.id ?? null);
    if (execute({ type: 'create', entity })) props.onSelect(selectOne(entity.id));
  };

  const deleteObjects = (ids: readonly string[]): boolean => {
    const top = topmostIds(scene.entities, ids);
    if (top.length === 0) return false;
    if (execute({ type: 'batch', commands: top.map(entityId => ({ type: 'delete' as const, entityId })) })) {
      props.onSelect(noSelection);
      return true;
    }
    return false;
  };

  const duplicateObjects = (ids: readonly string[]): void => {
    if (!canEdit) return;
    const plan = duplicatePlan(scene.entities, ids, undefined, snap.translate);
    if (!plan.ok) { props.onLog({ source: 'editor', severity: 'info', message: plan.reason }); return; }
    if (execute({ type: 'batch', commands: plan.value.commands })) {
      props.onSelect({ entityIds: plan.value.topLevelIds, primaryId: plan.value.topLevelIds[0] ?? null });
    }
  };

  const placeObject = (target: PlacementTarget, surface: SurfacePoint): void => {
    if (!canEdit) return;
    try {
      const placement = placementCommand(target, surface, props.viewportContext?.prefabs ?? [], layout.alignToSurface ?? false);
      if (execute(placement.command)) props.onSelect(selectOne(placement.selectedId));
    } catch (error) { props.onLog({ source: 'editor', severity: 'error', message: `Could not place object: ${String(error)}` }); }
  };

  const addAtCentre = (target: PlacementTarget): void => {
    if (!canEdit || !handle?.surfaceAt) return;
    const rect = workspaceRef.current?.querySelector('[data-slot="scene-viewport"]')?.getBoundingClientRect();
    if (!rect) return;
    try {
      const point = handle.surfaceAt(rect.left + rect.width / 2, rect.top + rect.height / 2);
      if (point) placeObject(target, point);
      else props.onLog({ source: 'editor', severity: 'info', message: 'No surface at the viewport centre. Aim the camera at the scene or ground plane and try again.' });
    } catch (error) { props.onLog({ source: 'editor', severity: 'error', message: `Could not find a placement surface: ${String(error)}` }); }
  };

  const transformObject = (entityId: string, transform: Transform): void => {
    execute({ type: 'transform', entityId, transform });
  };

  const transformObjects = (changes: readonly { entityId: string; transform: Transform }[]): void => {
    if (changes.length === 0) return;
    execute({ type: 'batch', commands: changes.map(({ entityId, transform }) => ({ type: 'transform', entityId, transform })) });
  };

  const openComposer = (): void => {
    setView('editor');
    show('composer');
    setFocusToken(token => token + 1);
  };

  const addToAgent = (entityId: string, name: string): void => {
    if (!agent) return;
    agent.addChip({ id: `entity:${entityId}`, kind: 'entity', ref: entityId, label: `${name} · ${entityId}` });
    openComposer();
  };

  const play = async (): Promise<void> => {
    if (!handle?.play || preparingPlay || playing) return;
    const generation = ++playGeneration.current;
    const preparation = new AbortController(); playPreparation.current = preparation;
    setPreparingPlay(true);
    try {
      const scripts = await props.preparePlay?.(preparation.signal);
      if (generation !== playGeneration.current) return;
      if (scripts && handle.playCompiled) await handle.playCompiled(scene, scripts, preparation.signal);
      else if (scripts?.scripts.length) throw new Error('This viewport does not support isolated script Play.');
      else handle.play(scene);
      if (generation !== playGeneration.current) return;
      setPlaying(true);
    } catch (error) {
      if (generation === playGeneration.current) {
        props.onLog({ source: 'editor', severity: 'error', message: `Could not play: ${String(error)}` });
        show('console');
      }
    } finally { if (generation === playGeneration.current) { setPreparingPlay(false); playPreparation.current = null; } }
  };

  const stop = (): void => {
    playGeneration.current++; setPreparingPlay(false);
    playPreparation.current?.abort(); playPreparation.current = null;
    try { handle?.stop?.(); }
    catch (error) { props.onLog({ source: 'editor', severity: 'error', message: `Could not stop: ${String(error)}` }); }
    finally { setPlaying(false); }
  };

  const requestClose = (): void => {
    if (props.saveStatus === 'saving') return;
    if (snapshot.dirty) {
      setCloseArmed(true);
      return;
    }
    props.onClose();
  };

  // A switch with unsaved edits asks first. A conflict or a failed save blocks it.
  const requestScene = (path: string): void => {
    setSwitchError(null);
    if (props.saveStatus === 'saving' || playing || preparingPlay) { setSwitchError('Stop Play and wait for saving to finish before switching scenes.'); return; }
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
    if (event.defaultPrevented) return;
    const mod = event.ctrlKey && !event.altKey && !event.metaKey;
    const key = event.key.toLowerCase();
    if (mod && key === 's') {
      event.preventDefault();
      void props.onSave();
      return;
    }
    if (event.key === 'Escape' && layout.expandedCard !== null) { event.preventDefault(); collapse(); return; }
    if (mod && ((key === 'k') || (key === 'l' && !event.shiftKey))) { event.preventDefault(); openComposer(); return; }
    if (mod && (key === '1' || key === '2')) {
      event.preventDefault();
      const panel = key === '1' ? 'hierarchy' : 'inspector';
      pendingFocus.current = layout[panel] ? `toggle-${panel}` : `panel-${panel}`;
      setLayout({ ...layout, [panel]: !layout[panel] }); return;
    }
    if (mod && key === '`') { event.preventDefault(); setLayout(toggleCard(layout, 'console')); return; }
    if (mod && key === '.' && agent) { event.preventDefault(); agent.cancel(); return; }
    if (mod && event.shiftKey && key === 'r') { event.preventDefault(); show('review'); return; }
    if (key === 'f5' || (mod && key === 'p' && !event.shiftKey)) { event.preventDefault(); (playing || preparingPlay ? stop : play)(); return; }
    if (isEditableTarget(event.target)) return;
    if (view_ !== 'editor') return;
    if (!event.ctrlKey && !event.altKey && !event.metaKey && (key === 'delete' || key === 'backspace')) {
      event.preventDefault(); deleteObjects(selection.entityIds); return;
    }
    if (mod && key === 'a' && !event.shiftKey) {
      event.preventDefault();
      props.onSelect({ entityIds: scene.entities.map(entity => entity.id), primaryId: selection.primaryId ?? scene.entities[0]?.id ?? null });
      return;
    }
    if (mod && !event.shiftKey && (key === 'c' || key === 'x')) {
      if (!selection.entityIds.length || (key === 'x' && !canEdit)) return;
      event.preventDefault();
      const plan = duplicatePlan(scene.entities, selection.entityIds, undefined, 0);
      if (!plan.ok) { props.onLog({ source: 'editor', severity: 'info', message: plan.reason }); return; }
      const copied = { entities: structuredClone(scene.entities), ids: [...selection.entityIds] };
      if (key === 'c' || deleteObjects(selection.entityIds)) objectClipboard.current = copied;
      return;
    }
    if (mod && key === 'v' && !event.shiftKey && objectClipboard.current) {
      event.preventDefault();
      if (!canEdit) return;
      const copied = objectClipboard.current;
      const plan = duplicatePlan(copied.entities, copied.ids, undefined, 0);
      if (!plan.ok) { props.onLog({ source: 'editor', severity: 'info', message: plan.reason }); return; }
      for (const command of plan.value.commands) {
        if (command.type === 'create' && plan.value.topLevelIds.includes(command.entity.id) && !scene.entities.some(entity => entity.id === command.entity.parentId)) command.entity.parentId = null;
      }
      if (execute({ type: 'batch', commands: plan.value.commands })) props.onSelect({ entityIds: plan.value.topLevelIds, primaryId: plan.value.topLevelIds[0] ?? null });
      return;
    }
    if (mod && event.shiftKey && key === 'n') { event.preventDefault(); if (canEdit) createObject(); return; }
    if (key === 'f2' && !event.ctrlKey && !event.altKey && !event.metaKey && primary && canEdit) {
      event.preventDefault(); setLayout({ ...layout, inspector: true }); pendingFocus.current = 'inspector-name'; return;
    }
    if (key === 'escape') { event.preventDefault(); props.onSelect(noSelection); return; }
    if (key === 'x' && !event.ctrlKey && !event.altKey && !event.metaKey && canEdit && handle?.setSpace) {
      event.preventDefault(); const next = space === 'world' ? 'local' : 'world'; handle.setSpace(next); setSpace(next); return;
    }
    if (key === '/' && !event.ctrlKey && !event.altKey && !event.metaKey) { event.preventDefault(); openComposer(); return; }
    if (mod && key === 'd' && !event.shiftKey) {
      event.preventDefault();
      duplicateObjects(selection.entityIds);
    } else if (mod && key === 'z' && !event.shiftKey) {
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
      setLayout({ ...layout, inspector: true });
      pendingFocus.current = 'panel-inspector';
    } else if (!event.ctrlKey && !event.altKey && !event.metaKey) {
      const shortcut = toolButtons.find(item => item.key.toLowerCase() === key);
      if (shortcut && !playing) {
        event.preventDefault();
        if (canTool) { handle?.setTool?.(shortcut.id); setTool(shortcut.id); }
      } else if (key === 'f' && canFrame) {
        event.preventDefault();
        handle?.frameSelection?.();
      }
    }
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

  const panelContent: Record<string, ReactElement> = {
    viewport: (
      <ViewportSlot
        mount={props.viewport}
        view={view}
        updatesEnabled={!playing}
        visible={true}
        onPick={entityId => props.onSelect(entityId === null ? noSelection : selectOne(entityId))}
        onFault={message => props.onLog({ source: 'editor', severity: 'error', message })}
        onTransform={transformObject}
        onTransforms={transformObjects}
        onHandle={setHandle}
        placementEnabled={canEdit && !!handle?.surfaceAt}
        onPlace={placeObject}
      >
        <ViewportTools tool={tool} space={space} snap={snap} onSnap={next => setLayout({ ...layout, snap: next })}
          alignToSurface={layout.alignToSurface ?? false} onAlignToSurface={enabled => setLayout({ ...layout, alignToSurface: enabled })}
          handle={handle} canEdit={canEdit} canFrame={canFrame} onTool={setTool} onSpace={setSpace} />
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
    hierarchy: (
      <Hierarchy
        sceneName={scene.name}
        entities={scene.entities}
        selection={selection}
        locked={!canEdit}
        onSelect={props.onSelect}
        onCreate={createObject}
        onDelete={deleteObjects}
        duplicateOffset={snap.translate}
        onRename={(entityId, name) => { execute({ type: 'rename', entityId, name }); }}
        onCommand={execute}
        onNotice={message => props.onLog({ source: 'editor', severity: 'info', message })}
      />
    ),
    inspector: (
      <Inspector
        scripts={props.scripts}
        onRefreshScripts={props.onRefreshScripts}
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
    agents: <AgentsPanel agent={agent} onOpenThread={openComposer} onOpenSettings={() => setView('settings')} />,
    project: <AssetsPanel assets={props.assets} prefabs={props.viewportContext?.prefabs ?? []} projectOpen={props.source === 'project'}
      canPlace={canEdit && !!handle?.surfaceAt} onAddToScene={addAtCentre} onRefresh={props.onRefreshAssets} onImport={props.onImportAsset} />,
    console: <ConsolePanel log={log} onClear={props.onClearLog} />,
    review: <ReviewPanel threadTitle={activeThread?.title ?? null} changedPaths={reviewPaths} />,
    stats: <dl className="fg-stats"><div><dt>Entities</dt><dd>{scene.entities.length}</dd></div><div><dt>Selected</dt><dd>{selection.entityIds.length}</dd></div><div><dt>Diagnostics</dt><dd>{counts.errors + counts.warnings}</dd></div></dl>,
  };

  return (
    <div ref={workspaceRef} className="fg-workspace" data-layout="floating" onKeyDown={onKeyDown}>
      <nav className="fg-rail" aria-label="Main">
        <IconButton className="fg-rail-item fg-rail-home" label="Back to projects" title="Forgon Engine — Back to projects" disabled={props.saveStatus === 'saving'} onClick={requestClose}><ForgonMark alt="" /></IconButton>
        <IconButton className={cx('fg-rail-item', view_ === 'editor' && 'is-active')} label="Editor" aria-current={view_ === 'editor' ? 'page' : undefined} onClick={() => setView('editor')}><LayoutDashboard {...iconProps} size={18} /></IconButton>
        <IconButton className={cx('fg-rail-item', view_ === 'settings' && 'is-active')} label="Settings" aria-current={view_ === 'settings' ? 'page' : undefined} onClick={() => setView(current => (current === 'settings' ? 'editor' : 'settings'))}><SettingsIcon {...iconProps} size={18} /></IconButton>
        <span className="fg-rail-spacer" />
        <IconButton className="fg-rail-item" label="Close project" title="Close project" disabled={props.saveStatus === 'saving'} onClick={requestClose}><FolderX {...iconProps} size={18} /></IconButton>
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
        <div className="fg-topbar-controls">
        <IconButton id="toggle-hierarchy" label="Toggle Hierarchy" title="Hierarchy (Ctrl+1)" aria-pressed={layout.hierarchy} onClick={() => setLayout({ ...layout, hierarchy: !layout.hierarchy })}><Network {...iconProps} /></IconButton>
        <IconButton id="toggle-inspector" label="Toggle Inspector" title="Inspector (Ctrl+2)" aria-pressed={layout.inspector} onClick={() => setLayout({ ...layout, inspector: !layout.inspector })}><SlidersHorizontal {...iconProps} /></IconButton>
        <div className="fg-pill fg-play-pill" role="group" aria-label="Mode">
          <span className={cx('fg-mode', playing && 'is-playing')}>{preparingPlay ? 'Preparing' : playing ? 'Playing' : 'Edit'}</span>
          <button
            type="button"
            className="fg-play"
            aria-pressed={playing}
            disabled={!preparingPlay && !playing && !handle?.play}
            title={handle?.play ? 'Play a snapshot of the scene (F5)' : 'Play needs the viewport runtime, which is not connected in this build.'}
            onClick={playing || preparingPlay ? stop : play}
          >
            <span className="fg-play-icon">{playing || preparingPlay ? <Square {...iconProps} /> : <Play {...iconProps} />}</span>
            {playing || preparingPlay ? 'Stop' : 'Play'}
          </button>
        </div>
        <div className="fg-pill fg-icon-group" role="group" aria-label="History">
          <IconButton label="Undo" disabled={!snapshot.canUndo || !canEdit} title="Undo (Ctrl+Z)" onClick={props.onUndo}><Undo2 {...iconProps} size={16} /></IconButton>
          <IconButton label="Redo" disabled={!snapshot.canRedo || !canEdit} title="Redo (Ctrl+Shift+Z)" onClick={props.onRedo}><Redo2 {...iconProps} size={16} /></IconButton>
          <IconButton label="Save" disabled={saveDisabled} title={props.saveDisabledReason ?? 'Save (Ctrl+S)'} onClick={() => { void props.onSave(); }}><Save {...iconProps} size={16} /></IconButton>
        </div>
        </div>
        <div className="fg-topbar-actions">
        {closeArmed ? (
          <>
            <Button variant="danger" disabled={props.saveStatus === 'saving'} onClick={props.onClose}>Discard changes and close</Button>
            <Button variant="ghost" onClick={() => setCloseArmed(false)}>Keep editing</Button>
          </>
        ) : null}
        </div>
      </header>

      <main className="fg-floating-stage" inert={view_ === 'settings'} aria-label="Scene workspace">
        {panelContent['viewport']}
        {(['hierarchy', 'inspector'] as const).map(panel => (
          <section key={panel} id={`panel-${panel}`} tabIndex={-1} aria-label={`${panel === 'hierarchy' ? 'Hierarchy' : 'Inspector'} card`}
            className={`fg-floating-card fg-floating-${panel}`} hidden={!layout[panel]} inert={!layout[panel]}>
            <IconButton className="fg-card-close" label={`Hide ${panel === 'hierarchy' ? 'Hierarchy' : 'Inspector'}`}
              title={`Hide ${panel} (Ctrl+${panel === 'hierarchy' ? '1' : '2'})`}
              onClick={() => { pendingFocus.current = `toggle-${panel}`; setLayout({ ...layout, [panel]: false }); }}><X {...iconProps} /></IconButton>
            {panelContent[panel]}
          </section>
        ))}
        <div className="fg-command-home">
          {secondaryCards.filter(card => card.id !== 'composer').map(card => (
            <section key={card.id} id={`card-${card.id}`} role="region" aria-label={card.label}
              className="fg-expanded-card fg-floating-card" hidden={layout.expandedCard !== card.id} inert={layout.expandedCard !== card.id}>
              <header className="fg-expanded-head"><h2>{card.label}</h2><IconButton label={`Close ${card.label}`} title="Close (Escape)" onClick={collapse}><X {...iconProps} /></IconButton></header>
              {panelContent[card.id]}
            </section>
          ))}
          <nav className="fg-command-bar" aria-label="Workspace panels">
            {secondaryCards.map(({ id, label, icon: Icon }) => (
              <button key={id} id={`command-${id}`} type="button" aria-expanded={layout.expandedCard === id}
                aria-controls={id === 'composer' ? 'agent-conversation' : `card-${id}`} title={id === 'console' ? 'Console (Ctrl+`)' : id === 'composer' ? 'Chat: focus prompt (Ctrl+K or /)' : label}
                onClick={() => setLayout(toggleCard(layout, id))}><Icon {...iconProps} /><span>{label}</span></button>
            ))}
          </nav>
          {/* Over the viewport, not inside the Inspector: an agent's external write must stay resolvable even with panels hidden. */}
          {conflict ? <div className="fg-conflict-float fg-floating-card"><ConflictCard conflict={conflict} onResolve={props.onResolveConflict} /></div> : null}
          <AgentDock agent={agent} scene={scene} assets={props.assets} projectOpen={props.source === 'project'} focusToken={focusToken}
            transcriptOpen={layout.expandedCard === 'composer'} onCloseTranscript={collapse} onOpenTranscript={() => show('composer')} />
        </div>
      </main>

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

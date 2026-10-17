export type {
  AgentConnection,
  AgentProviderInfo,
  CreatePlan,
  ProjectHost,
  ProjectOpenResult,
  ProjectSession,
  ProviderReadiness,
  RecentProject,
  StudioServices,
  ViewportCallbacks,
  ViewportHandle,
  ViewportMount,
  ViewportMountOptions,
  ViewportTool,
  ViewportView,
} from './services.js';

export { Banner, Button, EmptyState, StatusText } from './primitives/primitives.js';
export { Workspace, type SceneEntry, type WorkspaceProps } from './shell/Workspace.js';
export { Launcher, type LauncherProps } from './launcher/Launcher.js';

export { useEditorSnapshot, readEditorSnapshot, type EditorSnapshot } from './hooks/useEditorSnapshot.js';
export { useAgentSessions, type AgentController, type AgentSessionInput } from './agent/useAgentSessions.js';
export { agentReducer, newThread, threadStatus, threadStatusLabels, type AgentState, type AgentThread, type ThreadStatus } from './agent/threadState.js';
export { sendBlockers, isSendKey, buildContext, chipStatus, type ContextChip } from './agent/composerModel.js';
export { enforcementNote, permissionDescriptions, permissionLabels, defaultPermissionMode, providerLimitsNote } from './agent/permissions.js';

export { SceneHost, SceneSession, type SceneSessionOptions, type SceneSessionPhase } from './session/sceneSession.js';

export { noSelection, selectOne, toggleSelection, rangeSelection, pruneSelection, type Selection } from './model/selection.js';
export { buildRows, topmostIds, stepId, type TreeRow } from './model/tree.js';
export { canReparent, descendantIds, duplicatePlan, indentTarget, outdentTarget, reparentCommands, type DuplicateResult, type HierarchyPlan } from './model/hierarchyOps.js';
export { parseJsonDraft, propertyKind, withProperty, type JsonDraft, type PropertyKind } from './model/properties.js';
export { planSceneSwitch, type SceneSwitchPlan } from './model/sceneSwitch.js';
export { diffScenes, type EntityChange, type PropertyChange } from './model/sceneDiff.js';
export { parseFiniteNumber, formatNumber } from './model/numbers.js';
export { appendLog, countBySeverity, emptyLog, logCap, type ConsoleLog, type LogEntry, type LogInput, type LogSeverity, type LogSource } from './model/consoleLog.js';
export { defaultLayout, keyboardResize, layoutLimits, parseLayout, readLayout, rightDockSharesInspector, sharedRightDockBelow, writeLayout, type DockMode, type KeyValueStorage, type LayoutState } from './model/layout.js';
export type { FileBanner, SaveStatus } from './model/fileState.js';

export { projectDestination } from './model/projectDestination.js';

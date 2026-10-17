import { useRef, type KeyboardEvent } from 'react';
import type { AssetRecord, SceneDocument } from '@forgon/project-schema';
import type { AgentController } from '../agent/useAgentSessions.js';
import { AgentDock } from '../agent/AgentDock.js';
import { threadStatus, threadStatusLabels } from '../agent/threadState.js';
import { AssetsPanel } from '../panels/assets/AssetsPanel.js';
import { ConsolePanel } from '../panels/console/ConsolePanel.js';
import type { ConsoleLog } from '../model/consoleLog.js';
import type { DockMode } from '../model/layout.js';
import { ReviewPanel } from '../review/ReviewPanel.js';
import { Segmented, cx } from '../primitives/primitives.js';

export type DockTab = 'agent' | 'assets' | 'console' | 'review';

const tabs: ReadonlyArray<{ id: DockTab; label: string }> = [
  { id: 'agent', label: 'Agent' },
  { id: 'assets', label: 'Assets' },
  { id: 'console', label: 'Console' },
  { id: 'review', label: 'Review' },
];

const modeOptions: ReadonlyArray<{ value: DockMode; label: string }> = [
  { value: 'bottom', label: 'Bottom' },
  { value: 'right', label: 'Right' },
  { value: 'fullscreen', label: 'Full' },
];

export interface DockProps {
  tab: DockTab;
  onTab(tab: DockTab): void;
  mode: DockMode;
  onMode(mode: DockMode): void;
  agent: AgentController | null;
  scene: SceneDocument | null;
  assets: readonly AssetRecord[];
  projectOpen: boolean;
  onRefreshAssets?: (() => Promise<void>) | undefined;
  onImportAsset?: ((license: string) => Promise<void>) | undefined;
  providersOpen: boolean;
  onCloseProviders(): void;
  focusToken: number;
  log: ConsoleLog;
  reviewPaths: readonly string[];
  // True when the right dock shares the inspector column (narrow windows). Placement is then set by the parent.
  shared?: boolean;
}

export function Dock({ tab, onTab, mode, onMode, agent, scene, assets, projectOpen, onRefreshAssets, onImportAsset, providersOpen, onCloseProviders, focusToken, log, reviewPaths, shared = false }: DockProps) {
  const tabRefs = useRef<Record<DockTab, HTMLButtonElement | null>>({ agent: null, assets: null, console: null, review: null });
  const reviewBadge = reviewPaths.length;
  const activeThread = agent?.activeThread ?? null;

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    const index = tabs.findIndex(item => item.id === tab);
    let next: number | null = null;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = tabs.length - 1;
    if (next === null) return;
    event.preventDefault();
    const target = tabs[next];
    if (!target) return;
    onTab(target.id);
    tabRefs.current[target.id]?.focus();
  };

  return (
    <section className={cx('fg-dock', shared && 'fg-dock-shared')} aria-label="Supporting panels">
      <header className="fg-dock-header">
        <div role="tablist" aria-label="Panels" className="fg-tablist">
          {tabs.map(item => {
            const selected = item.id === tab;
            const label = item.id === 'review' && reviewBadge > 0 ? `${item.label} (${reviewBadge})` : item.label;
            return (
              <button
                key={item.id}
                ref={element => { tabRefs.current[item.id] = element; }}
                type="button"
                role="tab"
                id={`dock-tab-${item.id}`}
                aria-selected={selected}
                aria-controls="dock-panel"
                tabIndex={selected ? 0 : -1}
                className={cx('fg-tab', selected && 'is-selected')}
                onClick={() => onTab(item.id)}
                onKeyDown={onTabKeyDown}
              >
                {label}
              </button>
            );
          })}
        </div>
        <div className="fg-dock-mode">
          <Segmented<DockMode> label="Dock position" options={modeOptions} value={mode} onChange={onMode} />
        </div>
      </header>
      <div role="tabpanel" id="dock-panel" aria-labelledby={`dock-tab-${tab}`} className="fg-dock-body">
        {tab === 'agent' ? (
          <AgentDock
            agent={agent}
            scene={scene}
            assets={assets}
            projectOpen={projectOpen}
            providersOpen={providersOpen}
            onCloseProviders={onCloseProviders}
            focusToken={focusToken}
          />
        ) : null}
        {tab === 'assets' ? <AssetsPanel assets={assets} projectOpen={projectOpen} onRefresh={onRefreshAssets} onImport={onImportAsset} /> : null}
        {tab === 'console' ? <ConsolePanel log={log} /> : null}
        {tab === 'review' ? <ReviewPanel threadTitle={activeThread?.title ?? null} changedPaths={reviewPaths} /> : null}
      </div>
      <span className="fg-sr-only" aria-live="polite">{activeThread ? `Agent: ${threadStatusLabels[threadStatus(activeThread)]}` : ''}</span>
    </section>
  );
}

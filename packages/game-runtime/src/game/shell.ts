// DOM shell for a full campaign: title, course select, results, pause and settings. Browser-only
// and dependency-free; every decision it shows comes from the pure campaign model.
//
// The shell never owns game state. It calls back into the mount adapter and re-renders from the
// progress it is given, so saves, unlocks and medals have exactly one owner.

import type { CampaignDocument } from '@forgon/project-schema';
import { formatSeconds, isCourseUnlocked, totalMedals } from './campaign.js';
import type { CampaignProgress, CampaignSettings, Medal } from './campaign.js';

export type ShellScreen = 'title' | 'courses' | 'results' | 'pause' | 'settings' | 'credits' | 'loading' | 'error' | 'hidden';

export interface ResultsView {
  courseIndex: number;
  courseName: string;
  seconds: number;
  shards: number;
  totalShards: number;
  deaths: number;
  medal: Medal | null;
  bestSeconds: number | null;
  newBest: boolean;
  firstClear: boolean;
  unlockedName: string | null;
  hasNext: boolean;
  nextName: string | null;
}
export interface ShellActions {
  play(index: number): void;
  resume(): void;
  retry(): void;
  next(): void;
  quit(): void;
  settingsChanged(settings: CampaignSettings): void;
  resetProgress(): void;
  /** Leave the game entirely when the host provides an exit (the preview player does). */
  exit?(): void;
}
export interface ShellOptions {
  campaign: CampaignDocument;
  progress: CampaignProgress;
  actions: ShellActions;
  reducedMotion?: boolean;
  /** Shown on the credits screen; defaults to the campaign credits. */
  engineLabel?: string;
}
export interface Shell {
  readonly screen: ShellScreen;
  readonly visible: boolean;
  showTitle(): void;
  showCourses(): void;
  showResults(view: ResultsView): void;
  showPause(courseIndex: number): void;
  showSettings(): void;
  showCredits(): void;
  showLoading(label: string): void;
  showError(message: string): void;
  hide(): void;
  /** Return from settings/credits, or from pause to the run. */
  back(): void;
  update(progress: CampaignProgress): void;
  dispose(): void;
}

const STYLE_ID = 'forgon-shell-style';
const STYLES = `
.fg-shell{position:absolute;inset:0;z-index:4;display:grid;place-items:center;padding:clamp(1rem,4vw,3.5rem);overflow:auto;
  color:#f2efe9;font-family:"Segoe UI Variable","Segoe UI",ui-sans-serif,system-ui,sans-serif;letter-spacing:.01em;
  background:radial-gradient(120% 90% at 50% 0%,#1d2733 0%,#0c1118 55%,#070a0f 100%)}
.fg-shell[data-screen="hidden"]{display:none}
.fg-shell::before{content:"";position:absolute;inset:0;pointer-events:none;opacity:.5;
  background-image:linear-gradient(#ffffff08 1px,transparent 1px),linear-gradient(90deg,#ffffff08 1px,transparent 1px);
  background-size:64px 64px;mask-image:radial-gradient(70% 60% at 50% 35%,#000 20%,transparent 100%)}
.fg-shell *{box-sizing:border-box}
.fg-panel{position:relative;width:min(62rem,100%);margin:auto;display:flex;flex-direction:column;gap:1.6rem}
.fg-eyebrow{margin:0;font-size:.68rem;letter-spacing:.42em;text-transform:uppercase;color:#8aa0b6}
.fg-title{margin:0;font-size:clamp(2.6rem,7vw,4.6rem);line-height:.94;font-weight:650;letter-spacing:.02em;text-transform:uppercase}
.fg-tagline{margin:0;max-width:38rem;color:#a9b6c6;font-size:1rem;line-height:1.5}
.fg-accent{color:#f0a45a}
.fg-rule{height:1px;background:linear-gradient(90deg,#f0a45a,#ffffff14 45%,transparent)}
.fg-stats{display:flex;flex-wrap:wrap;gap:1.4rem;font-size:.75rem;letter-spacing:.16em;text-transform:uppercase;color:#8fa1b4}
.fg-stats b{display:block;margin-top:.35rem;font-size:1.15rem;letter-spacing:.04em;color:#f2efe9;font-variant-numeric:tabular-nums}
.fg-actions{display:flex;flex-wrap:wrap;gap:.7rem}
.fg-button{appearance:none;border:1px solid #ffffff26;background:#ffffff0b;color:#f2efe9;font:inherit;font-size:.82rem;
  letter-spacing:.14em;text-transform:uppercase;padding:.85rem 1.4rem;border-radius:.55rem;cursor:pointer;transition:background .16s ease,border-color .16s ease,transform .16s ease}
.fg-button:hover{background:#ffffff16;border-color:#ffffff3d}
.fg-button:active{transform:translateY(1px)}
.fg-button:focus-visible{outline:2px solid #f0a45a;outline-offset:3px}
.fg-button--primary{background:#f0a45a;border-color:#f0a45a;color:#1b1207;font-weight:650}
.fg-button--primary:hover{background:#ffb871;border-color:#ffb871}
.fg-button--ghost{background:transparent;border-color:transparent;color:#a9b6c6;padding-left:.4rem;padding-right:.4rem}
.fg-button--ghost:hover{color:#f2efe9;background:transparent}
.fg-button:disabled{opacity:.38;cursor:not-allowed;transform:none}
.fg-head{display:flex;align-items:baseline;justify-content:space-between;gap:1rem;flex-wrap:wrap}
.fg-head h2{margin:0;font-size:1.55rem;letter-spacing:.2em;text-transform:uppercase;font-weight:600}
.fg-head p{margin:0;color:#8fa1b4;font-size:.72rem;letter-spacing:.18em;text-transform:uppercase}
.fg-courses{display:grid;grid-template-columns:repeat(auto-fit,minmax(15.5rem,1fr));gap:.8rem}
.fg-course{position:relative;display:grid;gap:.45rem;text-align:left;padding:1.1rem 1.15rem 1.25rem;border-radius:.8rem;
  border:1px solid #ffffff1c;background:linear-gradient(160deg,#ffffff0d,#ffffff05);color:inherit;font:inherit;cursor:pointer;
  transition:border-color .16s ease,background .16s ease,transform .16s ease}
.fg-course:hover:not(:disabled){border-color:#f0a45a66;background:linear-gradient(160deg,#ffffff14,#ffffff07);transform:translateY(-2px)}
.fg-course:focus-visible{outline:2px solid #f0a45a;outline-offset:3px}
.fg-course:disabled{cursor:not-allowed;opacity:.52}
.fg-course-top{display:flex;align-items:center;justify-content:space-between;gap:.6rem}
.fg-course-no{font-size:.68rem;letter-spacing:.3em;color:#f0a45a}
.fg-course-name{font-size:1.08rem;font-weight:600;letter-spacing:.03em}
.fg-course-sub{font-size:.78rem;color:#93a3b5;line-height:1.4}
.fg-course-best{margin-top:.35rem;font-size:.72rem;letter-spacing:.12em;text-transform:uppercase;color:#b9c6d4;font-variant-numeric:tabular-nums}
.fg-lock{font-size:.7rem;letter-spacing:.12em;text-transform:uppercase;color:#7d8ea1}
.fg-medals{display:flex;gap:.3rem}
.fg-medal{width:1.5rem;height:.42rem;border-radius:999px;background:#ffffff14;border:1px solid #ffffff1f}
.fg-medal--gold.is-on{background:#f5c25b;border-color:#f5c25b;box-shadow:0 0 12px #f5c25b66}
.fg-medal--silver.is-on{background:#cdd8e4;border-color:#cdd8e4}
.fg-medal--bronze.is-on{background:#c98a5b;border-color:#c98a5b}
.fg-result{display:grid;gap:.4rem;justify-items:start}
.fg-result-time{font-size:clamp(2.6rem,6vw,4rem);font-weight:600;letter-spacing:.02em;font-variant-numeric:tabular-nums}
.fg-result-medal{font-size:.72rem;letter-spacing:.28em;text-transform:uppercase;color:#f0a45a}
.fg-result-note{color:#a9b6c6;font-size:.85rem;line-height:1.5}
.fg-grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(12rem,1fr));gap:1rem}
.fg-field{display:grid;gap:.5rem;padding:1rem 1.1rem;border:1px solid #ffffff17;border-radius:.7rem;background:#ffffff06}
.fg-field label{font-size:.7rem;letter-spacing:.2em;text-transform:uppercase;color:#9aabba;display:flex;justify-content:space-between;gap:1rem}
.fg-field output{color:#f2efe9;font-variant-numeric:tabular-nums;letter-spacing:.04em}
.fg-field input[type=range]{width:100%;accent-color:#f0a45a}
.fg-toggle{display:flex;align-items:center;gap:.6rem;font-size:.8rem;color:#c3cedb;cursor:pointer}
.fg-toggle input{width:1.05rem;height:1.05rem;accent-color:#f0a45a}
.fg-loading{display:flex;align-items:center;gap:.9rem;font-size:.8rem;letter-spacing:.2em;text-transform:uppercase;color:#a9b6c6}
.fg-spinner{width:1.1rem;height:1.1rem;border-radius:50%;border:2px solid #ffffff26;border-top-color:#f0a45a;animation:fg-spin .8s linear infinite}
@keyframes fg-spin{to{transform:rotate(360deg)}}
.fg-error{color:#ff9a9a;font-size:.9rem;line-height:1.5;max-width:44rem}
.fg-small{font-size:.72rem;color:#7d8ea1;letter-spacing:.06em;line-height:1.6}
.fg-kbd{display:inline-block;padding:.05rem .35rem;border-radius:.25rem;border:1px solid #ffffff26;background:#ffffff0d;font-size:.68rem;letter-spacing:.06em}
.fg-fade{animation:fg-fade .22s ease both}
@keyframes fg-fade{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.fg-shell[data-motion="reduced"] .fg-fade{animation:none}
.fg-shell[data-motion="reduced"] .fg-spinner{animation:none;border-top-color:#ffffff50}
@media (prefers-reduced-motion:reduce){.fg-fade{animation:none}.fg-spinner{animation:none}}
@media (max-width:640px){.fg-shell{padding:1.1rem}.fg-actions{gap:.5rem}.fg-button{padding:.75rem 1rem}}
`;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(label: string, onClick: () => void, variant: 'primary' | 'default' | 'ghost' = 'default', disabled = false): HTMLButtonElement {
  const node = h('button', `fg-button${variant === 'default' ? '' : ` fg-button--${variant}`}`, label);
  node.type = 'button';
  node.disabled = disabled;
  node.addEventListener('click', onClick);
  return node;
}
const MEDAL_LABEL: Record<Medal, string> = { gold: 'Gold', silver: 'Silver', bronze: 'Bronze' };

export function createShell(container: HTMLElement, options: ShellOptions): Shell {
  const { campaign, actions } = options;
  let progress = options.progress;
  let screen: ShellScreen = 'hidden';
  let previous: ShellScreen = 'title';
  let pauseIndex = 0;
  let errorMessage = '';
  let loadingLabel = '';
  let resetArmed = 0;

  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID; style.textContent = STYLES;
    document.head.appendChild(style);
  }
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
  const root = h('div', 'fg-shell');
  root.dataset.screen = 'hidden';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', `${campaign.title} menu`);
  if (options.reducedMotion) root.dataset.motion = 'reduced';
  container.appendChild(root);
  const panel = h('div', 'fg-panel');
  root.appendChild(panel);

  const clear = (): void => { panel.replaceChildren(); };
  const focusFirst = (): void => {
    const target = panel.querySelector<HTMLElement>('.fg-course:not(:disabled)')
      ?? panel.querySelector<HTMLElement>('button:not(:disabled), input, [tabindex]');
    if (target) setTimeout(() => target.focus(), 0);
  };
  const render = (): void => {
    clear();
    switch (screen) {
      case 'title': renderTitle(); break;
      case 'courses': renderCourses(); break;
      case 'results': break; // results are rendered once from the run view
      case 'pause': renderPause(); break;
      case 'settings': renderSettings(); break;
      case 'credits': renderCredits(); break;
      case 'loading': renderLoading(); break;
      case 'error': renderError(); break;
      default: break;
    }
    focusFirst();
  };
  const show = (next: ShellScreen): void => {
    previous = screen === 'hidden' ? next : screen;
    screen = next;
    root.dataset.screen = next;
    if (next === 'hidden') return;
    panel.classList.remove('fg-fade');
    void panel.offsetWidth;
    panel.classList.add('fg-fade');
    render();
  };

  function renderTitle(): void {
    panel.append(h('p', 'fg-eyebrow', 'Forgon Engine presents'));
    const title = h('h1', 'fg-title'); title.textContent = campaign.title; panel.appendChild(title);
    panel.append(h('div', 'fg-rule'));
    panel.append(h('p', 'fg-tagline', campaign.tagline));
    const cleared = campaign.courses.filter(course => progress.courses[course.sceneId]?.completed).length;
    const stats = h('div', 'fg-stats');
    for (const [label, value] of [['Courses cleared', `${cleared} / ${campaign.courses.length}`], ['Medals', `${totalMedals(campaign, progress)} / ${campaign.courses.length}`]] as const) {
      const block = h('span'); block.append(document.createTextNode(label), h('b', undefined, value)); stats.appendChild(block);
    }
    panel.appendChild(stats);
    const actionsRow = h('div', 'fg-actions');
    const lastIndex = progress.lastPlayedSceneId ? campaign.courses.findIndex(course => course.sceneId === progress.lastPlayedSceneId) : -1;
    if (lastIndex >= 0 && isCourseUnlocked(campaign, progress, lastIndex)) {
      actionsRow.append(button(`Continue · ${campaign.courses[lastIndex]!.name}`, () => actions.play(lastIndex), 'primary'));
    }
    actionsRow.append(button(cleared === campaign.courses.length ? 'Courses' : 'Start', () => show('courses'), lastIndex >= 0 ? 'default' : 'primary'));
    actionsRow.append(button('Settings', () => show('settings')));
    actionsRow.append(button('Credits', () => show('credits')));
    if (actions.exit) actionsRow.append(button('Exit', () => actions.exit!(), 'ghost'));
    panel.appendChild(actionsRow);
    panel.append(h('p', 'fg-small', 'Enter to play · Esc to pause in a run · progress saves on this device'));
  }

  function renderCourses(): void {
    const head = h('div', 'fg-head');
    const heading = h('div'); heading.append(h('h2', undefined, 'Courses'), h('p', undefined, `${campaign.courses.length} rooftop routes`));
    head.append(heading, button('Back', () => show('title'), 'ghost'));
    panel.appendChild(head);
    panel.append(h('div', 'fg-rule'));
    const grid = h('div', 'fg-courses');
    campaign.courses.forEach((course, index) => {
      const unlocked = isCourseUnlocked(campaign, progress, index);
      const record = progress.courses[course.sceneId];
      const card = h('button', 'fg-course');
      card.type = 'button';
      card.disabled = !unlocked;
      const top = h('div', 'fg-course-top');
      top.append(h('span', 'fg-course-no', String(index + 1).padStart(2, '0')));
      const medals = h('span', 'fg-medals');
      for (const medal of ['gold', 'silver', 'bronze'] as const) {
        const pip = h('span', `fg-medal fg-medal--${medal}${record?.bestMedal === medal ? ' is-on' : ''}`);
        pip.title = `${MEDAL_LABEL[medal]} ${formatSeconds(course[`${medal}Seconds` as const])}`;
        medals.appendChild(pip);
      }
      top.append(medals);
      card.append(top, h('span', 'fg-course-name', course.name), h('span', 'fg-course-sub', course.subtitle));
      card.append(h('span', 'fg-course-best', unlocked
        ? `Best ${formatSeconds(record?.bestSeconds ?? null)} · Gold ${formatSeconds(course.goldSeconds)}`
        : 'Clear the previous course to unlock'));
      if (!unlocked) card.append(h('span', 'fg-lock', 'Locked'));
      card.setAttribute('aria-label', unlocked ? `Play ${course.name}` : `${course.name} locked`);
      card.addEventListener('click', () => actions.play(index));
      grid.appendChild(card);
    });
    panel.appendChild(grid);
    panel.append(h('p', 'fg-small', 'Medals are earned on the clock: gold is the sharp route, bronze still ends clean.'));
  }

  function renderPause(): void {
    const course = campaign.courses[pauseIndex];
    panel.append(h('p', 'fg-eyebrow', 'Run paused'));
    const title = h('h1', 'fg-title'); title.textContent = course?.name ?? 'Paused'; panel.appendChild(title);
    panel.append(h('div', 'fg-rule'));
    panel.append(h('p', 'fg-tagline', 'The clock is stopped. Resume, restart the route, or take the menu.'));
    const row = h('div', 'fg-actions');
    row.append(button('Resume', () => actions.resume(), 'primary'), button('Retry', () => actions.retry()), button('Courses', () => actions.quit()), button('Settings', () => show('settings')));
    panel.appendChild(row);
    panel.append(h('p', 'fg-small', 'Esc resumes · R retries during a run'));
  }

  function renderResults(view: ResultsView): void {
    panel.append(h('p', 'fg-eyebrow', `Course ${String(view.courseIndex + 1).padStart(2, '0')} cleared`));
    const title = h('h1', 'fg-title'); title.textContent = view.courseName; panel.appendChild(title);
    panel.append(h('div', 'fg-rule'));
    const result = h('div', 'fg-result');
    result.append(h('div', 'fg-result-time', formatSeconds(view.seconds)));
    const medal = view.medal ? `${MEDAL_LABEL[view.medal]} medal` : 'Finished';
    result.append(h('p', 'fg-result-medal', medal));
    result.append(h('p', 'fg-result-note', `${view.shards} / ${view.totalShards} shards · ${view.deaths} ${view.deaths === 1 ? 'fall' : 'falls'} · best ${formatSeconds(view.bestSeconds)}`));
    if (view.newBest) result.append(h('p', 'fg-result-medal', 'New personal best'));
    if (view.unlockedName) result.append(h('p', 'fg-result-note', `Unlocked · ${view.unlockedName}`));
    panel.appendChild(result);
    const row = h('div', 'fg-actions');
    if (view.hasNext) row.append(button(view.nextName ? `Next · ${view.nextName}` : 'Next course', () => actions.next(), 'primary'));
    row.append(button('Retry', () => actions.retry(), view.hasNext ? 'default' : 'primary'));
    row.append(button('Courses', () => show('courses')));
    panel.appendChild(row);
  }

  function renderSettings(): void {
    const head = h('div', 'fg-head');
    head.append(h('h2', undefined, 'Settings'), button('Back', () => { if (previous === 'pause') show('pause'); else show('title'); }, 'ghost'));
    panel.appendChild(head);
    panel.append(h('div', 'fg-rule'));
    const grid = h('div', 'fg-grid2');

    const volume = h('input'); volume.type = 'range'; volume.min = '0'; volume.max = '1'; volume.step = '0.05'; volume.value = String(progress.settings.volume);
    const volumeOut = h('output', undefined, `${Math.round(progress.settings.volume * 100)}%`);
    const volumeField = h('div', 'fg-field'); const volumeLabel = h('label'); volumeLabel.textContent = 'Master volume'; volumeLabel.appendChild(volumeOut);
    volumeField.append(volumeLabel, volume);
    volume.addEventListener('input', () => {
      const next = { ...progress.settings, volume: Number(volume.value) };
      progress = { ...progress, settings: next }; volumeOut.textContent = `${Math.round(next.volume * 100)}%`; actions.settingsChanged(next);
    });

    const sensitivity = h('input'); sensitivity.type = 'range'; sensitivity.min = '0.25'; sensitivity.max = '3'; sensitivity.step = '0.05'; sensitivity.value = String(progress.settings.sensitivity);
    const sensitivityOut = h('output', undefined, `${progress.settings.sensitivity.toFixed(2)}×`);
    const sensitivityField = h('div', 'fg-field'); const sensitivityLabel = h('label'); sensitivityLabel.textContent = 'Look sensitivity'; sensitivityLabel.appendChild(sensitivityOut);
    sensitivityField.append(sensitivityLabel, sensitivity);
    sensitivity.addEventListener('input', () => {
      const next = { ...progress.settings, sensitivity: Number(sensitivity.value) };
      progress = { ...progress, settings: next }; sensitivityOut.textContent = `${next.sensitivity.toFixed(2)}×`; actions.settingsChanged(next);
    });

    const reduce = h('input'); reduce.type = 'checkbox'; reduce.checked = progress.settings.reducedMotion;
    const reduceLabel = h('label', 'fg-toggle'); reduceLabel.append(reduce, document.createTextNode('Reduce menu motion'));
    reduce.addEventListener('change', () => {
      const next = { ...progress.settings, reducedMotion: reduce.checked };
      progress = { ...progress, settings: next };
      root.dataset.motion = reduce.checked ? 'reduced' : 'default';
      actions.settingsChanged(next);
    });
    const reduceField = h('div', 'fg-field'); reduceField.append(reduceLabel, h('p', 'fg-small', 'The OS reduced-motion preference is always respected.'));

    grid.append(volumeField, sensitivityField, reduceField);
    panel.appendChild(grid);

    const danger = h('div', 'fg-actions');
    danger.append(button('Reset progress', () => {
      const now = Date.now();
      if (now - resetArmed < 4000) {
        resetArmed = 0;
        actions.resetProgress();
        show('courses');
      } else {
        resetArmed = now;
        const target = danger.querySelector<HTMLButtonElement>('button');
        if (target) { target.textContent = 'Tap again to reset everything'; target.classList.add('fg-button--primary'); }
      }
    }, 'ghost'));
    panel.appendChild(danger);
    panel.append(h('p', 'fg-small', 'Progress is stored locally for this campaign. Nothing is uploaded.'));
  }

  function renderCredits(): void {
    panel.append(h('p', 'fg-eyebrow', 'Credits'));
    const title = h('h1', 'fg-title'); title.textContent = campaign.title; panel.appendChild(title);
    panel.append(h('div', 'fg-rule'));
    panel.append(h('p', 'fg-tagline', campaign.credits ?? 'A Forgon Engine sample production.'));
    panel.append(h('p', 'fg-small', `${options.engineLabel ?? 'Built with Forgon Engine'} · original placeholder art, level design and synthesized audio`));
    const row = h('div', 'fg-actions');
    row.append(button('Back', () => show('title'), 'ghost'));
    panel.appendChild(row);
  }

  function renderLoading(): void {
    const line = h('div', 'fg-loading');
    line.append(h('span', 'fg-spinner'), document.createTextNode(loadingLabel || 'Loading course'));
    const box = h('div', 'fg-field'); box.appendChild(line);
    panel.appendChild(box);
  }

  function renderError(): void {
    panel.append(h('p', 'fg-eyebrow', 'Run interrupted'));
    const title = h('h1', 'fg-title'); title.textContent = 'Something broke'; panel.appendChild(title);
    panel.append(h('div', 'fg-rule'));
    panel.append(h('p', 'fg-error', errorMessage || 'Unknown engine fault'));
    const row = h('div', 'fg-actions');
    row.append(button('Courses', () => show('courses'), 'primary'), button('Retry', () => actions.retry()));
    panel.appendChild(row);
  }

  return {
    get screen() { return screen; },
    get visible() { return screen !== 'hidden'; },
    showTitle(): void { show('title'); },
    showCourses(): void { show('courses'); },
    showResults(view: ResultsView): void {
      previous = screen === 'hidden' ? 'results' : screen;
      screen = 'results';
      root.dataset.screen = 'results';
      clear();
      renderResults(view);
      panel.classList.remove('fg-fade'); void panel.offsetWidth; panel.classList.add('fg-fade');
      focusFirst();
    },
    showPause(courseIndex: number): void { pauseIndex = courseIndex; show('pause'); },
    showSettings(): void { show('settings'); },
    showCredits(): void { show('credits'); },
    showLoading(label: string): void { loadingLabel = label; show('loading'); },
    showError(message: string): void { errorMessage = message; show('error'); },
    hide(): void { screen = 'hidden'; root.dataset.screen = 'hidden'; },
    back(): void {
      if (screen === 'settings' || screen === 'credits') { if (previous === 'pause') show('pause'); else show('title'); }
      else if (screen === 'pause') actions.resume();
      else show('title');
    },
    update(next: CampaignProgress): void {
      progress = next;
      root.dataset.motion = next.settings.reducedMotion ? 'reduced' : 'default';
      if (screen === 'title' || screen === 'courses' || screen === 'settings') render();
    },
    dispose(): void { root.remove(); },
  };
}

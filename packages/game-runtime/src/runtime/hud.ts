// Minimal cinematic HUD for the Sector demo, drawn as an overlay inside the game container.
// Browser-only and entirely optional: the parkour session runs headless without it.

export interface HudSnapshot {
  time: number;
  deaths: number;
  collected: number;
  total: number;
  checkpointIndex: number;
  checkpointTotal: number;
  speed: number;
  grounded: boolean;
  finished: boolean;
  finishTime: number | null;
}

export interface Hud {
  update(snapshot: HudSnapshot): void;
  /** Shown once at start; fades automatically. */
  showOpening(title: string, subtitle: string): void;
  dispose(): void;
}

const STYLE_ID = 'forgon-hud-style';
const STYLES = `
.forgon-hud{position:absolute;inset:0;pointer-events:none;font-family:'Cascadia Code',ui-monospace,SFMono-Regular,Menlo,monospace;color:#e8e6e1;text-transform:uppercase;letter-spacing:.14em}
.forgon-hud *{box-sizing:border-box}
.forgon-hud .row{position:absolute;display:flex;gap:1.25rem;align-items:flex-start;font-size:.72rem;text-shadow:0 1px 3px #000a}
.forgon-hud .time{left:50%;top:1.1rem;transform:translateX(-50%);font-size:1.5rem;letter-spacing:.08em}
.forgon-hud .time small{display:block;font-size:.6rem;opacity:.55;letter-spacing:.2em;text-align:center}
.forgon-hud .shards{left:1.4rem;top:1.2rem;color:#e7ba71}
.forgon-hud .deaths{left:1.4rem;top:2.7rem;opacity:.7}
.forgon-hud .pips{right:1.4rem;top:1.2rem;gap:.4rem}
.forgon-hud .pip{width:.7rem;height:.35rem;border-radius:999px;background:#ffffff22;border:1px solid #ffffff2a}
.forgon-hud .pip.on{background:#e7ba71;border-color:#e7ba71;box-shadow:0 0 10px #e7ba7199}
.forgon-hud .speed{right:1.4rem;bottom:1.2rem;opacity:.6;font-size:.68rem}
.forgon-hud .opening{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;align-items:center;gap:.6rem;transition:opacity .8s ease;background:radial-gradient(60% 60% at 50% 45%,#0000,#000a)}
.forgon-hud .opening h1{margin:0;font-size:2.4rem;letter-spacing:.5em;font-weight:600}
.forgon-hud .opening p{margin:0;font-size:.68rem;opacity:.6}
.forgon-hud .opening.gone{opacity:0}
.forgon-hud .controls{position:absolute;left:50%;bottom:1.4rem;transform:translateX(-50%);font-size:.62rem;opacity:.55;transition:opacity .6s ease;text-align:center;line-height:1.9}
.forgon-hud .controls.gone{opacity:0}
.forgon-hud .finish{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;align-items:center;gap:.5rem;background:#05070ab8;opacity:0;transition:opacity .5s ease}
.forgon-hud .finish.show{opacity:1}
.forgon-hud .finish h1{margin:0;font-size:1.8rem;letter-spacing:.4em;color:#e7ba71}
.forgon-hud .finish .big{font-size:2.6rem;letter-spacing:.06em}
.forgon-hud .finish p{margin:0;font-size:.66rem;opacity:.7}
@media (prefers-reduced-motion:reduce){.forgon-hud .opening,.forgon-hud .controls,.forgon-hud .finish{transition:none}}
`;

function formatTime(seconds: number): string {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const rest = safe - minutes * 60;
  return `${minutes}:${rest.toFixed(2).padStart(5, '0')}`;
}

export function createHud(container: HTMLElement): Hud {
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID; style.textContent = STYLES;
    document.head.appendChild(style);
  }
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
  const root = document.createElement('div');
  root.className = 'forgon-hud';
  root.setAttribute('aria-hidden', 'true');
  root.innerHTML = `
    <div class="row shards">◇ <span data-shards>0 / 0</span> shards</div>
    <div class="row deaths" data-deaths></div>
    <div class="time"><small>sector 07</small><span data-time>0:00.00</span></div>
    <div class="row pips" data-pips></div>
    <div class="row speed" data-speed></div>
    <div class="controls" data-controls>WASD move · SPACE jump / double jump · SHIFT sprint · C slide · mouse look · R retry</div>
    <div class="finish" data-finish><h1>sector clear</h1><div class="big" data-finish-time>0:00.00</div><p data-finish-detail></p></div>`;
  container.appendChild(root);
  const shards = root.querySelector<HTMLElement>('[data-shards]')!;
  const deaths = root.querySelector<HTMLElement>('[data-deaths]')!;
  const time = root.querySelector<HTMLElement>('[data-time]')!;
  const pips = root.querySelector<HTMLElement>('[data-pips]')!;
  const speed = root.querySelector<HTMLElement>('[data-speed]')!;
  const controls = root.querySelector<HTMLElement>('[data-controls]')!;
  const finish = root.querySelector<HTMLElement>('[data-finish]')!;
  const finishTime = root.querySelector<HTMLElement>('[data-finish-time]')!;
  const finishDetail = root.querySelector<HTMLElement>('[data-finish-detail]')!;
  let controlTimer = 12;
  let finished = false;
  let disposed = false;

  return {
    update(snapshot: HudSnapshot): void {
      if (disposed) return;
      shards.textContent = `${snapshot.collected} / ${snapshot.total}`;
      time.textContent = formatTime(snapshot.finishTime ?? snapshot.time);
      deaths.textContent = snapshot.deaths > 0 ? `${snapshot.deaths} falls` : '';
      speed.textContent = `${snapshot.speed.toFixed(1)} m/s${snapshot.grounded ? '' : ' · air'}`;
      if (pips.childElementCount !== snapshot.checkpointTotal) {
        pips.replaceChildren(...Array.from({ length: snapshot.checkpointTotal }, () => {
          const pip = document.createElement('div'); pip.className = 'pip'; return pip;
        }));
      }
      Array.from(pips.children).forEach((pip, index) => pip.classList.toggle('on', index <= snapshot.checkpointIndex));
      controlTimer -= 1 / 60;
      if (controlTimer <= 0) controls.classList.add('gone');
      if (snapshot.finished && !finished) {
        finished = true;
        finishTime.textContent = formatTime(snapshot.finishTime ?? snapshot.time);
        finishDetail.textContent = `${snapshot.collected} / ${snapshot.total} shards · ${snapshot.deaths} falls`;
        finish.classList.add('show');
      }
    },
    showOpening(title, subtitle): void {
      if (disposed) return;
      const opening = document.createElement('div');
      opening.className = 'opening';
      const heading = document.createElement('h1'); heading.textContent = title;
      const caption = document.createElement('p'); caption.textContent = subtitle;
      opening.append(heading, caption);
      root.appendChild(opening);
      setTimeout(() => opening.classList.add('gone'), 2200);
      setTimeout(() => opening.remove(), 3400);
    },
    dispose(): void { disposed = true; root.remove(); },
  };
}

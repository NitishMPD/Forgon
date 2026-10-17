let loading: Promise<void> | undefined;
let ready = false;

/** Load the engine-tagged Ammo build once; each Application owns its own physics world. */
export function loadPhysics(): Promise<void> {
  return loading ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = new URL('../../vendor/ammo.wasm.js', import.meta.url).href;
    script.onload = () => {
      const global = globalThis as typeof globalThis & { Ammo?: unknown };
      const factory = global.Ammo as (options: { locateFile: () => string }) => Promise<unknown>;
      if (typeof factory !== 'function') { script.remove(); reject(new Error('Ammo factory unavailable')); return; }
      Promise.resolve().then(() => factory({ locateFile: () => new URL('../../vendor/ammo.wasm.wasm', import.meta.url).href })).then(module => {
        global.Ammo = module;
        ready = true;
        script.remove();
        resolve();
      }, error => { script.remove(); reject(error); });
    };
    script.onerror = () => { script.remove(); reject(new Error('Ammo physics payload could not be loaded')); };
    document.head.appendChild(script);
  }).catch(error => { loading = undefined; throw error; });
}

export function physicsReady(): boolean { return ready; }

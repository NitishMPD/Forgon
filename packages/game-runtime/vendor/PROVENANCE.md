# Ammo runtime payloads
Author: Nitish

Unmodified payloads from PlayCanvas Engine tag `v2.23.3`:
https://github.com/playcanvas/engine/tree/v2.23.3/examples/assets/wasm/ammo

- ammo.wasm.js SHA-256: 8481c5250507d3f2c0cecff7cc55a34727f52f96590a2304556a43ca4cf4e0b3
- ammo.wasm.wasm SHA-256: de36b300b25d244a79ae56ef0e7fee5efe2a3281f346a134945eef0b2fbaa5d8

Ammo is Bullet Physics compiled with Emscripten, distributed under the zlib license.
AMMO-LICENSE.txt retains the upstream https://github.com/kripken/ammo.js/blob/main/LICENSE notice.
The browser loads the factory as a classic script and supplies an explicit local WASM URL;
no CDN or project-authored script is used. Vite packages these payloads with the game.

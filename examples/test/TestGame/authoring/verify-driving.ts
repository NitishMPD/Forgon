import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { defineScript, prop } from '../../../../packages/game-runtime/src/scripting/index.ts';
import { createScriptHost } from '../../../../packages/game-runtime/src/scripting/host.ts';
import { projectScene } from '../../../../packages/game-runtime/src/core/reconcile.ts';
import { disposeGraph } from '../../../../packages/game-runtime/src/core/projection.ts';
import { validatePlayableScene } from '../../../../packages/game-runtime/src/runtime/validate.ts';
import { compileProjectScripts } from '../../../../packages/project-io/src/scripting.ts';


async function main() {
  const require = createRequire(new URL('../../../../packages/game-runtime/package.json', import.meta.url));
  const three = await import(pathToFileURL(require.resolve('three').replace('three.cjs', 'three.module.js')).href);
  const root = new URL('../', import.meta.url);
  const scene = validatePlayableScene(JSON.parse(readFileSync(new URL('scenes/main.scene.json', root), 'utf8')));
  const catalog = await compileProjectScripts(fileURLToPath(root));
  assert.deepEqual(catalog.diagnostics, []);
  assert.equal(catalog.scripts.length, 1);
  const compiled = await import(`data:text/javascript;base64,${Buffer.from(catalog.scripts[0]!.code).toString('base64')}`);
  const script = compiled.load({ three, '@forgon/game-runtime/scripting': { defineScript, prop } });
  const graph = new three.Group();
  const projection = projectScene(graph, scene, true);
  let keys = new Set<string>();
  let edges = new Set<string>();
  const host = createScriptHost({ scene, entities: projection.registry.byId,
    scripts: { 'scripts/city-car.ts': script },
    input: { down: key => keys.has(key), pressed: key => edges.has(key) },
    onFault: message => assert.fail(message),
  });
  const car = projection.registry.byId.get('city_car_0')!;
  const camera = projection.registry.byId.get('gen_c68de6bf2459a97b')!.camera!;
  const overview = camera.position.clone();
  const tick = (dt = 1 / 60) => { host.update(dt); edges.clear(); };
  try {
    const quadrants = new Set<string>();
    let distance = 0;
    for (let i = 0; i < 3600; i++) {
      const before = car.position.clone(); tick(); distance += before.distanceTo(car.position);
      quadrants.add(`${Math.sign(car.position.x)},${Math.sign(car.position.z)}`);
    }
    assert.equal(quadrants.size, 4, 'Tour reaches all four sides of the park');
    assert(distance > 350, 'Tour completes multiple loops without getting stuck');
    assert(camera.position.equals(overview), 'Tour preserves overview camera');
    edges.add('Enter'); tick();
    const cameraPosition = camera.getWorldPosition(new three.Vector3());
    assert(cameraPosition.distanceTo(car.position) < 10, 'Enter switches to chase camera');
    const before = car.position.clone();
    keys.add('KeyW'); for (let i = 0; i < 25; i++) tick();
    assert(car.position.distanceTo(before) > 0.5, 'Throttle moves the car');
    const yaw = car.rotation.y;
    keys.add('KeyA'); for (let i = 0; i < 10; i++) tick();
    assert(car.rotation.y > yaw, 'Steering turns the car');
    keys = new Set(['Space']); for (let i = 0; i < 120; i++) tick();
    const stopped = car.position.clone(); for (let i = 0; i < 30; i++) tick();
    assert(car.position.distanceTo(stopped) < 1e-8, 'Brake stops the car');
    // Deliberately aim at every border at high throttle, including slow-frame updates.
    for (const [x, z, yaw] of [[47, 0, Math.PI / 2], [-47, 0, -Math.PI / 2], [0, 47, 0], [0, -47, Math.PI]]) {
      car.position.set(x!, 0.43, z!); car.rotation.y = yaw!;
      keys = new Set(['KeyW']); edges.add('Enter'); tick();
      for (let i = 0; i < 60; i++) tick(0.25);
      assert(Math.abs(car.position.x) < 49 && Math.abs(car.position.z) < 49, 'Borders block the full car footprint');
      keys = new Set(['KeyS']); for (let i = 0; i < 60; i++) tick();
      assert(Math.abs(car.position.x) < 47 || Math.abs(car.position.z) < 47, 'Car can reverse away from a collision');
    }
    graph.updateWorldMatrix(true, true);
    for (const id of ['city_body_0', 'city_tree_trunk_0', 'city_fountain_base', 'city_car_1']) {
      const obstacle = projection.registry.byId.get(id)!;
      const half = obstacle.collision!.halfExtents;
      const box = new three.Box3(half.clone().negate(), half.clone()).applyMatrix4(obstacle.matrixWorld);
      car.position.set(box.min.x - 2, 0.43, (box.min.z + box.max.z) / 2);
      car.rotation.y = Math.PI / 2;
      const start = car.position.x;
      keys = new Set(['KeyW']); edges.add('Enter'); tick();
      for (let i = 0; i < 120; i++) tick();
      assert(car.position.x > start + 0.1, `${id}: car approaches obstacle`);
      assert(car.position.x <= box.min.x - 1.09, `${id}: collider blocks the car`);
    }
    keys.clear(); edges.add('KeyR'); tick();
    assert(camera.position.equals(overview), 'Restart restores overview');
    assert.deepEqual(scene, validatePlayableScene(JSON.parse(readFileSync(new URL('scenes/main.scene.json', root), 'utf8'))), 'Play leaves authored scene unchanged');
    console.log('Driving verified: compiled script, repeated tour loops, Enter/chase camera, throttle, steering, braking, four borders, reverse and restart.');
  } finally { host.stop(); disposeGraph(graph); projection.materials.dispose(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

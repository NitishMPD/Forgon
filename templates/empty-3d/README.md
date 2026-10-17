# Empty 3D fixture
Author: Nitish

Minimal schema-v1 project with one scene, a camera and two lights. No geometry, prefabs, assets or executable project code. `authoring/generated.json` keeps built-in generator metadata outside the core scene schema. The default seed is `forgon`.

After workspace installation, from the repository root:

```powershell
pnpm --filter @forgon/cli forge inspect ../../templates/empty-3d
pnpm --filter @forgon/cli forge validate ../../templates/empty-3d
pnpm --filter @forgon/cli forge bake ../../templates/empty-3d
```

Bake prints a `{scene, authoring}` bundle and never writes project files. Project creation/open UI and safe persistence await project-io integration. Runtime camera/light support requires engine integration; catalog validity alone does not establish rendering.

# Campaigns: full games on the Forgon runtime
Author: Nitish

Status: implemented for Rooftop Relay (17 October 2026). This note records the contract so later games do not fork it.

## Why

A demo is one scene with a mechanic. A full game needs a shell (menu, course select, results, pause, settings), progression (medals, unlocks, best times), persistence and a multi-scene build. None of that existed: the web player mounted `startScene` and stopped. Rooftop Relay is the first project that exercises all of it.

## Document

`progression/campaign.json`, referenced by `game.project.json` as `campaign`, is a strict versioned document:

```json
{
  "schemaVersion": 1,
  "campaignId": "gen_…",
  "title": "Rooftop Relay",
  "tagline": "Five rooftop routes. One relay.",
  "unlock": "sequential",
  "credits": "…",
  "courses": [
    { "sceneId": "gen_…", "name": "First Drop", "subtitle": "…",
      "goldSeconds": 26, "silverSeconds": 36, "bronzeSeconds": 50 }
  ]
}
```

Rules enforced by `parseCampaign`/`validateProject`: unique course scene references that are registered in the manifest, gold < silver < bronze, 1–64 courses, project-wide ID uniqueness with manifest/asset/prefab/scene IDs. A manifest that declares a campaign but does not provide one fails validation; `project-io` reads and claims the file like any other catalog document.

## Runtime

- `mountCampaign(container, { campaign, scenes, assets, prefabs, loadAssetBytes, storage? })` validates every course before showing a menu, boots GPU/physics lazily on the first Play (audio is created inside that click gesture), and starts one detached play session per course on the same surface.
- `src/game/campaign.ts` owns medals, unlock rules, best-hit recording, tolerant save migration and `formatSeconds`; it is DOM-free and headlessly tested.
- `src/game/shell.ts` owns the menu DOM (title, courses, results, pause, settings, credits, loading, error). It never mutates progress; it renders whatever the adapter passes and calls back for actions.
- `src/game/campaign-mount.ts` is the adapter: play/retry/next/quit, Esc/P pause, results → record → persist, settings → live volume/sensitivity, faults → error screen.
- Save key: `forgon.campaign.<campaignId>.v1`. Version mismatch, wrong campaign ID or unparsable JSON resets to a fresh save. Settings are clamped on load. A refused write (quota/private mode) is reported to the caller and the session continues in memory.
- `PlaySession` gained `setPaused`, `setVolume` and cue routing (`audio.on = any|arrival|checkpoint|goal|death`); HUD accepts a label/controls and can drop its built-in finish card when the shell owns results.

## Export

`forge build --target web` includes the campaign document in `game.json`. The web player mounts `mountCampaign` when a campaign is present and keeps the old single-scene path otherwise. The shell is part of the runtime bundle, so a campaign export is self-contained. Script components are still rejected by the exporter; campaign games must use the component vocabulary.

## Known gaps

- Studio Play still mounts one scene; the studio does not yet hand the campaign shell to the viewport.
- The authoring artifact tracks the generated base scene only, so `forge bake` regenerates course 1 of a campaign.
- No level-select thumbnails, cloud save, localization, or Windows game export.

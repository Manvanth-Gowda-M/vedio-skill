# ADR 0001 — CreatorFlow architecture

Status: accepted (Stage A) · Date: 2026-10-22

## Context

CreatorFlow is a portable agent skill plus toolkit that helps one creator plan and produce research-backed, faceless videos. It must work across Antigravity, Claude Code, Kiro and OpenCode, run free/local first, never fabricate research or completed work, and stop before public publishing.

Environment audit (2026-10-22, the development machine):

| Item | Finding |
|---|---|
| Repository | Empty directory, not a git repository. `git init` performed; no commits made. |
| OS / hardware | Windows 11 (NT 10.0.26200), Intel i5-11400H (12 threads), 7.7 GiB RAM, ~44–90 GB free disk. |
| Node / npm / pnpm / git | Node 22.20.0, npm 11.15 (npm 10.9 bundled), pnpm 11.3, git 2.51. |
| FFmpeg / ffprobe | **Not installed.** Blocks technical QA (Stage H) until installed. |
| Browser | Google Chrome installed (usable by Remotion; Remotion can also fetch Chrome Headless Shell). |
| Current packages | remotion 4.0.537, zod 4.6.7, commander 15.0.0 (Node ≥ 22.12), vitest 5.0.5 (Node ^22.12 / ^24 / ≥26), typescript 7.0.2, yaml 2.9.1. |

## Decisions

1. **TypeScript on Node ≥ 22.18 with native type stripping; no build step.** Sources use only erasable syntax (no enums, namespaces or parameter properties) and `.ts` import specifiers. `tsc --noEmit` (TS 7) is the typechecker. This removes a build pipeline and makes the skill runnable straight from a checkout. Verified: workspace package imports of `.ts` run on Node 22.20 without warnings.
2. **npm workspaces** (`packages/*`) rather than pnpm: npm ships with Node, so agents can always run it. Dependencies are pinned to exact versions.
3. **Packages are created only when they contain real code.** Stage B ships `core`, `schemas`, `cli`. The other areas from the brief (orchestrator, research, planner, scriptwriter, localization, asset-manager, voice, video-engine, quality, publishing, `apps/remotion-studio`, `providers/`) are added in the stage that implements them.
4. **Zod 4 is the single source of truth for artifact schemas.** JSON Schema (draft 2020-12) files are generated into `packages/schemas/json/` and a test fails if they are stale. Profile (who the creator is) and config (how CreatorFlow runs: paths, providers, budget) are separate files so personal preferences and machine settings change independently.
5. **CLI: commander 15**, one `main(argv, deps)` function that returns an exit code (no `process.exit` inside), `--json` for machine output on stdout, diagnostics on stderr, stable exit codes (0/1/2/3/4/70) and errors with `code`, `hint`, `details`.
6. **Skill: one portable Agent Skills directory** (`skills/creatorflow/`) with a short SKILL.md and progressive-disclosure references. **No per-agent adapter code**: all four agents discover standard `SKILL.md` folders, so the only per-agent difference is the install path, handled by `creatorflow skill install --agent`. Adapters will be added only if an agent needs different discovery or execution.
7. **Safety defaults are enforced in schemas, not just documented**: publishing is the literal `manual-only` / `package-only`; paid providers require `allowPaidProviders` and a positive monthly limit; secrets are referenced by env-var name and a secret scan fails validation; config paths must be relative and may not contain `..`.
8. **Free-first provider defaults** with explicit unavailability: research `manual-sources`, llm `agent-host`, storage `local-fs`, publishing `package-only`; tts/image/video `none`. No provider is silently substituted.
9. **Atomic writes** (temp file + fsync + rename, with Windows lock retries) for all persisted state; `init` keeps `.bak` copies and does not rewrite unchanged files.
10. **Subprocesses use argument arrays** (`execFile`), never shell strings. On Windows, `.cmd` shims are not spawned without a shell (Node refuses since the CVE-2024-27980 fix); npm is run via its JS entry point instead.

## Licensing review

| Component | Licence | Implication |
|---|---|---|
| CreatorFlow code | MIT | — |
| Remotion | Remotion License (source-available) | Free for individuals and companies of up to 3 people; larger organisations need a paid company licence (remotion.dev/docs/license/pricing, checked 2026-10-22). Not OSI open source. |
| FFmpeg | LGPL-2.1+ / GPL-2+ depending on build | Called as an external binary installed by the user; not redistributed. |
| Default fonts (Inter, JetBrains Mono) | SIL OFL 1.1 | Free to embed in videos. |
| zod, commander, yaml, vitest, typescript | MIT / Apache-2.0 / ISC | Permissive. |

We do not claim the complete system is free for every commercial use: Remotion's licence and any user-selected providers, music or B-roll have their own terms.

## Consequences and risks

- **FFmpeg missing** on this machine: Stage F (render) can proceed via Remotion's bundled tooling, but Stage H technical checks need ffprobe. `doctor` reports it with an install hint.
- **7.7 GiB RAM**: renders should run one at a time; config defaults `maxConcurrentRenders: 1`.
- Native type stripping requires Node ≥ 22.18; the launcher checks this and exits with code 3 otherwise.
- Remotion licence restricts larger teams; documented in the skill's safety reference.
- Agent loading of the installed skill is verified only for file placement, not inside each live agent (see `skills/creatorflow/references/agent-compatibility.md`).

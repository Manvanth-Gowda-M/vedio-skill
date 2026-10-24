# Agent compatibility

The skill is a standard [Agent Skills](https://agentskills.io/specification) directory. No agent-specific adapter code is needed in this release: every supported agent discovers `SKILL.md` folders, and the CLI is the same for all of them.

Install with `creatorflow skill install --agent <id> [--scope project|user]`.

| Agent | `--agent` | Project location | User location | Status |
|---|---|---|---|---|
| Kiro CLI | `kiro` | `.kiro/skills/creatorflow` | `~/.kiro/skills/creatorflow` | Discovery paths from Kiro docs. Install copy tested. Loading in a live session: not yet verified. |
| Claude Code | `claude-code` | `.claude/skills/creatorflow` | `~/.claude/skills/creatorflow` | Paths per Anthropic docs. Install copy tested. Live loading: not verified (not installed here). |
| OpenCode | `opencode` | `.opencode/skills/creatorflow` | `~/.config/opencode/skills/creatorflow` | Paths per opencode.ai/docs/skills. OpenCode also reads `.claude/skills` and `.agents/skills`. Live loading: not verified. |
| Antigravity App / IDE | `antigravity` | `.agents/skills/creatorflow` | `~/.gemini/config/skills/creatorflow` | Paths per antigravity.google/docs/skills. Live loading: not verified. |
| Antigravity CLI | `antigravity-cli` | `.agents/skills/creatorflow` | `~/.gemini/antigravity-cli/skills/creatorflow` | Same source. Live loading: not verified. |

"Install copy tested" means the automated tests check that the files land in the documented directory and validate against the spec. It does not prove the agent loads them; check that in the agent's own skill or context listing.

## Untested assumptions

- Agents that do not support `allowed-tools` ignore it; this skill does not set it so permission behaviour stays under the user's control.
- Kiro reads `name` and `description` and loads the body on demand; other frontmatter keys are assumed to be ignored safely.
- Antigravity CLI converts skills to slash commands (`/creatorflow`) per its docs.

## Capability expectations

The skill needs shell execution and file read/write in the project directory. Browser automation and network access are optional and only used for research when the user enables them.

---
status: accepted
---

# Provider-owned Skill discovery

Update 2026-11-10: the leading-only composer flow below is superseded by ADR-0002's cursor-local inline Skill references. Provider-owned discovery and send-time revalidation remain unchanged; Athena still uses `/skill-name`, not `$skill-name`.

Athena treats the current CLI Agent adapter as the authoritative source of user-selectable Skills. Each supported adapter returns normalized Skill metadata, including a name, description, optional short description/path/hash, user-invocable state, and capability status; Athena presents that metadata through the existing leading `/skill-name` composer flow and re-requests the current adapter list before sending. Athena no longer decides menu availability by strictly parsing local `SKILL.md` frontmatter or applying its own 12KB limit. It retains the path-safety boundary for any provider path it receives and never executes Skill scripts or resources itself. When the current adapter cannot provide Skills, Athena shows an explicit no-Skill-capability state and does not fall back to local workspace/global scanning in this decision.

The existing slash syntax remains `/skill-name` even though the T3 Code reference uses `$skill-name` for Skills; the reference informs provider-owned discovery, not a syntax change. The first adapter scope is Codex, Claude Code, Gemini CLI, Pi, and Cursor Agent, with unsupported capability reported rather than silently inferred.

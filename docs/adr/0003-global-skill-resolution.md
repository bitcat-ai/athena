---
status: accepted
---

# Global Skill resolution

Athena resolves Skills from both the current workspace's `.agents/skills` directory and the current user's fixed `~/.agents/skills` directory. Both sources use the same metadata, size, hash, and path-containment validation; a global package must remain inside the user's home-scoped global root, and escaping symlinks are rejected. Resolution is task-level and explicit. When both sources contain the same Skill name, the Workspace Skill overrides the Global Skill and the menu exposes only the resulting effective Skill, preserving the existing `/skill-name` reference syntax. The menu rescans both roots when opened and the send boundary rescans and revalidates them again; unavailable global Skills degrade with diagnostics and never block workspace tasks. Usage metadata records source, normalized path, and content hash without copying the Skill body, while legacy workspace-only records remain readable without migration.

This preserves project-local customization, avoids silently applying global guidance, gives both scopes the same trust boundary, and keeps the visible selection syntax unambiguous.

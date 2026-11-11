---
status: accepted
---

# Skill slash selection

## Superseding decision — 2026-11-10

The composer now follows T3 Code's cursor-local Skill picker and inline atom interaction, retaining Athena's `/skill-name` spelling. A slash token at the start of a whitespace-delimited token can open the picker anywhere in the draft; URL and path tokens remain text. Arrow keys navigate, Tab and Enter select, and Escape dismisses. Selection replaces only the current token and preserves surrounding text. Skill references are colored, atomic inline items, not individually editable name characters.

The structured editor document is the draft source of truth. Sending derives task text and explicit Skill names from the same document; the host does not infer Skills from arbitrary leading slash text. Text import recognizes only known invocable Skills. Existing provider revalidation, duplicate rejection and the three-Skill limit remain in force. This supersedes the leading-only/plain-text decisions below.

## Implementation note — 2026-11-11

The picker is built on the composer's existing token input, the one that carries inline element mentions, not on a separate rich-text editor. Its token segments are the structured draft. Enter selects the highlighted Skill, or the first available one when none is highlighted; Tab does not select. Only a menu selection creates a Skill reference: typed, pasted or imported text stays text.

## Original decision

Athena uses a leading slash in the task composer as an explicit Skill-selection affordance: when `/` is the first draft character, it opens a workspace Skill menu; selecting an available Skill inserts the editable `/skill-name ` reference and closes the menu. The menu supports name filtering, ArrowUp/ArrowDown navigation, Enter selection, and Escape dismissal; it rejects duplicate references and disables further available Skills after three selections. At send time Athena parses only the consecutive Skill references at the beginning of the draft, removes those references from the task text, and re-scans the workspace before sending; stale or unavailable references remain visible and block sending rather than being silently removed. A slash in ordinary text, a URL, or a path remains ordinary editable text.

This keeps the visible draft understandable and removable with normal text editing, avoids treating arbitrary slash text as a command, preserves the existing three-Skill domain limit, and does not infer undocumented parsing behavior from the public T3 Code reference.

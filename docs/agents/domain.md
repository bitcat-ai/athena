# Domain documentation

## Layout

Athena is a single-context repository:

- `GLOSSARY.md` contains domain vocabulary only.
- `docs/adr/` contains accepted architectural decisions.

## Consumer rules

Read the glossary and relevant ADRs before changing a domain area. Use canonical glossary terms in specifications and code discussions. When a term is clarified, update `GLOSSARY.md` immediately. Create an ADR only for a hard-to-reverse decision that would otherwise be surprising and that resulted from a meaningful trade-off.

Keep the glossary free of implementation details, specifications, and scratch notes. Keep ADRs focused on context, decision, alternatives, and consequences.

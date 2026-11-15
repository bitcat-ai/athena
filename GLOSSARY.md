# Athena domain language

Athena coordinates local CLI Agents, reusable workspace guidance, and explicitly approved external Agent access.

## Skills and task selection

**Workspace Skill**:
A reusable guidance package in the current workspace's `.agents/skills` directory whose `SKILL.md` entry can be validated and selected for one task.
_Avoid_: slash command, prompt template, plugin

**Global Skill**:
A reusable guidance package in the current user's `~/.agents/skills` directory that can be selected for one task when no same-named Workspace Skill overrides it.
_Avoid_: user-level plugin, default Skill

**Provider Skill**:
A Skill advertised by the current CLI Agent adapter through its normalized Skill discovery capability. Its availability and metadata are owned by that provider rather than inferred from Athena's local filesystem scan.
_Avoid_: local Skill, automatically trusted Skill

**Skill source**:
The scope from which a Skill is resolved: workspace, global, or provider. Workspace and global identify local packages; provider identifies metadata advertised by the current CLI Agent adapter.
_Avoid_: trust level, installation scope

**Skill reference**:
An explicit `/skill-name` reference to a selected Skill anywhere in a task draft, represented as a single inline item distinct from ordinary task text.
_Avoid_: hidden command, leading-only command

**Skill injection**:
The bounded task context Athena sends to a CLI Agent for selected Skills, containing identity, description, hash, and controlled entry path rather than a copied Skill body.
_Avoid_: automatic Skill execution, prompt expansion

**Available Skill**:
A Workspace Skill or Global Skill that passes Athena's entry-file, metadata, path-containment, and size checks at the time it is listed or revalidated.
_Avoid_: installed Skill, enabled Skill

## External access

**Athena MCP Endpoint**:
Athena's loopback HTTP boundary through which an explicitly approved external Agent can access the operations allowed by its effective access mode.
_Avoid_: raw MCP server, Electron IPC, browser automation endpoint

**External Agent**:
A process outside Athena's local CLI execution flow that requests access through the Athena MCP Endpoint.
_Avoid_: remote user, CLI Agent

**Access mode**:
The effective permission level granted to an external Agent: read-only, supervised, or full.
_Avoid_: authentication level, trust level

**External thread**:
An external Agent's handle mapped to an existing Athena Conversation and AgentSession lifecycle.
_Avoid_: separate Thread model, raw CLI thread

## Local records and webpage interaction

**Local profile**:
The local collection of Athena preferences, conversations, interaction history and saved knowledge belonging to one application data identity.
_Avoid_: cloud account, tenant, project workspace

**Workspace**:
The project directory or personal working location selected for a task. It does not own every record in the Local profile.
_Avoid_: all application data, browser profile

**Interaction evidence**:
A recorded action, observation, result or artifact used to explain and check what happened on a webpage.
_Avoid_: execution permission, proof that every business effect succeeded

**Execution authority**:
The current permission for a task or participant to act on a particular live page. Historical evidence does not preserve this permission.
_Avoid_: saved approval, permanent page ownership

**Historical reference**:
An identifier retained to explain a record's origin even when the original conversation, page or task no longer exists.
_Avoid_: live object handle, permission to replay

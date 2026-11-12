import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_BROWSER_VERSION, ensureAgentBrowserBinary } from '../src/main/agent-browser-server';

// Development copy of the pinned official release, verified by SHA-256. Nothing is launched.
process.chdir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const binary = await ensureAgentBrowserBinary(path.resolve('.runtime/agent-browser'));
console.log(`agent-browser ${AGENT_BROWSER_VERSION} verified at:\n${binary}`);

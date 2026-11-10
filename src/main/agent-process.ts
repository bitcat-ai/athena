import path from 'node:path';

/** A local CLI runs with the user's own environment: its provider keys and configuration are its business. */
export function cliEnvironment(executable: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${path.dirname(executable)}${path.delimiter}${process.env.PATH ?? '/usr/bin:/bin'}`,
  };
}

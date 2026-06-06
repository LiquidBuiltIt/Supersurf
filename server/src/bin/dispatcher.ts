export type Target = 'mcp' | 'daemon' | 'creds' | 'help';

export interface DispatchPlan {
  target: Target;
  remainingArgv: string[];
}

export const HELP_TEXT = `supersurf — MCP browser automation for AI agents

Usage: supersurf <command> [options]

Commands:
  mcp       Start the MCP server over stdio (the agent entrypoint)
  daemon    Manage the coordinator daemon: start | stop | restart | status | observe
  creds     Manage credentials in the OS keychain: add | list | rm

Examples:
  npx supersurf@latest mcp
  supersurf daemon status
  supersurf creds add github`;

export function pickTarget(argv: string[]): DispatchPlan {
  const subcommand = argv[2];
  if (subcommand === 'mcp' || subcommand === 'daemon' || subcommand === 'creds') {
    return {
      target: subcommand,
      remainingArgv: [...argv.slice(0, 2), ...argv.slice(3)],
    };
  }
  // No recognized subcommand — intentionally do NOT default to the MCP
  // server. A bare invocation (or --help) prints usage; an unrecognized
  // command is a usage error. This keeps the entrypoint explicit so a
  // misconfigured caller gets help instead of a silently-hanging stdio server.
  return { target: 'help', remainingArgv: argv };
}

export async function dispatch(argv: string[]): Promise<void> {
  const { target, remainingArgv } = pickTarget(argv);

  if (target === 'help') {
    const sub = argv[2];
    if (sub === undefined || sub === '--help' || sub === '-h') {
      // Bare `supersurf` or an explicit help flag → usage on stdout, exit 0.
      console.log(HELP_TEXT);
      return;
    }
    // Unrecognized command → usage on stderr, non-zero exit.
    console.error(`supersurf: unknown command '${sub}'\n`);
    console.error(HELP_TEXT);
    process.exit(1);
  }

  process.argv = remainingArgv;
  if (target === 'mcp') {
    await import('../cli');
  } else if (target === 'daemon') {
    // @ts-ignore - resolved at runtime after daemon bundle copy
    await import('../daemon/main');
  } else {
    const credsModule = await import('./creds');
    await credsModule.runCredsProgram(remainingArgv);
  }
}

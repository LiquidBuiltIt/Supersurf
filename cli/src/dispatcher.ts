import { checkAndTouchVersionState, UPGRADE_NOTICE_MESSAGE } from 'shared';
import { shellOut } from './shell-out';
import { VERSION } from './version';

export type Target = 'mcp' | 'daemon' | 'profiles' | 'export' | 'playbook' | 'creds' | 'help';

export interface DispatchPlan {
  target: Target;
  remainingArgv: string[];
}

export const HELP_TEXT = `supersurf — MCP browser automation for AI agents

Usage: supersurf <command> [options]

Commands:
  mcp       Start the MCP server over stdio (the agent entrypoint)
  daemon    Manage the coordinator daemon: start | stop | restart | status | observe
  profiles  Manage browser profiles: ls | open <name> | create <name> | rm <name> | rename <old> <new>
  export    Bundle usage-metrics logs into a .zip in the current directory
  playbook  Playbook scripts: ls | inspect <name> | validate [name] | run <name> [--param k=v] | migrate

Examples:
  supersurf mcp
  supersurf daemon status
  supersurf profiles open dev
  supersurf export
  supersurf playbook ls`;

export function pickTarget(argv: string[]): DispatchPlan {
  const subcommand = argv[2];
  if (
    subcommand === 'mcp' ||
    subcommand === 'daemon' ||
    subcommand === 'profiles' ||
    subcommand === 'export' ||
    subcommand === 'playbook'
  ) {
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

  // `mcp` (JSON-RPC over stdout — see cli.ts) and `daemon` (its own CLI in
  // daemon/src/main.ts, imported below) each own their own stderr-only/human
  // notice check. Every other subcommand here — profiles, export, help/usage
  // errors — is plain human-facing stdio, so the notice is safe on stdout.
  if (target !== 'mcp' && target !== 'daemon') {
    const versionCheck = checkAndTouchVersionState(VERSION);
    if (versionCheck.shouldNotify) {
      console.log(UPGRADE_NOTICE_MESSAGE);
    }
  }

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
    // Shell out with real fd inheritance: `mcp` is a stdio protocol server, so a
    // relay would corrupt the JSON-RPC stream. Pinned to this binary's version.
    shellOut('supersurf-mcp', remainingArgv.slice(2));
  } else if (target === 'daemon') {
    shellOut('supersurf-daemon', remainingArgv.slice(2));
  } else if (target === 'profiles') {
    const { runProfilesCli } = await import('./profiles-cli');
    await runProfilesCli(remainingArgv);
  } else if (target === 'export') {
    const { runExportProgram } = await import('./export');
    const code = await runExportProgram(remainingArgv);
    process.exit(code);
  } else if (target === 'playbook') {
    const { runPlaybookProgram } = await import('./playbook-cli');
    await runPlaybookProgram(remainingArgv);
  } else {
    // Unreachable until `creds` is re-listed in pickTarget — kept intentionally
    // (delisting is reversible; the keychain CLI is dead-but-ready, not deleted).
    const credsModule = await import('./creds');
    await credsModule.runCredsProgram(remainingArgv);
  }
}

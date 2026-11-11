/**
 * The server's `EngineHost`: wires the engine to this package's daemon
 * lifecycle, config merge and version.
 *
 * @module engine-host
 */
import type { EngineHost } from './host';
import { openSocketLink } from './socket-link';
import { queryDaemonStatus } from './daemon-spawn';
import { buildConfigService, backendConfigFrom } from './backend-config';

export function createEngineHost(version: string): EngineHost {
  return {
    packageVersion: version,
    openLink: openSocketLink,
    queryDaemonStatus: () => queryDaemonStatus(),
    runConfig: () => backendConfigFrom(buildConfigService({}), version),
  };
}

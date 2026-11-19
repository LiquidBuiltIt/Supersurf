// Test fixture: the `entry.main` a hand-off spawns as the successor.
// Behaviour comes from <HOME>/fixture.json: { mode, delayMs, port, main }.
//   exit-early  print a boot error and exit 1
//   hang        stay alive, bind nothing
//   exit-after  wait delayMs, then exit 1
//   (default)   wait delayMs, optionally swap `--port`, then load the real daemon (cfg.main)
// Every start appends its pid to <HOME>/successors.log.
const fs = require('fs');
const path = require('path');

const home = process.env.HOME;
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path.join(home, 'fixture.json'), 'utf8')); } catch {}
fs.appendFileSync(path.join(home, 'successors.log'), `${process.pid}\n`);

if (cfg.mode === 'exit-early') {
  console.error('fixture successor: boot failure');
  process.exit(1);
} else if (cfg.mode === 'exit-after') {
  setTimeout(() => process.exit(1), cfg.delayMs || 0);
} else if (cfg.mode === 'hang') {
  setInterval(() => {}, 1000);
} else {
  if (cfg.port) {
    const i = process.argv.indexOf('--port');
    if (i !== -1) process.argv[i + 1] = String(cfg.port);
  }
  setTimeout(() => require(cfg.main), cfg.delayMs || 0);
}

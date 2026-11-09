// Runs a command again when it fails: `node scripts/retry.mjs <attempts> <delay-seconds> <command> [args...]`.
// CI wraps `npm ci` in it, because the native downloads of its install scripts fail on a passing
// GitHub 504 with no retry of their own (torrent-tv/meta#338). Exits with the last attempt's code.
import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const [attemptsArg, delayArg, command, ...args] = process.argv.slice(2);
const attempts = /^\d+$/.test(attemptsArg ?? "") ? Number(attemptsArg) : 0;
const delay = /^\d+(\.\d+)?$/.test(delayArg ?? "") ? Number(delayArg) : -1;

if (attempts < 1 || delay < 0 || !command) {
  process.stderr.write("usage: node scripts/retry.mjs <attempts ≥ 1> <delay-seconds ≥ 0> <command> [args...]\n");
  process.exit(2);
}

for (let attempt = 1; ; attempt += 1) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) {
    process.stderr.write(`${command}: ${result.error.message}\n`);
    process.exit(127);
  }
  const code = result.status ?? 1;
  if (code === 0 || attempt === attempts) process.exit(code);
  process.stderr.write(
    `::warning::${command} failed on attempt ${attempt} of ${attempts} (exit ${code}); retrying in ${delay} s\n`
  );
  await sleep(delay * 1000);
}

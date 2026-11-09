// Runs one service: `tsx scripts/service.ts <name>`. scripts/dev.ts spawns one of these per service.
const NAMES = ['simulator', 'market-gateway', 'planner', 'evaluator', 'signer', 'chain-gateway', 'orchestrator'];
const name = process.argv[2];
if (!NAMES.includes(name)) {
  console.error(`usage: service.ts <${NAMES.join('|')}>`);
  process.exit(2);
}
// Under dev.ts, stdin is a pipe from the parent: when the parent dies, even by a hard kill that runs
// no exit handler (Windows TerminateProcess), the pipe closes and this service exits instead of lingering.
if (process.env.ROOK_DEV_CHILD === '1') {
  process.stdin.on('close', () => process.exit(0)).on('end', () => process.exit(0)).resume();
}
// The real orchestrator keeps tasks across restarts; tests call start() directly and stay in memory.
if (name === 'orchestrator') process.env.ROOK_DB ??= new URL('../data/rook.sqlite', import.meta.url).pathname;
const { start } = await import(`../src/${name}/index.ts`);
const r = await start();
console.log(`listening on ${r.url}`);

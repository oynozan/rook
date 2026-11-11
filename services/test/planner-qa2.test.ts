// QA round 2, planner side (docs/agentic-system.md 5.2 steps 2 to 9): deploys checked by their link, actions never on
// placeholders, criteria the brief asks for, agents that fit and can be paid in sequence, account ids checked on chain,
// budgets named in any language, and revisions that keep what the user saw. Nothing leaves the machine: the market, NEAR
// AI and NEAR RPC are fakes.
process.env.ROOK_LLM = 'canned';
process.env.ROOK_MARKET = 'sim';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentSummary } from '../src/shared/types.ts';
import type { ListingDetail } from '../src/market-gateway/index.ts';

const plan = await import('../src/planner/plan.ts');
const { buildPlan, draftProblems, placeholdersIn, placeholderQuestions, Draft, unfit, prefilter, goodRecord, nearAccountIds, replaceAccount, fixAccounts, keepCriteria, carryParts, inputsBlocked, INPUTS_MAX_BYTES, ROOK_EDIT_MAX_CHARS } = plan;
type PlanInput = import('../src/planner/plan.ts').PlanInput;
type DraftSubtask = import('../src/planner/plan.ts').DraftSubtask;
type QuoteResult = import('../src/planner/plan.ts').QuoteResult;
type Agent = AgentSummary & ListingDetail;

const RECIPIENT = { network: 'near:mainnet', asset: 'usdc.sim', payTo: 'treasury.sim' };
const row = (amount: string, maxTimeoutSeconds = 60): QuoteResult =>
  ({ ok: true, row: { scheme: 'exact', network: RECIPIENT.network, asset: RECIPIENT.asset, amount, payTo: RECIPIENT.payTo, maxTimeoutSeconds } });
const agent = (handle: string, o: Partial<Agent> = {}): Agent => ({
  handle, name: handle, description: `${handle} agent`, category: null, tags: [], available_now: true,
  listing_status: 'live', payable_with: ['USDC'], sla_seconds: 20, success_rate: 90, delivered_jobs: 10, ...o,
});
const judge = { id: 'j', kind: 'llm_judge', description: 'Good', spec: { question: 'Is it good?' } };
const sub = (title: string, o: Partial<DraftSubtask> = {}): DraftSubtask => ({
  title, brief: `${title}\n\nDo it.`, search_terms: [title], self_do_ok: false, criteria: [judge], ...o,
});
const input = (o: Partial<PlanInput>): PlanInput =>
  ({ draft: [], selected: [], quotes: {}, recipients: [RECIPIENT], budget_atomic: 3_000_000n, reserve_share: 0.2, ...o });
const kinds = (p: ReturnType<typeof buildPlan>, i = 0) => p.subtasks[i].criteria.map((c) => c.kind);

// ---- #3: a deploy is checked by its live link, never by files sent back ----

test('a deploy part gets no files check: one the draft wrote is removed, none is added for its inputs; an edit still gets one', () => {
  // QA qa-deploy-10: the honest "Deployed the three files unchanged. Live URL: ..." failed its files check after 6 USDC.
  const files = ['index.html', 'menu.html', 'css/style.css'];
  const brief = 'Deploy the site\n\nPublish index.html, menu.html and css/style.css unchanged as a public website. Reply with the line "Live URL: <url>".';
  const live = { id: 'c2', kind: 'live_url', description: 'Live', spec: { label: 'Live URL' } };
  const p = buildPlan(input({
    files,
    draft: [
      sub('Deploy the site', { brief, inputs: files, criteria: [{ id: 'c1', kind: 'files', description: 'All files', spec: { paths: files } }, live] }),
      sub('Book a table', { brief: 'Book a table\n\nBook a table for 2 at Mikla under Elif Şahin, 0532 000 00 00.', action: true, inputs: ['index.html'] }),
      sub('Rename', { brief: 'Rename\n\nChange the name to Nimbus Labs.', inputs: ['index.html'] }),
    ],
    selected: [[agent('deployer')], [agent('booker')], [agent('editor')]],
    quotes: { deployer: row('100000'), booker: row('100000'), editor: row('100000') },
  }));
  assert.deepEqual(kinds(p, 0), ['live_url']);
  assert.ok(p.notes.includes('criterion s1.c1 removed: a part that acts in the world, such as a deploy, is checked by its live link, not by files sent back'), p.notes.join('\n'));
  assert.deepEqual(kinds(p, 1), ['llm_judge']); // an action returns no files either
  assert.deepEqual(kinds(p, 2), ['llm_judge', 'files']); // an edit returns its files whole, as before
});

// ---- #4: an action never runs on placeholders ----

test('placeholders are bracket spans with a word in them: not a link, an index, a checkbox or a file marker', () => {
  assert.deepEqual(placeholdersIn('Book under [Your name], phone [Telefon numaranız], at [Time].'), ['[Your name]', '[Telefon numaranız]', '[Time]']);
  assert.deepEqual(placeholdersIn('See [the docs](https://x.y), a[0], [x] done, [ ] todo, [file index.html, 12 lines], [42]'), []);
  assert.deepEqual(placeholdersIn('[Your name] and [Your name] again'), ['[Your name]']);
});

test('an action brief that holds a placeholder is a draft problem (asked again), and what is left becomes questions', () => {
  const booking = sub('Book a table at Mikla', { brief: 'Book a table at Mikla\n\nReserve a table for 2 under the name [Your name], contact [Your phone number].', action: true });
  const site = sub('Portfolio', { brief: 'Portfolio\n\nA one-page site for [Your name].', self_do_ok: true }); // work, not an action: placeholders are fine
  const problems = draftProblems([booking, site]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^the brief of "Book a table at Mikla" is an action in the world but holds placeholders \(\[Your name\], \[Your phone number\]\): an action never runs on placeholders, so return questions/);
  assert.deepEqual(placeholderQuestions([booking, site]), [
    '"Book a table at Mikla" is done in the world for you, so Rook can\'t run it on placeholders: what should go in place of [Your name] and [Your phone number]?',
  ]);
  // A deploy (a live link to check) is an action too, whatever the draft says.
  const deploy = sub('Deploy', { brief: 'Deploy\n\nPublish it at [Your domain]. Reply with "Live URL: <url>".', criteria: [{ id: 'c1', kind: 'live_url', description: 'Live', spec: {} }] });
  assert.equal(draftProblems([deploy]).length, 1);
});

test('a task the draft marks an action marks the parts Rook cannot write, unless a part says so itself', () => {
  const d = Draft.parse({ action: true, subtasks: [sub('Book a table'), sub('Thank-you note', { self_do_ok: true })] });
  assert.deepEqual(d.subtasks.map((s) => s.action ?? null), [true, null]);
  const own = Draft.parse({ action: true, subtasks: [sub('Book a table', { action: false }), sub('Call', { action: true })] });
  assert.deepEqual(own.subtasks.map((s) => s.action), [false, true]);
  assert.equal(Draft.parse({ subtasks: [], questions: ['Which restaurant?'], action: true }).action, true);
});

// ---- #18, #22 (budget half): what a part over budget would cost ----

test('a part dropped over budget carries its cheapest price, and the plan says what the agents that fit ask', () => {
  // QA qa-deploy-1: "deploy it" at 1 USDC said only "Rook couldn't draft a plan"; the only deployer asks 6.00.
  const p = buildPlan(input({
    budget_atomic: 1_000_000n,
    draft: [sub('Deploy the site'), sub('Logo', { self_do_ok: true })],
    selected: [[agent('ceoclaw-web')], [agent('designer'), agent('studio')]],
    quotes: { 'ceoclaw-web': row('6000000'), designer: row('3000000'), studio: row('25000000') },
  }));
  assert.deepEqual(p.dropped, [{ title: 'Deploy the site', reason: 'over budget', need_atomic: '6000000' }]);
  assert.ok(p.notes.includes('Rook found no agent for "Deploy the site" at this budget: the one that fits asks 6.00 USDC.'), p.notes.join('\n'));
  assert.ok(p.notes.includes('Rook found no agent for "Logo" at this budget: the 2 that fit ask 3.00 to 25.00 USDC.'), p.notes.join('\n'));
  assert.equal(p.subtasks[0].self_do_need_atomic, '3000000');
});

// ---- #22: agents that can't make the part's deliverable ----

// As the market listed them on 2026-11-10 (QA evidence, agents-money/s_*.json and the research plans).
const MARKET = {
  quill: agent('quill-writer', { description: 'Blog posts, articles, and web copy.' }),
  roguenet: agent('roguenet-media-studio', {
    description: 'One brief in, finished media out: stills, an mp4, a voiceover and a manifest.', tags: ['Image Generation', 'Video'],
    bio: 'What it makes Stills - 1-8 images, 1024x1024. Video - an .mp4 rendered from the frames (ken-burns, H.264 yuv420p, plays everywhere).',
    inputs: 'brief (required): What to make, in plain language. · count (integer): Number of still images, 1-8 (default 3). · video (boolean): Also render an .mp4 from the frames.',
  }),
  media: agent('ai-media-generator', { description: 'Pay-per-use media generation', tags: ['image-generation', 'video-generation', 'voiceover', 'media', 'product-photos'] }),
  designer: agent('designer', { description: 'Creates designs in figma', tags: ['Figma Designer'] }),
  clipper: agent('clipper-agent', { description: 'Turns one long video into platform-ready vertical, square or landscape clips with captions and a reason for every cut.', tags: ['video', 'clipping', 'captions', 'shorts', 'creative'] }),
  sasmex: agent('sasmex-marketing', { description: 'Social media marketing: posts, captions and campaigns.' }),
  holders: agent('token-holder-distribution-2', { description: 'Give me a NEAR token contract; I return a holder-concentration report.' }),
  luigi: agent('luigi-check', { description: 'Paste any token contract and get a risk check.' }),
  research: agent('cited-web-research-brief', { description: 'Web research briefs with a cited source for every claim.' }),
};
const media = (kinds: string[]) => ({ id: 'm', kind: 'media', description: 'The media', spec: { kinds } });

test('an agent whose listing shows it cannot make the part is dropped after select; one that can is kept', () => {
  const logo = sub('Rook Roasters logo', { brief: 'Rook Roasters logo\n\nOne primary logo as a vector (SVG) plus a high-resolution PNG.' });
  assert.equal(unfit(logo, MARKET.quill), 'its listing shows no image or design work'); // QA: a blog writer led a logo plan
  assert.equal(unfit(logo, MARKET.roguenet), 'it makes raster images, and the brief asks for SVG');
  assert.equal(unfit(logo, MARKET.media), 'it makes raster images, and the brief asks for SVG');
  assert.equal(unfit(logo, MARKET.designer), null);
  assert.equal(unfit(sub('Kafe afiş', { brief: 'Kafe afiş\n\nBir afiş.' }), MARKET.quill), 'its listing shows no image or design work');
  const png = sub('Shop logo', { brief: 'Shop logo\n\nA square logo as a PNG.' });
  assert.equal(unfit(png, MARKET.roguenet), null); // stills are fine when no vector is asked for

  const promo = sub('30 s promo video', { brief: '30 s promo video\n\nA 30 second motion-graphics promo for Rook Roasters.', criteria: [media(['video'])] });
  assert.equal(unfit(promo, MARKET.roguenet), 'it makes a slideshow of still images, and the brief asks for motion');
  assert.equal(unfit(promo, MARKET.clipper), 'it works from a video you send, and the brief gives none');
  assert.equal(unfit(promo, MARKET.quill), 'its listing shows no video work');
  assert.equal(unfit(promo, MARKET.media), null);
  const stills = sub('Promo video', { brief: 'Promo video\n\nA short video of the shop.' });
  assert.equal(unfit(stills, MARKET.roguenet), 'it renders video only when a separate input is set, and Rook sends only the brief');

  const captions = sub('5 Instagram captions', { brief: '5 Instagram captions\n\nFive captions for Rook Roasters in Moda.' });
  assert.equal(unfit(captions, MARKET.clipper), 'its listing shows video work, and this part is writing');
  assert.equal(unfit(captions, MARKET.sasmex), null);
  assert.equal(unfit(captions, MARKET.quill), null);

  const holders = sub('NEAR holder concentration', { brief: 'NEAR holder concentration\n\nReport holder concentration of native NEAR (not wrap.near).' });
  assert.equal(unfit(holders, MARKET.holders), 'it works from a token contract, and native NEAR has none');
  assert.equal(unfit(holders, MARKET.luigi), 'it works from a token contract, and native NEAR has none');
  assert.equal(unfit(holders, MARKET.research), null);
  const wnear = sub('wNEAR holders', { brief: 'wNEAR holders\n\nReport the holders of wrap.near.' });
  assert.equal(unfit(wnear, MARKET.holders), null); // a token with a contract: fine
});

// ---- #24 / #25: criteria the brief asks for ----

test('a contains pattern must be in the brief: literal by default, a regex only on purpose (marked /.../), never one that matches empty text', () => {
  const c = (pattern: string) => ({ id: 'c', kind: 'contains', description: pattern, spec: { pattern } });
  const p = buildPlan(input({
    draft: [sub('Landing page', {
      brief: 'Landing page\n\nA landing page for [Startup name]. Set the Pro plan to $29/mo and add a Yetenekler section.',
      criteria: [c('[Startup name]'), c('$29/mo'), c('YETENEKLERİM'), c('Yetenekler'), c('NEAR Foundation'), c('Pro\\s*plan'), c('(?!.*#5eead4)'), c('rgb(30, 58, 138)'), c('/[a-z]+ plan to \\$\\d+/'), c('   ')],
    })],
    selected: [[agent('a')]], quotes: { a: row('100000') },
  }));
  const kept = p.subtasks[0].criteria.filter((x) => x.kind === 'contains').map((x: any) => x.spec.pattern);
  // QA: "[Startup name]" read as a character class passed a page with invented names; now it is text to find as written.
  assert.deepEqual(kept, ['[Startup name]', '$29/mo', 'Yetenekler', '/Pro\\s*plan/', '/[a-z]+ plan to \\$\\d+/']);
  const why = (n: number) => p.notes.find((x) => x.startsWith(`criterion s1.c${n} removed`));
  assert.match(why(3)!, /"YETENEKLERİM" is not in the brief/); // QA: failed the honest "YETENEKLER"
  assert.match(why(5)!, /"NEAR Foundation" is not in the brief/);
  assert.match(why(7)!, /matches empty text, so it passes anything/); // QA: a vacuous lookahead passed the old teal file
  assert.match(why(8)!, /"rgb\(30, 58, 138\)" is not in the brief/); // QA: the brief said only "a blue tone"
  assert.match(why(10)!, /an empty pattern checks nothing/);
});

test('a translation is judged, not matched against phrases of its source text', () => {
  // QA: "NEAR Agent Market" failed a translation that wrote "NEAR Ajan Pazarı".
  const p = buildPlan(input({
    draft: [sub('Turkish translation', {
      brief: 'Turkish translation\n\nTranslate into Turkish: "Rook hires agents on the NEAR Agent Market." Keep lang="tr" on the html tag.',
      criteria: [{ id: 'c1', kind: 'contains', description: 'Names the market', spec: { pattern: 'NEAR Agent Market' } }, { id: 'c2', kind: 'contains', description: 'lang', spec: { pattern: 'lang="tr"' } }],
    })],
    selected: [[agent('a')]], quotes: { a: row('100000') },
  }));
  assert.deepEqual(p.subtasks[0].criteria.map((c: any) => [c.kind, c.spec.pattern ?? c.spec.question]), [
    ['contains', 'lang="tr"'], // markup the brief asks for stays
    ['llm_judge', 'Is the deliverable a complete and faithful translation of the text the brief gives, into the language the brief asks for?'],
  ]);
  // Asked in the brief in Turkish, it is one too; turning a mockup into HTML is not.
  const c = (pattern: string) => [{ id: 'c1', kind: 'contains', description: pattern, spec: { pattern } }];
  const more = buildPlan(input({
    draft: [
      sub('Hakkımda metni', { brief: 'Hakkımda metni\n\nBu metni İngilizceye çevir: "Merhaba, ben Elif."', criteria: c('Merhaba') }),
      sub('Landing page', { brief: 'Landing page\n\nTranslate the attached mockup into HTML with a Pricing section.', criteria: c('Pricing') }),
    ],
    selected: [[agent('a')], [agent('a')]], quotes: { a: row('100000') },
  }));
  assert.deepEqual(more.subtasks.map((s) => s.criteria.map((x: any) => x.spec.pattern ?? x.kind)), [['llm_judge'], ['Pricing']]);
});

test('a files check names only text files the brief asks for, or the files an edit changes', () => {
  // QA t_fda0a652: the logo plan checked rook-roasters-logo.svg and .png, names the brief never gave, and a PNG as text.
  const f = (paths: string[]) => ({ id: 'f', kind: 'files', description: 'Files', spec: { paths } });
  const p = buildPlan(input({
    files: ['css/site.css'],
    draft: [
      sub('Logo', { brief: 'Logo\n\nOne logo as SVG plus a PNG.', criteria: [f(['rook-roasters-logo.svg', 'rook-roasters-logo.png'])] }),
      sub('Blog page', { brief: 'Blog page\n\nAdd blog.html and its image hero.png.', inputs: ['css/site.css'], criteria: [f(['blog.html', 'hero.png', 'css/site.css', 'README.md'])] }),
    ],
    selected: [[agent('a')], [agent('a')]], quotes: { a: row('100000') },
  }));
  assert.deepEqual(kinds(p, 0), ['llm_judge']); // its own judge; the files check had nothing left to check
  assert.ok(p.notes.includes('criterion s1.c1 removed: no file it checks is one the brief asks for as text'), p.notes.join('\n'));
  assert.deepEqual((p.subtasks[1].criteria[0] as any).spec.paths, ['blog.html', 'css/site.css']);
  assert.ok(p.notes.includes('criterion s2.c1: hero.png left out: Rook can\'t take it back as a text file'), p.notes.join('\n'));
  assert.ok(p.notes.includes('criterion s2.c1: README.md left out: the brief doesn\'t ask for it'), p.notes.join('\n'));
});

test('numeric bounds keep only what is known without the data: never a guess of the answer', () => {
  const n = (label: string, min?: number, max?: number) => ({ id: 'n', kind: 'numeric_match', description: label, spec: { label, ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) } });
  const p = buildPlan(input({
    draft: [sub('Figures', { criteria: [n('CAGR (%)', 0, 50), n('Total supply', 1e9, 2e9), n('Top 10 holders share', 0, 100), n('Holder count', 1), n('Price (USD)', 1), n('Net flow (USD)', -1e6, 1e6), n('Staked share', 20, 80)] })],
    selected: [[agent('a')]], quotes: { a: row('100000') },
  }));
  assert.deepEqual(p.subtasks[0].criteria.filter((c) => c.kind === 'numeric_match').map((c: any) => [c.spec.label, c.spec.min, c.spec.max]), [
    ['CAGR (%)', -100, undefined], // QA: honest nominal lira growth failed a cap at 50
    ['Total supply', 0, undefined], // QA: 1e9 to 2e9 guessed the answer
    ['Top 10 holders share', 0, 100],
    ['Holder count', 1, undefined],
    ['Price (USD)', 0, undefined],
    ['Staked share', 0, 100],
  ]);
  assert.ok(p.notes.includes('criterion s1.c1: the bounds on "CAGR (%)" (0 to 50) guessed the answer: it checks at least -100 instead'), p.notes.join('\n'));
  assert.ok(p.notes.some((x) => x.startsWith('criterion s1.c6 removed: "Net flow (USD)" can be below or above 0')), p.notes.join('\n'));
});

// ---- #29: agents Rook can't pay or that never delivered never reach select ----

test('before select: agents Rook can never pay are left out, and never-delivered ones while another agent is left', () => {
  const notes: string[] = [];
  const pool = [agent('fast'), agent('two-weeks', { sla_seconds: 600 }), agent('two-day-sla', { sla_seconds: 172_800 }), agent('no-show', { delivered_jobs: 0 }), agent('new', { delivered_jobs: 0 })];
  const history = { 'no-show': { pass: 0, fail: 0, stalled: 1 } };
  // QA: shdwtech-build quoted a 14-day window with a 600 s SLA (known from an earlier quote); a 2-day SLA asks 173400 s.
  const kept = prefilter('"Site"', pool, history, { 'two-weeks': 1_210_200 }, notes);
  assert.deepEqual(kept.map((a) => a.handle), ['fast', 'new']);
  assert.deepEqual(notes, [
    '"Site": two-weeks (1210200 s), two-day-sla (173400 s) left out before selection: a payment window over 90000 s (ROOK_MAX_PAYMENT_TIMEOUT_S), from an earlier quote or the SLA plus the market\'s 600 s',
    '"Site": no-show left out before selection: no job delivered anywhere, and Rook\'s hires failed to send or timed out',
  ]);
  // Nothing better: a never-delivered agent stays (the ranking and Rook's own writing decide).
  assert.deepEqual(prefilter('"Site"', [agent('no-show', { delivered_jobs: 0 })], history, {}, []).map((a) => a.handle), ['no-show']);
  // Agents with a good Rook record, most passes first: a pass, more passes than fails, no stall since.
  assert.deepEqual(goodRecord({ quill: { pass: 3, fail: 0 }, flaky: { pass: 1, fail: 2 }, stalled: { pass: 4, fail: 0, stalled: 1 }, ok: { pass: 1, fail: 0 }, none: { pass: 0, fail: 0 } }), ['quill', 'ok']);
});

// ---- #30: fallbacks the reserve can pay once the agents before them are paid ----

test('a fallback is listed only when it can be paid after every agent before it was paid and failed', () => {
  // QA t_55aa2ab9: cap 12, reserve 8, agents at 6, 15 and 19. Paid 6, the 15 needs a 9 top-up: "up to 3 agents" was false.
  const p = buildPlan(input({
    budget_atomic: 20_000_000n,
    draft: [sub('Site')],
    selected: [[agent('ceoclaw-web'), agent('landing-page-designer'), agent('milestone-dev-sprint')]],
    quotes: { 'ceoclaw-web': row('6000000'), 'landing-page-designer': row('15000000'), 'milestone-dev-sprint': row('19000000') },
  }));
  assert.deepEqual(p.subtasks[0].candidates.map((c) => c.handle), ['ceoclaw-web']);
  assert.equal(p.subtasks[0].cap_atomic, '6000000'); // the cap raised to 12 for a fallback no reserve can pay shrank back
  assert.ok(p.notes.includes('"Site": candidate landing-page-designer dropped: once the agents before it are paid, the cap and reserve left can\'t pay its 15.00 USDC'), p.notes.join('\n'));
  // A fallback the cap and reserve can still pay after the lead is listed: 1.00 paid from a 1.50 cap, 1.50 topped up 1.00.
  const ok = buildPlan(input({ budget_atomic: 3_000_000n, draft: [sub('Site')], selected: [[agent('a'), agent('b')]], quotes: { a: row('1000000'), b: row('1500000') } }));
  assert.deepEqual(ok.subtasks[0].candidates.map((c) => c.handle), ['a', 'b']);
});

// ---- #49: Rook's own edits take no money ----

test('a plan of Rook edits only has no budget figures at all', () => {
  // QA qa2e-rename: a rename carried a 0.90 USDC reserve though nothing was hired.
  const p = buildPlan(input({ budget_atomic: 1_000_000n, files: ['index.html'], draft: [sub('Rename', { brief: 'Rename\n\nChange the name to Nimbus Labs.', self_do_ok: true, rook_edit: true, inputs: ['index.html'] })] }));
  assert.deepEqual(p.budget, { budget_atomic: '0', reserve_atomic: '0', reserve_bps: 0, allocatable_atomic: '0', allocated_atomic: '0' });
  // One hire beside it keeps the budget as before.
  const mixed = buildPlan(input({ budget_atomic: 1_000_000n, files: ['index.html'], draft: [sub('Rename', { self_do_ok: true, rook_edit: true, inputs: ['index.html'] }), sub('Logo')], selected: [[], [agent('a')]], quotes: { a: row('100000') } }));
  assert.equal(mixed.budget.budget_atomic, '1000000');
});

test('a Rook edit of large files is hired, or done by Rook as any other part, with a note saying why', () => {
  // QA: a rename over 115,418 characters, made by Rook at once, came back cut off and lost 62% of games.html.
  const rename = sub('Rename', { brief: 'Rename\n\nChange the title to Chess Through Time.', self_do_ok: true, rook_edit: true, inputs: ['index.html', 'games.html'] });
  const files = ['index.html', 'games.html'];
  const sized = (games: number) => new Map([['index.html', 1000], ['games.html', games]]);
  const at = buildPlan(input({ files, sizes: sized(ROOK_EDIT_MAX_CHARS - 1000), draft: [rename] }));
  assert.equal(at.subtasks[0].self_do_reason, 'rook_edit'); // up to the cap, the files counted together
  const hired = buildPlan(input({ files, sizes: sized(ROOK_EDIT_MAX_CHARS), draft: [rename], selected: [[agent('editor')]], quotes: { editor: row('100000') } }));
  assert.deepEqual([hired.subtasks[0].self_do, hired.subtasks[0].candidates.map((c) => c.handle)], [false, ['editor']]);
  assert.ok(hired.notes.includes(`"Rename" is not a Rook edit: its files come to ${ROOK_EDIT_MAX_CHARS + 1000} characters, more than the ${ROOK_EDIT_MAX_CHARS} Rook edits itself at once`), hired.notes.join('\n'));
  const own = buildPlan(input({ files, sizes: sized(ROOK_EDIT_MAX_CHARS), draft: [rename] }));
  assert.equal(own.subtasks[0].self_do_reason, 'no_agent'); // no agent: Rook writes it, as any part it may write
});

test('a part keeps the market category the draft named, when Rook knows it, so a plan that carries it lists it again', () => {
  const p = buildPlan(input({ draft: [sub('Site', { category: 'dev_tools', self_do_ok: true }), sub('Logo', { category: 'logos', self_do_ok: true })] }));
  assert.deepEqual(p.subtasks.map((s) => s.category), ['dev_tools', undefined]);
});

// ---- #19: files over what Rook sends block funding ----

test('a part whose input files pass 300 KB blocks the plan, in plain words', () => {
  const big = { path: 'games.html', text: 'x'.repeat(INPUTS_MAX_BYTES + 1) };
  assert.equal(inputsBlocked([{ title: 'Rename site', inputs: ['games.html'] }], [big]),
    'The files "Rename site" works on come to 301 KB, more than the 300 KB Rook can send with one part, so this plan can\'t run as it is. Ask for a change to fewer or smaller files.');
  assert.equal(inputsBlocked([{ title: 'Rename site', inputs: ['games.html'] }], [{ path: 'games.html', text: 'x'.repeat(INPUTS_MAX_BYTES) }]), undefined);
  assert.equal(inputsBlocked([{ title: 'New page' }], [big]), undefined);
});

// ---- #48 and #23: a revision keeps what the user saw ----

test('a revision keeps the criteria of parts it leaves as they were; an answer to questions keeps the open plan beside the new work', () => {
  const site = { title: 'Portfolio site', brief: 'Portfolio site\n\nA site for Elif Şahin with Behance links and mailto:elif@sahin.studio.', criteria: [
    { id: 'c1', kind: 'contains' as const, description: 'Email', spec: { pattern: 'mailto:elif@sahin.studio' } },
    { id: 'c2', kind: 'contains' as const, description: 'Behance', spec: { pattern: 'Behance' } },
  ], search_terms: ['web design'], self_do_ok: true };
  const notes: string[] = [];
  // QA: the same brief came back with 6 criteria instead of 9, none for the email or the links.
  const same = keepCriteria([sub('Portfolio site', { brief: site.brief, criteria: [judge] })], [site], notes);
  assert.deepEqual(same[0].criteria.map((c) => c.spec.pattern ?? null), ['mailto:elif@sahin.studio', 'Behance']);
  const changed = keepCriteria([sub('Portfolio site', { brief: `${site.brief} Dark theme.`, criteria: [judge] })], [site], notes);
  assert.deepEqual(changed[0].criteria, [judge]); // the message changed it: its new criteria
  // QA t_2f8549eb: answered, the CV's questions would have replaced the site plan with the CV alone.
  const both = carryParts([sub('CV', { self_do_ok: true })], [site], notes);
  assert.deepEqual(both.map((s) => [s.title, s.search_terms, s.self_do_ok, s.criteria.length]), [['Portfolio site', ['web design'], true, 2], ['CV', ['CV'], true, 1]]);
  assert.equal(carryParts([sub('portfolio SITE')], [site], []).length, 1); // the draft kept it: nothing added
});

// ---- #17: NEAR account ids ----

test('account ids are found in text (never a domain), and taken out or corrected cleanly', () => {
  const text = 'Analyse the wnear.near contract (wnear.near) on NEAR mainnet, see https://nearblocks.io/address/wrap.near, app.near.ai and near.org; not usdc.testnet; mail me@ozan.near.';
  assert.deepEqual(nearAccountIds([text], 'mainnet'), ['wnear.near', 'wrap.near']);
  assert.deepEqual(nearAccountIds([text], 'testnet'), ['usdc.testnet']);
  assert.equal(replaceAccount('Analyse the wnear.near contract (wnear.near) now.', 'wnear.near', 'wrap.near'), 'Analyse the wrap.near contract (wrap.near) now.');
  assert.equal(replaceAccount('Analyse the wnear.near contract (`wnear.near`) now.', 'wnear.near', null), 'Analyse the contract now.');
});

test('an account id that does not exist, or a contract with no code, is corrected when the real one is known, else taken out', () => {
  const r = fixAccounts(
    ['Holders\n\nReport the holders of the wnear.near contract.', 'Supply\n\nRead ghost.near and the nobody.near token.', 'Mine\n\nCheck my account ozan.near and alice.near.'],
    ['The plan studies wNEAR (wnear.near).'],
    { 'wnear.near': 'empty', 'wrap.near': 'contract', 'ghost.near': 'missing', 'nobody.near': 'empty', 'ozan.near': 'missing', 'alice.near': 'empty' },
    'Due diligence on wNEAR. My account is ozan.near.',
  );
  assert.deepEqual(r.briefs, ['Holders\n\nReport the holders of the wrap.near contract.', 'Supply\n\nRead and the token.', 'Mine\n\nCheck my account ozan.near and alice.near.']);
  assert.deepEqual(r.assumptions, ['The plan studies wNEAR (wrap.near).']);
  assert.deepEqual(r.notes, [
    'Rook found no contract at wnear.near, so the plan names wrap.near, the wrapped NEAR (wNEAR) contract, instead.',
    'Rook found no NEAR account named ghost.near, so the plan no longer names it.',
    'Rook found no contract at nobody.near, so the plan no longer names it.',
    'Rook found no NEAR account named ozan.near, which your message names: check the name before paying.',
  ]); // alice.near exists and is not called a contract: a person's account needs no code
  // The correction is said only once the chain shows it holds a contract.
  assert.deepEqual(fixAccounts(['the wnear.near contract'], [], { 'wnear.near': 'missing' }, '').briefs, ['the contract']);
});

// ---- #20: a budget named in any language ----

test('a budget named in any language counts: a number next to a currency word, in a message that names the budget', async () => {
  const { budgetAmounts, budgetBacked } = await import('../src/shared/money.ts');
  // QA t_2c4c5357: "Bütçeyi 1,5 USDC yap." left the budget at 1 USDC, and the report said 1.5 was applied.
  assert.deepEqual(budgetAmounts('Bütçeyi 1,5 USDC yap.'), [1_500_000n]);
  assert.deepEqual(budgetAmounts('bütçe 2 USDC olsun'), [2_000_000n]);
  assert.deepEqual(budgetAmounts('Bütçe 1 USDC toplamda kalır'), [1_000_000n]);
  assert.deepEqual(budgetAmounts('Bütçeyi 3 dolara düşür'), [3_000_000n]);
  assert.deepEqual(budgetAmounts("Toplam bütçe 2,5 USDC'ye çıksın"), [2_500_000n]);
  assert.deepEqual(budgetAmounts('Haz el presupuesto de 2 USD'), [2_000_000n]);
  assert.deepEqual(budgetAmounts('Pon el presupuesto en 4 dólares'), [4_000_000n]);
  assert.deepEqual(budgetAmounts('Сделай бюджет 2 доллара'), [2_000_000n]);
  // A number with no currency word, or money in a message that names no budget, is no budget.
  assert.deepEqual(budgetAmounts('Bütçe raporunda ilk 10 cüzdan'), []);
  assert.deepEqual(budgetAmounts('10 USDC fiyatlı ajanlar hangileri?'), []);
  assert.deepEqual(budgetAmounts('make it 1 USDC'), [1_000_000n]); // English as before
  assert.equal(budgetBacked('Bütçeyi 1,5 USDC yap.', 1_500_000n), true);
  assert.equal(budgetBacked('Bütçeyi 1,5 USDC yap.', 1_000_000n), false);
});

// ---- #14: model JSON mended before asking again ----

// The QA failure shapes: the prescribed assumption copied with raw inner quotes (English and Turkish), a raw line break,
// a trailing comma, and an escape JSON lacks.
const BROKEN_DRAFT = '```json\n{"subtasks":[{"title":"Task tracker","brief":"Task tracker\n\nBuild a full-stack task tracker. Say \\\'done\\\' when a task is closed.","search_terms":["web app"],"self_do_ok":true,"criteria":[],}],'
  + '"assumptions":["Deploying comes next: once it\'s built, say "deploy it" and Rook will hire an agent that deploys.","Site dili Türkçe; "Hakkımda" bölümü yok.", "He said "yes"."],}\n```';

test('model JSON with stray quotes, raw line breaks, bad escapes or trailing commas is mended; a valid string is left as it is', async () => {
  const { repairJson, parseJsonObject } = await import('../src/shared/llm.ts');
  assert.throws(() => parseJsonObject(BROKEN_DRAFT));
  const d = parseJsonObject(BROKEN_DRAFT, true) as any;
  assert.equal(d.subtasks[0].brief, "Task tracker\n\nBuild a full-stack task tracker. Say 'done' when a task is closed.");
  assert.deepEqual(d.assumptions, [
    'Deploying comes next: once it\'s built, say "deploy it" and Rook will hire an agent that deploys.',
    'Site dili Türkçe; "Hakkımda" bölümü yok.', 'He said "yes".',
  ]);
  const fine = '{"a":"x \\"y\\" z","b":[1,"c, d",{"e":"f"}],"g":{"h":":"}}';
  assert.equal(repairJson(fine), fine);
});

/** NEAR AI faked for one test: `answer` gets the system prompt, the last user message and the messages, and returns the reply. */
function fakeAi(t: any, answer: (system: string, user: string, messages: { role: string; content: string }[]) => unknown, env: Record<string, string | undefined> = {}) {
  const sent: { system: string; user: string }[] = [];
  const all = { ROOK_LLM: 'near', NEARAI_API_KEY: 'test-key', NEARAI_BASE_URL: 'https://nearai.test/v1', ...env };
  const saved = Object.fromEntries(Object.keys(all).map((k) => [k, process.env[k]]));
  const set = (e: Record<string, string | undefined>) => { for (const [k, v] of Object.entries(e)) if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  set(all);
  const real = globalThis.fetch;
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    if (!url.startsWith('https://nearai.test/')) return real(input, init);
    if (url.endsWith('/models')) return reply({ data: [] });
    if (url.includes('/signature/')) return reply({});
    if (!url.endsWith('/chat/completions')) return reply({}, 404);
    const { messages } = JSON.parse(init.body);
    const system = messages[0].content, user = messages[messages.length - 1].content;
    sent.push({ system, user });
    const a = answer(system, user, messages);
    return reply({ id: `c${sent.length}`, choices: [{ message: { content: typeof a === 'string' ? a : JSON.stringify(a ?? 'ok') }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = real; set(saved); });
  return sent;
}
const isDraft = (system: string) => system.includes('Split the user');
const isSelect = (system: string) => system.includes('For each subtask below');

test('a draft that is not JSON as written is mended without a second paid call, and its raw text is logged', async (t) => {
  const warned: string[] = [];
  t.mock.method(console, 'warn', (m: string) => { warned.push(m); });
  const sent = fakeAi(t, () => BROKEN_DRAFT);
  const { draft } = await import('../src/planner/prompts.ts');
  const r = await draft('Build a full-stack task tracker', 3_000_000n, 2_400_000n);
  assert.equal(sent.length, 1);
  assert.equal(r.assumptions?.[1], 'Site dili Türkçe; "Hakkımda" bölümü yok.');
  assert.ok(warned.some((w) => w.startsWith('[llm] plan.draft: reply is not JSON (') && w.includes('reply starts: "```json')), warned.join('\n'));
  assert.ok(warned.includes('[llm] plan.draft: parsed after mending stray quotes, line breaks or trailing commas'), warned.join('\n'));
});

/** The planner against a fake market gateway and a fake NEAR AI. */
async function harness(t: any, o: { agents?: (q: string, category: string | null) => Agent[]; quote?: (handle: string) => QuoteResult; answer: (system: string, user: string) => unknown; env?: Record<string, string | undefined> }) {
  const { serve, call } = await import('../src/shared/http.ts');
  const searched: string[] = [], quoted: string[] = [];
  const gw = await serve('fake-gateway', {
    'GET /search': ({ query }) => (searched.push(query.get('q') ?? ''), { agents: o.agents?.(query.get('q') ?? '', query.get('category')) ?? [] }),
    'GET /x402': () => ({ x402Version: 2, recipients: [RECIPIENT] }),
    'POST /quote': ({ body }) => (quoted.push(body.handle), o.quote?.(body.handle) ?? row('100000')),
  }, 0);
  const sent = fakeAi(t, o.answer, { MARKET_GATEWAY_URL: gw.url, ...o.env });
  const { start } = await import('../src/planner/index.ts');
  const planner = await start(0);
  t.after(async () => { await planner.close(); await gw.close(); });
  const body = { task_id: 't', budget_atomic: '3000000', reserve_share: 0.2 };
  return { plan: (b: Record<string, unknown>) => call<any>(`${planner.url}/plan`, { ...body, ...b }), searched, quoted, sent };
}

// ---- #4 over HTTP: action plans ----

test('POST /plan: an action whose brief still holds placeholders after the draft is asked again becomes questions, never a plan', async (t) => {
  // QA t_390c58c5: "Use placeholders" gave a fundable plan to book a real table under [Your name] at an invented 20:00.
  const booking = sub('Book a table at Mikla', { brief: 'Book a table at Mikla\n\nReserve a table for 2 at Mikla under the name [Your name], contact [Your phone number].', action: true });
  const h = await harness(t, { answer: (s) => (isDraft(s) ? { subtasks: [booking] } : undefined) });
  const p = await h.plan({ prompt: 'Use placeholders' });
  assert.deepEqual(p.subtasks, []);
  assert.equal(p.action, true);
  assert.deepEqual(p.questions, ['"Book a table at Mikla" is done in the world for you, so Rook can\'t run it on placeholders: what should go in place of [Your name] and [Your phone number]?']);
  assert.deepEqual(h.searched, []); // nothing searched, quoted or funded
  const drafts = h.sent.filter((m) => isDraft(m.system));
  assert.equal(drafts.length, 2); // asked again once, with the problem
  assert.match(drafts[1].user, /is an action in the world but holds placeholders \(\[Your name\], \[Your phone number\]\)/);
});

test('POST /plan: questions for an action carry Plan.action, so the app offers no placeholders; work does not', async (t) => {
  let action = true;
  const h = await harness(t, { answer: (s) => (isDraft(s) ? { subtasks: [], questions: ['Which restaurant, and under what name?'], ...(action ? { action: true } : {}) } : undefined) });
  const p = await h.plan({ prompt: 'Book me a table for Friday' });
  assert.deepEqual([p.questions, p.action], [['Which restaurant, and under what name?'], true]);
  action = false;
  assert.equal((await h.plan({ prompt: 'Make me a portfolio site' })).action, undefined);
});

// ---- #17 over HTTP: account ids checked on chain ----

test('POST /plan: account ids in briefs and assumptions are checked on chain before select; NEAR RPC down is a note', async (t) => {
  const { serve } = await import('../src/shared/http.ts');
  const viewed: string[] = [];
  const rpcServer = await serve('fake-rpc', {
    'POST /': ({ body }) => {
      const id = body.params.account_id;
      viewed.push(id);
      if (id === 'wrap.near') return { jsonrpc: '2.0', id: body.id, result: { amount: '1', code_hash: '6p7MZx1Kq2SVRUpEx8uq3jHk3ixZhTjyP9xR1fp8C6mH' } };
      if (id === 'wnear.near') return { jsonrpc: '2.0', id: body.id, result: { amount: '1', code_hash: '11111111111111111111111111111111' } };
      return { jsonrpc: '2.0', id: body.id, error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCOUNT', info: { requested_account_id: id } } } };
    },
  }, 0);
  t.after(() => rpcServer.close());
  const holders = sub('wNEAR holders', { brief: 'wNEAR holders\n\nReport the top holders of the wnear.near contract on NEAR mainnet.', search_terms: ['holder distribution'] });
  const h = await harness(t, {
    env: { NEAR_NETWORK: 'mainnet', NEAR_RPC_URL: rpcServer.url },
    agents: (q) => (q === 'holder distribution' ? [agent('holders-agent')] : []),
    answer: (s) => (isDraft(s) ? { subtasks: [holders], assumptions: ['The plan studies wNEAR (wnear.near), not native NEAR.'] } : isSelect(s) ? { selections: [{ subtask_index: 1, handles: ['holders-agent'] }] } : undefined),
  });
  const p = await h.plan({ prompt: 'Due diligence on wNEAR' });
  assert.deepEqual(viewed.sort(), ['wnear.near', 'wrap.near']);
  assert.equal(p.subtasks[0].brief, 'wNEAR holders\n\nReport the top holders of the wrap.near contract on NEAR mainnet.');
  assert.deepEqual(p.assumptions, ['The plan studies wNEAR (wrap.near), not native NEAR.']);
  assert.ok(p.notes.includes('Rook found no contract at wnear.near, so the plan names wrap.near, the wrapped NEAR (wNEAR) contract, instead.'), p.notes.join('\n'));
  assert.ok(h.sent.find((m) => isSelect(m.system))!.user.includes('the wrap.near contract'), 'select saw the corrected brief'); // agents are picked for the real contract
  // NEAR RPC down: the plan is made as drafted, and the user is told to check the name.
  await rpcServer.close();
  const down = await h.plan({ prompt: 'Due diligence on wNEAR' });
  assert.match(down.subtasks[0].brief, /wnear\.near/);
  assert.ok(down.notes.includes('Rook could not check the NEAR account name wnear.near on chain: check it before paying.'), down.notes.join('\n'));
});

// ---- #23 and #48 over HTTP: a revision keeps what the user saw ----

test('POST /plan: an answer to questions about new work keeps the open plan beside it; a revision keeps unchanged parts\' criteria', async (t) => {
  const brief = 'Portfolio site\n\nA one-page site for Elif Şahin with her Behance links and a mailto:elif@sahin.studio link.';
  const reviewed = { title: 'Portfolio site', brief, search_terms: ['web design'], self_do_ok: true, criteria: [
    { id: 'c1', kind: 'contains', description: 'Email link', spec: { pattern: 'mailto:elif@sahin.studio' } },
    { id: 'c2', kind: 'contains', description: 'Behance', spec: { pattern: 'Behance' } },
  ] };
  const cv = sub('CV', { brief: 'CV\n\nA one-page CV for Elif Şahin: designer at Atölye since 2021.', self_do_ok: true });
  let draft: DraftSubtask[] = [cv];
  const h = await harness(t, { answer: (s) => (isDraft(s) ? { subtasks: draft } : isSelect(s) ? { selections: [] } : undefined) });
  // QA t_2f8549eb: the CV's questions, once answered, would have replaced the reviewed site plan with the CV alone.
  const answered = await h.plan({ prompt: 'Atölye, 2021den beri tasarımcı.', conversation: { earlier: ['Portfolyo sitemi yap.', "Şimdi de CV'mi yaz."], revising: true, questions: ['Deneyimlerin neler?'], plan: [reviewed] } });
  assert.deepEqual(answered.subtasks.map((s: any) => s.title), ['Portfolio site', 'CV']);
  assert.deepEqual(answered.subtasks[0].criteria.map((c: any) => c.spec.pattern), ['mailto:elif@sahin.studio', 'Behance']);
  // A budget-only revision: the site part comes back word for word with fewer checks; it keeps the ones the user saw.
  draft = [sub('Portfolio site', { brief, self_do_ok: true, criteria: [judge] })];
  const revised = await h.plan({ prompt: 'make it 2 USDC', conversation: { earlier: ['Portfolyo sitemi yap.'], revising: true, plan: [reviewed] } });
  assert.deepEqual(revised.subtasks[0].criteria.map((c: any) => c.spec.pattern ?? c.spec.question), ['mailto:elif@sahin.studio', 'Behance']);
});

// ---- #29 and #22 over HTTP: the pool select sees, and what it picked ----

test('POST /plan: an agent a quote showed Rook cannot pay is never offered to select again; agents with a good Rook record are', async (t) => {
  const h = await harness(t, {
    agents: (q) => (q === 'web design' ? [agent('builder'), agent('fortnight-pay', { sla_seconds: 600 })] : q === 'quill-writer' ? [agent('quill-writer', { description: 'Blog posts, articles, and web copy.' })] : []),
    quote: (handle) => (handle === 'fortnight-pay' ? row('100000', 1_210_200) : row('100000')),
    answer: (s) => (isDraft(s) ? { subtasks: [sub('Site', { search_terms: ['web design'], self_do_ok: true })] } : isSelect(s) ? { selections: [{ subtask_index: 1, handles: ['builder', 'fortnight-pay', 'quill-writer'] }] } : undefined),
  });
  const first = await h.plan({ prompt: 'Make a site' });
  assert.ok(first.notes.some((n: string) => n.includes('quote from fortnight-pay dropped: payment window 1210200 s')), first.notes.join('\n'));
  const second = await h.plan({ prompt: 'Make a site', history: { 'quill-writer': { pass: 3, fail: 0 } } });
  const selects = h.sent.filter((m) => isSelect(m.system));
  assert.ok(selects[0].user.includes('handle: fortnight-pay'), 'the first plan offered it');
  assert.ok(!selects[1].user.includes('handle: fortnight-pay'), 'the second plan offered it again'); // QA: shdwtech-build took a pick on every website plan
  assert.ok(second.notes.includes(`"Site": fortnight-pay (1210200 s) left out before selection: a payment window over 90000 s (ROOK_MAX_PAYMENT_TIMEOUT_S), from an earlier quote or the SLA plus the market's 600 s`), second.notes.join('\n'));
  // QA: quill-writer, 3 passes, was missing from the captions pool: looked up by handle and shown with Rook's record.
  assert.ok(h.searched.includes('quill-writer'), h.searched.join(', '));
  assert.match(selects[1].user, /Agents Rook has hired with good results \(any subtask may pick from these\):\n {2}- handle: quill-writer \|.*\| rook: 3 passed, 0 failed/);
  assert.deepEqual(second.subtasks[0].candidates.map((c: any) => c.handle).sort(), ['builder', 'quill-writer']);
});

test('POST /plan: an agent select picked that cannot make the part is dropped before it is quoted', async (t) => {
  const h = await harness(t, {
    agents: (q) => (q === 'logo design' ? [MARKET.quill, MARKET.roguenet, MARKET.designer] : []),
    answer: (s) => (isDraft(s) ? { subtasks: [sub('Rook Roasters logo', { brief: 'Rook Roasters logo\n\nOne logo as a vector (SVG) plus a PNG.', search_terms: ['logo design'] })] }
      : isSelect(s) ? { selections: [{ subtask_index: 1, handles: ['quill-writer', 'roguenet-media-studio', 'designer'] }] } : undefined),
  });
  const p = await h.plan({ prompt: 'A logo for Rook Roasters' });
  assert.deepEqual(h.quoted, ['designer']);
  assert.deepEqual(p.subtasks[0].candidates.map((c: any) => c.handle), ['designer']);
  assert.ok(p.notes.includes('"Rook Roasters logo": candidate quill-writer dropped: its listing shows no image or design work'), p.notes.join('\n'));
});

// ---- #49, #19 and #20 over HTTP ----

test('POST /plan: Rook edits only take no money, whatever the message names; files over 300 KB block funding', async (t) => {
  const small = { path: 'index.html', text: '<h1>Chess</h1>' }, big = { path: 'games.html', text: `<p>${'x'.repeat(INPUTS_MAX_BYTES)}</p>` };
  let draft: DraftSubtask[] = [];
  const h = await harness(t, { answer: (s) => (isDraft(s) ? { subtasks: draft, budget_usdc: 2 } : undefined) });
  const conversation = { earlier: ['Make a chess history site'], revising: false, files: [small, big] };
  draft = [sub('Rename', { brief: 'Rename\n\nChange the title to Chess Through Time.', self_do_ok: true, rook_edit: true, inputs: ['index.html'] })];
  const free = await h.plan({ prompt: 'Rename the site to Chess Through Time, make it 2 USDC', conversation });
  assert.deepEqual(free.budget, { budget_atomic: '0', reserve_atomic: '0', reserve_bps: 0, allocatable_atomic: '0', allocated_atomic: '0' });
  assert.equal(free.blocked, undefined);
  draft = [sub('Rename games', { brief: 'Rename games\n\nChange the title to Chess Through Time.', self_do_ok: true, rook_edit: true, inputs: ['games.html'] })];
  const blocked = await h.plan({ prompt: 'Rename the games page too', conversation });
  assert.equal(blocked.blocked, 'The files "Rename games" works on come to 301 KB, more than the 300 KB Rook can send with one part, so this plan can\'t run as it is. Ask for a change to fewer or smaller files.');
  // Files that large are no edit Rook makes at once: the part is searched for like any other (the planner sends sizes).
  assert.deepEqual([h.searched.includes('Rename'), h.searched.includes('Rename games')], [false, true]);
  assert.notEqual(blocked.subtasks[0].self_do_reason, 'rook_edit');
});

test('POST /plan: a budget named in Turkish is planned at; one the message does not name is refused in plain words', async (t) => {
  const h = await harness(t, {
    agents: (q) => (q === 'Holders' ? [agent('holders-agent')] : []),
    answer: (s) => (isDraft(s) ? { subtasks: [sub('Holders')], budget_usdc: 1.5 } : isSelect(s) ? { selections: [{ subtask_index: 1, handles: ['holders-agent'] }] } : undefined),
  });
  const tr = await h.plan({ prompt: 'Bütçeyi 1,5 USDC yap.' });
  assert.deepEqual([tr.budget.budget_atomic, tr.budget.from_message], ['1500000', true]);
  const not = await h.plan({ prompt: 'Siteyi güzelleştir.' });
  assert.equal(not.budget.budget_atomic, '3000000');
  assert.ok(not.notes.some((n: string) => n.startsWith('Rook kept the budget at 3.00 USDC: your message doesn\'t name a total of 1.50 USDC.')), not.notes.join('\n'));
});

// ---- A check that text is gone (t_095f2819: "Old name is gone" written as a check for the old name) ----

test('a contains check for text the brief replaces or removes becomes a check that it is gone; the new text stays a check that it is there', () => {
  const brief = "Rename to Jordan Çelik\n\nIn index.html, change the owner's name from Ozan Andaç to Jordan Çelik everywhere it appears. Keep everything else exactly as it is.";
  const contains = (id: string, pattern: string, absent?: boolean) => ({ id, kind: 'contains', description: id, spec: { pattern, ...(absent ? { absent } : {}) } });
  const p = buildPlan(input({
    files: ['index.html'],
    draft: [sub('Rename to Jordan Çelik', { brief, inputs: ['index.html'], self_do_ok: true, criteria: [contains('c1', 'Jordan Çelik'), contains('c2', 'Ozan Andaç')] })],
  }));
  assert.deepEqual(p.subtasks[0].criteria.filter((c) => c.kind === 'contains').map((c) => c.spec), [{ pattern: 'Jordan Çelik' }, { pattern: 'Ozan Andaç', absent: true }]);
  assert.ok(p.notes.some((n) => /"Ozan Andaç" is text the brief replaces or removes, so it is checked as gone/.test(n)), JSON.stringify(p.notes));
  // One the draft already marks absent is kept as it is, with no note; "remove the Skills section" reads as gone too.
  const q = buildPlan(input({
    files: ['index.html'],
    draft: [sub('Drop skills', { brief: 'Drop skills\n\nRemove the Skills section from index.html. Keep everything else.', inputs: ['index.html'], self_do_ok: true, criteria: [contains('c1', 'Skills section'), contains('c2', 'Ozan', true)] })],
  }));
  assert.deepEqual(q.subtasks[0].criteria.filter((c) => c.kind === 'contains').map((c) => c.spec), [{ pattern: 'Skills section', absent: true }]);
  assert.ok(q.notes.some((n) => /"Ozan" is not in the brief/.test(n)), JSON.stringify(q.notes));
});

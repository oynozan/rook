// The draft step's prompt after QA round 2 (docs/agentic-system.md 5.2 step 1): actions never planned on placeholders,
// no posting from the user's accounts, questions capped to required facts, edits that change only what was asked, the
// user's private details kept out of briefs, the new media and sources checks, examples a model can copy into JSON, and
// the current files shown smallest first with an honest label for the rest.
process.env.ROOK_LLM = 'canned';
process.env.ROOK_MARKET = 'sim';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Conversation, WorkFile } from '../src/shared/types.ts';

const { DRAFT_SYSTEM, BUDGET_HOW, GO_AHEAD, DRAFT_FILES_CHARS, draftMessage } = await import('../src/planner/prompts.ts');
const { Criterion } = await import('../src/shared/types.ts');

// ---- Actions (QA2 #4, #8, #33) ----

test('an action sets "action" and is never planned on placeholders; the app, not the model, offers placeholders for work', () => {
  // One "Use placeholders" gave a fundable booking under "[Your name]" at an invented 20:00.
  assert.match(DRAFT_SYSTEM, /An action in the world on the user's behalf \(booking, calling, buying, sending, posting, publishing, deploying\) sets "action": true, with its questions \(\{"subtasks":\[\],"questions":\["\.\.\."\],"action":true\}\) or with its plan\./);
  assert.match(DRAFT_SYSTEM, /An action never goes ahead on a placeholder or a guess: ask until the name and contact to act under, the time and the choice \(which restaurant, or that the agent may pick one\) are given\./);
  assert.match(DRAFT_SYSTEM, /A plan that only makes something the user receives \(a site, a post to paste, a report\) is not an action\./);
  assert.match(DRAFT_SYSTEM, /Never offer placeholders in a question: the app offers them itself, for work only\./);
  assert.doesNotMatch(DRAFT_SYSTEM, /Or should I use clearly marked placeholders/);
  // The reply shape carries the field, and a build-then-deploy request plans the build, which is no action.
  assert.match(DRAFT_SYSTEM, /"action":<true for an action in the world, else leave it out>/);
  assert.match(DRAFT_SYSTEM, /plans the build only \(not an action: leave "action" out\)/);
});

test('an answer to the questions of an action never turns into placeholders: Rook asks again for what is still missing', () => {
  const m = draftMessage('Use placeholders', 1_000_000n, 800_000n, {
    earlier: ['book me a table for 2 in Kadıköy tonight'], revising: true,
    questions: ['Which restaurant should the agent book, or may it pick one?', 'The name and phone number to book under?', 'What time?'],
  });
  assert.match(m, /For work the user receives, a fact it leaves out, or a reply that tells Rook to go on without it \("use placeholders", "just do it", in any language\), becomes a clearly marked placeholder/);
  assert.match(m, /An action in the world \(a booking, a call, a purchase, a post, a deploy\) never goes ahead on a placeholder or a guess, whatever the reply says: while it lacks a fact it can't go without \(the name and phone number to act under, the time, which restaurant or that the agent may pick one\), return questions again with "action": true, asking only for those facts\./);
});

test("no agent acts in the user's own accounts: posting from them is ready-to-paste copy, and no brief carries made-up consent", () => {
  // "Post this on X" asked how to authorise an agent, then wrote "they have approved an agent posting for them" into a
  // copywriter's brief and paid for copy as if it were posted.
  assert.match(DRAFT_SYSTEM, /No agent can act in the user's own accounts \(their X, Instagram, LinkedIn, email, bank or hosting\): Rook takes no logins, passwords or keys, and never asks for them or how to authorise an agent\./);
  assert.match(DRAFT_SYSTEM, /A request to post or send from their own account is planned as ready-to-paste copy that the user posts, and an assumption says so \('Rook can't post from your X account: you get the post ready to paste\.'\)\./);
  assert.match(DRAFT_SYSTEM, /Never write into a brief that the user approved, authorised or consented to anything\./);
  // A post an agent makes from its own account is checked by loading its link.
  assert.match(DRAFT_SYSTEM, /A post an agent makes from its own account \(only when the user asks for that\) gives its link on a line "Post URL: <url>", checked the same way with "label":"Post URL"\./);
});

test('questions and assumptions promise only what Rook does: no confirming with the user mid-run, no deploy to their account', () => {
  // "would you like me to pick one and confirm with you first?" and "name your own hosting and Rook will use it".
  assert.match(DRAFT_SYSTEM, /A run can't stop to ask the user anything, so never offer to check a choice with them first: offer the real options \('Which restaurant should the agent book, or may it pick one\?'\)\./);
  assert.match(DRAFT_SYSTEM, /A deploy goes on the hosting agent's own account: the user can upload the files to their own hosting later, but Rook can't deploy to it\./);
  assert.doesNotMatch(DRAFT_SYSTEM, /name their own hosting|Rook will use that instead/);
});

// ---- Questions (QA2 #31, #44) ----

test('questions ask only for what the work cannot do without, at most 3 by default, in Rook\'s voice; the rest defaults into assumptions', () => {
  assert.match(DRAFT_SYSTEM, /Ask only for the facts the work can't be done without: who or what it is about \(a name, what they do or sell\), what only they can give \(their projects with links, their experience for a CV\), and for an action every detail it needs \(below\)\./);
  assert.match(DRAFT_SYSTEM, /At most 3 short questions \(5 only when the task truly can't be done with fewer\)/);
  assert.match(DRAFT_SYSTEM, /Never ask about what has a sensible default: style, tone, colours, layout, length, the number of items, the language \(the user's own\), extra sections\. Pick the default and say it in assumptions/);
  // The old list made opening hours, prices and brand askable for any business work.
  assert.doesNotMatch(DRAFT_SYSTEM, /\(their name, role, projects with links, contact details, prices, brand, opening hours/);
  assert.match(DRAFT_SYSTEM, /Write questions, assumptions and not_a_task as Rook, by name \('Rook can't \.\.\.'\), never as 'I' or 'we'\./);
  assert.match(DRAFT_SYSTEM, /the most important first: what the plan takes as given \(placeholders, a language, a format, the defaults it picked, several in one sentence\)/);
});

// ---- Never invent, personal data (QA2 #21, #26) ----

test('never-invent covers what a product has or does, and nothing claims it invented nothing', () => {
  // A bakery site said "flour, water, salt and our own starter" and "That's the whole menu", then "no facts were invented".
  assert.match(DRAFT_SYSTEM, /nor claims about what the user's product or business has or does: features, capabilities, what a plan includes or its limits, ingredients, how something is made, freshness, origin, quality, or that a list is complete \("that's the whole menu"\)\. Nor a domain, handle or email address made up from a name\./);
  assert.match(DRAFT_SYSTEM, /a brief never asks for "descriptive copy", "generic features" or "typical" claims that would state facts nobody gave\./);
  assert.match(DRAFT_SYSTEM, /Never write that nothing was invented, in a brief or an assumption, unless it is true of the whole work\./);
});

test("a brief carries only the personal details its work needs, and the plan says who receives the user's private details", () => {
  // A CV brief to a hired writer held a national ID number and a date of birth, and no line told the user.
  assert.match(DRAFT_SYSTEM, /Personal data: a brief carries only the personal details its work needs\. Never a national ID or passport number, a bank or card detail, or a password; a date of birth or a home address only when the deliverable itself must show it/);
  assert.match(DRAFT_SYSTEM, /When a brief that may go to a hired agent \(any part but a rook_edit\) carries the user's private details \(phone number, email, address, work or education history\), an assumption says who receives them/);
});

// ---- Edits (QA2 #13, #27, #34) ----

test('an edit changes only what the message names, says what it removes or moves, and flags sample content and fake forms it inherits', () => {
  // "a separate pricing page" removed the home page's pricing, unsaid.
  assert.match(DRAFT_SYSTEM, /An edit changes only what the message names\. It never removes, moves, merges or shortens anything else: a new pricing page leaves the pricing on the home page where it is, unless the message says to move it\. When the change does remove or move content, assumptions say exactly what goes and where/);
  // A rename put the user's real name above invented projects and a form that sends nothing.
  assert.match(DRAFT_SYSTEM, /Content in the files that no message gave \(sample projects, clients, metrics, testimonials, a domain\) and a form that sends nothing were made up by an earlier run\. When an edit puts the user's real name or facts next to such content, or the message touches it, list it in assumptions with what the user can do/);
  assert.match(DRAFT_SYSTEM, /A brief never tells an agent to keep a fake form working or to add more such content\./);
});

test("adding an item that copies one the files already have, with the user's facts, is a Rook edit", () => {
  // A fully specified project card was hired out (82 s to plan, up to 30 min per agent); Rook's writer did it in 16 s.
  assert.match(DRAFT_SYSTEM, /and so does adding one item built like an item the files already have, filled only with facts the user gave \(a project card, a list item, a nav link, a menu line, a section copied from another with the user's own text\): Rook makes it itself at once/);
  assert.match(DRAFT_SYSTEM, /Leave it out for anything that needs new writing, new design or facts nobody gave\./);
});

// ---- Criteria and self-do (QA2 #3, #5, #6, #35) ----

test('research Rook can source on the public web is Rook\'s to write; on-chain and live market data, media and actions are not', () => {
  assert.match(DRAFT_SYSTEM, /explanations from general knowledge, and research whose facts are on public web pages \(news, documentation, reports, public statements\), since Rook's writer searches the web and cites each source, and the sources criterion opens the links\./);
  assert.match(DRAFT_SYSTEM, /false only when it needs on-chain data or live market data \(balances, holders, prices, volumes as of now\), media a model cannot write as text \(images, audio, video\), or acting in the world \(posting, deploying, booking, contacting someone\)\./);
});

test('the draft knows the media and sources checks, and a deploy gets a live_url check only', () => {
  assert.match(DRAFT_SYSTEM, /8\. media: the delivery must give an image, video or audio \(a file or a link\) that loads as that kind of media[^\n]*Every logo, image, illustration, video or audio subtask gets one; never check such a part with contains or llm_judge on what its reply says about the media, nor with a files check on an image or video path\./);
  assert.match(DRAFT_SYSTEM, /9\. sources: the links the delivery cites as sources must load as public pages[^\n]*Every research subtask gets one, with "figures": true when its brief asks for label lines\./);
  assert.match(DRAFT_SYSTEM, /At most 2 per subtask, and none on an image, video or audio subtask/);
  assert.match(DRAFT_SYSTEM, /a research subtask a sources criterion, an image, video or audio subtask a media criterion, and a deploy a live_url criterion only\./);
  assert.match(DRAFT_SYSTEM, /Every deploy gets one, and it is a deploy's only check/);
  // Label lines carry their source, so digits-only lines and a source next to each figure no longer contradict.
  assert.match(DRAFT_SYSTEM, /in research the figure's source link follows on the same line, as in 'Holder count: 412530 \(source: <link to the page>\)'/);
  // Every criterion example is valid JSON and a criterion of the contract.
  const examples = DRAFT_SYSTEM.split('\n').filter((l) => /^\s+\{"id":"c\d+"/.test(l));
  assert.equal(examples.length, 10);
  for (const e of examples) assert.ok(Criterion.safeParse(JSON.parse(e)).success, e);
  assert.deepEqual(examples.map((e) => JSON.parse(e).kind).slice(-3), ['live_url', 'media', 'sources']);
});

// ---- Examples (QA2 #14, #40) ----

test('every example the model copies into a JSON string holds no raw double quote, and the reply shape is JSON', () => {
  // "invalid JSON twice" fell in the assumptions array, after the prompt's own say "deploy it".
  assert.doesNotMatch(DRAFT_SYSTEM, /say "deploy it"/);
  assert.doesNotMatch(DRAFT_SYSTEM, /"Holder count: 412530"|"Label: value"|the line "Live URL: <url>"/);
  assert.match(DRAFT_SYSTEM, /Every string must stay valid JSON: inside a string, quote with single quotes \('Blog'\), never a raw double quote\./);
  // The sentences the model sets not_a_task to, word for word, survive as JSON strings unescaped.
  for (const s of [BUDGET_HOW, GO_AHEAD]) {
    assert.ok(!s.includes('"'), s);
    assert.equal(JSON.parse(`{"not_a_task":"${s}"}`).not_a_task, s);
  }
  assert.ok(DRAFT_SYSTEM.includes(`set not_a_task to exactly: "${BUDGET_HOW}"`));
  // The reply shape, its <placeholders> filled in, parses, and so does the questions shape.
  const shape = DRAFT_SYSTEM.trimEnd().split('\n').at(-1)!;
  const parsed = JSON.parse(shape.replace(/<[^>]*>/g, 'true').replace('[...]', '[]'));
  assert.deepEqual(Object.keys(parsed), ['subtasks', 'assumptions', 'action', 'budget_usdc']);
  const asks = [...DRAFT_SYSTEM.matchAll(/\{"subtasks":\[\],"[^\n]*?\}(?=[).\s])/g)].map((m) => JSON.parse(m[0]));
  assert.deepEqual(asks.map((a) => Object.keys(a)), [['subtasks', 'questions'], ['subtasks', 'questions', 'action'], ['subtasks', 'not_a_task']]);
});

test("no prompt example names the founder or his projects: questions borrowed them as a stranger's sample answer", () => {
  const conv: Conversation = { earlier: ['make me a portfolio'], revising: false, files: [{ path: 'index.html', text: '<h1>Site</h1>' }], questions: ['Your name?'] };
  for (const text of [DRAFT_SYSTEM, BUDGET_HOW, GO_AHEAD, draftMessage('use placeholders', 1n, 1n, conv)]) {
    assert.doesNotMatch(text, /Ozan|oynozan|Andaç|Elowen|snoop|\bSona\b/);
  }
  assert.match(DRAFT_SYSTEM, /"Change the owner's name to Jordan Lee everywhere it appears\./);
});

// ---- Language and scope (QA2 #46, #47) ----

test("the work is in the user's language unless they ask for another, each topic is researched once, and 'this week' stays this week", () => {
  // The same English bakery prompt gave a Turkish site once and an English one with Turkish labels the next time.
  assert.match(DRAFT_SYSTEM, /Language: the work is in the language of the user's messages unless they ask for another \(an English request for a shop in Istanbul gets an English site\)\. Each brief names that language, and every heading, label and button of the work is in it, never a mix\./);
  assert.match(DRAFT_SYSTEM, /Proofread each brief, question and assumption before replying/);
  assert.match(DRAFT_SYSTEM, /Each topic belongs to one subtask only \(token unlocks once, not under supply and again under team\)\. A time the user names keeps its span: 'this week' is the current week up to today, never a wider window\./);
  assert.match(DRAFT_SYSTEM, /First line is the title, then a blank line, then the request, with no second title line\. Say exactly what to deliver, and in which language\./);
});

// ---- The current files (QA2 #43) ----

test('the draft sees the smallest files first, and the rest are labelled by why they are missing and never described', () => {
  // One 71k page took the 80k room and nine 4-5k pages were listed as "too long to show"; the plan described one anyway.
  const page = (path: string, n: number): WorkFile => ({ path, text: `<h1>${path}</h1>\n${'p'.repeat(n)}` });
  const big = page('games.html', DRAFT_FILES_CHARS - 1_000); // fits alone, but not next to the small ones
  const small = ['chess-today.html', 'openings.html', 'endgames.html'].map((p) => page(p, 3_000));
  const huge = page('archive.html', DRAFT_FILES_CHARS + 1);
  const conv: Conversation = { earlier: ['make me a chess site'], revising: false, files: [big, ...small, huge] };
  const m = draftMessage('rename the site to Knight Moves everywhere', 3_000_000n, 2_400_000n, conv);
  for (const f of small) assert.ok(m.includes(`<file path="${f.path}" lines="2">`), f.path);
  assert.ok(!m.includes('<file path="games.html"') && !m.includes('<file path="archive.html"'));
  assert.match(m, new RegExp(`</files>\\nFiles not shown, for lack of room once the files above were in, by path and size:\\n- games\\.html \\(2 lines, ${big.text.length} characters\\)\\nFiles too long to show at all \\(over 80,000 characters\\), by path and size:\\n- archive\\.html \\(2 lines, ${huge.text.length} characters\\)\\nYou have not seen what those files hold: never describe them, in a brief or an assumption\\. They can still be a subtask's inputs, which Rook attaches whole\\.`));
  // A file the message names still gets the room first, whatever its size.
  const named = draftMessage('rename the site in games.html', 3_000_000n, 2_400_000n, conv);
  assert.ok(named.includes('<file path="games.html"'));
  assert.match(named, /Files not shown, for lack of room[^\n]*\n- chess-today\.html[^\n]*\n- openings\.html[^\n]*\n- endgames\.html/);
  // Everything fits: no list and no warning.
  const fits = draftMessage('make it orange', 3_000_000n, 2_400_000n, { ...conv, files: small });
  assert.doesNotMatch(fits, /Files not shown|too long to show|You have not seen/);
});

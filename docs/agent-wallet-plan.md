# Agent wallet: spending rules from the chat, enforced by NEAR Intents

Status: MVP in progress on `feat/agent-wallet` (started 2026-11-12). Suggested by a NEAR developer: use the NEAR Intents
Agent API (docs.agentsonintents.com) as Rook's permissioning layer. The user describes in the chat how Rook may spend
("Only spend $1000, make sure all transactions come to me for approval"). Rook turns that into an Agent API wallet the
user owns, with those rules as its policy, and funds the market jobs it hires for from that wallet after the chat.

Ideas that are not part of the MVP are in [agent-wallet-ideas.md](agent-wallet-ideas.md).

## What the Agent API is (read 2026-11-12)

- A custodial wallet per "agent", on NEAR Intents, mainnet only ("experimental beta; you may lose all assets used with
  it"). Base URL `https://api.agentsonintents.com`, partner key `X-API-Key` from https://partners.near-intents.org/.
- **Owner:** a NEAR account and one of its full-access keys. Every change the owner makes (create the wallet, change its
  policy, issue or revoke a grant, approve a pending spend) is an intent: our backend asks `POST /v1/generate-intent`,
  the user's wallet signs `intent.payload` (NEP-366 delegate for on-chain changes such as `agent_create`, NEP-413
  message for the rest), our backend posts it to `/v1/submit-intent` and polls `/v1/status`.
- **Wallet:** `GET /v1/agents/{id}/wallet` gives `near_account_id` (a 64-hex implicit account). Its NEAR Intents balance
  is the policy-gated money. The same account id also has a native NEAR account that "native" routes act from.
- **Policy:** `actions` (swap, transfer, withdraw, limit_order), `assets`, per-asset `limits` (per transaction, hourly,
  daily, monthly), USD `budget` (daily, weekly, monthly), `destinations` (only, except, any), `owner_approval` (every
  spend waits for the owner's vote), `timelock_ms`, `schedule`, and `native` switches.
- **Grant:** a bearer token `ngt_…` our backend makes. The owner signs only its SHA-256 (`grant_issue`). With the API
  key and the grant, our backend may spend, within the policy. The API never sees the token.
- **Spending:** `withdraw` (to an account on any chain, `near` included), `transfer` (to a NEAR Intents account),
  `swap`, plus native routes (`native/near/call` on a listed contract). With `owner_approval`, a spend answers
  `PENDING_APPROVAL` with an `approval_id`, and the owner votes with an `approval_vote` intent.
- NEAR USDC (`nep141:17208628…33a1`) is in `GET /v1/tokens`.

## The gap, and how the MVP bridges it

Market agents are paid by x402: a signed NEP-366 delegate of `ft_transfer`, which Rook's per-task sub-accounts sign. The
Agent API has no route that signs a NEP-366 delegate for the wallet's NEAR key, and a `withdraw` cannot carry the
`msg` of an `ft_transfer_call`. So the wallet cannot pay an agent itself, nor open a Rook contract task in one step.

The MVP keeps Rook's contract and x402 path as they are, and makes the agent wallet **the funder** of each task:

1. **Withdraw** the task's budget in USDC from the wallet's NEAR Intents balance to its own native NEAR account
   (`chain: near`, `recipient: near_account_id`). This is the policy-gated step: the USD budget, the per-transaction
   limit and `owner_approval` all apply here. With approval on, the run waits for the user's vote in Rook's page.
2. **Call** `ft_transfer_call` on the USDC contract from that native account (`native/near/call`; the policy lists the
   USDC contract in `native.near.call`), to `rook.oynozan.near` with the plan's `create_task` message. Rook's contract
   records the wallet's account as the task's funder, exactly as when the user's own wallet funds it.
3. The run is unchanged. Unspent USDC comes back to the wallet's native account at close. Rook then deposits it into
   the wallet's NEAR Intents balance again (`ft_transfer_call` to `intents.near`), so the next task can use it.

Only money that already passed step 1 (budget, limits, the user's approval) ever sits on the native account. The
native call switch is limited to the USDC contract, but it can move any USDC on that native account. That is the trade
the MVP makes, and the plan card says so.

## Spending rules from the chat

The draft can return `spending` when the user states rules (never invented):

| User says | `spending` | Policy |
|---|---|---|
| "Only spend $1000" | `budget_usd: 1000, period: "month"` | `budget.monthly_usd: 1000` |
| "at most $50 a day" | `budget_usd: 50, period: "day"` | `budget.daily_usd: 50` |
| "no task over $20" | `per_task_max_usd: 20` | `limits.per_transaction[USDC]: 20 USDC` |
| "all transactions come to me for approval" | `approval: "every"` | `owner_approval: true` |
| "for the next two weeks" | `expires_days: 14` | grant `expires_at` |

The rules are shown as a "Spending rules" card with the exact policy the wallet gets, before any signature. They are
the conversation's: later messages fund from the same wallet under the same rules until the user changes them.

## Setup (the user signs three times, once)

1. **Create the wallet** (`agent_create`, NEP-366, sponsored: no gas for the user). Policy: `actions: [withdraw]`,
   `assets: [USDC, wrap.near]` (wNEAR only for the 1 yocto deposit `ft_transfer_call` needs), the limits and budget
   from the rules, `owner_approval`, `destinations: only []`, `native.near.call: [USDC contract]`.
2. **Allow the withdrawal to its own native account** (`policy_update` with `destinations: only [{withdraw, near,
   <near_account_id>}]`, NEP-413). Its account id is only known after step 1.
3. **Issue Rook's grant** (`grant_issue`, NEP-413). Rook makes the token, keeps it server side, and shows the user what
   they sign.

Then the user deposits USDC into the wallet (`ft_transfer_call` to `intents.near` with the wallet's account as `msg`,
from their NEAR wallet, one click), and Rook registers the wallet's native account on the USDC contract
(`storage_deposit`, paid by Rook).

## Pieces

| Where | What |
|---|---|
| `services/src/wallet/` | Agent API client (plain `fetch`: the SDK needs Node 24), policy builder from spending rules, the store of wallets, grants and pending intents per owner, the funding steps (withdraw, wait for approval, native call, bind the contract task), the sweep back after close |
| orchestrator routes | `GET /wallet`, `POST /wallet/intents` (generate), `POST /wallet/intents/:cid/submit`, `POST /tasks/:id/fund-from-wallet`, task state `awaiting_approval` |
| planner | `spending` in the draft, validated (positive amounts, known periods), shown as plan notes and on the card |
| web | Spending rules card, wallet setup (three signatures), wallet panel (balance, budget left, pending approvals), "Fund from agent wallet" next to "Fund with my wallet", "Approve this spend" |
| config | `ROOK_AGENT_API_KEY`, `ROOK_AGENT_API_URL` (default the public URL). Without a key the feature reports itself not configured |

## What only the user can do

- Create the partner API key at https://partners.near-intents.org/ and put it in `ROOK_AGENT_API_KEY` (server env only).
- Sign the three setup intents and the approvals with their NEAR wallet.

## Open questions to check against the live API

- Whether a withdrawal to the wallet's own native account is allowed as a destination (the docs don't say otherwise).
- Who pays gas for `native/near/call` (the docs say the wallet provider sends it).
- Whether `agent_create` can list the native account in `destinations` before it exists (if not, step 2 stays).

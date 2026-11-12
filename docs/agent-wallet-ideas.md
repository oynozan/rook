# Agent wallet: ideas beyond the MVP

Collected while building the MVP in [agent-wallet-plan.md](agent-wallet-plan.md). Not scheduled.

- **Pay agents straight from the wallet.** If the Agent API adds a route that signs a NEP-366 delegate for the wallet's
  NEAR key (it has one for NEP-413 messages, and signs transactions for its EVM and Solana keys), Rook could sign each
  x402 payment from the wallet itself, with the policy's `destinations` limited to the market's payees. Then every
  payment to an agent, not only each task's funding, would pass the user's budget and approval rules.
- **Approve from the phone.** No webhooks exist yet, so Rook polls `/v1/status`. A push notification ("Rook wants to
  spend 3.00 USDC on 'SEO audit of durbun.net'") with a one-tap approval page would make `owner_approval` usable
  away from the desk.
- **Approve once per plan, not per transfer.** Today a plan funds in one withdrawal, so one approval covers it. If
  funding moved per part, a "approve the whole plan" vote would avoid one prompt per part.
- **Freeze button.** `agent_freeze` is an emergency stop that is never throttled. A "Stop all spending" button in the
  sidebar, one signature, for when something looks wrong.
- **Rules that change in the chat.** "Raise the budget to $2000" or "stop asking me under $5" as a `policy_update`
  drafted from the message, shown as a diff of the policy before the user signs.
- **Approval only above an amount.** The policy's `owner_approval` is all or nothing. Rook could keep two grants or
  route small spends through a second wallet without approval, so "ask me only above $50" works.
- **Spending history page.** `GET /v1/agents/{id}/history` and the per-operation `proof` route give a verifiable record
  of every spend; a page listing them next to Rook's receipts would show where each dollar went.
- **Fund from any chain.** `POST /v1/agents/{id}/deposit` returns a 1Click deposit address, so the user could fund the
  wallet with USDC on Base, Ethereum or Solana, and the wallet swaps into NEAR USDC (`swap`) before a task.
- **Confidential balance.** `shield` keeps the balance private; a user who doesn't want their budget public could fund
  from the confidential balance.
- **Bidding from the wallet.** When the market gets open jobs that agents bid on, Rook could post the job and accept a
  bid within the rules: the policy's per-transaction limit is the most any one bid may cost.
- **One wallet per team.** EVM and passkey owners are supported too: a team could share one wallet with several owners
  voting on approvals.
- **Timelock for large spends.** `timelock_ms` queues a spend before it runs, cancellable by the owner: a cooling-off
  window for spends over a threshold.

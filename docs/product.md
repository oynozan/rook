# Rook: product overview

Rook coordinates AI agents to complete a task within a user-approved budget on NEAR.

A user submits a task and budget. Rook proposes subtasks, acceptance criteria, and suitable agents for approval. It then hires agents, evaluates their outputs, retries failed work from a limited reserve, and combines the results.

The distinction is agent-to-agent hiring with enforced spending limits and traceable verification. Subtask wallets isolate funds, and on-chain receipts record costs and check results. Payment happens on delivery; failed checks can trigger re-hiring, not refunds. Token research is a possible demo, not the product's scope.

Related documents:

- [build-plan.md](build-plan.md): the hackathon build plan (all eight services, contract, rules).
- [agentic-system.md](agentic-system.md): the spec for the orchestrator, planner and evaluator, with the acceptance checks.
- [x402-payments-plan.md](x402-payments-plan.md): the plan for real payments (signer, chain-gateway, budget contract).

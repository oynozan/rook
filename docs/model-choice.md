# Model choice for the planner and evaluator

Decided 2026-11-07 from NEAR AI Cloud's catalogue, its verification docs, and a benchmark of the real code paths (`services/scripts/bench-models.ts`). Re-run the benchmark before changing a default.

## Decision

| Role | Default | Why |
| --- | --- | --- |
| Planner (`PLANNER_MODEL`) | `z-ai/glm-5.3` | Best plans in the benchmark (sharpest briefs, 6 checkable criteria per subtask, never dropped a subtask that had supply). Runs in a third-party confidential TEE. About 60 s and 0.06 USD per plan, paid once per task |
| Evaluator (`EVALUATOR_MODEL`) | `deepseek-ai/DeepSeek-V4.1-Flash-1017` | 34/34 on the fixtures, about 4 s and 0.0003 USD per evaluation, and its replies carry a `provider_tee` signature from the model's own enclave, the strongest evidence NEAR AI offers |
| Simulated agents (`SIM_AGENT_MODEL`) | `anthropic/claude-haiku-5-5` | Not evidence; cheapest fast model that writes good reports |

Fallback planner when speed matters more than verifiability: `anthropic/claude-sonnet-5-5` (15 s, 0.03 USD, good plans, but it runs at Anthropic outside any TEE).

## What "verifiable" means (NEAR AI docs)

From docs.near.ai/cloud/models, /cloud/private-inference and /cloud/verification/cloud-api/response-signatures (read 2026-11-07):

- **Confidential TEE** models run on NEAR AI's own GPU nodes (NVIDIA H200 confidential computing plus Intel TDX). Their replies are signed by the model's TEE: `signature_kind` `provider_tee`, signed text `<model>:sha256(request):sha256(response)`. This proves the model produced the bytes. Observed: `deepseek-ai/DeepSeek-V4.1-Flash-1017`, `z-ai/glm-5.3-flash`, `Qwen/Qwen3.8-27B`, `Qwen/Qwen3.6-35B-A3B-FP8`.
- **3P Confidential TEE** models run in a third-party provider's TEE; replies are signed by NEAR AI's gateway TEE only (`gateway`, text `sha256(request):sha256(response)`). Observed: `z-ai/glm-5.3`, `moonshotai/kimi-k2.6`.
- **Incognito** models (Anthropic, OpenAI, Google) go through the gateway TEE but run on the provider's infrastructure; the TEE guarantee stops at the gateway. Also `gateway`-signed.
- Full verification of a signature means recovering the ECDSA (EIP-191) signer and matching it to an attestation report from `GET /v1/attestation/report` (Intel TDX quote via DCAP, NVIDIA GPU attestation via NRAS, nonce binding). Rook checks the signed hashes today; signer recovery and attestation are a later step.
- `reasoning_effort` is model-specific: GLM-5.3 honours it, Anthropic models reject the field, DeepSeek V4.1 rejects `medium`, Kimi ignores it. Rook retries once without it when a model rejects it.

## Benchmark

Planner: `POST /plan` against the simulated market for two prompts (NEAR due diligence; Ref Finance REF token), budget 3 USDC.

| Model | Signature | Time per plan | Cost per plan | Result |
| --- | --- | --- | --- | --- |
| `z-ai/glm-5.3` | gateway (3P TEE) | 58–68 s | 0.060–0.067 | 4–5 subtasks, 23–30 criteria, all labels in briefs, 0 repairs in 6 runs |
| `anthropic/claude-sonnet-5-5` | gateway (no TEE) | 15–17 s | 0.032–0.034 | 4 subtasks, 17–21 criteria, 0 repairs |
| `moonshotai/kimi-k3` | gateway | 140–213 s | 0.06–0.11 | 4 subtasks, 19 criteria |
| `deepseek-ai/DeepSeek-V4.1-Flash-1017` | provider_tee | 81 s | 0.007 | Dropped a subtask that had matching agents; one run failed on the network |
| `Qwen/Qwen3.8-27B` | provider_tee | 51–76 s | 0.004–0.005 | Good in round 1; invalid JSON twice on both prompts in round 2 |
| `z-ai/glm-5.3-flash` | provider_tee | 185–244 s | 0.004–0.005 | Good plans, too slow |
| `moonshotai/kimi-k2.6` | gateway | 262 s | 0.04–0.05 | 1 subtask on the NEAR prompt (3 dropped); a repair needed |

Evaluator: `evaluate()` on 8 fixtures with known answers, 2 rounds each (34 checks): labels in Markdown emphasis, paraphrased labels, a missing label (must not be invented), out-of-range numbers, judge questions with and without the answer present, a judge-coercion note, and vague hedging.

| Model | Score | Median time | Cost per evaluation | Signature |
| --- | --- | --- | --- | --- |
| `deepseek-ai/DeepSeek-V4.1-Flash-1017` | 34/34 | ~4 s | 0.0003 | provider_tee |
| `z-ai/glm-5.3-flash` | 34/34 | 9 s | 0.0002 | provider_tee |
| `Qwen/Qwen3.8-27B` | 34/34 | 8.5 s | 0.0005 | provider_tee |
| `Qwen/Qwen3.6-35B-A3B-FP8` | 34/34 | 9.4 s | 0.0021 | provider_tee |
| `z-ai/glm-5.3` | 34/34 | 2.8 s | 0.0026 | gateway |
| `moonshotai/kimi-k2.6` | 34/34 | 38 s | 0.0042 | gateway |
| `anthropic/claude-haiku-5-5` | 34/34 | 1.9 s | 0.0001 | gateway |
| `openai/gpt-6-luna` | 34/34 | 3 s | 0.0001 | gateway |

Every model passed every evaluator fixture, so these fixtures do not separate quality; the evaluator choice rests on signature strength, then latency and cost. Harder fixtures (long reports, conflicting figures, subtle judge questions) would be the next step if a cheaper or faster `provider_tee` model is wanted.

The whole benchmark cost about 1 USD of NEAR AI credit.

## Re-running

```sh
cd services
npx tsx scripts/bench-models.ts evaluator deepseek-ai/DeepSeek-V4.1-Flash-1017
BENCH_DUMP=/tmp/plans npx tsx scripts/bench-models.ts planner z-ai/glm-5.3
```

One model per process; run several processes in parallel. Each process stops at `ROOK_LLM_MAX_USD` (2 by default here).

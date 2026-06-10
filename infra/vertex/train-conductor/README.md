# Conductor trainer (Maestro brain — SFT + DPO)

> **Status**: skeleton. Submits and refuses gracefully today because the
> dataset format and base model choice are still being decided. Once
> finalized, swap the two TODOs in `train.py` and rebuild the image.

The Conductor trainer fine-tunes the **Maestro decision-making model** —
the LLM that picks which tools to call, in what order, when given a song
idea. Two flavours:

| Kind            | Algorithm          | Dataset format                                            |
| --------------- | ------------------ | --------------------------------------------------------- |
| `conductor-sft` | Supervised FT      | Pairs of `(messages[], expected_tool_calls[])`            |
| `conductor-dpo` | Direct Preference  | Triplets of `(prompt, chosen, rejected)`                  |

We use `trl` (HuggingFace TRL) on top of a small instruct base model
(e.g. `Qwen/Qwen2.5-3B-Instruct` or `meta-llama/Llama-3.2-3B-Instruct`)
with LoRA so the full Maestro brain runs inference cheaply on consumer
hardware.

## Sources of training data

* **SFT**: Successful Maestro chat sessions where the user said "yes,
  that's exactly what I wanted" — pulled from `ai_agent_sessions` joined
  with thumbs-up feedback on the produced assets.
* **DPO**: Sibling chat branches where one branch led to thumbs-up and
  the other to thumbs-down on the same starting prompt. The
  `generation_feedback` table + `getDpoPairs(limit)` already mines this
  signal for the music model; the Conductor variant pulls the
  *tool-call sequence* instead of the *audio output*.

## Build

```powershell
docker build -t europe-west1-docker.pkg.dev/mmo-mw-prod/mmo-training/conductor-trainer:latest .
docker push  europe-west1-docker.pkg.dev/mmo-mw-prod/mmo-training/conductor-trainer:latest
```

Submission goes through the same `submit-training.py` script with
`VERTEX_TRAINER_IMAGE` overridden to the conductor image.

# Original Qwen3 embedding runtime

This isolated server serves the original `Qwen/Qwen3-Embedding-8B` weights at revision `1d8ad4ca9b3dd8059ad90a75d4983776a23d44af`. The upstream repository totals 15,150,575,778 bytes. It requires Apple MPS and sufficient unified memory (the experiment host has 32 GiB). There is no smaller-model fallback or remote-code trust.

Create a dedicated environment and download outside tracked source:

```sh
uv venv --python 3.12 .superpowers/research/reharness-2610.12668v1/embedding/.venv
uv pip install --python .superpowers/research/reharness-2610.12668v1/embedding/.venv/bin/python -r evaluation/reharness/embedding-requirements.txt
.superpowers/research/reharness-2610.12668v1/embedding/.venv/bin/hf download Qwen/Qwen3-Embedding-8B --revision 1d8ad4ca9b3dd8059ad90a75d4983776a23d44af --local-dir .superpowers/research/reharness-2610.12668v1/embedding/model
.superpowers/research/reharness-2610.12668v1/embedding/.venv/bin/python evaluation/reharness/embedding_server.py --model-dir .superpowers/research/reharness-2610.12668v1/embedding/model --metadata-dir .superpowers/research/reharness-2610.12668v1/embedding --port 18081 --model-revision 1d8ad4ca9b3dd8059ad90a75d4983776a23d44af
```

The process binds only `127.0.0.1`. `POST /v1/embeddings` accepts `{"model":"Qwen/Qwen3-Embedding-8B","input":"query"}` and returns OpenAI-compatible `data[0].embedding`. `GET /health` returns runtime metadata after model loading. No API key is required. A single process serializes requests.

Use endpoint configuration:

```json
{"endpoint":"http://127.0.0.1:18081/v1/embeddings","model":"Qwen/Qwen3-Embedding-8B","model_revision":"1d8ad4ca9b3dd8059ad90a75d4983776a23d44af","api_key_env":null}
```

Raw symmetric query strings are the default: the ReHarness paper specifies query-to-query retrieval without an exact instruction, and upstream `default_prompt_name` is null. Optional `--instruction` adds the official `Instruct: ...\nQuery:` formatting identically to requests and records its value. It should remain empty for this experiment.

The implementation follows the [official model card](https://huggingface.co/Qwen/Qwen3-Embedding-8B/tree/1d8ad4ca9b3dd8059ad90a75d4983776a23d44af): last-unmasked-token pooling and L2 normalization, full 4096 dimensions. Float16 MPS weights/compute, SDPA attention, and float32 vector normalization can differ numerically from CPU float32, CUDA/FlashAttention, or the paper's unspecified runtime. No quantization or dimension reduction is used. The resource bound is 8192 input tokens (official example length); longer input is rejected, never silently truncated. Model capability itself is 32768 tokens. No KV cache is retained.

Unit checks, independent of model loading:

```sh
.superpowers/research/reharness-2610.12668v1/embedding/.venv/bin/python -m unittest discover -s evaluation/reharness -p test_embedding_server.py
```

The server does not terminate other processes, change Python defaults, alter profiles, or call external inference services. Runtime artifacts record PID, endpoint, model revision, package versions, instruction and precision. Model files and virtual environments should not be committed.

## Artifact identity versus revision labels

`--model-revision` is a caller-declared revision, defaulting to null. A model directory alone does not prove its upstream revision. Before loading, the server hashes each root-level safetensor, JSON config/tokenizer file, and tokenizer vocabulary/merges file. It derives `artifact_fingerprint` as SHA-256 of a canonical sorted file manifest (names, sizes, SHA-256 hashes) and writes `artifact-provenance.json`. This identifies the bytes inspected at startup; keep model files immutable during execution.

When local Hugging Face download metadata is present, a conflicting revision rejects startup. Complete matching metadata is labeled `local-download-metadata-matches`; missing metadata is `unverified`. Local metadata is editable and is not a cryptographic upstream attestation: `revision_attested` remains false. The original experiment separately compared all downloaded weight shard hashes with the upstream manifest.

New server responses and `/health` include the declared `model_revision`, computed artifact fingerprint, evidence status, instruction, device, pooling, attention, weight precision, and normalization precision. The current CLI's `model_revision` configuration remains caller-declared; it does not yet enforce or compare endpoint artifact identity. Do not describe that label as endpoint verification.

The server already running for the pilot predates this provenance response protocol and was deliberately not restarted. Its archived runtime and independent weight verification remain the evidence for that run; the new startup and response fields apply on a subsequent launch.

"""Loopback-only Qwen embedding server; original weights, no remote code."""

import argparse, json, os, time, platform, hashlib
from pathlib import Path
from http.server import BaseHTTPRequestHandler, HTTPServer
import torch
import torch.nn.functional as F
import transformers
from transformers import AutoModel, AutoTokenizer


def validate_payload(data, model):
    if data.get("model") != model:
        raise ValueError("model must be " + model)
    value = data.get("input")
    if not isinstance(value, str) or not value:
        raise ValueError("input must be a nonempty string")
    return value


def validate_token_count(count):
    if count > 8192:
        raise ValueError(
            "input exceeds explicit 8192-token resource bound; no silent truncation"
        )


def last_token_pool(hidden, mask):
    if (mask[:, -1].sum() == mask.shape[0]).item():
        return hidden[:, -1]
    lengths = mask.sum(dim=1) - 1
    return hidden[torch.arange(hidden.shape[0], device=hidden.device), lengths]


def artifact_provenance(model_dir, declared_revision=None):
    """Hash actual local artifacts; HF cache metadata is a local claim, not attestation."""
    paths = sorted(
        p
        for p in model_dir.iterdir()
        if p.is_file()
        and (
            p.suffix in {".safetensors", ".json"}
            or p.name in {"merges.txt", "vocab.txt", "tokenizer.model"}
        )
    )
    if (
        not any(p.suffix == ".safetensors" for p in paths)
        or not (model_dir / "config.json").is_file()
    ):
        raise ValueError(
            "model directory must include safetensor weights and config.json"
        )
    files = []
    cached_revisions = set()
    missing_metadata = []
    for path in paths:
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
                digest.update(chunk)
        files.append(
            {
                "name": path.name,
                "size": path.stat().st_size,
                "sha256": digest.hexdigest(),
            }
        )
        cache = (
            model_dir
            / ".cache"
            / "huggingface"
            / "download"
            / (path.name + ".metadata")
        )
        if cache.is_file():
            lines = cache.read_text().splitlines()
            if lines:
                cached_revisions.add(lines[0])
            else:
                missing_metadata.append(path.name)
        else:
            missing_metadata.append(path.name)
    if declared_revision and any(rev != declared_revision for rev in cached_revisions):
        raise ValueError(
            "declared revision differs from local Hugging Face download metadata"
        )
    canonical = json.dumps(files, sort_keys=True, separators=(",", ":")).encode()
    return {
        "declared_model_revision": declared_revision,
        "artifact_fingerprint": "sha256:" + hashlib.sha256(canonical).hexdigest(),
        "artifact_files": files,
        "cached_revision_claims": sorted(cached_revisions),
        "revision_evidence": "local-download-metadata-matches"
        if declared_revision
        and cached_revisions == {declared_revision}
        and not missing_metadata
        else "unverified",
        "missing_download_metadata": missing_metadata,
        "revision_attested": False,
    }


def response_identity(metadata):
    return {
        key: metadata[key]
        for key in (
            "model_revision",
            "artifact_fingerprint",
            "revision_evidence",
            "revision_attested",
            "instruction",
            "device",
            "weight_dtype",
            "normalization_dtype",
            "pooling",
            "attention",
        )
    }


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, default=18081)
    p.add_argument("--instruction", default="")
    p.add_argument("--model-dir", type=Path, required=True)
    p.add_argument("--metadata-dir", type=Path, required=True)
    p.add_argument(
        "--model-revision",
        default=None,
        help="Caller-declared revision; checked against available local HF metadata, not an attestation",
    )
    args = p.parse_args()
    root = args.metadata_dir
    root.mkdir(parents=True, exist_ok=True)
    MODEL = "Qwen/Qwen3-Embedding-8B"
    provenance = artifact_provenance(args.model_dir, args.model_revision)
    (root / "artifact-provenance.json").write_text(
        json.dumps(provenance, indent=2) + "\n"
    )
    if not torch.backends.mps.is_available():
        raise RuntimeError("MPS unavailable; no silent runtime substitution")
    torch.set_num_threads(4)
    tokenizer = AutoTokenizer.from_pretrained(
        args.model_dir,
        padding_side="left",
        local_files_only=True,
        trust_remote_code=False,
    )
    model = (
        AutoModel.from_pretrained(
            args.model_dir,
            torch_dtype=torch.float16,
            attn_implementation="sdpa",
            local_files_only=True,
            trust_remote_code=False,
            low_cpu_mem_usage=True,
        )
        .eval()
        .to("mps")
    )
    metadata = {
        "pid": os.getpid(),
        "endpoint": f"http://127.0.0.1:{args.port}/v1/embeddings",
        "model": MODEL,
        "model_revision": args.model_revision,
        **{
            key: provenance[key]
            for key in (
                "artifact_fingerprint",
                "revision_evidence",
                "revision_attested",
            )
        },
        "api_key_env": None,
        "device": "mps",
        "weight_dtype": "float16",
        "normalization_dtype": "float32",
        "pooling": "last unmasked token",
        "dimensions": 4096,
        "instruction": args.instruction,
        "max_tokens": 8192,
        "truncation": False,
        "torch": torch.__version__,
        "transformers": transformers.__version__,
        "python": platform.python_version(),
        "attention": "sdpa",
        "trust_remote_code": False,
    }
    (root / "runtime.json").write_text(json.dumps(metadata, indent=2) + "\n")
    print(json.dumps(metadata), flush=True)

    class Handler(BaseHTTPRequestHandler):
        def send_json(self, status, obj):
            data = json.dumps(obj).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            self.send_json(200, metadata) if self.path == "/health" else self.send_json(
                404, {"error": "not found"}
            )

        def do_POST(self):
            if self.path != "/v1/embeddings":
                return self.send_json(404, {"error": "not found"})
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 1048576:
                    raise ValueError("body must be 1..1048576 bytes")
                data = json.loads(self.rfile.read(length))
                value = validate_payload(data, MODEL)
                text = (
                    f"Instruct: {args.instruction}\nQuery:{value}"
                    if args.instruction
                    else value
                )
                batch = tokenizer(
                    [text], padding=True, truncation=False, return_tensors="pt"
                )
                count = batch["input_ids"].shape[1]
                validate_token_count(count)
                start = time.monotonic()
                with torch.inference_mode():
                    outputs = model(
                        **{k: v.to("mps") for k, v in batch.items()}, use_cache=False
                    )
                    vector = F.normalize(
                        last_token_pool(
                            outputs.last_hidden_state, batch["attention_mask"].to("mps")
                        ).float(),
                        p=2,
                        dim=1,
                    )[0].cpu()
                if not torch.isfinite(vector).all():
                    raise RuntimeError("nonfinite model result")
                result = {
                    "object": "list",
                    "model": MODEL,
                    **response_identity(metadata),
                    "data": [
                        {
                            "object": "embedding",
                            "index": 0,
                            "embedding": vector.tolist(),
                        }
                    ],
                    "usage": {"prompt_tokens": count, "total_tokens": count},
                }
                self.send_json(200, result)
                print(
                    json.dumps(
                        {
                            "tokens": count,
                            "seconds": time.monotonic() - start,
                            "norm": vector.norm().item(),
                        }
                    ),
                    flush=True,
                )
                del outputs
                torch.mps.empty_cache()
            except (ValueError, KeyError, json.JSONDecodeError) as exc:
                self.send_json(400, {"error": str(exc)})
            except Exception as exc:
                print(repr(exc), flush=True)
                self.send_json(500, {"error": str(exc)})

    HTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()

import unittest
import tempfile
from pathlib import Path
import torch
from embedding_server import (
    last_token_pool,
    validate_payload,
    validate_token_count,
    artifact_provenance,
    response_identity,
)


class EmbeddingServerTests(unittest.TestCase):
    def test_left_padding_last_token(self):
        x = torch.arange(24).reshape(2, 3, 4)
        self.assertTrue(
            torch.equal(
                last_token_pool(x, torch.tensor([[0, 1, 1], [1, 1, 1]])), x[:, -1]
            )
        )

    def test_right_padding_last_unmasked(self):
        x = torch.arange(24).reshape(2, 3, 4)
        self.assertTrue(
            torch.equal(
                last_token_pool(x, torch.tensor([[1, 1, 0], [1, 0, 0]])),
                torch.stack([x[0, 1], x[1, 0]]),
            )
        )

    def test_reject_oversize_without_truncation(self):
        validate_token_count(8192)
        with self.assertRaises(ValueError):
            validate_token_count(8193)

    def test_model_mismatch_before_inference(self):
        with self.assertRaises(ValueError):
            validate_payload(
                {"model": "wrong", "input": "query"}, "Qwen/Qwen3-Embedding-8B"
            )

    def test_raw_input_preserved(self):
        self.assertEqual(
            validate_payload({"model": "m", "input": " raw query "}, "m"), " raw query "
        )


class ArtifactProvenanceTests(unittest.TestCase):
    def fixture(self, root):
        (root / "config.json").write_text("{}")
        (root / "weights.safetensors").write_bytes(b"weight bytes")
        (root / "tokenizer.json").write_text("{}")

    def test_fingerprint_depends_on_actual_tokenizer_and_weights(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.fixture(root)
            first = artifact_provenance(root, "declared")
            self.assertEqual(first["revision_evidence"], "unverified")
            self.assertFalse(first["revision_attested"])
            self.assertEqual(
                first["artifact_fingerprint"],
                artifact_provenance(root, "other")["artifact_fingerprint"],
            )
            (root / "tokenizer.json").write_text('{"changed":true}')
            second = artifact_provenance(root)
            self.assertNotEqual(
                first["artifact_fingerprint"], second["artifact_fingerprint"]
            )
            (root / "weights.safetensors").write_bytes(b"new weights")
            self.assertNotEqual(
                second["artifact_fingerprint"],
                artifact_provenance(root)["artifact_fingerprint"],
            )

    def test_local_revision_metadata_mismatch_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.fixture(root)
            cache = root / ".cache/huggingface/download"
            cache.mkdir(parents=True)
            for name in ("config.json", "weights.safetensors", "tokenizer.json"):
                (cache / (name + ".metadata")).write_text("revision-a\netag\n0\n")
            self.assertEqual(
                artifact_provenance(root, "revision-a")["revision_evidence"],
                "local-download-metadata-matches",
            )
            with self.assertRaises(ValueError):
                artifact_provenance(root, "revision-b")

    def test_incomplete_download_metadata_is_not_verified(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.fixture(root)
            cache = root / ".cache/huggingface/download"
            cache.mkdir(parents=True)
            (cache / "config.json.metadata").write_text("revision-a\n")
            self.assertEqual(
                artifact_provenance(root, "revision-a")["revision_evidence"],
                "unverified",
            )

    def test_response_carries_precision_instruction_and_identity(self):
        keys = (
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
        metadata = {key: key for key in keys}
        metadata["private_extra"] = "excluded"
        self.assertEqual(set(response_identity(metadata)), set(keys))


if __name__ == "__main__":
    unittest.main()

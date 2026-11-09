# Working Rules for an AI Agent

- Read repository ARCHITECTURE.md to locate the current implementation.
- Implement only the feature described in the accompanying task. Do not infer that all possible future extensions are approved. Avoid unrelated refactoring, dependency upgrades, or changes to generated output.
- Add focused positive and negative tests. Preserve existing public API behavior and golden outputs unless a contract/output change is explicitly approved and versioned.
- Run Core tests, host-parity tests, and the existing 24-configuration generated-project integration matrix. Report the exact results and any tests that were not run. Do not claim unverified success.
- Deliver a minimal diff, affected-file summary, compatibility impact, and clear acceptance evidence.
- Success means: the requested feature is added without moving business logic into clients, breaking existing P0 behavior, or weakening generation and integration checks.

# Tasks: detect-untranslated-ai-output

## 1. Evidence classification

- [x] 1.1 Add Unicode-aware normalization and dominant-script detection.
- [x] 1.2 Classify strong, weak, and no-evidence untranslated candidates.
- [x] 1.3 Exempt non-language and target-script retained content.

## 2. Pipeline integration

- [x] 2.1 Apply semantic validation to echo and legacy string responses.
- [x] 2.2 Aggregate cross-script exact weak candidates only when batch strong evidence exceeds 1/3.
- [x] 2.3 Revalidate targeted repair output and enforce the three-attempt cap.
- [x] 2.4 Replace rounded retry threshold with `problemCount * 3 > batchSize`.

## 3. Verification and contract

- [x] 3.1 Add issue #283 ten-line offline regression coverage.
- [x] 3.2 Add same-script Spanish/Portuguese and Croatian/Serbian regressions.
- [x] 3.3 Invoke real `handleAIBatchTranslation` with an injected offline translator for retry, repair, and cap coverage.
- [x] 3.4 Update canonical spec and this delta.
- [x] 3.5 Cover promoted proper-name repair exhaustion and preserve the original weak-evidence output.
- [x] 3.6 Cover `auto` source-language detection while retaining the explicit same-language exemption.

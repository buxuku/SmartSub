# Tasks: add-xiaomi-mimo-audio-providers

## 1. Shared protocol and providers

- [x] 1.1 Add shared MiMo URL, authentication, timeout and error helpers.
- [x] 1.2 Register Xiaomi MiMo ASR with fixed model, safe upload limit and provider defaults.
- [x] 1.3 Implement ASR request, language mapping, response parsing, retry and cancellation.
- [x] 1.4 Register Xiaomi MiMo TTS with the eight fixed voices and provider defaults.
- [x] 1.5 Implement TTS request, WAV validation, PCM normalization and global-speed atempo.

## 2. Pipeline and UI

- [x] 2.1 Route no-timestamp ASR providers directly through 20-second silence chunks.
- [x] 2.2 Apply optional TTS request intervals without changing legacy provider defaults.
- [x] 2.3 Add the coarse-timeline model badge and Xiaomi provider icon.
- [x] 2.4 Add matching Chinese and English field guidance.

## 3. Documentation

- [x] 3.1 Add standalone ASR and TTS provider guides with credential-free screenshots.
- [x] 3.2 Update ASR/TTS comparison pages and current provider counts.
- [x] 3.3 Update Chinese, English and Japanese READMEs.

## 4. Verification

- [x] 4.1 Add focused protocol, retry, cancellation, audio and speed tests.
- [x] 4.2 Pass i18n, engine and dubbing unit tests.
- [x] 4.3 Pass full app and docs CI-equivalent checks.
- [x] 4.4 Run real ASR/TTS smoke tests without persisting credentials.

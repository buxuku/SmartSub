## ADDED Requirements

### Requirement: Protocol-type provider presets

The system SHALL let a protocol-type cloud ASR provider type (e.g. OpenAI-compatible) declare a list of named presets, where each preset carries connection field values (such as base URL and model list) but not credentials. When creating a new instance of such a type, the configuration panel SHALL offer these presets for one-click prefill in addition to a "Custom" option. A preset SHALL only prefill field values; the created instance's provider `type` and the backend transcription/dispatch behavior SHALL remain unchanged.

#### Scenario: Selecting a preset prefills endpoint and models

- **WHEN** a user opens the "Add instance" menu under a protocol-type provider that has presets and selects a preset (e.g. Groq)
- **THEN** a new instance is created with that preset's base URL and model list prefilled, the provider `type` unchanged, and the instance selected for editing

#### Scenario: Custom selection uses type defaults

- **WHEN** a user chooses the "Custom" option instead of a named preset
- **THEN** a new instance is created using only the provider type's default field values (equivalent to the pre-existing add behavior)

#### Scenario: Presets never fill credentials

- **WHEN** an instance is created from any preset
- **THEN** no API key or other credential is written by the preset, and the instance is reported as not-yet-configured until the user supplies the required credential

#### Scenario: Brand-type and preset-less types are unaffected

- **WHEN** the provider type is a brand-type singleton (e.g. ElevenLabs) or a protocol-type without declared presets
- **THEN** the add/configure affordance behaves exactly as before this change, with no preset dropdown introduced

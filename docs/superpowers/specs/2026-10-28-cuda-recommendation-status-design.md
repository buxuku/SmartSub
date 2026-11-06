# CUDA recommendation and current status

Issue #130's diagnostics show CUDA 13 lite recommended with Toolkit 12.6, followed by a persisted fallback still presented after a full package was installed. The user authorized fixing both on a new branch.

- Keep choosing the CUDA addon version from driver capability. Recommend lite only when the detected Toolkit has the same major and an equal or newer minor version. Unknown/unparseable versions require full. Ignore patch numbers because nvcc reports component build versions.
- Share this check between the main process and download UI, including manual version selection and package switching. Update Chinese and English explanations.
- Current backend means a load performed in this session under the current addon configuration. Startup and cache invalidation return pending, not a persisted load. Notify renderers when the current result is invalidated.
- Preserve `lastAddonLoadResult` and `addonLoadHistory` for exported diagnostics. Actual new loads continue to publish success/fallback results.
- No native loading changes, automatic test transcription, dependency installation, or claims about whether the user's current Windows environment works.

## Approaches

Use one shared Toolkit compatibility check instead of downgrading the recommended addon to match an old Toolkit; this preserves support for newer GPUs and uses bundled runtimes when needed. Separate session state from diagnostic history instead of deleting evidence or merely hiding the error text. These are implementation choices within the approved fix scope.

## Verification

Regression coverage for mismatched/unknown Toolkit versions, matching major/minor boundaries, manually selected versions, startup with persisted history, invalidation notifications, retained diagnostic evidence, and a new load replacing pending status. Run the GPU suite, renderer regressions, locale checks, and relevant TypeScript checks.

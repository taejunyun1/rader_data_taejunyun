# UI Accessibility Remediation Report

Date: 2026-08-25
Scope: Visual Inspector, decision sheets, mobile PDF extraction sheet, related styles, and focused UI tests only.

## Findings

- The mobile visual inspector exposed `aria-modal="true"` without focus trapping, Escape handling, or background isolation.
- The decision sheet trapped focus only partially and did not hide/inert background content while open.
- The mobile PDF extraction sheet restored trigger focus on close, but it did not manage initial focus, focus trapping, Escape, or background isolation.

## Remediation

- Added a shared modal accessibility helper for:
  - initial focus placement
  - Tab and Shift+Tab focus wrapping
  - Escape close
  - background `aria-hidden` and `inert`
  - body scroll locking and trigger focus restoration
- Portaled the mobile visual inspector into a dedicated modal layer with a scrim and dialog keyboard handling.
- Applied the shared modal behavior to the decision sheet and the mobile PDF extraction sheet.
- Dismissed the decision sheet when decision, reanalysis, or refetch actions start so async work no longer leaves the background inaccessible.
- Expanded focused tests to cover keyboard behavior, focus restoration, and background isolation.

## Verification

- `pnpm exec vitest run src/components/reading/DecisionBottomSheet.test.tsx src/components/visual/VisualWorkspace.test.tsx src/views/ReservoirView.test.tsx`
  - Passed: 56 / 56 tests
- `pnpm run typecheck`
  - Passed

## Limitations

- Verification was scoped to the touched web surfaces and the web package typecheck only.
- No deployment or backend/API changes were performed.

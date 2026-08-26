# UI Accessibility Remediation Report

Date: 2026-08-26
Scope: Visual Inspector, decision sheets, mobile PDF extraction sheet, Discover/Reservoir async decision UX, the Discover candidate keep route, and web verification fixtures/tests.

## Findings

- The mobile visual inspector exposed `aria-modal="true"` without focus trapping, Escape handling, or background isolation.
- The decision sheet trapped focus only partially and did not hide/inert background content while open.
- The mobile PDF extraction sheet restored trigger focus on close, but it did not manage initial focus, focus trapping, Escape, or background isolation.
- DiscoverView and ReservoirView closed decision sheets before awaiting actions, so failures were reported only to an unmounted/closed sheet.
- DiscoverView's develop flow treated a failed `/api/signals` response as success; retrying then repeated the keep request, while the keep route did not persist or reuse the created source/job.
- A persisted candidate source with a failed, blocked, or missing acquisition job returned success without recovery, leaving keep/develop retries permanently link-only or incomplete.
- Visual asset tests asserted a stale fixed calendar date, and the PDF extraction fixture's valid xref whitespace was visible to Git's text diff checker.

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
- Added active-view error status and retry affordances for failed DiscoverView and ReservoirView decision actions.
- Made failed develop-signal responses visible to DiscoverView and made the candidate keep route persist `source_id`, reuse active/succeeded acquisition jobs, and re-enqueue failed/blocked/missing acquisitions without recreating the source.
- Replaced fixed visual-asset dates with deterministic ISO timestamp validation.
- Scoped the PDF and inspector close controls to their respective dialogs and marked the binary PDF fixture as non-text in `.gitattributes`.
- Expanded tests to cover keyboard behavior, focus restoration, background isolation, pending-action dismissal, failure visibility, and retry behavior.

## Verification

- `pnpm exec vitest run src/views/DiscoverView.test.tsx src/views/ReservoirView.test.tsx src/lib/visualAssets.test.ts`
  - Passed: 128 / 128 tests
- `pnpm exec vitest run src/views/DiscoverView.test.tsx src/lib/discoverCandidatesRoute.test.ts`
  - Passed: 2 files / 37 tests
- `pnpm exec vitest run`
  - Passed: 41 files / 412 tests
- `pnpm run typecheck` (workspace)
  - Passed
- `pnpm run build`
  - Passed
- `PLAYWRIGHT_PORT=4176 pnpm exec playwright test tests/e2e/visual-extraction-web-pdf.spec.ts --project=chromium`
  - Passed: 3 / 3 tests
- `git diff --check`
  - Passed

## Limitations

- Playwright verification covered the targeted visual-extraction spec, not the full E2E suite; ports 4173–4175 were already occupied, so the isolated run used port 4176.
- No deployment was performed; backend changes remain scoped to Discover candidate keep idempotency and acquisition recovery.

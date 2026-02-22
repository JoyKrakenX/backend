# Data Purge Runbook (Pre-Delivery)

This runbook defines the controlled cleanup workflow for test data before delivery.

## Scope

The purge script handles full application data cleanup for:

- users (with allowlisted admin/support retention)
- surveys and survey_2
- opinions, opinion_2, opinion_flashes, opinion_2_flashes
- chatmessages
- supporttickets, supportconversations, supportmessages
- supportpushsubscriptions
- newslettersubscribers
- userprivacysettings

It also removes QR/upload artifacts from:

- `backend/uploads/qrcodes` (`survey-*` and `debug-logo-*` files only)
- `backend/uploads/support` (files only, folder kept)

## Prerequisites

1. Stop API/socket processes (maintenance window).
2. Confirm `.env` points to the intended MongoDB environment.
3. Confirm allowlist env vars are present:
   - `SUPPORT_ADMIN_EMAILS` or `ADMIN_EMAILS`

## Commands

Run from `backend/`.

### 1) Dry-run (mandatory first)

```bash
npm run data:purge:dry-run
```

Expected:

- no deletion
- full pre-purge inventory in log file under `backend/logs/`

### 2) Execute purge with mandatory backup

```bash
npm run data:purge:execute -- --backup-dir ./backups/purge-manual-YYYYMMDD-HHMM
```

Notes:

- Backup is required in execute mode.
- If `--backup-dir` is omitted, an auto directory is created under `backend/backups/purge-<timestamp>`.
- The command requires `--confirm CLEAN_TEST_DATA` (already included in `data:purge:execute`).

### 3) Verify post-purge log

Check `backend/logs/data-purge-<timestamp>.json`:

- `verification.success` must be `true`.
- all business collections must be `0` except preserved allowlisted users.

## Restore (if needed)

Dry-run validation:

```bash
npm run data:restore -- --manifest ./backups/purge-<timestamp>/manifest.json --dry-run
```

Execute restore:

```bash
npm run data:restore -- --manifest ./backups/purge-<timestamp>/manifest.json --execute --confirm RESTORE_DATA
```

Expected:

- checksums validated
- counts after restore match `manifest.countsBefore`

## Post-maintenance checks

1. Restart backend service.
2. Login with preserved admin/support account.
3. Validate application is clean (no test surveys or test users except retained allowlisted account(s)).
4. Create and close one validation survey.
5. Archive backup folder and operation log for traceability.

# dynamic-processor (Phase 1)

This Edge Function handles:

- `save_and_send` (and legacy alias `save_and_sync`)
- `scan_migration_conflicts`
- `auth_sign_in`
- `auth_complete_password_reset`

## Environment Variables

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

## Request: save_and_send

```json
{
  "action": "save_and_send",
  "request_id": "optional-uuid",
  "table": "pricing_catalog_state",
  "payload": {
    "meta": {},
    "brands": [],
    "ticketLines": [],
    "resources": []
  },
  "user_operations": [],
  "actor_name": "Primary Admin",
  "actor_user_id": "optional-uuid",
  "actor_role": "primary_admin"
}
```

### Notes
- Catalog payload is force-sanitized to:
  - `meta`
  - `brands`
  - `ticketLines`
  - `resources`
- User ops are accepted from `user_operations`:
  - `create_user`
  - `update_user`
  - `set_user_status`
  - `delete_user`
- All user ops are queued in `auth_provisioning_tasks`.
- Explicit readiness state is tracked for account-creation tasks (`create_user`).
- A provisioning pass runs automatically so pending account tasks can move to ready state.
- Admin response messages are plain language.

## Request: auth_sign_in

```json
{
  "action": "auth_sign_in",
  "role": "admin",
  "identifier": "WWID or work email",
  "password": "user password"
}
```

Returns plain-language status and a sanitized user profile (no internal synthetic login identifier).

## Request: auth_complete_password_reset

```json
{
  "action": "auth_complete_password_reset",
  "role": "marketer",
  "identifier": "WWID or work email",
  "current_password": "temporary password",
  "new_password": "new password"
}
```

Completes forced reset flow in cloud auth and clears `force_password_reset`.

## Request: scan_migration_conflicts

```json
{
  "action": "scan_migration_conflicts",
  "users": [],
  "actor_user_id": "optional-uuid",
  "source_label": "local_export"
}
```

This writes a migration run + conflict rows for duplicate WWID role/material conflicts.

# Auth/Support Role Resolution

This backend separates billing exemption from support privileges.

## Environment Variables

- `BILLING_EXEMPT_EMAILS` (or `SUPER_ADMIN_EMAILS` fallback): billing-only exemption.
- `GLOBAL_SUPPORT_ADMIN_EMAILS`: dedicated global support allowlist (CSV).
- `SUPPORT_ADMIN_EMAILS` / `ADMIN_EMAILS`: legacy support/admin allowlists (backward compatibility).

Example:

```env
GLOBAL_SUPPORT_ADMIN_EMAILS=tomseigneurjoyagbossou@gmail.com
```

## Effective Role Priority

1. If email is in `GLOBAL_SUPPORT_ADMIN_EMAILS` -> effective role is `support`.
2. Else if email is billing-exempt -> effective role is `user`.
3. Else fallback to existing support/admin allowlists and stored role.

## Important

- Billing exemption does not grant org/survey global admin rights.
- Support access is controlled by support allowlists, not by billing exemption.

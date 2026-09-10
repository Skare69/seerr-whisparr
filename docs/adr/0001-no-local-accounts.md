# No local Velvarr accounts; identity stays with the media server

Proposed 2026-09-10 so that people who run Plex/Emby instead of Jellyfin could
still sign in. Rejected: local accounts do not give a non-Jellyfin user a
working application, because every authenticated read in Velvarr is performed
with **that user's own media-server token** — `listLibraries`,
`listLibraryItems`, `getLibraryItem`, `getLibraryImage`, the per-request
`validateUser` re-check, the credential-free watch link, and (per the planned
M7) removal executed as the requester. An account with no upstream identity
therefore has no library, no availability truth, no playback authorization and
no deletion authority: a login that reaches an empty, permanently
"Not available" application.

The real answer to "someone uses something else" is a **second media-server
provider** implementing the same four contracts (authenticate a user, list that
user's libraries, list/read that user's items, build a deep link into the
server's own web client), not a parallel identity system. That work is deferred
until a real non-Jellyfin deployment exists; nothing about it is blocked by
this decision, because the seam already exists: `Account` carries no
Jellyfin-specific field, `ExternalUser` is the provider-shaped record, and the
only provider-coupled pieces are `src/server/jellyfin.ts` and
`Session.jellyfinToken`.

Consequences accepted:

- Velvarr never stores a password, keeps no password reset/lockout surface, and
  cannot be used by anyone the media server does not know. Account admission,
  role and library grants stay Velvarr's own; authentication does not.
- If the media server is unreachable, nobody can sign in — including the owner.
  This is deliberate: with the server down there is no library, no
  availability and no playback either. If offline administrator access is ever
  needed, the smallest sufficient mechanism is a break-glass, operator-supplied
  environment secret (the existing `VELVARR_SETUP_SECRET` pattern), not stored
  passwords.
- Request-only accounts (browse and request, watch elsewhere) are likewise not
  a reason for local accounts; grant such a user a media-server account without
  playback permission instead.

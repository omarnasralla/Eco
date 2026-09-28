-- Web push: the delivery half of a notification system that was otherwise
-- complete. sendPush() has logged "would push" since it was written.
--
-- On iOS this only works for a site added to the Home Screen — Apple does not
-- allow push from a Safari tab — which is why the web platform matters here
-- rather than waiting for a native app.
--
-- A Web Push subscription is three values, not one: the endpoint URL plus two
-- keys the browser generates for encrypting the payload. The endpoint keeps
-- using the existing `token` column, since it is the unique identifier for a
-- subscription; the keys are new and are null for the native platforms, which
-- carry a plain device token and nothing else.

ALTER TABLE "push_tokens" ADD COLUMN "p256dh" TEXT;
ALTER TABLE "push_tokens" ADD COLUMN "auth"   TEXT;

-- Three new reasons to notify, all of them about the automatic capture that
-- now records most spending:
--
--   CAPTURE_FAILED  — a message arrived and could not be recorded. Every
--                     failure of this kind has so far been silent, which is
--                     how a missing purchase went two days without being
--                     noticed.
--   NEEDS_REVIEW    — captured expenses filed under a guessed category, sent
--                     as one daily summary rather than one per purchase.
--   CAPTURE_UNKNOWN — a message whose format the parser does not recognise,
--                     which means a bank changed its wording and a pattern
--                     needs adding.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'CAPTURE_FAILED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'NEEDS_REVIEW';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'CAPTURE_UNKNOWN';

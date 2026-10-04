-- A bank reversed a charge it had already alerted us about, so the expense
-- captured from that alert was removed.
--
-- Its own type rather than SYSTEM or CAPTURE_FAILED: nothing failed and
-- nothing needs doing, but an expense vanishing from the list on its own is
-- alarming unless the user is told why. This is the one capture that deletes
-- instead of adding, which is exactly why it has to announce itself.

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'TRANSACTION_REVERSED';

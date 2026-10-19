-- Downloadable launcher binaries are public because updates must work before
-- sign-in. The source repository and write credentials remain private.
INSERT INTO storage.buckets (id, name, public)
VALUES ('bweeep-launcher-updates', 'bweeep-launcher-updates', true)
ON CONFLICT (id) DO NOTHING;

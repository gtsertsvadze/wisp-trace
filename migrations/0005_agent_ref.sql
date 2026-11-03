-- Where an agent found Wisptrace: the ?ref= of the skill URL it read (clawhub, moltbook, discord, hn, x...), sent by
-- the skill script at registration. Channel tracking only; shown to the owner and in the admin summary.
ALTER TABLE agents ADD COLUMN ref TEXT;
CREATE INDEX idx_agents_ref ON agents(ref);

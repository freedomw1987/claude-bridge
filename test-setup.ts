/**
 * Preload for `bun test`. Runs BEFORE any test file is loaded, so env
 * vars are set before config.ts is first evaluated.
 *
 * Unconditional overwrite is safe here: tests don't need real Discord
 * credentials, and a stray .env load by Bun would otherwise leak in.
 */

process.env.DISCORD_TOKEN = "test-token";
process.env.DISCORD_CHANNEL_ID = "test-channel";
process.env.DISCORD_USER_ID = "test-user";

#!/usr/bin/env ts-node
/**
 * Registers /start, /stop, /status as global Discord application commands.
 * Run once after creating your Discord application.
 *
 * Usage: npx ts-node discord/register-commands.ts
 * Requires: DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN in environment or .env
 */

import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.join(__dirname, "../.env") });

const APPLICATION_ID = process.env.DISCORD_APPLICATION_ID;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

if (!APPLICATION_ID || !BOT_TOKEN) {
  console.error(
    "Missing DISCORD_APPLICATION_ID or DISCORD_BOT_TOKEN in environment"
  );
  process.exit(1);
}

const commands = [
  {
    name: "start",
    description: "Start the Minecraft server",
  },
  {
    name: "stop",
    description: "Stop the Minecraft server",
  },
  {
    name: "status",
    description: "Check the Minecraft server status",
  },
];

async function registerCommands() {
  const url = `https://discord.com/api/v10/applications/${APPLICATION_ID}/commands`;
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bot ${BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(commands),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Discord API error ${res.status}: ${body}`);
  }

  const registered = (await res.json()) as Array<{ name: string; id: string }>;
  console.log("Registered commands:");
  for (const cmd of registered) {
    console.log(`  /${cmd.name} (${cmd.id})`);
  }
}

registerCommands().catch((err) => {
  console.error(err);
  process.exit(1);
});

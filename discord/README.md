# Discord Bot Setup

This sets up `/start`, `/stop`, and `/status` slash commands that control the Minecraft server without needing AWS credentials.

## Prerequisites

- AWS CDK deployed (MinecraftBucket + MinecraftServer stacks must exist)
- Node.js 18+

## Steps

### 1. Create a Discord Application

1. Go to https://discord.com/developers/applications
2. Click **New Application**, give it a name (e.g. "Minecraft Bot")
3. Under **General Information**, copy:
   - **Application ID**
   - **Public Key**
4. Under **Bot**, click **Add Bot**, then copy the **Token**

### 2. Add credentials to `.env`

Copy `.env.example` to `.env` and fill in the values:

```
DISCORD_PUBLIC_KEY=<from General Information>
DISCORD_BOT_TOKEN=<from Bot section>
DISCORD_APPLICATION_ID=<from General Information>
```

### 3. Deploy the stack

```bash
task deploy
```

Note the `DiscordEndpoint` output URL printed at the end.

### 4. Set the Interactions Endpoint URL

1. In the Discord Developer Portal, go to your application → **General Information**
2. Paste the `DiscordEndpoint` URL into **Interactions Endpoint URL**
3. Click **Save Changes** — Discord will send a PING and show a green checkmark if the handler is working

### 5. Register slash commands

```bash
task register-discord-commands
```

This registers `/start`, `/stop`, `/status` as global commands. Global commands take up to 1 hour to propagate.

### 6. Invite the bot to your server

Generate an invite URL in the Developer Portal under **OAuth2 → URL Generator**:
- Scope: `applications.commands`
- Copy and open the URL to add the bot to your Discord server

### 7. Test

In any channel where the bot has access:
- `/status` — shows current server state
- `/start` — launches the EC2 instance
- `/stop` — cancels the spot request and terminates the instance

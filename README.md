# KF2-DiscordLink-Edited

# How to use discord script in Windows

This section explains how to set up and run the Discord bot script on Windows.

## 1. Install Node.js

Download and install the current LTS version of Node.js:

https://nodejs.org

After installation, open Command Prompt and check that Node.js and npm are available:

```bash
node -v
npm -v
```

Example output:

```bash
v20.11.1
10.2.4
```

If both commands print a version number, Node.js is installed correctly.

## 2. Install dependencies

Open a terminal as an Administrator in the `discord-bot-script` folder and run:

```bash
npm install discord.js dotenv
```

This will install the required libraries used by the bot.

## 3. Create the `.env` file

Inside the `discord-bot-script` folder, create a `.env` file based on `example.env`.

You will need the following values:

- `DISCORD_TOKEN` - from the Discord Developer Portal under `Bot`
- `CLIENT_ID` - from `General Information`
- `GUILD_ID` - enable Discord Developer Mode, then right-click your server and copy its ID
- `STEAM_API_KEY` - optional, used to show Steam avatars when forwarding KF2 chat through a webhook

Discord Developer Portal:

https://discord.com/developers/applications

The bot needs the `MESSAGE CONTENT INTENT` enabled in the Discord Developer Portal if you want Discord channel messages forwarded back to KF2.

## 4. Run the bot

Open a terminal in the `discord-bot-script` folder and run:

```bash
node .\index.js
```

If everything is configured correctly, the bot will start, register its slash commands for your server, and respond to them in Discord.

## 5. Notes

While the bot is running, changes to settings in `discord-bot-script/.env` are reloaded automatically except `DISCORD_TOKEN`, `CLIENT_ID`, `GUILD_ID`, and `STEAM_API_KEY`. Changing a server host or port restarts only that KF2 socket connection. Discord token, client ID, guild ID, and Steam API key changes still require restarting the bot.
When `.env` is reloaded, the bot logs each changed setting with its previous and new value. Startup-only settings are logged as not applied and require a restart.

Normal slash commands spend public tokens. Commands with `hidden=true` spend private tokens. If a user runs out of public tokens, normal commands automatically spend private tokens and answer hidden. If private tokens are also exhausted, the bot sends that user a hidden limit message instead of processing the command.

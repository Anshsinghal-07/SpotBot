require('dotenv').config();
const { App, LogLevel } = require('@slack/bolt');
const mongoose = require('mongoose');
const Spot = require('./Spot');
const Installation = require('./Installation');

// ─── Startup Env Check ────────────────────────────────────────────────────────
const requiredVars = ['SLACK_CLIENT_ID', 'SLACK_CLIENT_SECRET', 'SLACK_SIGNING_SECRET', 'SLACK_STATE_SECRET', 'MONGODB_URI'];
requiredVars.forEach(v => {
  console.log(`  ${v}: ${process.env[v] ? 'SET' : '*** MISSING ***'}`);
});

// ─── MongoDB Connection ───────────────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err));

// ─── Installation Store (Multi-Workspace Token Storage) ───────────────────────
const installationStore = {
  storeInstallation: async (installation) => {
    const teamId = installation.team.id;
    await Installation.findOneAndUpdate(
      { teamId },
      {
        teamId,
        teamName: installation.team.name,
        botToken: installation.bot.token,
        botId: installation.bot.id,
        botUserId: installation.bot.userId,
        installation,
      },
      { upsert: true, new: true }
    );
    console.log(`Installation stored for team ${teamId}`);
  },

  fetchInstallation: async (installQuery) => {
    const teamId = installQuery.teamId;
    const record = await Installation.findOne({ teamId });
    if (!record) {
      throw new Error(`No installation found for team ${teamId}`);
    }
    return record.installation;
  },

  deleteInstallation: async (installQuery) => {
    const teamId = installQuery.teamId;
    await Installation.deleteOne({ teamId });
    console.log(`Installation deleted for team ${teamId}`);
  },
};

// ─── Initialize Bolt App (HTTP mode + OAuth) ─────────────────────────────────
const app = new App({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  clientId: process.env.SLACK_CLIENT_ID,
  clientSecret: process.env.SLACK_CLIENT_SECRET,
  stateSecret: process.env.SLACK_STATE_SECRET,
  scopes: [
    'chat:write',
    'channels:history',
    'files:read',
    'commands',
    'users:read',
    'reactions:write',
    'reactions:read',
  ],
  installationStore,
  installerOptions: {
    directInstall: true, // Clicking /slack/install goes straight to Slack OAuth
  },
  logLevel: process.env.SLACK_DEBUG === '1' ? LogLevel.DEBUG : LogLevel.INFO,
});


// ─── Channel Guard Helper ─────────────────────────────────────────────────────
// Returns the active channel for a team, or null if not set
async function getActiveChannel(teamId) {
  const record = await Installation.findOne({ teamId });
  return record?.activeChannelId || null;
}

// Checks if a message/command is in the active channel. Returns true if allowed.
async function isActiveChannel(teamId, channelId) {
  const active = await getActiveChannel(teamId);
  if (!active) return false; // No channel set yet
  return active === channelId;
}


// ─── The "Set Channel" Command (Admin Only) ──────────────────────────────────
// An admin runs /setchannel in the channel they want SpotBot to operate in
app.command('/setchannel', async ({ command, ack, say, client }) => {
  await ack();

  try {
    // Admin check
    const userResult = await client.users.info({ user: command.user_id });
    const isAdmin = userResult.user.is_admin;

    if (!isAdmin) {
      return await say(`🚫 *Access Denied.* <@${command.user_id}>, only Workspace Admins can set the SpotBot channel.`);
    }

    // Save this channel as the active channel for this workspace
    await Installation.findOneAndUpdate(
      { teamId: command.team_id },
      { activeChannelId: command.channel_id }
    );

    await say(`✅ *SpotBot is now active in this channel!* All spotting will happen here.`);

  } catch (error) {
    console.error(error);
    await say("⚠️ I had trouble setting the channel.");
  }
});


// ─── The "Spot" Listener ─────────────────────────────────────────────────────
// Triggers on "spot/spotted" OR any message with a @mention
app.message(/spot|spotted|<@[A-Z0-9]+>/i, async ({ message, say }) => {
  console.log('[SPOT] Message received:', { team: message.team, channel: message.channel, text: message.text, hasFiles: !!(message.files && message.files.length) });

  // Only operate in the configured channel
  const channelOk = await isActiveChannel(message.team, message.channel);
  console.log('[SPOT] Active channel check:', channelOk);
  if (!channelOk) return;

  const mentionMatch = message.text.match(/<@([A-Z0-9]+)>/);
  const targetUser = mentionMatch ? mentionMatch[1] : null;
  const hasImage = message.files && message.files.length > 0;
  console.log('[SPOT] Parsed:', { targetUser, hasImage });

  if (targetUser && hasImage) {
    try {
      const newSpot = new Spot({
        teamId: message.team,
        spotterId: message.user,
        targetId: targetUser,
        imageUrl: message.files[0].url_private,
        channelId: message.channel,
        messageTs: message.ts,
      });

      await newSpot.save();
      await say(`✅ *Spot Logged!* <@${message.user}> has captured <@${targetUser}> in the wild.`);
    } catch (error) {
      console.error(error);
      await say("⚠️ I had trouble saving that spot to the database.");
    }
  } else if (!hasImage && targetUser) {
    await say(`📸 No photo, no glory, <@${message.user}>!`);
  }
});


// ─── The "Spotboard" Command ─────────────────────────────────────────────────
app.command('/spotboard', async ({ command, ack, say }) => {
  await ack();

  if (!await isActiveChannel(command.team_id, command.channel_id)) {
    return await say("⚠️ SpotBot isn't active in this channel. An admin can run `/setchannel` to activate it.");
  }

  let limit = parseInt(command.text) || 10;
  if (limit > 25) limit = 25;

  try {
    const leaderboard = await Spot.aggregate([
      { $match: { teamId: command.team_id, channelId: command.channel_id, status: 'confirmed' } },
      { $group: { _id: '$spotterId', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: limit }
    ]);

    if (leaderboard.length === 0) {
      return await say("No spots yet! Go touch grass and find someone!");
    }

    let messageText = `🏆 *Top ${limit} Spotters*\n`;
    leaderboard.forEach((entry, index) => {
      const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '•';
      messageText += `${medal} <@${entry._id}>: *${entry.count}* spots\n`;
    });

    await say(messageText);

  } catch (error) {
    console.error(error);
    await say("⚠️ I had trouble crunching the numbers for the leaderboard.");
  }
});


// ─── The "Caughtboard" Command ───────────────────────────────────────────────
app.command('/caughtboard', async ({ command, ack, say }) => {
  await ack();

  if (!await isActiveChannel(command.team_id, command.channel_id)) {
    return await say("⚠️ SpotBot isn't active in this channel. An admin can run `/setchannel` to activate it.");
  }

  let limit = parseInt(command.text) || 10;
  if (limit > 25) limit = 25;

  try {
    const leaderboard = await Spot.aggregate([
      { $match: { teamId: command.team_id, channelId: command.channel_id, status: 'confirmed' } },
      { $group: { _id: '$targetId', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: limit }
    ]);

    if (leaderboard.length === 0) {
      return await say("Everyone is a ninja here. No one has been caught yet!");
    }

    let messageText = `🎯 *Top ${limit} Most Wanted (Caught)*\n`;
    leaderboard.forEach((entry, index) => {
      const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '•';
      messageText += `${medal} <@${entry._id}>: *${entry.count}* times\n`;
    });

    await say(messageText);

  } catch (error) {
    console.error(error);
    await say("⚠️ I had trouble loading the Caughtboard.");
  }
});


// ─── The "Pics" Listener ─────────────────────────────────────────────────────
app.message(/pics/i, async ({ message, say }) => {
  if (!await isActiveChannel(message.team, message.channel)) return;

  const mentionMatch = message.text.match(/<@([A-Z0-9]+)>/);
  const targetUser = mentionMatch ? mentionMatch[1] : null;

  if (!targetUser) {
    return await say(`👀 Who do you want to see? Usage: "pics <@User>"`);
  }

  try {
    const spots = await Spot.find({
      teamId: message.team,
      targetId: targetUser,
      channelId: message.channel,
      status: 'confirmed'
    })
    .sort({ timestamp: -1 })
    .limit(10);

    if (spots.length === 0) {
      return await say(`🤷 <@${targetUser}> is clean! No photos found.`);
    }

    const responseBlocks = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `📸 *Last ${spots.length} times <@${targetUser}> was spotted:*`
        }
      },
      { type: "divider" }
    ];

    spots.forEach((spot) => {
      const dateString = new Date(spot.timestamp).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
      });

      responseBlocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `🗓 *${dateString}* by <@${spot.spotterId}>\n🔗 <${spot.imageUrl}|View Evidence>`
        }
      });
    });

    await say({
      blocks: responseBlocks,
      text: `Gallery for <@${targetUser}>`
    });

  } catch (error) {
    console.error(error);
    await say("⚠️ I couldn't dig up those photos right now.");
  }
});


// ─── The "Veto" Listener (Admin replies "veto" to a spot message) ────────────
app.message(/^veto$/i, async ({ message, say, client }) => {
  if (!await isActiveChannel(message.team, message.channel)) return;
  if (!message.thread_ts || message.thread_ts === message.ts) return;

  try {
    const userResult = await client.users.info({ user: message.user });
    const isAdmin = userResult.user.is_admin;

    if (!isAdmin) {
      return await say({
        text: `🚫 *Access Denied.* <@${message.user}>, only Workspace Admins can veto spots.`,
        thread_ts: message.thread_ts
      });
    }

    const deletedSpot = await Spot.findOneAndDelete({
      teamId: message.team,
      messageTs: message.thread_ts,
      channelId: message.channel
    });

    if (deletedSpot) {
      const dateString = new Date(deletedSpot.timestamp).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
      });
      await say({
        text: `🔨 *Vetoed!* Admin <@${message.user}> removed this spot ` +
              `(<@${deletedSpot.spotterId}> spotted <@${deletedSpot.targetId}> on ${dateString}).`,
        thread_ts: message.thread_ts
      });
    } else {
      await say({
        text: `🤷 No spot found for this message. It may have already been vetoed.`,
        thread_ts: message.thread_ts
      });
    }

  } catch (error) {
    console.error(error);
    await say({
      text: "⚠️ I had trouble processing the veto.",
      thread_ts: message.thread_ts
    });
  }
});


// ─── The "Reset" Command (Admin Only) ────────────────────────────────────────
app.command('/reset', async ({ command, ack, say, client }) => {
  await ack();

  if (!await isActiveChannel(command.team_id, command.channel_id)) {
    return await say("⚠️ SpotBot isn't active in this channel. An admin can run `/setchannel` to activate it.");
  }

  try {
    const userResult = await client.users.info({ user: command.user_id });
    const isAdmin = userResult.user.is_admin;

    if (!isAdmin) {
      return await say(`🚫 *Access Denied.* <@${command.user_id}>, you are not a Workspace Admin.`);
    }

    const result = await Spot.deleteMany({ teamId: command.team_id, channelId: command.channel_id });

    if (result.deletedCount > 0) {
      await say(`*Kaboom!* Admin <@${command.user_id}> has wiped the board. ${result.deletedCount} spots deleted.`);
    } else {
      await say("🧹 The board is already clean.");
    }

  } catch (error) {
    console.error(error);
    await say("⚠️ I couldn't verify your admin status with Slack.");
  }
});


// ─── Start the App ───────────────────────────────────────────────────────────
(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`SpotBot is running on port ${port}!`);
  console.log(`Install URL: https://spotbot-4ilo.onrender.com/slack/install`);
})();

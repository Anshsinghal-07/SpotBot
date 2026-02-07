require('dotenv').config();
const { App } = require('@slack/bolt');

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

const mongoose = require('mongoose');
const Spot = require('./Spot'); // Import the schema

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('🍃 Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err));


// The "Spot" Listener
app.message(/spot|spotted/i, async ({ message, say }) => {
  if (message.channel !== 'C0AD6UA1G92') return;

  const mentionMatch = message.text.match(/<@([A-Z0-9]+)>/);
  const targetUser = mentionMatch ? mentionMatch[1] : null;
  const hasImage = message.files && message.files.length > 0;

  if (targetUser && hasImage) {
    try {
      // Create the spot record, storing the original message ts so we can link replies
      const newSpot = new Spot({
        spotterId: message.user,
        targetId: targetUser,
        imageUrl: message.files[0].url_private, //Requires bot to have 'files:read'
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

(async () => {
  await app.start();
  console.log('⚡️ Spot Bot is running in Socket Mode!');
})();


// The "Spotboard" Command
app.command('/spotboard', async ({ command, ack, say }) => {
  // 1. Acknowledge the command immediately so Slack doesn't timeout
  await ack();

  // 2. Determine how many people to show (Default to 10, max 25)
  let limit = parseInt(command.text) || 10;
  if (limit > 25) limit = 25; // Cap it to prevent spamming the channel

  try {
    // 3. The MongoDB Aggregation Pipeline
    const leaderboard = await Spot.aggregate([
      // Stage A: Filter for this channel only and valid spots
      { $match: { channelId: command.channel_id, status: 'confirmed' } },
      
      // Stage B: Group by the 'spotterId' and count them
      { $group: { _id: '$spotterId', count: { $sum: 1 } } },
      
      // Stage C: Sort by count (Highest to Lowest)
      { $sort: { count: -1 } },
      
      // Stage D: Take only the top N results
      { $limit: limit }
    ]);

    if (leaderboard.length === 0) {
      return await say("zb No spots yet! Go touch grass and find someone!");
    }

    // 4. Format the output text
    let messageText = `🏆 *Top ${limit} Spotters*\n`;
    
    // Loop through results and build the list
    // formatting: "1. @User: 5 spots"
    leaderboard.forEach((entry, index) => {
      // entry._id is the Slack User ID (e.g., U12345)
      // entry.count is the number of spots
      const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '•';
      messageText += `${medal} <@${entry._id}>: *${entry.count}* spots\n`;
    });

    await say(messageText);

  } catch (error) {
    console.error(error);
    await say("⚠️ I had trouble crunching the numbers for the leaderboard.");
  }
});


// The "Caughtboard" Command (Who is the biggest target?)
app.command('/caughtboard', async ({ command, ack, say }) => {
  await ack();

  let limit = parseInt(command.text) || 10;
  if (limit > 25) limit = 25;

  try {
    const leaderboard = await Spot.aggregate([
      // Stage A: Filter for this channel & valid spots
      { $match: { channelId: command.channel_id, status: 'confirmed' } },
      
      // Stage B: Group by 'targetId' (The VICTIM) instead of spotterId
      { $group: { _id: '$targetId', count: { $sum: 1 } } },
      
      // Stage C: Sort descending (Most caught at the top)
      { $sort: { count: -1 } },
      
      { $limit: limit }
    ]);

    if (leaderboard.length === 0) {
      return await say("zbHs Everyone is a ninja here. No one has been caught yet!");
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

// The "Pics" Listener (Show a gallery of the last 10 spots)
app.message(/pics/i, async ({ message, say }) => {
  // 1. Check Channel & Parse Mention
  if (message.channel !== 'C0AD6UA1G92') return; // Replace with your Channel ID

  const mentionMatch = message.text.match(/<@([A-Z0-9]+)>/);
  const targetUser = mentionMatch ? mentionMatch[1] : null;

  if (!targetUser) {
    return await say(`👀 Who do you want to see? Usage: "pics <@User>"`);
  }

  try {
    // 2. Find spots where this person was the TARGET
    // We limit to 10 to avoid spamming the channel with a huge wall of text
    const spots = await Spot.find({ 
      targetId: targetUser, 
      channelId: message.channel, 
      status: 'confirmed' 
    })
    .sort({ timestamp: -1 }) // Newest first
    .limit(10);

    if (spots.length === 0) {
      return await say(`🤷 <@${targetUser}> is clean! No photos found.`);
    }

    // 3. Build the Message Blocks
    // We use "Section" blocks with Markdown links
    const responseBlocks = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `📸 *Last ${spots.length} times <@${targetUser}> was spotted:*`
        }
      },
      {
        type: "divider"
      }
    ];

    // Loop through spots and add a link for each
    spots.forEach((spot) => {
      // Format the date nicely (e.g., "Feb 4th")
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

    // 4. Send the blocks
    await say({
      blocks: responseBlocks,
      text: `Gallery for <@${targetUser}>` // Fallback for notifications
    });

  } catch (error) {
    console.error(error);
    await say("⚠️ I couldn't dig up those photos right now.");
  }
});


// The "Veto" Listener (Admin replies "veto" to a spot message to delete it)
app.message(/^veto$/i, async ({ message, say, client }) => {
  // 1. Only works as a threaded reply to a spot message
  if (!message.thread_ts || message.thread_ts === message.ts) return;

  try {
    // 2. Admin check
    const userResult = await client.users.info({ user: message.user });
    const isAdmin = userResult.user.is_admin;

    if (!isAdmin) {
      return await say({
        text: `🚫 *Access Denied.* <@${message.user}>, only Workspace Admins can veto spots.`,
        thread_ts: message.thread_ts
      });
    }

    // 3. Find the spot linked to the original message this reply is on
    const deletedSpot = await Spot.findOneAndDelete({
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


// The "Reset" Command (Dynamic Admin Check)
app.command('/reset', async ({ command, ack, say, client }) => {
  await ack();

  try {
    // 1. Ask Slack for info about the user who ran the command
    const userResult = await client.users.info({
      user: command.user_id
    });

    // 2. Check the "is_admin" flag (This works for Owners too)
    const isAdmin = userResult.user.is_admin;

    if (!isAdmin) {
      return await say(`🚫 *Access Denied.* <@${command.user_id}>, you are not a Workspace Admin.`);
    }

    // 3. If they ARE an admin, proceed with the wipe
    const result = await Spot.deleteMany({ channelId: command.channel_id });

    if (result.deletedCount > 0) {
      await say(`qm *Kaboom!* Admin <@${command.user_id}> has wiped the board. ${result.deletedCount} spots deleted.`);
    } else {
      await say("🧹 The board is already clean.");
    }

  } catch (error) {
    console.error(error);
    await say("⚠️ I couldn't verify your admin status with Slack.");
  }
});
const mongoose = require('mongoose');

// Stores OAuth tokens for each workspace that installs SpotBot
const InstallationSchema = new mongoose.Schema({
  teamId: { type: String, required: true, unique: true },
  teamName: { type: String },
  botToken: { type: String, required: true },
  botId: { type: String },
  botUserId: { type: String },
  installation: { type: Object, required: true }, // Full Slack installation object
  installedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Installation', InstallationSchema);

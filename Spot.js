const mongoose = require('mongoose');

const SpotSchema = new mongoose.Schema({
  spotterId: { type: String, required: true }, // Slack User ID (e.g., U12345)
  targetId: { type: String, required: true },  // Slack User ID
  imageUrl: { type: String, required: true },  // URL of the image
  channelId: { type: String, required: true }, // To keep spots channel-specific
  status: { 
    type: String, 
    enum: ['confirmed', 'pending', 'rejected'], 
    default: 'confirmed' 
  },
  timestamp: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Spot', SpotSchema);
var mongoose = require('mongoose');

// A user owns a list of unfinished task ids.
var UserSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },
    email: {
        type: String,
        required: true,
        trim: true,
        unique: true
    },
    pendingTasks: {
        type: [String],
        default: []
    },
    dateCreated: {
        type: Date,
        default: Date.now,
        immutable: true
    }
});

module.exports = mongoose.model('User', UserSchema);

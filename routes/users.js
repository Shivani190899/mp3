var query = require('./query');
var mongoose = require('mongoose');
var User = require('../models/user');
var Task = require('../models/task');

function rejectRequest(status, message) {
    var error = new Error(message);
    error.status = status;
    throw error;
}

// POST and PUT share validation and assignment rules. An id means replace that user.
async function saveUser(body, id) {
    if (id !== undefined && !/^[a-f\d]{24}$/i.test(id)) rejectRequest(404, 'User not found.');
    return mongoose.connection.transaction(async function (session) {
        var user = id ? await User.findById(id).session(session) : new User();
        if (!user) rejectRequest(404, 'User not found.');
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            rejectRequest(400, 'Please provide a JSON object.');
        }
        for (var field of ['name', 'email']) {
            if (typeof body[field] !== 'string' || !body[field].trim()) {
                rejectRequest(400, field + ' must be a nonempty string.');
            }
        }
        var pendingTasks = body.pendingTasks === undefined ? [] : body.pendingTasks;
        if (!Array.isArray(pendingTasks) || !pendingTasks.every(function (taskId) {
            return typeof taskId === 'string' && /^[a-f\d]{24}$/i.test(taskId);
        })) {
            rejectRequest(400, 'pendingTasks must be an array of valid task ids.');
        }
        pendingTasks = [...new Set(pendingTasks.map(function (taskId) { return taskId.toLowerCase(); }))];
        var name = body.name.trim();
        var email = body.email.trim();
        if (await User.exists({ email: email, _id: { $ne: user._id } }).session(session)) {
            rejectRequest(400, 'That email is already used by another user.');
        }
        var tasks = await Task.find({ _id: { $in: pendingTasks } }).session(session);
        if (tasks.some(function (task) { return task.completed; })) {
            rejectRequest(400, 'pendingTasks cannot contain completed tasks.');
        }
        if (tasks.length !== pendingTasks.length) rejectRequest(404, 'A referenced task was not found.');

        // Only editable fields are replaced; _id and dateCreated remain unchanged.
        user.set({ name: name, email: email, pendingTasks: pendingTasks });
        await user.save({ session: session });
        if (id) {
            // Omitted pending tasks become unassigned. Completed tasks stay assigned.
            await Task.updateMany(
                { assignedUser: user.id, completed: false, _id: { $nin: pendingTasks } },
                { $set: { assignedUser: '', assignedUserName: 'unassigned' } },
                { session: session }
            );
            // Renames also apply to completed assignments.
            await Task.updateMany(
                { assignedUser: user.id },
                { $set: { assignedUserName: name } },
                { session: session }
            );
        }
        if (pendingTasks.length) {
            await User.updateMany(
                { _id: { $ne: user._id }, pendingTasks: { $in: pendingTasks } },
                { $pull: { pendingTasks: { $in: pendingTasks } } },
                { session: session }
            );
            await Task.updateMany(
                { _id: { $in: pendingTasks } },
                { $set: { assignedUser: user.id, assignedUserName: name } },
                { session: session }
            );
        }
        return user.toObject();
    });
}

module.exports = function (router) {
    router.route('/users')
        .get(async function (req, res) {
            var users = await query.collection(User, req.query);
            res.status(200).json({ message: 'OK', data: users });
        })
        .post(async function (req, res) {
            var user = await saveUser(req.body);
            res.status(201).json({ message: 'User created.', data: user });
        });
    router.route('/users/:id')
        .get(async function (req, res) {
            if (!/^[a-f\d]{24}$/i.test(req.params.id)) rejectRequest(404, 'User not found.');
            var user = await User.findById(req.params.id).select(query.select(req.query)).lean();
            if (!user) rejectRequest(404, 'User not found.');
            res.status(200).json({ message: 'OK', data: user });
        })
        .put(async function (req, res) {
            var user = await saveUser(req.body, req.params.id);
            res.status(200).json({ message: 'User updated.', data: user });
        })
        .delete(async function (req, res) {
            if (!/^[a-f\d]{24}$/i.test(req.params.id)) rejectRequest(404, 'User not found.');
            var deleted = await mongoose.connection.transaction(async function (session) {
                var user = await User.findById(req.params.id).session(session);
                if (!user) rejectRequest(404, 'User not found.');
                // The deletion and reference cleanup either both commit or both roll back.
                await user.deleteOne({ session: session });
                await Task.updateMany(
                    { assignedUser: user.id }, { $set: { assignedUser: '', assignedUserName: 'unassigned' } },
                    { session: session }
                );
                return user.toObject();
            });
            res.status(200).json({ message: 'User deleted.', data: deleted });
        });
    return router;
};

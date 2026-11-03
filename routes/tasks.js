var query = require('./query');
var mongoose = require('mongoose');
var Task = require('../models/task');
var User = require('../models/user');

function rejectRequest(status, message) {
    var error = new Error(message);
    error.status = status;
    throw error;
}

// POST and PUT share validation and assignment rules. An id means replace that task.
async function saveTask(body, id) {
    if (id !== undefined && !/^[a-f\d]{24}$/i.test(id)) rejectRequest(404, 'Task not found.');
    return mongoose.connection.transaction(async function (session) {
        var task = id ? await Task.findById(id).session(session) : new Task();
        if (!task) rejectRequest(404, 'Task not found.');
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            rejectRequest(400, 'Please provide a JSON object.');
        }
        if (typeof body.name !== 'string' || !body.name.trim()) rejectRequest(400, 'name must be a nonempty string.');
        if (typeof body.deadline !== 'string' || !body.deadline.trim() || !Number.isFinite(Date.parse(body.deadline))) {
            rejectRequest(400, 'deadline must be a valid date string.');
        }
        for (var field of ['description', 'assignedUser', 'assignedUserName']) {
            if (body[field] !== undefined && typeof body[field] !== 'string') rejectRequest(400, field + ' must be a string.');
        }
        if (body.completed !== undefined && typeof body.completed !== 'boolean') rejectRequest(400, 'completed must be true or false.');
        var assignedUser = body.assignedUser === undefined ? '' : body.assignedUser;
        if (assignedUser && !/^[a-f\d]{24}$/i.test(assignedUser)) {
            rejectRequest(400, 'assignedUser must be a valid user id or an empty string.');
        }
        // An explicit empty id requests unassignment; an omitted id cannot name an owner.
        if (body.assignedUser === undefined && body.assignedUserName !== undefined && body.assignedUserName !== 'unassigned') {
            rejectRequest(400, 'assignedUserName must be unassigned when assignedUser is omitted.');
        }
        assignedUser = assignedUser.toLowerCase();
        var owner = null;
        if (assignedUser) {
            owner = await User.findById(assignedUser).session(session);
            if (!owner) rejectRequest(404, 'The assigned user was not found.');
            if (body.assignedUserName !== undefined && body.assignedUserName !== owner.name) {
                rejectRequest(400, 'assignedUserName must match the assigned user’s name.');
            }
        }

        // PUT replaces optional fields with defaults when they are omitted.
        task.set({
            name: body.name.trim(),
            deadline: new Date(body.deadline),
            description: body.description === undefined ? '' : body.description,
            completed: body.completed === undefined ? false : body.completed,
            assignedUser: assignedUser,
            assignedUserName: owner ? owner.name : 'unassigned'
        });
        await task.save({ session: session });
        if (id) {
            await User.updateMany(
                { pendingTasks: task.id },
                { $pull: { pendingTasks: task.id } },
                { session: session }
            );
        }
        if (owner) {
            // Touch the owner even for completed tasks so a concurrent rename or
            // deletion conflicts and retries instead of leaving a stale assignment.
            var update = { $inc: { __v: 1 } };
            if (!task.completed) update.$addToSet = { pendingTasks: task.id };
            await User.updateOne({ _id: owner._id }, update, { session: session });
        }
        return task.toObject();
    });
}

module.exports = function (router) {
    router.route('/tasks')
        .get(async function (req, res) {
            var tasks = await query.collection(Task, req.query, 100);
            res.status(200).json({ message: 'OK', data: tasks });
        })
        .post(async function (req, res) {
            var task = await saveTask(req.body);
            res.status(201).json({ message: 'Task created.', data: task });
        });
    router.route('/tasks/:id')
        .get(async function (req, res) {
            if (!/^[a-f\d]{24}$/i.test(req.params.id)) rejectRequest(404, 'Task not found.');
            var task = await Task.findById(req.params.id).select(query.select(req.query)).lean();
            if (!task) rejectRequest(404, 'Task not found.');
            res.status(200).json({ message: 'OK', data: task });
        })
        .put(async function (req, res) {
            var task = await saveTask(req.body, req.params.id);
            res.status(200).json({ message: 'Task updated.', data: task });
        })
        .delete(async function (req, res) {
            if (!/^[a-f\d]{24}$/i.test(req.params.id)) rejectRequest(404, 'Task not found.');
            var deleted = await mongoose.connection.transaction(async function (session) {
                var task = await Task.findById(req.params.id).session(session);
                if (!task) rejectRequest(404, 'Task not found.');
                // The deletion and reference cleanup either both commit or both roll back.
                await task.deleteOne({ session: session });
                await User.updateMany(
                    { pendingTasks: task.id }, { $pull: { pendingTasks: task.id } },
                    { session: session }
                );
                return task.toObject();
            });
            res.status(200).json({ message: 'Task deleted.', data: deleted });
        });
    return router;
};

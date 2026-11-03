const test = require('node:test');
const assert = require('node:assert/strict');
const User = require('../models/user');

test('users require a nonblank name and email', async () => {
    for (const body of [{}, { name: 'Ada' }, { email: 'ada@example.com' }, { name: ' ', email: 'ada@example.com' }]) {
        await assert.rejects(new User(body).validate(), { name: 'ValidationError' });
    }
});

test('users start with an empty task list and a current creation date', async () => {
    const before = Date.now();
    const user = new User({ name: 'Ada', email: 'ada@example.com' });
    await user.validate();
    assert.deepEqual(Array.from(user.pendingTasks), []);
    assert.ok(user.dateCreated.getTime() >= before);
    assert.ok(user.dateCreated.getTime() <= Date.now());
});

test('tasks require a nonblank name and a valid deadline', async () => {
    const Task = require('../models/task');
    for (const body of [{}, { name: 'Read' }, { deadline: '2026-11-03' }, { name: ' ', deadline: '2026-11-03' }, { name: 'Read', deadline: 'not a date' }]) {
        await assert.rejects(new Task(body).validate(), { name: 'ValidationError' });
    }
});

test('new tasks receive the assignment defaults and a current creation date', async () => {
    const Task = require('../models/task');
    const before = Date.now();
    const task = new Task({ name: 'Read', deadline: '2026-11-03' });
    await task.validate();
    assert.equal(task.description, '');
    assert.equal(task.completed, false);
    assert.equal(task.assignedUser, '');
    assert.equal(task.assignedUserName, 'unassigned');
    assert.equal(task.deadline.toISOString(), '2026-11-03T00:00:00.000Z');
    assert.ok(task.dateCreated.getTime() >= before);
    assert.ok(task.dateCreated.getTime() <= Date.now());
});

test('editing an existing document preserves its creation date', async () => {
    const Task = require('../models/task');
    const original = new Date('2026-01-01');
    for (const Model of [User, Task]) {
        const document = Model.hydrate({ name: 'Original', dateCreated: original });
        document.name = 'Changed';
        document.dateCreated = new Date('2026-06-01');
        assert.equal(document.dateCreated.getTime(), original.getTime());
    }
});

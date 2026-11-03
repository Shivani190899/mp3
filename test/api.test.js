const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const User = require('../models/user');
const Task = require('../models/task');
let database, server, base;

before(async () => {
    database = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(database.getUri());
    await Promise.all([User.init(), Task.init()]);
    const probe = net.createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    base = `http://127.0.0.1:${port}/api`;
    server = spawn(process.execPath, ['server.js'], {
        cwd: path.resolve(__dirname, '..'),
        env: { ...process.env, MONGODB_URI: database.getUri(), PORT: String(port) },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Test server startup timed out')), 20000);
        server.stdout.on('data', chunk => {
            if (chunk.toString().includes('Server running')) { clearTimeout(timer); resolve(); }
        });
        server.once('exit', () => { clearTimeout(timer); reject(new Error('Test server exited during startup')); });
    });
});
beforeEach(async () => {
    await User.deleteMany({});
    await Task.deleteMany({});
});
after(async () => {
    if (server && server.exitCode === null) {
        const stopped = new Promise(resolve => server.once('exit', resolve));
        server.kill('SIGTERM');
        await stopped;
    }
    await mongoose.disconnect();
    await database?.stop();
});
async function request(method, body, expectedStatus = 200, route = '/users') {
    const response = await fetch(base + route, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    assert.equal(response.status, expectedStatus, await response.clone().text());
    if (expectedStatus === 204) {
        assert.equal(await response.text(), '');
        return;
    }
    const result = await response.json();
    assert.equal(typeof result.message, 'string');
    assert.ok(Object.hasOwn(result, 'data'));
    return result.data;
}
const valid = { name: 'Ada', email: 'ada@example.com' };

test('GET users returns an empty array before anyone is created', async () => {
    assert.deepEqual(await request('GET'), []);
});
test('POST creates a user with server defaults, and GET lists it', async () => {
    const user = await request('POST', { ...valid, dateCreated: '1990-01-01', _id: '0123456789abcdef01234567' }, 201);
    assert.equal(user.name, 'Ada');
    assert.equal(user.email, 'ada@example.com');
    assert.deepEqual(user.pendingTasks, []);
    assert.notEqual(user._id, '0123456789abcdef01234567');
    assert.ok(Date.parse(user.dateCreated) > Date.parse('2026-01-01'));
    assert.deepEqual(await request('GET'), [user]);
});
test('POST rejects missing, blank and incorrectly typed fields without saving', async () => {
    for (const body of [{}, { name: 'Ada' }, { email: valid.email }, { ...valid, name: ' ' }, { ...valid, name: 3 }, { ...valid, email: false }, { ...valid, pendingTasks: 'bad' }, { ...valid, pendingTasks: ['bad'] }, [], null]) {
        await request('POST', body, 400);
    }
    assert.equal(await User.countDocuments(), 0);
});
test('POST rejects a duplicate email with 400', async () => {
    await request('POST', valid, 201);
    await request('POST', { name: 'Other', email: valid.email }, 400);
    assert.equal(await User.countDocuments(), 1);
});
test('concurrent duplicate requests create exactly one user', async () => {
    const responses = await Promise.all([1, 2].map(() => fetch(base + '/users', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(valid)
    })));
    assert.deepEqual(responses.map(r => r.status).sort(), [201, 400]);
    assert.equal(await User.countDocuments(), 1);
    const error = await responses.find(r => r.status === 400).json();
    assert.equal(error.data, null);
    assert.doesNotMatch(error.message, /E11000|MongoServerError|index:/);
});
test('creating a user with pending tasks transfers ownership in both directions', async () => {
    const oldOwner = await User.create({ name: 'Previous', email: 'previous@example.com' });
    const task = await Task.create({ name: 'Read', deadline: new Date(), assignedUser: oldOwner.id, assignedUserName: oldOwner.name });
    oldOwner.pendingTasks = [task.id];
    await oldOwner.save();
    const user = await request('POST', { ...valid, pendingTasks: [task.id, task.id] }, 201);
    assert.deepEqual(user.pendingTasks, [task.id]);
    assert.deepEqual(Array.from((await User.findById(oldOwner.id)).pendingTasks), []);
    const updated = await Task.findById(task.id);
    assert.equal(updated.assignedUser, user._id);
    assert.equal(updated.assignedUserName, 'Ada');
});
test('missing and completed task references fail without partial writes', async () => {
    const pending = await Task.create({ name: 'Read', deadline: new Date() });
    const completed = await Task.create({ name: 'Done', deadline: new Date(), completed: true });
    await request('POST', { ...valid, pendingTasks: [pending.id, '0123456789abcdef01234567'] }, 404);
    await request('POST', { ...valid, pendingTasks: [pending.id, completed.id] }, 400);
    assert.equal(await User.countDocuments(), 0);
    assert.equal((await Task.findById(pending.id)).assignedUser, '');
});
test('duplicate emails and malformed ids take priority over missing references', async () => {
    await request('POST', valid, 201);
    await request('POST', { ...valid, pendingTasks: ['0123456789abcdef01234567'] }, 400);
    await request('POST', { ...valid, email: 'new@example.com', pendingTasks: ['0123456789abcdef01234567', 'bad'] }, 400);
});
test('malformed JSON returns a readable JSON error response', async () => {
    const response = await fetch(base + '/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
    assert.equal(response.status, 400);
    const result = await response.json();
    assert.equal(typeof result.message, 'string');
    assert.equal(result.data, null);
});

const taskBody = { name: 'Finish MP3', deadline: '2026-11-03T23:59:00-06:00' };
const createTask = (fields = {}, status = 201) => request('POST', { ...taskBody, ...fields }, status, '/tasks');

test('tasks start empty; creating a task sets defaults and makes it visible in the list', async () => {
    assert.deepEqual(await request('GET', undefined, 200, '/tasks'), []);
    const before = Date.now();
    const task = await createTask({ dateCreated: '1990-01-01', _id: '0123456789abcdef01234567' });
    assert.equal(task.name, 'Finish MP3');
    assert.equal(task.deadline, '2026-11-04T05:59:00.000Z');
    assert.equal(task.description, '');
    assert.equal(task.completed, false);
    assert.equal(task.assignedUser, '');
    assert.equal(task.assignedUserName, 'unassigned');
    assert.ok(Date.parse(task.dateCreated) >= before);
    assert.notEqual(task._id, '0123456789abcdef01234567');
    assert.deepEqual(await request('GET', undefined, 200, '/tasks'), [task]);
});
test('task creation rejects missing required fields and wrong input types', async () => {
    for (const body of [{}, { name: 'Read' }, { deadline: taskBody.deadline }, [], null]) {
        await request('POST', body, 400, '/tasks');
    }
    for (const fields of [{ name: ' ' }, { name: 12 }, { deadline: 'bad date' }, { deadline: null }, { deadline: 123 }, { description: null }, { completed: 'false' }, { assignedUser: 123 }, { assignedUserName: false }]) {
        await createTask(fields, 400);
    }
    assert.equal(await Task.countDocuments(), 0);
});
test('an assigned pending task appears in its user pendingTasks and fills the user name', async () => {
    const user = await request('POST', valid, 201);
    const task = await createTask({ assignedUser: user._id.toUpperCase(), description: 'Read the instructions' });
    assert.equal(task.assignedUser, user._id);
    assert.equal(task.assignedUserName, 'Ada');
    assert.equal(task.description, 'Read the instructions');
    const users = await request('GET');
    assert.deepEqual(users[0].pendingTasks, [task._id]);
});
test('completed tasks remain assigned but stay out of pendingTasks', async () => {
    const user = await request('POST', valid, 201);
    const task = await createTask({ assignedUser: user._id, assignedUserName: 'Ada', completed: true });
    assert.equal(task.assignedUser, user._id);
    assert.equal(task.assignedUserName, 'Ada');
    assert.equal(task.completed, true);
    assert.deepEqual((await request('GET'))[0].pendingTasks, []);
});
test('invalid and inconsistent user references fail without creating tasks', async () => {
    const user = await request('POST', valid, 201);
    await createTask({ assignedUser: 'bad' }, 400);
    await createTask({ assignedUser: '0123456789abcdef01234567', assignedUserName: false }, 400);
    await createTask({ assignedUser: '0123456789abcdef01234567' }, 404);
    await createTask({ assignedUser: user._id, assignedUserName: 'Someone else' }, 400);
    assert.equal(await Task.countDocuments(), 0);
    assert.deepEqual((await request('GET'))[0].pendingTasks, []);
});
test('concurrent task creation does not lose pending task references', async () => {
    const user = await request('POST', valid, 201);
    const tasks = await Promise.all([createTask({ assignedUser: user._id }), createTask({ assignedUser: user._id })]);
    const pending = (await request('GET'))[0].pendingTasks;
    assert.deepEqual(pending.sort(), tasks.map(task => task._id).sort());
});
test('task listing defaults to at most 100 documents', async () => {
    await Task.insertMany(Array.from({ length: 105 }, (_, n) => ({ name: `Task ${n}`, deadline: new Date() })));
    assert.equal((await request('GET', undefined, 200, '/tasks')).length, 100);
});

test('single-resource GET returns one user or task and ignores collection-only parameters', async () => {
    const user = await request('POST', valid, 201);
    const task = await createTask();
    for (const [resource, document] of [['users', user], ['tasks', task]]) {
        const found = await request('GET', undefined, 200, `/${resource}/${document._id}?where=bad&sort=bad&skip=bad&limit=bad&count=bad`);
        assert.deepEqual(found, document);
    }
});
test('single-resource GET returns JSON 404 for malformed or nonexistent ids', async () => {
    for (const resource of ['users', 'tasks']) {
        for (const id of ['not-an-id', '0123456789abcdef01234567']) {
            assert.equal(await request('GET', undefined, 404, `/${resource}/${id}`), null);
        }
    }
});

const queryString = values => '?' + new URLSearchParams(Object.entries(values).map(([key, value]) => [key, JSON.stringify(value)]));

test('task queries combine filtering, sorting, projection, skip and limit', async () => {
    await Task.insertMany([
        { name: 'A', deadline: '2026-11-01', completed: false },
        { name: 'B', deadline: '2026-11-02', completed: true },
        { name: 'C', deadline: '2026-11-03', completed: false },
        { name: 'D', deadline: '2026-11-04', completed: false }
    ]);
    const result = await request('GET', undefined, 200, '/tasks' + queryString({
        where: { completed: false }, sort: { deadline: -1 }, select: { name: 1, _id: 0 }, skip: 1, limit: 2
    }));
    assert.deepEqual(result, [{ name: 'C' }, { name: 'A' }]);
});
test('user queries combine the same options and support id membership filters', async () => {
    const users = await User.insertMany([
        { name: 'Ada', email: 'ada@example.com' },
        { name: 'Bob', email: 'bob@example.com' },
        { name: 'Cara', email: 'cara@example.com' }
    ]);
    const result = await request('GET', undefined, 200, '/users' + queryString({
        where: { _id: { $in: users.map(user => user.id) } }, sort: { name: 1 }, skip: 1, limit: 1, select: { name: 1, _id: 0 }
    }));
    assert.deepEqual(result, [{ name: 'Bob' }]);
});
test('where supports logical operators, date comparisons and task id membership', async () => {
    const tasks = await Task.insertMany([
        { name: 'Early', deadline: '2026-11-01', completed: false },
        { name: 'Later', deadline: '2026-11-05', completed: true }
    ]);
    const result = await request('GET', undefined, 200, '/tasks' + queryString({
        where: { $and: [{ _id: { $in: tasks.map(task => task.id) } }, { deadline: { $gte: '2026-11-03' } }] }, select: { name: 1, _id: 0 }
    }));
    assert.deepEqual(result, [{ name: 'Later' }]);
});
test('count returns all matching documents independent of pagination and projection', async () => {
    await Task.insertMany(Array.from({ length: 105 }, (_, n) => ({ name: `T${n}`, deadline: new Date(), completed: n < 3 })));
    await User.insertMany([{ name: 'Ada', email: 'a@example.com' }, { name: 'Bob', email: 'b@example.com' }]);
    assert.equal(await request('GET', undefined, 200, '/tasks?count=true'), 105);
    assert.equal(await request('GET', undefined, 200, '/tasks' + queryString({ where: { completed: true }, sort: { name: 1 }, select: { name: 1 }, skip: 1, limit: 1, count: true })), 3);
    assert.equal(await request('GET', undefined, 200, '/users?count=true'), 2);
    assert.ok(Array.isArray(await request('GET', undefined, 200, '/users?count=false')));
});
test('empty collection matches return an empty array or zero count with 200', async () => {
    for (const resource of ['users', 'tasks']) {
        const where = { _id: '0123456789abcdef01234567' };
        assert.deepEqual(await request('GET', undefined, 200, `/${resource}` + queryString({ where })), []);
        assert.equal(await request('GET', undefined, 200, `/${resource}` + queryString({ where, count: true })), 0);
    }
});
test('users are unlimited by default and limit zero removes the task cap', async () => {
    await User.insertMany(Array.from({ length: 105 }, (_, n) => ({ name: `U${n}`, email: `${n}@example.com` })));
    await Task.insertMany(Array.from({ length: 105 }, (_, n) => ({ name: `T${n}`, deadline: new Date() })));
    assert.equal((await request('GET')).length, 105);
    assert.equal((await request('GET', undefined, 200, '/tasks?limit=0')).length, 105);
    assert.deepEqual(await request('GET', undefined, 200, '/tasks?skip=105'), []);
});
test('select includes or excludes fields on collections and individual records', async () => {
    const user = await request('POST', valid, 201);
    const task = await createTask();
    for (const [resource, document] of [['users', user], ['tasks', task]]) {
        assert.deepEqual(await request('GET', undefined, 200, `/${resource}/${document._id}` + queryString({ select: { name: 1, _id: 0 } }) + '&where=bad&sort=bad&skip=bad&limit=bad&count=bad'), { name: document.name });
        const excluded = await request('GET', undefined, 200, `/${resource}/${document._id}` + queryString({ select: { _id: 0 } }));
        assert.equal(excluded._id, undefined);
        assert.equal(excluded.name, document.name);
        const rows = await request('GET', undefined, 200, `/${resource}` + queryString({ select: { _id: 0 } }));
        assert.equal(rows[0]._id, undefined);
        await request('GET', undefined, 400, `/${resource}/${document._id}?select=bad`);
    }
});
test('invalid JSON and invalid query types return readable 400 responses', async () => {
    const invalidQueries = [
        'where=bad', 'sort=bad', 'select=bad', 'skip=bad', 'limit=bad', 'count=bad',
        'where=null', 'where=[]', 'sort=[]', 'select=null', 'skip=-1', 'limit=1.5',
        'skip="1"', 'count=1', 'count="true"', 'limit=1&limit=2'
    ];
    for (const resource of ['users', 'tasks']) {
        for (const query of invalidQueries) await request('GET', undefined, 400, `/${resource}?${query}`);
        for (const values of [{ sort: { name: 2 } }, { select: { name: 2 } }, { select: { name: 1, dateCreated: 0 } }, { where: { _id: 'bad' } }, { where: { $nonsense: true } }, { where: { $where: 'true' } }]) {
            await request('GET', undefined, 400, `/${resource}` + queryString(values));
        }
    }
});

const readUser = id => request('GET', undefined, 200, `/users/${id}`);
const readTask = id => request('GET', undefined, 200, `/tasks/${id}`);
const replaceTask = (id, fields = {}, status = 200) => request('PUT', { ...taskBody, ...fields }, status, `/tasks/${id}`);
const replaceUser = (user, fields = {}, status = 200) => request('PUT', { name: user.name, email: user.email, ...fields }, status, `/users/${user._id}`);

test('PUT checks URL existence before invalid fields or malformed JSON', async () => {
    for (const resource of ['users', 'tasks']) {
        for (const id of ['bad', '0123456789abcdef01234567']) {
            await request('PUT', {}, 404, `/${resource}/${id}`);
            const response = await fetch(`${base}/${resource}/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{' });
            assert.equal(response.status, 404);
            assert.equal((await response.json()).data, null);
        }
    }
});
test('PUT tasks replaces optional fields and preserves the original id and creation date', async () => {
    const user = await request('POST', valid, 201);
    const task = await createTask({ description: 'Old description', completed: true, assignedUser: user._id });
    const updated = await replaceTask(task._id, { name: 'Updated', dateCreated: '1990-01-01', _id: '0123456789abcdef01234567' });
    assert.equal(updated._id, task._id);
    assert.equal(updated.dateCreated, task.dateCreated);
    assert.equal(updated.description, '');
    assert.equal(updated.completed, false);
    assert.equal(updated.assignedUser, '');
    assert.equal(updated.assignedUserName, 'unassigned');
    assert.deepEqual((await readUser(user._id)).pendingTasks, []);
});
test('PUT tasks handles completing, moving a completed task and reopening it', async () => {
    const a = await request('POST', valid, 201);
    const b = await request('POST', { name: 'Bob', email: 'bob@example.com' }, 201);
    const task = await createTask({ assignedUser: a._id });
    const completed = await replaceTask(task._id, { assignedUser: a._id, completed: true });
    assert.equal(completed.assignedUser, a._id);
    assert.deepEqual((await readUser(a._id)).pendingTasks, []);
    const moved = await replaceTask(task._id, { assignedUser: b._id, completed: true });
    assert.equal(moved.assignedUserName, 'Bob');
    assert.deepEqual((await readUser(b._id)).pendingTasks, []);
    await replaceTask(task._id, { assignedUser: b._id, completed: false });
    assert.deepEqual((await readUser(b._id)).pendingTasks, [task._id]);
    assert.deepEqual((await readUser(a._id)).pendingTasks, []);
});
test('PUT tasks transfers pending ownership and unassigns tasks cleanly', async () => {
    const a = await request('POST', valid, 201);
    const b = await request('POST', { name: 'Bob', email: 'bob@example.com' }, 201);
    const task = await createTask({ assignedUser: a._id });
    await replaceTask(task._id, { assignedUser: b._id, assignedUserName: 'Bob' });
    assert.deepEqual((await readUser(a._id)).pendingTasks, []);
    assert.deepEqual((await readUser(b._id)).pendingTasks, [task._id]);
    const unassigned = await replaceTask(task._id, { assignedUser: '', assignedUserName: 'Bob' });
    assert.equal(unassigned.assignedUserName, 'unassigned');
    assert.deepEqual((await readUser(b._id)).pendingTasks, []);
});
test('PUT users removes omitted tasks, transfers incoming tasks and renames every retained assignment', async () => {
    const a = await request('POST', valid, 201);
    const b = await request('POST', { name: 'Bob', email: 'bob@example.com' }, 201);
    const removed = await createTask({ assignedUser: a._id });
    const retained = await createTask({ assignedUser: a._id });
    const incoming = await createTask({ assignedUser: b._id });
    const completed = await createTask({ assignedUser: a._id, completed: true });
    const updated = await replaceUser(a, { name: 'New Ada', pendingTasks: [incoming._id, retained._id, incoming._id], dateCreated: '1990-01-01' });
    assert.equal(updated.dateCreated, a.dateCreated);
    assert.deepEqual(updated.pendingTasks, [incoming._id, retained._id]);
    assert.equal((await readTask(removed._id)).assignedUser, '');
    assert.equal((await readTask(removed._id)).assignedUserName, 'unassigned');
    for (const task of [incoming, retained, completed]) {
        const current = await readTask(task._id);
        assert.equal(current.assignedUser, a._id);
        assert.equal(current.assignedUserName, 'New Ada');
    }
    assert.deepEqual((await readUser(b._id)).pendingTasks, []);
});
test('PUT users defaults omitted pendingTasks to empty and keeps completed assignments', async () => {
    const user = await request('POST', valid, 201);
    const pending = await createTask({ assignedUser: user._id });
    const done = await createTask({ assignedUser: user._id, completed: true });
    const updated = await replaceUser(user, { name: 'Renamed' });
    assert.deepEqual(updated.pendingTasks, []);
    assert.equal((await readTask(pending._id)).assignedUser, '');
    assert.equal((await readTask(done._id)).assignedUser, user._id);
    assert.equal((await readTask(done._id)).assignedUserName, 'Renamed');
});
test('failed user updates preserve all users and tasks', async () => {
    const a = await request('POST', valid, 201);
    const b = await request('POST', { name: 'Bob', email: 'bob@example.com' }, 201);
    const pending = await createTask({ assignedUser: a._id });
    const completed = await createTask({ completed: true });
    const beforeUsers = await User.find().sort('_id').lean();
    const beforeTasks = await Task.find().sort('_id').lean();
    for (const fields of [{ name: '' }, { name: 1 }, { email: '' }, { pendingTasks: 'bad' }, { pendingTasks: ['bad'] }, { pendingTasks: [completed._id] }, { email: b.email, pendingTasks: ['0123456789abcdef01234567'] }]) {
        await replaceUser(a, fields, 400);
    }
    await request('PUT', {}, 400, `/users/${a._id}`);
    await replaceUser(a, { pendingTasks: [pending._id, '0123456789abcdef01234567'] }, 404);
    assert.deepEqual(await User.find().sort('_id').lean(), beforeUsers);
    assert.deepEqual(await Task.find().sort('_id').lean(), beforeTasks);
});
test('failed task updates preserve all users and tasks', async () => {
    const user = await request('POST', valid, 201);
    const task = await createTask({ assignedUser: user._id });
    const beforeUser = await readUser(user._id);
    for (const fields of [{ name: '' }, { deadline: 'bad' }, { completed: 'true' }, { assignedUser: 'bad' }, { assignedUser: user._id, assignedUserName: 'Wrong' }]) {
        await replaceTask(task._id, fields, 400);
    }
    await request('PUT', {}, 400, `/tasks/${task._id}`);
    await replaceTask(task._id, { assignedUser: '0123456789abcdef01234567' }, 404);
    assert.deepEqual(await readTask(task._id), task);
    assert.deepEqual(await readUser(user._id), beforeUser);
});
test('concurrent task transfers settle on one owner with matching pending lists', async () => {
    const a = await request('POST', valid, 201);
    const b = await request('POST', { name: 'Bob', email: 'bob@example.com' }, 201);
    const task = await createTask();
    await Promise.all([a, b].map(user => replaceTask(task._id, { assignedUser: user._id })));
    const final = await readTask(task._id);
    for (const user of [a, b]) assert.deepEqual((await readUser(user._id)).pendingTasks, final.assignedUser === user._id ? [task._id] : []);
});
test('concurrent rename and completed-task creation keep the assigned name current', async () => {
    const user = await request('POST', valid, 201);
    const [, task] = await Promise.all([replaceUser(user, { name: 'New Ada' }), createTask({ assignedUser: user._id, completed: true })]);
    assert.equal((await readTask(task._id)).assignedUserName, 'New Ada');
    assert.deepEqual((await readUser(user._id)).pendingTasks, []);
});

test('a supplied assignee name without an assignee id is rejected without changes', async () => {
    await createTask({ assignedUserName: 'Bob' }, 400);
    assert.equal(await Task.countDocuments(), 0);
    const user = await request('POST', valid, 201);
    const task = await createTask({ assignedUser: user._id });
    const beforeUser = await readUser(user._id);
    await replaceTask(task._id, { assignedUserName: 'Ada' }, 400);
    assert.deepEqual(await readTask(task._id), task);
    assert.deepEqual(await readUser(user._id), beforeUser);
});

test('DELETE task removes its pending reference and subsequent requests return 404', async () => {
    const user = await request('POST', valid, 201);
    const task = await createTask({ assignedUser: user._id });
    const keep = await createTask({ assignedUser: user._id });
    await request('DELETE', undefined, 204, `/tasks/${task._id}`);
    assert.deepEqual((await readUser(user._id)).pendingTasks, [keep._id]);
    await request('GET', undefined, 404, `/tasks/${task._id}`);
    await request('DELETE', undefined, 404, `/tasks/${task._id}`);
    assert.equal((await readTask(keep._id)).assignedUser, user._id);
});
test('DELETE user unassigns pending and completed tasks while preserving other owners', async () => {
    const a = await request('POST', valid, 201);
    const b = await request('POST', { name: 'Bob', email: 'bob@example.com' }, 201);
    const pending = await createTask({ assignedUser: a._id });
    const done = await createTask({ assignedUser: a._id, completed: true });
    const unrelated = await createTask({ assignedUser: b._id });
    await request('DELETE', undefined, 204, `/users/${a._id}`);
    for (const task of [pending, done]) {
        const remaining = await readTask(task._id);
        assert.equal(remaining.assignedUser, '');
        assert.equal(remaining.assignedUserName, 'unassigned');
        assert.equal(remaining.completed, task.completed);
    }
    assert.equal((await readTask(unrelated._id)).assignedUser, b._id);
    assert.deepEqual((await readUser(b._id)).pendingTasks, [unrelated._id]);
    await request('GET', undefined, 404, `/users/${a._id}`);
    await request('DELETE', undefined, 404, `/users/${a._id}`);
});
test('DELETE handles unassigned or completed tasks and users without tasks', async () => {
    const user = await request('POST', valid, 201);
    const task = await createTask();
    const done = await createTask({ assignedUser: user._id, completed: true });
    await request('DELETE', undefined, 204, `/tasks/${task._id}`);
    await request('DELETE', undefined, 204, `/tasks/${done._id}`);
    await request('DELETE', undefined, 204, `/users/${user._id}`);
    assert.equal(await User.countDocuments(), 0);
    assert.equal(await Task.countDocuments(), 0);
});
test('DELETE malformed or nonexistent ids returns 404 without changing records', async () => {
    const user = await request('POST', valid, 201);
    const task = await createTask({ assignedUser: user._id });
    for (const resource of ['users', 'tasks']) {
        for (const id of ['bad', '0123456789abcdef01234567']) await request('DELETE', undefined, 404, `/${resource}/${id}`);
    }
    assert.equal((await readTask(task._id)).assignedUser, user._id);
    assert.deepEqual((await readUser(user._id)).pendingTasks, [task._id]);
});
for (const completed of [false, true]) {
    test(`concurrent user deletion and task creation leave no dangling owner (completed=${completed})`, async () => {
        const user = await request('POST', valid, 201);
        const [creation] = await Promise.all([
            fetch(base + '/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...taskBody, assignedUser: user._id, completed }) }),
            request('DELETE', undefined, 204, `/users/${user._id}`)
        ]);
        assert.ok([201, 404].includes(creation.status), await creation.clone().text());
        if (creation.status === 201) {
            const task = (await creation.json()).data;
            assert.equal((await readTask(task._id)).assignedUser, '');
            assert.equal((await readTask(task._id)).assignedUserName, 'unassigned');
        } else assert.equal(await Task.countDocuments(), 0);
        assert.equal(await User.countDocuments(), 0);
    });
}
for (const resource of ['tasks', 'users']) {
    test(`DELETE ${resource} rolls back when reference cleanup fails and returns a generic 500`, async () => {
        const user = await request('POST', valid, 201);
        const task = await createTask({ assignedUser: user._id });
        const beforeUser = await readUser(user._id);
        const blockedCollection = resource === 'tasks' ? User.collection.name : Task.collection.name;
        // A temporary database validator simulates a failure on the cleanup write.
        await mongoose.connection.db.command({ collMod: blockedCollection, validator: { $jsonSchema: { required: ['testOnlyMissingField'] } }, validationLevel: 'strict' });
        try {
            const response = await fetch(`${base}/${resource}/${resource === 'tasks' ? task._id : user._id}`, { method: 'DELETE' });
            assert.equal(response.status, 500);
            const result = await response.json();
            assert.equal(result.data, null);
            assert.doesNotMatch(result.message, /Mongo|validator|testOnlyMissingField|121/);
        } finally {
            await mongoose.connection.db.command({ collMod: blockedCollection, validator: {} });
        }
        assert.deepEqual(await readUser(user._id), beforeUser);
        assert.deepEqual(await readTask(task._id), task);
    });
}
test('CORS preflight responds with 204 and an empty body', async () => {
    const response = await fetch(base + '/tasks', { method: 'OPTIONS', headers: { Origin: 'https://example.com', 'Access-Control-Request-Method': 'DELETE' } });
    assert.equal(response.status, 204);
    assert.equal(await response.text(), '');
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.match(response.headers.get('access-control-allow-methods'), /DELETE/);
});

test('the API home endpoint follows the same JSON response envelope', async () => {
    const data = await request('GET', undefined, 200, '');
    assert.equal(data.users, '/api/users');
    assert.equal(data.tasks, '/api/tasks');
});

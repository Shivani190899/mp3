// Get the packages we need
var express = require('express'),
    router = express.Router(),
    mongoose = require('mongoose');

var User = require('./models/user');
var Task = require('./models/task');

// Read .env file
require('dotenv').config();

// Create our Express application
var app = express();

// Use environment defined port or 3000
var port = process.env.PORT || 3000;


// Allow CORS so that backend and frontend could be put on different servers
var allowCrossDomain = function (req, res, next) {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "X-Requested-With, X-HTTP-Method-Override, Content-Type, Accept");
    res.header("Access-Control-Allow-Methods", "POST, GET, PUT, DELETE, OPTIONS");
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
};
app.use(allowCrossDomain);

// For PUT, a missing URL record takes priority even over malformed JSON.
for (const [resource, Model] of [['users', User], ['tasks', Task]]) {
    app.put('/api/' + resource + '/:id', async function (req, res, next) {
        if (!/^[a-f\d]{24}$/i.test(req.params.id) || !await Model.exists({ _id: req.params.id })) {
            return res.status(404).json({ message: Model.modelName + ' not found.', data: null });
        }
        next();
    });
}

// Parse URL-encoded and JSON request bodies
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Use routes as a module (see index.js)
require('./routes')(app, router);

// Connect and prepare indexes before accepting requests.
async function startServer() {
    var uri = process.env.MONGODB_URI;
    if (!uri || uri.includes('<') || uri.includes('>')) {
        console.error('Set MONGODB_URI in .env to your MongoDB Atlas connection string.');
        process.exitCode = 1;
        return;
    }

    try {
        await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
        // User.init() waits for the unique email index to be ready.
        await Promise.all([User.init(), Task.init()]);
        app.listen(port, function () {
            console.log('Database connected. Server running on port ' + port);
        });
    } catch (error) {
        console.error('Could not connect to the database or prepare its indexes. Check your Atlas settings.');
        await mongoose.disconnect();
        process.exitCode = 1;
    }
}

startServer();

module.exports = function (router) {
    router.get('/', function (req, res) {
        res.json({
            message: 'Llama.io API is running.',
            data: { users: '/api/users', tasks: '/api/tasks' }
        });
    });
    return router;
};

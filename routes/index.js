/* Connect all endpoints under /api. */
module.exports = function (app, router) {
    require('./home')(router);
    require('./users')(router);
    require('./tasks')(router);
    app.use('/api', router);

    app.use(function (req, res) {
        res.status(404).json({ message: 'Endpoint not found.', data: null });
    });

    // Express sends rejected async route operations to this error handler.
    app.use(function (error, req, res, next) {
        if (res.headersSent) return next(error);
        var status = 500;
        var message = 'The request could not be completed. Please try again.';
        if (error.type === 'entity.parse.failed') {
            status = 400;
            message = 'The request body must contain valid JSON.';
        } else if (error.code === 11000) {
            // The unique index also catches two simultaneous requests for the same email.
            status = 400;
            message = 'That email is already used by another user.';
        } else if (error.name === 'ValidationError' || error.name === 'CastError') {
            status = 400;
            message = 'One or more field values are invalid.';
        } else if (error.name === 'MongoServerError' && [2, 9, 14, 168, 31249, 31253, 31254].includes(error.code)) {
            status = 400;
            message = 'One or more query values are invalid.';
        } else if (error.status >= 400 && error.status < 500) {
            status = error.status;
            message = error.message;
        }
        res.status(status).json({ message: message, data: null });
    });
};

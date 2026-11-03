// Both collections use the same parsing rules; single-record routes use only select.
function badQuery(message) {
    var error = new Error(message);
    error.status = 400;
    throw error;
}

function parse(query, key, fallback) {
    if (query[key] === undefined) return fallback;
    if (typeof query[key] !== 'string') badQuery(key + ' must have one JSON value.');
    try {
        return JSON.parse(query[key]);
    } catch (error) {
        badQuery(key + ' must contain valid JSON.');
    }
}

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function checkKeys(value) {
    if (Array.isArray(value)) return value.forEach(checkKeys);
    if (!isObject(value)) return;
    for (var key of Object.keys(value)) {
        // Filters may use MongoDB comparisons, but must not run server-side JavaScript.
        if (['$where', '$function', '$accumulator', '__proto__', 'constructor', 'prototype'].includes(key)) {
            badQuery('The query contains an unsupported operator or field.');
        }
        checkKeys(value[key]);
    }
}

function select(query) {
    var fields = parse(query, 'select', {});
    if (!isObject(fields) || Object.values(fields).some(function (value) { return value !== 0 && value !== 1; })) {
        badQuery('select must be an object with 0 or 1 values.');
    }
    var modes = new Set(Object.entries(fields).filter(function (entry) {
        return entry[0] !== '_id';
    }).map(function (entry) { return entry[1]; }));
    if (modes.size > 1) badQuery('select cannot mix included and excluded fields, except for _id.');
    checkKeys(fields);
    return fields;
}

async function collection(Model, query, defaultLimit) {
    var where = parse(query, 'where', {});
    var sort = parse(query, 'sort', {});
    var fields = select(query);
    var skip = parse(query, 'skip', 0);
    var limit = parse(query, 'limit', defaultLimit);
    var count = parse(query, 'count', false);
    if (!isObject(where)) badQuery('where must be a JSON object.');
    if (!isObject(sort) || Object.values(sort).some(function (value) { return value !== 1 && value !== -1; })) {
        badQuery('sort must be an object with 1 or -1 values.');
    }
    if (!Number.isSafeInteger(skip) || skip < 0) badQuery('skip must be a nonnegative integer.');
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) badQuery('limit must be a nonnegative integer.');
    if (typeof count !== 'boolean') badQuery('count must be true or false.');
    checkKeys(where);
    checkKeys(sort);

    try {
        // Count every matching document; pagination applies only when returning documents.
        if (count) return await Model.countDocuments(where);
        var results = Model.find(where).sort(sort).select(fields).skip(skip);
        if (limit !== undefined) results.limit(limit);
        return await results.lean();
    } catch (error) {
        // Mongoose rejects some invalid field operators before the query reaches MongoDB.
        if (error.name === 'Error' && error.message.startsWith("Can't use ")) {
            badQuery('The query contains an invalid field operator.');
        }
        throw error;
    }
}

module.exports = { collection: collection, select: select };

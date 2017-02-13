'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.newContext = exports.instrumentSchema = exports.decorateField = exports.instrumentHapiServer = exports.opticsMiddleware = undefined;

var _typeof = typeof Symbol === "function" && typeof Symbol.iterator === "symbol" ? function (obj) { return typeof obj; } : function (obj) { return obj && typeof Symbol === "function" && obj.constructor === Symbol && obj !== Symbol.prototype ? "symbol" : typeof obj; }; // This file contains the functions that interact with graphql-js to
// get the data for us to report.


var _graphqlTools = require('graphql-tools');

var _Report = require('./Report');

var onFinished = require('on-finished');

// //////// Request Wrapping ////////

// Here we wrap HTTP requests coming in to the web server.

// On request start:
// 1) note the request start time
// 2) create a per-request place to put state

// On request end:
// 3) note the request stop time
// 4) send the collected data off to Report.js for processing

// This should be the only code that interacts with the web
// server. Supporting new web servers besides Express and HAPI should
// be contained here.

var preRequest = function preRequest(req) {
  var context = {
    req: req,
    startWallTime: +new Date(),
    startHrTime: process.hrtime(),
    resolverCalls: []
  };
  req._opticsContext = context; // eslint-disable-line no-param-reassign
};

var postRequest = function postRequest(req) {
  var context = req._opticsContext;
  // context should always be set, but double check just in case.
  //
  // XXX consider error reporting. We might not want to `console.log`
  // here, as it is potentially in a critical path and getting called
  // a lot. maybe a `warnOnce` function that prints the first time it
  // happens and not repeatedly?
  //
  // See also:
  // https://github.com/apollostack/optics-agent-js/issues/6
  if (context) {
    context.durationHrTime = process.hrtime(context.startHrTime);
    context.endWallTime = +new Date();

    // put reporting later in the event loop after I/O, so hopefully we
    // don't impact latency as much.
    setImmediate(function () {
      (0, _Report.reportRequestEnd)(req);
    });
  }
};

var opticsMiddleware = exports.opticsMiddleware = function opticsMiddleware(req, res, next) {
  preRequest(req);
  onFinished(res, function (_err, _res) {
    postRequest(req);
  });

  return next();
};

var instrumentHapiServer = exports.instrumentHapiServer = function instrumentHapiServer(server) {
  server.ext([{
    type: 'onPreHandler',
    method: function method(request, reply) {
      var req = request.raw.req;
      preRequest(req);
      return reply.continue();
    }
  }, {
    type: 'onPostHandler',
    method: function method(request, reply) {
      var req = request.raw.req;
      postRequest(req);
      return reply.continue();
    }
  }]);
};

// //////// Resolver Wrapping ////////

// Here we wrap resolver functions. The wrapped resolver notes start
// and end times, resolvers that return null/undefined, and
// errors. Note that a resolver is not considered finished until all
// Promises it returns (if any) have completed.

// This is applied to each resolver in the schema by instrumentSchema
// below.

var decorateField = exports.decorateField = function decorateField(fn, fieldInfo) {
  var decoratedResolver = function decoratedResolver(p, a, ctx, resolverInfo) {
    // setup context and note start time.
    var opticsContext = ctx && ctx.opticsContext;

    if (!opticsContext) {
      // This happens when `instrumentSchema` was called, but
      // `newContext` didn't get put in the graphql context correctly.
      //
      // XXX we should report this error somehow, but logging once per
      // resolver is not good. Perhaps a "warn once" mechanism?

      return fn(p, a, ctx, resolverInfo);
    }

    var resolverReport = {
      startOffset: process.hrtime(opticsContext.startHrTime),
      fieldInfo: fieldInfo,
      resolverInfo: resolverInfo,
      resolverContext: ctx
    };
    // save the report object for when we want to send query traces and to
    // aggregate its statistics at the end of the request.
    opticsContext.resolverCalls.push(resolverReport);

    // Call this when the resolver and all the Promises it returns
    // (if any) are complete.
    var finishRun = function finishRun() {
      // note end time.
      resolverReport.endOffset = process.hrtime(opticsContext.startHrTime);
    };

    // Actually run the resolver.
    var result = void 0;
    try {
      result = fn(p, a, ctx, resolverInfo);
    } catch (e) {
      // Resolver function threw during execution. Note the error and
      // re-throw.
      resolverReport.error = true;
      finishRun();
      throw e;
    }

    // Now process the results of the resolver.
    //
    // Resolver can return any of: null, undefined, string, number,
    // array[thing], or Promise[thing].
    // For primitives and arrays of primitives, fire the report immediately.
    // For Promises, fire when the Promise returns.
    // For arrays containing Promises, fire when the last Promise returns.
    //
    // Wrap in try-catch so bugs in optics-agent are less likely to break an
    // app.
    try {
      if (result === null) {
        resolverReport.resultNull = true;
      } else if (typeof result === 'undefined') {
        resolverReport.resultUndefined = true;
      } else if (typeof result.then === 'function') {
        // single Promise
        //
        // don’t throw from this promise, because it’s not one that the app
        // gets to handle, instead it operates on the original promise.
        result.then(finishRun).catch(function () {
          resolverReport.error = true;
          finishRun();
        });
        // exit early so we do not hit the default return.
        return result;
      } else if (Array.isArray(result)) {
        var _ret = function () {
          // array

          // collect the Promises in the array, if any.
          var promises = [];
          result.forEach(function (value) {
            if (value && typeof value.then === 'function') {
              promises.push(value);
            }
          });
          // if there are Promises in the array, fire when they are all done.
          if (promises.length > 0) {
            // don’t throw from this promise, because it’s not one that the app
            // gets to handle, instead it operates on the original promise.
            Promise.all(promises).then(finishRun).catch(function () {
              resolverReport.error = true;
              finishRun();
            });
            // exit early so we do not hit the default return.
            return {
              v: result
            };
          }
        }();

        if ((typeof _ret === 'undefined' ? 'undefined' : _typeof(_ret)) === "object") return _ret.v;
      } else {}
      // primitive type. do nothing special, just default return.


      // default return for non-Promise answers
      finishRun();
      return result;
    } catch (e) {
      // safety belt.
      // XXX log here!
      return result;
    }
  };

  // Add .$proxy to support graphql-sequelize.
  // See: https://github.com/mickhansen/graphql-sequelize/blob/edd4266bd55828157240fe5fe4d4381e76f041f8/src/generateIncludes.js#L37-L41
  decoratedResolver.$proxy = fn;

  return decoratedResolver;
};

// //////// Helpers ////////

// Copied from https://github.com/graphql/graphql-js/blob/v0.7.1/src/execution/execute.js#L1004
// with 'return undefined' added for clarity (and eslint)
function defaultResolveFn(source, args, context, _ref) {
  var fieldName = _ref.fieldName;

  // ensure source is a value for which property access is acceptable.
  if ((typeof source === 'undefined' ? 'undefined' : _typeof(source)) === 'object' || typeof source === 'function') {
    var property = source[fieldName];
    if (typeof property === 'function') {
      return source[fieldName](args, context);
    }
    return property;
  }
  return undefined;
}

//  //////// Schema Wrapping ////////

// Here we take the executable schema object that graphql-js will
// execute against and add wrappings. We add both a per-schema
// wrapping that runs once per query and a per-resolver wrapping that
// runs around every resolver invocation.

var instrumentSchema = exports.instrumentSchema = function instrumentSchema(schema) {
  if (schema._opticsInstrumented) {
    return schema;
  }
  schema._opticsInstrumented = true; // eslint-disable-line no-param-reassign

  // add per field instrumentation
  (0, _graphqlTools.forEachField)(schema, function (field, typeName, fieldName) {
    // If there is no resolver for a field, add the default resolve
    // function (which matches the behavior of graphql-js when there
    // is no explicit resolve function). This way we can instrument
    // it.
    if (!field.resolve) {
      field.resolve = defaultResolveFn; // eslint-disable-line no-param-reassign
    }

    field.resolve = decorateField( // eslint-disable-line no-param-reassign
    field.resolve, { typeName: typeName, fieldName: fieldName });
  });

  // add per query instrumentation
  (0, _graphqlTools.addSchemaLevelResolveFunction)(schema, function (root, args, ctx, info) {
    var opticsContext = ctx.opticsContext;
    if (opticsContext) {
      (0, _Report.reportRequestStart)(opticsContext, info, ctx);
    }
    return root;
  });

  return schema;
};

// //////// Glue ////////


// The graphql `context` object is how we get state into the resolver
// wrappers. For resolver level information gathering to work, the
// user must call `newContext` once per query and place the return
// value in the `opticsContext` field of the graphql-js `context`
// argument.
var newContext = exports.newContext = function newContext(req, agent) {
  var context = req._opticsContext;
  if (!context) {
    // This happens if the middleware isn't run correctly.

    // XXX this will print once per request! Maybe add a "warn once"
    // feature to print only once.
    agent.debugFn('Optics context not found. Make sure Optics middleware is installed.');

    // Fix things up by re-running the pre-request hook. We probably
    // won't correctly send a report as the post-request hook
    // probably won't fire, but this way optics code that assumes a
    // context will run correctly.
    preRequest(req);
    context = req._opticsContext;
  }

  // This does not really need to be set here. It could be set in
  // preRequest, if we threaded agent through there. Once we do that,
  // we could change the API to not require calling this as a function
  // and instead just ask users to add `req.opticsContext` to their
  // graphql context. See:
  // https://github.com/apollostack/optics-agent-js/issues/46
  context.agent = agent;

  return context;
};
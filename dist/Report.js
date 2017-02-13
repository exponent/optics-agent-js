'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.reportSchema = exports.reportRequestEnd = exports.reportTrace = exports.reportRequestStart = exports.sendSchema = exports.sendTrace = exports.sendStatsReport = exports.sendMessage = exports.getTypesFromSchema = undefined;

var _buffer = require('buffer');

var _os = require('os');

var _os2 = _interopRequireDefault(_os);

var _request = require('request');

var _request2 = _interopRequireDefault(_request);

var _graphql = require('graphql');

var _language = require('graphql/language');

var _type = require('graphql/type');

var _utilities = require('graphql/utilities');

var _Normalize = require('./Normalize');

var _Proto = require('./Proto');

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

// Babel cleverly inlines the require below!
// eslint-disable-next-line global-require
var VERSION = 'optics-agent-js ' + '1.0.5';

// Pre-compute the report header. It is the same for each message.
// This file contains the functions for processing incoming data from
// the agent instrumentation and reporting it back to the optics
// backend.

var REPORT_HEADER = new _Proto.ReportHeader({
  hostname: _os2.default.hostname(),
  agent_version: VERSION,
  runtime_version: 'node ' + process.version,
  // XXX not actually uname, but what node has easily.
  uname: _os2.default.platform() + ', ' + _os2.default.type() + ', ' + _os2.default.release() + ', ' + _os2.default.arch() + ')'
});

// //////// Helpers ////////

var getTypesFromSchema = exports.getTypesFromSchema = function getTypesFromSchema(schema) {
  var ret = [];
  var typeMap = schema.getTypeMap();
  var typeNames = Object.keys(typeMap);
  typeNames.forEach(function (typeName) {
    var type = typeMap[typeName];
    if ((0, _type.getNamedType)(type).name.startsWith('__') || !(type instanceof _type.GraphQLObjectType)) {
      return;
    }
    var t = new _Proto.Type();
    t.name = typeName;
    t.field = [];
    var fields = type.getFields();
    Object.keys(fields).forEach(function (fieldName) {
      var field = fields[fieldName];
      var f = new _Proto.Field();
      f.name = fieldName;
      f.returnType = (0, _Normalize.printType)(field.type);
      t.field.push(f);
    });
    ret.push(t);
  });
  return ret;
};

// Converts an hrtime array (as returned from process.hrtime) to nanoseconds.
//
// ONLY CALL THIS ON VALUES REPRESENTING DELTAS, NOT ON THE RAW RETURN VALUE
// FROM process.hrtime() WITH NO ARGUMENTS.
//
// The entire point of the hrtime data structure is that the JavaScript Number
// type can't represent all int64 values without loss of precision:
// Number.MAX_SAFE_INTEGER nanoseconds is about 104 days. Calling this function
// on a duration that represents a value less than 104 days is fine. Calling
// this function on an absolute time (which is generally roughly time since
// system boot) is not a good idea.
var durationHrTimeToNanos = function durationHrTimeToNanos(hrtime) {
  return hrtime[0] * 1e9 + hrtime[1];
};

// Converts a JS Date into a Proto.Timestamp.
var dateToTimestamp = function dateToTimestamp(date) {
  return new _Proto.Timestamp({ seconds: date / 1000, nanos: date % 1000 * 1e6 });
};

// //////// Sending Data ////////

var sendMessage = exports.sendMessage = function sendMessage(agent, path, message) {
  var headers = {
    'user-agent': 'optics-agent-js',
    'x-api-key': agent.apiKey
  };

  var options = {
    url: agent.endpointUrl + path,
    method: 'POST',
    headers: headers,
    body: message.encode().toBuffer(),
    proxy: agent.proxyUrl
  };
  (0, _request2.default)(options, function (err, res, body) {
    // XXX add retry logic
    // XXX add separate flag for disable printing errors?
    if (err) {
      console.log('OPTICS Error trying to report to optics backend:', err.message); // eslint-disable-line no-console
    } else if (res.statusCode < 200 || res.statusCode > 299) {
      console.log('OPTICS Backend error', res.statusCode, body); // eslint-disable-line no-console
    }

    if (agent.printReports) {
      console.log('OPTICS', path, message.encodeJSON(), body); // eslint-disable-line no-console
    }
  });
};

//  //////// Marshalling Data ////////

var sendStatsReport = exports.sendStatsReport = function sendStatsReport(agent, reportData, startTime, endTime, durationHr) {
  try {
    (function () {
      // build report protobuf object
      var report = new _Proto.StatsReport();
      report.header = REPORT_HEADER;

      report.start_time = dateToTimestamp(startTime);
      report.end_time = dateToTimestamp(endTime);
      // XXX Would be nice to rename this field to include the unit (ns).
      report.realtime_duration = durationHrTimeToNanos(durationHr);

      report.type = getTypesFromSchema(agent.schema);

      // fill out per signature
      report.per_signature = {};
      Object.keys(reportData).forEach(function (query) {
        var c = new _Proto.StatsPerSignature();

        // add client stats
        c.per_client_name = {};
        var clients = reportData[query].perClient;
        Object.keys(clients).forEach(function (client) {
          var versions = clients[client].perVersion;
          var v = new _Proto.StatsPerClientName();
          v.latency_count = (0, _Normalize.trimLatencyBuckets)(clients[client].latencyBuckets);
          v.count_per_version = {};
          Object.keys(versions).forEach(function (version) {
            var r = versions[version];
            v.count_per_version[version] = r;
          });
          c.per_client_name[client] = v;
        });

        // add field stats
        c.per_type = [];
        var fields = reportData[query].perField;
        Object.keys(fields).forEach(function (parentType) {
          var ts = new _Proto.TypeStat();
          c.per_type.push(ts);
          ts.name = parentType;
          ts.field = [];
          Object.keys(fields[parentType]).forEach(function (fieldName) {
            var fs = new _Proto.FieldStat();
            ts.field.push(fs);
            var fObj = fields[parentType][fieldName];
            fs.name = fieldName;
            fs.returnType = fObj.returnType;
            fs.latency_count = (0, _Normalize.trimLatencyBuckets)(fObj.latencyBuckets);
          });
        });

        report.per_signature[query] = c;
      });

      sendMessage(agent, '/api/ss/stats', report);
    })();
  } catch (e) {
    console.log('Optics sendStatsReport error', e); // eslint-disable-line no-console
  }
};

var sendTrace = exports.sendTrace = function sendTrace(agent, context, info, resolvers) {
  // exceptions from here are caught and ignored somewhere.
  // catch manually for debugging.
  try {
    (function () {
      var report = new _Proto.TracesReport();
      report.header = REPORT_HEADER;
      var req = context.req;

      var trace = new _Proto.Trace();
      // XXX make up a server_id
      trace.start_time = dateToTimestamp(context.startWallTime);
      trace.end_time = dateToTimestamp(context.endWallTime);
      trace.duration_ns = durationHrTimeToNanos(context.durationHrTime);

      trace.signature = agent.normalizeQuery(info);

      trace.details = new _Proto.Trace.Details();
      var operationStr = (0, _language.print)(info.operation);
      var fragmentsStr = Object.keys(info.fragments).map(function (k) {
        return (0, _language.print)(info.fragments[k]) + '\n';
      }).join('');
      trace.details.raw_query = operationStr + '\n' + fragmentsStr;
      if (info.operation.name) {
        trace.details.operation_name = (0, _language.print)(info.operation.name);
      }
      if (agent.reportVariables) {
        trace.details.variables = {};
        Object.keys(info.variableValues).forEach(function (k) {
          trace.details.variables[k] = new _buffer.Buffer(JSON.stringify(info.variableValues[k]), 'utf8');
        });
      }

      var _agent$normalizeVersi = agent.normalizeVersion(req),
          client_name = _agent$normalizeVersi.client_name,
          client_version = _agent$normalizeVersi.client_version;

      trace.client_name = client_name; // eslint-disable-line camelcase
      trace.client_version = client_version; // eslint-disable-line camelcase

      trace.client_addr = req.connection.remoteAddress; // XXX x-forwarded-for?
      trace.http = new _Proto.Trace.HTTPInfo();
      trace.http.host = req.headers.host;
      trace.http.path = req.url;

      trace.execute = new _Proto.Trace.Node();
      // XXX trace.execute.start_time is missing despite it being documented as
      // non-(optional).
      trace.execute.child = resolvers.map(function (rep) {
        // XXX for now we just list all the resolvers in a flat list.
        //
        // With graphql 0.6.1+ we have the path field in resolverInfo so
        // we should make these into a hierarchical list.
        // See: https://github.com/apollostack/optics-agent-js/issues/34
        var n = new _Proto.Trace.Node();
        n.field_name = rep.fieldInfo.typeName + '.' + rep.fieldInfo.fieldName;
        n.type = (0, _Normalize.printType)(rep.resolverInfo.returnType);
        n.start_time = durationHrTimeToNanos(rep.startOffset);
        n.end_time = durationHrTimeToNanos(rep.endOffset);
        return n;
      });

      // no batching for now.
      report.trace = [trace];

      sendMessage(agent, '/api/ss/traces', report);
    })();
  } catch (e) {
    console.log('Optics sendTrace error', e); // eslint-disable-line no-console
  }
};

var sendSchema = exports.sendSchema = function sendSchema(agent, schema) {
  // modified introspection query that doesn't return something
  // quite so giant.
  var q = '\n  query ShorterIntrospectionQuery {\n    __schema {\n      queryType { name }\n      mutationType { name }\n      subscriptionType { name }\n      types {\n        ...FullType\n      }\n      directives {\n        name\n        # description\n        locations\n        args {\n          ...InputValue\n        }\n      }\n    }\n  }\n\n  fragment FullType on __Type {\n    kind\n    name\n    # description\n    fields(includeDeprecated: true) {\n      name\n      # description\n      args {\n        ...InputValue\n      }\n      type {\n        ...TypeRef\n      }\n      isDeprecated\n      # deprecationReason\n    }\n    inputFields {\n      ...InputValue\n    }\n    interfaces {\n      ...TypeRef\n    }\n    enumValues(includeDeprecated: true) {\n      name\n      # description\n      isDeprecated\n      # deprecationReason\n    }\n    possibleTypes {\n      ...TypeRef\n    }\n  }\n\n  fragment InputValue on __InputValue {\n    name\n    # description\n    type { ...TypeRef }\n    # defaultValue\n  }\n\n  fragment TypeRef on __Type {\n    kind\n    name\n    ofType {\n      kind\n      name\n      ofType {\n        kind\n        name\n        ofType {\n          kind\n          name\n          ofType {\n            kind\n            name\n            ofType {\n              kind\n              name\n              ofType {\n                kind\n                name\n                ofType {\n                  kind\n                  name\n                }\n              }\n            }\n          }\n        }\n      }\n    }\n  }\n\n';
  (0, _graphql.graphql)(schema, q).then(function (res) {
    if (!res || !res.data || !res.data.__schema) {
      // XXX huh?
      console.log('Optics internal error: bad schema result'); // eslint-disable-line no-console
      return;
    }
    var resultSchema = res.data.__schema;
    // remove the schema schema from the schema.
    resultSchema.types = resultSchema.types.filter(function (x) {
      return x && (x.kind !== 'OBJECT' || x.name !== '__Schema');
    });

    var schemaString = JSON.stringify(resultSchema);

    var report = new _Proto.SchemaReport();
    report.header = REPORT_HEADER;
    report.introspection_result = schemaString;
    report.type = getTypesFromSchema(schema);

    sendMessage(agent, '/api/ss/schema', report);
  });
  // ).catch(() => {}); // XXX!
};

// //////// Incoming Data ////////

// Called once per query at query start time by graphql-js.
var reportRequestStart = exports.reportRequestStart = function reportRequestStart(context, queryInfo, queryContext) {
  if (!context || !queryInfo || !context.agent) {
    // Happens when non-graphql requests come through.
    return;
  }

  // This may be called more than once per request, for example
  // apollo-server can batch multiple requests in a single POST (aka
  // Transport Level Batching).
  //
  // We keep track of each info object separately, along with the
  // `context` object passed to the query, and use these to determine
  // which resolver runs correspond to which query.
  //
  // Store as a Map of `context` => [ { info, context, resolvers } ] objects.
  //
  // This is a contract between reportRequestStart and reportRequestEnd.
  //
  // Note: we use a Map instead of simple array to avoid doing O(N^2)
  // work on a batch with a lot of queries, each with a separate
  // context object. We store a list in each map item in case the
  // caller does not allocate a new context object per query and we
  // see a duplicate context object.
  if (!context.queries) {
    context.queries = new Map(); // eslint-disable-line no-param-reassign
  }
  if (!context.queries.has(queryContext)) {
    context.queries.set(queryContext, []);
  }
  context.queries.get(queryContext).push({
    info: queryInfo,
    resolvers: []
  });
};

var reportTrace = exports.reportTrace = function reportTrace(agent, context, info, resolvers) {
  // For now just send every trace immediately. We might want to add
  // batching here at some point.
  //
  // Send in its own function on the event loop to minimize impact on
  // response times.
  setImmediate(function () {
    return sendTrace(agent, context, info, resolvers);
  });
};

// called once per query by the middleware when the request ends.
var reportRequestEnd = exports.reportRequestEnd = function reportRequestEnd(req) {
  var context = req._opticsContext;
  if (!context || !context.queries || !context.agent) {
    // Happens when non-graphql requests come through.
    return;
  }

  var queries = context.queries;
  var agent = context.agent;

  try {
    // Separate out resolvers into buckets by query. To determine
    // which query a resolver corresponds to in the case of multiple
    // queries per HTTP request, we look at the GraphQL `context` and
    // `operation` objects which are available both at query start
    // time and during resolver runs.
    //
    // Implementations that do batching of GraphQL requests (such as
    // apollo-server) should use a separate `context` object for each
    // request in the batch. Shallow cloning is sufficient.
    //
    // For backwards compatibility with older versions of
    // apollo-server, and potentially with other graphql integrations,
    // we also look at the `operation` object. This will be different
    // for each query in the batch unless the application is using
    // pre-prepared queries and the user sends multiple queries for
    // the same operation in the same batch.
    (context.resolverCalls || []).forEach(function (resolverReport) {
      // check the report is complete.
      if (!resolverReport.resolverInfo || !resolverReport.resolverInfo.operation || !resolverReport.fieldInfo || !resolverReport.startOffset || !resolverReport.endOffset) {
        return;
      }

      // eslint-disable-next-line no-restricted-syntax
      var _iteratorNormalCompletion = true;
      var _didIteratorError = false;
      var _iteratorError = undefined;

      try {
        for (var _iterator = (queries.get(resolverReport.resolverContext) || [])[Symbol.iterator](), _step; !(_iteratorNormalCompletion = (_step = _iterator.next()).done); _iteratorNormalCompletion = true) {
          var queryObj = _step.value;

          if (resolverReport.resolverInfo.operation === queryObj.info.operation) {
            queryObj.resolvers.push(resolverReport);
            break;
          }
        }
      } catch (err) {
        _didIteratorError = true;
        _iteratorError = err;
      } finally {
        try {
          if (!_iteratorNormalCompletion && _iterator.return) {
            _iterator.return();
          }
        } finally {
          if (_didIteratorError) {
            throw _iteratorError;
          }
        }
      }
    });

    // Iterate over each query in this request and aggregate its
    // timing and resolvers.
    queries.forEach(function (queryList) {
      queryList.forEach(function (_ref) {
        var info = _ref.info,
            _ref$resolvers = _ref.resolvers,
            queryResolvers = _ref$resolvers === undefined ? [] : _ref$resolvers;

        var query = agent.normalizeQuery(info);

        var _agent$normalizeVersi2 = agent.normalizeVersion(req),
            client_name = _agent$normalizeVersi2.client_name,
            client_version = _agent$normalizeVersi2.client_version;

        var res = agent.pendingResults;

        // Initialize per-query state in the report if we're the first of
        // this query shape to come in this report period.
        if (!res[query]) {
          (function () {
            res[query] = {
              perClient: {},
              perField: {}
            };

            var perField = res[query].perField;
            var typeInfo = new _utilities.TypeInfo(agent.schema);
            // We do this calculation once per minute per query. We think this
            // will be fast enough in most cases, and is out of critical path, but
            // if profiling points at a slow spot here consider a cache -- the
            // data is very cachable.
            var asts = [info.operation].concat(Object.keys(info.fragments).map(function (k) {
              return info.fragments[k];
            }));
            asts.forEach(function (ast) {
              (0, _language.visit)(ast, (0, _language.visitWithTypeInfo)(typeInfo, {
                Field: function Field() {
                  var parentType = typeInfo.getParentType().name;
                  if (!perField[parentType]) {
                    perField[parentType] = {};
                  }
                  var fieldName = typeInfo.getFieldDef().name;
                  perField[parentType][fieldName] = {
                    returnType: (0, _Normalize.printType)(typeInfo.getType()),
                    latencyBuckets: (0, _Normalize.newLatencyBuckets)()
                  };
                }
              }));
            });
          })();
        }

        // initialize latency buckets if this is the first time we've had
        // a query from this client type in this period.
        var perClient = res[query].perClient;
        if (!perClient[client_name]) {
          perClient[client_name] = {
            latencyBuckets: (0, _Normalize.newLatencyBuckets)(),
            perVersion: {}
          };
        }

        // now that we've initialized, this should always be set.
        var clientObj = res[query] && res[query].perClient && res[query].perClient[client_name];

        if (!clientObj) {
          // XXX huh?
          console.log('Optics internal error: no match for query', query); // eslint-disable-line no-console
          return;
        }

        var nanos = durationHrTimeToNanos(context.durationHrTime);

        // add query latency to buckets
        (0, _Normalize.addLatencyToBuckets)(clientObj.latencyBuckets, nanos);

        // add per-client version count to buckets
        var perVersion = clientObj.perVersion;
        if (!perVersion[client_version]) {
          perVersion[client_version] = 0;
        }
        perVersion[client_version] += 1;

        // now iterate over our resolvers and add them to the latency buckets.
        queryResolvers.forEach(function (resolverReport) {
          var _resolverReport$field = resolverReport.fieldInfo,
              typeName = _resolverReport$field.typeName,
              fieldName = _resolverReport$field.fieldName;

          if (resolverReport.endOffset && resolverReport.startOffset) {
            var resolverNanos = durationHrTimeToNanos(resolverReport.endOffset) - durationHrTimeToNanos(resolverReport.startOffset);
            var fObj = res && res[query] && res[query].perField && res[query].perField[typeName] && res[query].perField[typeName][fieldName];
            if (!fObj) {
              // This can happen when there is a fragment on an
              // interface and a field that returns a concrete type of
              // that fragment.
              //
              // XXX when else can this happen?
              return;
            }
            (0, _Normalize.addLatencyToBuckets)(fObj.latencyBuckets, resolverNanos);
          }
        });

        // check to see if we've sent a trace for this bucket/client name yet
        // this report period. if we haven't (ie, if we're the only query in
        // this bucket), send one now.
        // XXX would it also make sense to send traces for strange buckets of
        //     individual resolvers?
        var bucket = (0, _Normalize.latencyBucket)(nanos);
        var numSoFar = clientObj.latencyBuckets[bucket];
        if (numSoFar === 1 && agent.reportTraces) {
          reportTrace(agent, context, info, queryResolvers);
        }
      });
    });
  } catch (e) {
    // XXX https://github.com/apollostack/optics-agent-js/issues/17
    console.log('Optics reportRequestEnd error', e); // eslint-disable-line no-console
  }
};

var reportSchema = exports.reportSchema = function reportSchema(agent, schema) {
  // Sent once on startup. Wait 10 seconds to report the schema. This
  // does two things:
  // - help apps start up and serve users faster. don't clog startup
  //   time with reporting.
  // - avoid sending a ton of reports from a crash-looping server.
  setTimeout(function () {
    return sendSchema(agent, schema);
  }, 10 * 1000);
};